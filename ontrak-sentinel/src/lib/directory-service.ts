/**
 * Directory service (S2): reading a roster from AD, Entra or Google and negotiating
 * what Sentinel does with it.
 *
 * The rules module decides *what* should happen; this file does it, and it does it in
 * an order that is worth reading before the code:
 *
 *   1. **Pull, then plan, then write — never pull and write.** A directory is a network
 *      service that can answer with half a page, time out mid-stream or return yesterday
 *      cached; a sync that wrote as it read would leave the tenant half-updated and no
 *      one able to say where it stopped. The plan is also what the console shows before
 *      anything happens, so the dry run is the same code path rather than a second
 *      implementation that could disagree with the real one.
 *   2. **Every write goes through the spine, and the destructive one goes through SCIM.**
 *      Creating, editing and switching an identity on are calls the console and the SCIM
 *      API also make; deactivating somebody goes through `ScimService.deprovision`, so
 *      "switch them off, end their sessions, revoke their tokens" stays one operation
 *      with one audit sentence rather than a second copy of it here.
 *   3. **The run is recorded.** Counts and the reason for every skip are written to a run
 *      row and to the organization's evidence chain, because "what did last night's sync
 *      do?" is a question with a wrong answer people repeat.
 *
 * A source with no reader configured is refused at connection time rather than at sync
 * time: an administrator should learn that this deployment cannot read Google the moment
 * they choose it, not at 02:00 when the schedule fires.
 */

import { randomUUID } from "node:crypto";

import type { AuditTrail } from "./identity-service";
import type { IdentityActor, IdentityService, ServiceResult } from "./identity-service";
import type { IdentityRecord, IdentityRole } from "./identity-rules";
import {
  canManageDirectory,
  planDirectorySync,
  validateConnection,
  type ConflictPolicy,
  type DirectoryConnectionRecord,
  type DirectoryPerson,
  type DirectoryPlan,
  type DirectorySource,
} from "./directory-rules";
import type { ScimService } from "./scim-service";

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

/** What a pull produced. A failed pull is reported, never treated as an empty roster. */
export type DirectoryPull =
  | { ok: true; people: DirectoryPerson[]; skipped: string[] }
  | { ok: false; error: string };

/**
 * The reader: the vendor-shaped half.
 *
 * Behind a port because Entra (Graph), Google (Admin SDK) and a plain LDAP bind share
 * nothing but this shape, and because the tests must be able to drive a sync without a
 * directory — a fake reader is a five-line object, whereas a fake Graph is a project.
 */
export interface DirectoryReader {
  /**
   * Read the directory. The credential is passed in rather than carried on the
   * connection record, so it exists in exactly one place: the call about to use it.
   */
  pull(connection: DirectoryConnectionRecord, secret: string | null): Promise<DirectoryPull>;
}

export interface DirectorySyncRunRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  startedAt: string;
  finishedAt: string;
  /** `COMPLETED` or `FAILED` — a dry run writes nothing, so it has no run row. */
  status: "COMPLETED" | "FAILED";
  counts: DirectoryPlan["counts"];
  /** One sentence, plus the reasons any record was skipped. */
  detail: string | null;
}

export type { DirectoryConnectionRecord };

export interface DirectoryStore {
  listConnections(organizationId: string): Promise<DirectoryConnectionRecord[]>;
  findConnection(organizationId: string, connectionId: string): Promise<DirectoryConnectionRecord | null>;
  insertConnection(record: DirectoryConnectionRecord): Promise<void>;
  updateConnection(record: DirectoryConnectionRecord): Promise<void>;
  removeConnection(organizationId: string, connectionId: string): Promise<void>;

  insertRun(record: DirectorySyncRunRecord): Promise<void>;
  listRuns(organizationId: string, connectionId?: string): Promise<DirectorySyncRunRecord[]>;

  /** The stored credential, read only by the call about to use it. */
  findSecret(organizationId: string, connectionId: string): Promise<string | null>;
  setSecret(organizationId: string, connectionId: string, secret: string | null): Promise<void>;
}

export interface DirectoryIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemDirectoryIds(): DirectoryIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export interface ConnectionInput {
  name?: string;
  source?: string;
  settings?: Record<string, string>;
  conflictPolicy?: string;
  defaultRole?: string;
  /** `undefined` leaves the stored credential alone; `null` clears it. */
  secret?: string | null;
}

export interface SyncReport {
  connectionId: string;
  dryRun: boolean;
  plan: DirectoryPlan;
  /** What the writes actually did, which a dry run leaves empty. */
  applied: { created: number; updated: number; deactivated: number; reactivated: number; groups: number; failed: number };
  detail: string | null;
}

export class DirectoryService {
  constructor(
    private readonly store: DirectoryStore,
    private readonly spine: IdentityService,
    /** The destructive half of a sync: the leaver path and group membership. */
    private readonly scim: Pick<ScimService, "deprovisionForActor" | "syncGroup"> | null,
    /** Only the sources this deployment can actually read. */
    private readonly readers: Partial<Record<DirectorySource, DirectoryReader>>,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: DirectoryIds = systemDirectoryIds(),
  ) {}

  /* --------------------------------------------------------- connections */

  async connections(actor: IdentityActor): Promise<ServiceResult<DirectoryConnectionRecord[]>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    return { ok: true, value: await this.store.listConnections(actor.organizationId) };
  }

  /** Which sources this deployment can read, for a picker rather than a failed save. */
  sources(): DirectorySource[] {
    return Object.keys(this.readers).filter((key) => this.readers[key as DirectorySource] !== undefined) as DirectorySource[];
  }

  async createConnection(actor: IdentityActor, input: ConnectionInput): Promise<ServiceResult<DirectoryConnectionRecord>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    const refused = this.validate(input);
    if (refused) return refused;

    const now = this.ids.now();
    const record: DirectoryConnectionRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      name: input.name!.trim(),
      source: input.source as DirectorySource,
      settings: { ...(input.settings ?? {}) },
      conflictPolicy: (input.conflictPolicy ?? "preferDirectory") as ConflictPolicy,
      defaultRole: (input.defaultRole ?? "AGENT") as IdentityRole,
      lastSyncedAt: null,
      hasSecret: typeof input.secret === "string" && input.secret.trim().length > 0,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertConnection(record);
    if (input.secret !== undefined) {
      await this.store.setSecret(actor.organizationId, record.id, input.secret ? input.secret : null);
    }
    await this.append(actor, "directory.connection.create", record.id, {
      name: record.name,
      source: record.source,
      conflictPolicy: record.conflictPolicy,
    });
    return { ok: true, value: record };
  }

  async updateConnection(actor: IdentityActor, connectionId: string, input: ConnectionInput): Promise<ServiceResult<DirectoryConnectionRecord>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    const found = await this.store.findConnection(actor.organizationId, connectionId);
    if (!found) return { ok: false, error: "That connection does not exist." };

    const merged: ConnectionInput = {
      name: input.name ?? found.name,
      source: input.source ?? found.source,
      conflictPolicy: input.conflictPolicy ?? found.conflictPolicy,
      defaultRole: input.defaultRole ?? found.defaultRole,
      settings: input.settings ?? found.settings,
    };
    const refused = this.validate(merged);
    if (refused) return refused;

    const next: DirectoryConnectionRecord = {
      ...found,
      name: merged.name!.trim(),
      source: merged.source as DirectorySource,
      settings: { ...(merged.settings ?? {}) },
      conflictPolicy: merged.conflictPolicy as ConflictPolicy,
      defaultRole: merged.defaultRole as IdentityRole,
      hasSecret: input.secret === undefined ? found.hasSecret : typeof input.secret === "string" && input.secret.trim().length > 0,
      updatedAt: this.ids.now(),
    };
    await this.store.updateConnection(next);
    if (input.secret !== undefined) {
      await this.store.setSecret(actor.organizationId, next.id, input.secret ? input.secret : null);
    }
    await this.append(actor, "directory.connection.update", next.id, {
      name: next.name,
      source: next.source,
      conflictPolicy: next.conflictPolicy,
    });
    return { ok: true, value: next };
  }

  async removeConnection(actor: IdentityActor, connectionId: string): Promise<ServiceResult<{ removed: true }>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    const found = await this.store.findConnection(actor.organizationId, connectionId);
    if (!found) return { ok: false, error: "That connection does not exist." };
    await this.store.removeConnection(actor.organizationId, connectionId);
    await this.append(actor, "directory.connection.remove", connectionId, { name: found.name, source: found.source });
    return { ok: true, value: { removed: true } };
  }

  async runs(actor: IdentityActor, connectionId?: string): Promise<ServiceResult<DirectorySyncRunRecord[]>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    return { ok: true, value: await this.store.listRuns(actor.organizationId, connectionId) };
  }

  /* ---------------------------------------------------------------- sync */

  /**
   * Pull, plan, and either stop (a dry run) or apply.
   *
   * `dryRun` is a parameter of the *same* method rather than a separate `preview`
   * function, because a preview that computed a different plan from the one that would
   * run would be worse than no preview: it would be a promise the product breaks.
   */
  async sync(actor: IdentityActor, connectionId: string, options: { dryRun?: boolean } = {}): Promise<ServiceResult<SyncReport>> {
    if (!canManageDirectory(actor.role)) return { ok: false, error: "You do not administer directories." };
    const connection = await this.store.findConnection(actor.organizationId, connectionId);
    if (!connection) return { ok: false, error: "That connection does not exist." };

    const reader = this.readers[connection.source];
    if (!reader) {
      return { ok: false, error: `This deployment has no reader for ${connection.source}.` };
    }

    const startedAt = this.ids.now();
    const secret = await this.store.findSecret(actor.organizationId, connectionId);
    const pulled = await reader.pull(connection, secret);
    if (!pulled.ok) {
      await this.recordRun({
        connectionId,
        organizationId: actor.organizationId,
        startedAt,
        status: "FAILED",
        counts: { created: 0, updated: 0, deactivated: 0, reactivated: 0, unchanged: 0, conflicts: 0 },
        detail: pulled.error,
      });
      await this.append(actor, "directory.sync.failed", connectionId, { reason: pulled.error });
      return { ok: false, error: pulled.error };
    }

    const identities = await this.spine.listIdentities(actor);
    if (!identities.ok) return { ok: false, error: identities.error };

    const plan = planDirectorySync(identities.value, pulled.people, {
      conflictPolicy: connection.conflictPolicy,
      defaultRole: connection.defaultRole,
      lastSyncedAt: connection.lastSyncedAt,
    });
    plan.skipped.push(...pulled.skipped);

    const detail =
      `${plan.counts.created} created, ${plan.counts.updated} updated, ` +
      `${plan.counts.deactivated} deactivated, ${plan.counts.reactivated} reactivated, ` +
      `${plan.counts.unchanged} unchanged, ${plan.counts.conflicts} conflict(s)` +
      (plan.skipped.length > 0 ? `, ${plan.skipped.length} skipped` : "");

    if (options.dryRun) {
      await this.append(actor, "directory.sync.preview", connectionId, { ...plan.counts, skipped: plan.skipped.length });
      return {
        ok: true,
        value: { connectionId, dryRun: true, plan, applied: emptyApplied(), detail },
      };
    }

    const applied = await this.apply(actor, plan, pulled.people);
    const finishedAt = this.ids.now();
    await this.recordRun({
      connectionId,
      organizationId: actor.organizationId,
      startedAt,
      status: applied.failed > 0 ? "FAILED" : "COMPLETED",
      counts: plan.counts,
      detail: applied.failed > 0 ? `${detail}; ${applied.failed} write(s) failed` : detail,
    });
    // Only a completed run moves the clock that protects local edits: a failed sync that
    // advanced it would silently stop protecting changes made here.
    if (applied.failed === 0) {
      await this.store.updateConnection({ ...connection, lastSyncedAt: finishedAt, updatedAt: finishedAt });
    }
    await this.append(actor, "directory.sync", connectionId, {
      ...plan.counts,
      groups: applied.groups,
      failed: applied.failed,
      skipped: plan.skipped.length,
    });

    return { ok: true, value: { connectionId, dryRun: false, plan, applied, detail } };
  }

  /* ----------------------------------------------------------- internals */

  private validate(input: ConnectionInput): ServiceResult<never> | null {
    const issues = validateConnection(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
    if (!input.source) return { ok: false, error: "Choose which kind of directory this is." };
    if (!this.readers[input.source as DirectorySource]) {
      return { ok: false, error: `This deployment has no reader for ${input.source}; nothing could be pulled from it.` };
    }
    return null;
  }

  /**
   * Write the plan.
   *
   * One failure does not abandon the rest: a person whose write is refused (say, the
   * last administrator) is counted and the sync continues, because stopping at the first
   * refusal would leave the tenant more inconsistent than carrying on — and the run is
   * marked failed either way, so nobody reads a partial success as a clean one.
   */
  private async apply(
    actor: IdentityActor,
    plan: DirectoryPlan,
    people: readonly DirectoryPerson[],
  ): Promise<SyncReport["applied"]> {
    const byExternalId = new Map(people.map((person) => [person.externalId, person]));
    const applied = emptyApplied();

    for (const change of plan.changes) {
      const person = byExternalId.get(change.externalId);
      if (!person) continue;

      if (change.action === "create") {
        const created = await this.spine.createIdentity(actor, {
          identifier: person.userName,
          displayName: person.displayName,
          externalId: person.externalId,
          kind: "HUMAN",
          role: person.role ?? undefined,
        });
        if (created.ok) applied.created += 1;
        else applied.failed += 1;
        continue;
      }

      if (!change.identityId) continue;

      if (change.action === "update") {
        const input: { identifier?: string; displayName?: string; role?: string; externalId?: string | null } = {};
        if (change.changes.includes("identifier")) input.identifier = person.userName;
        if (change.changes.includes("displayName")) input.displayName = person.displayName;
        if (change.changes.includes("externalId")) input.externalId = person.externalId;
        if (change.changes.includes("role") && person.role) input.role = person.role;
        const updated = await this.spine.updateIdentity(actor, change.identityId, input);
        if (updated.ok) applied.updated += 1;
        else applied.failed += 1;
        continue;
      }

      if (change.action === "deactivate") {
        if (!this.scim) {
          applied.failed += 1;
          continue;
        }
        // `deprovisionForActor` is the same path a SCIM `active:false` takes: switched
        // off, sessions ended, tokens revoked, one audit sentence.
        const down = await this.scim.deprovisionForActor(actor, change.identityId, "the directory reports this person inactive");
        if (down.ok) applied.deactivated += 1;
        else applied.failed += 1;
        continue;
      }

      if (change.action === "reactivate") {
        const up = await this.spine.setActive(actor, change.identityId, true);
        if (up.ok) applied.reactivated += 1;
        else applied.failed += 1;
      }
    }

    // Groups last, and from a fresh listing: a member the sync just created has an
    // identity id only after the create above.
    if (this.scim && plan.groups.length > 0) {
      const listed = await this.spine.listIdentities(actor);
      const byExternal = new Map<string, IdentityRecord>();
      if (listed.ok) {
        for (const identity of listed.value) {
          if (identity.externalId) byExternal.set(identity.externalId, identity);
        }
      }
      for (const group of plan.groups) {
        const members = group.memberExternalIds
          .map((externalId) => byExternal.get(externalId)?.id)
          .filter((id): id is string => id !== undefined);
        const result = await this.scim.syncGroup(actor, group.displayName, members);
        if (result.ok) applied.groups += 1;
        else applied.failed += 1;
      }
    }

    return applied;
  }

  private async recordRun(input: {
    organizationId: string;
    connectionId: string;
    startedAt: string;
    status: DirectorySyncRunRecord["status"];
    counts: DirectoryPlan["counts"];
    detail: string | null;
  }): Promise<void> {
    await this.store.insertRun({
      id: this.ids.id(),
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      startedAt: input.startedAt,
      finishedAt: this.ids.now(),
      status: input.status,
      counts: input.counts,
      detail: input.detail,
    });
  }

  private async append(
    actor: IdentityActor,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "DirectoryConnection",
      targetId,
      detail: { ...detail, organizationId: actor.organizationId },
    });
  }
}

function emptyApplied(): SyncReport["applied"] {
  return { created: 0, updated: 0, deactivated: 0, reactivated: 0, groups: 0, failed: 0 };
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and the memory-mode server               */
/* -------------------------------------------------------------------------- */

/**
 * The same shape as the durable adapter, over maps.
 *
 * Records come back as deep copies, for the same reason the audit log's do: a caller that
 * mutated what it was handed would be editing a store it never wrote to — and a sync that
 * appeared to change a connection's policy without a write is exactly the kind of bug
 * this prevents.
 */
export class MemoryDirectoryStore implements DirectoryStore {
  private readonly connections = new Map<string, DirectoryConnectionRecord>();
  private readonly secrets = new Map<string, string>();
  private readonly runs: DirectorySyncRunRecord[] = [];

  async listConnections(organizationId: string): Promise<DirectoryConnectionRecord[]> {
    return [...this.connections.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => structuredClone(entry));
  }

  async findConnection(organizationId: string, connectionId: string): Promise<DirectoryConnectionRecord | null> {
    const found = this.connections.get(connectionId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async insertConnection(record: DirectoryConnectionRecord): Promise<void> {
    this.connections.set(record.id, structuredClone(record));
  }

  async updateConnection(record: DirectoryConnectionRecord): Promise<void> {
    this.connections.set(record.id, structuredClone(record));
  }

  async removeConnection(organizationId: string, connectionId: string): Promise<void> {
    const found = this.connections.get(connectionId);
    if (!found || found.organizationId !== organizationId) return;
    this.connections.delete(connectionId);
    this.secrets.delete(connectionId);
  }

  async insertRun(record: DirectorySyncRunRecord): Promise<void> {
    this.runs.push(structuredClone(record));
  }

  async listRuns(organizationId: string, connectionId?: string): Promise<DirectorySyncRunRecord[]> {
    return this.runs
      .filter((entry) => entry.organizationId === organizationId)
      .filter((entry) => (connectionId === undefined ? true : entry.connectionId === connectionId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((entry) => structuredClone(entry));
  }

  async findSecret(organizationId: string, connectionId: string): Promise<string | null> {
    const found = this.connections.get(connectionId);
    if (!found || found.organizationId !== organizationId) return null;
    return this.secrets.get(connectionId) ?? null;
  }

  async setSecret(organizationId: string, connectionId: string, secret: string | null): Promise<void> {
    const found = this.connections.get(connectionId);
    if (!found || found.organizationId !== organizationId) return;
    if (secret === null || secret === "") this.secrets.delete(connectionId);
    else this.secrets.set(connectionId, secret);
  }
}
