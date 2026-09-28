/**
 * SLA policy authoring (M4).
 *
 * Until now a promise could only be seeded. Once one desk serves many clients,
 * the promise is the thing that differs per client, so the desk has to be able
 * to write it — and writing it is the moment a breach claim becomes arguable,
 * which is why every write here is validated, tenant-scoped and audited.
 *
 * Three decisions worth stating out loud:
 *
 *  - **A policy is edited, not deleted.** Tickets name the policy they were
 *    measured against, so removing one would leave clocks nobody can explain.
 *    A policy no ticket references may go; one that is referenced must be
 *    edited instead, and the refusal says how many tickets are holding it.
 *  - **The calendar is a choice, not a form.** Two presets cover what a desk
 *    actually runs on — weekdays 09:00–17:00 and around the clock — so no one
 *    can author a calendar that is open at no time at all.
 *  - **The numbers are minutes of the calendar.** A 4-hour promise on a 9–5
 *    calendar is not four wall-clock hours, and the form says so.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import type { ClientService } from "./client-service";
import {
  ALWAYS_OPEN_CALENDAR,
  validateSlaPolicy,
  weekdayCalendar,
  type BusinessCalendar,
  type SlaPolicy,
} from "./sla-rules";
import { TICKET_PRIORITIES, type TicketPriority } from "./ticket-rules";
import type { ServiceResult } from "./ticket-service";

/** A stored policy, with the tenant it belongs to. */
export interface SlaPolicyRecord extends SlaPolicy {
  tenantId: string;
}

/** Which hours a promise is measured in. */
export type SlaHours = "business" | "always";

/** The preset bounds, for the form's own wording. */
export const SLA_HOURS: readonly { key: SlaHours; label: string }[] = [
  { key: "business", label: "Weekdays 09:00–17:00" },
  { key: "always", label: "Around the clock (24×7)" },
];

export function calendarFor(hours: SlaHours, utcOffsetMinutes = 0): BusinessCalendar {
  return hours === "always" ? ALWAYS_OPEN_CALENDAR : weekdayCalendar("Weekdays 09:00–17:00", utcOffsetMinutes);
}

export interface SlaPolicyStore {
  listForTenant(tenantId: string): Promise<SlaPolicyRecord[]>;
  findById(tenantId: string, policyId: string): Promise<SlaPolicyRecord | null>;
  findByName(tenantId: string, name: string): Promise<SlaPolicyRecord | null>;
  insert(record: SlaPolicyRecord): Promise<void>;
  update(record: SlaPolicyRecord): Promise<void>;
  remove(tenantId: string, policyId: string): Promise<void>;
  /** How many tickets are measured against this policy. */
  countTickets(tenantId: string, policyId: string): Promise<number>;
}

/** Enough of the desk's queues to check that a promise names a real one. */
export interface QueueLookup {
  listQueues(tenantId: string): Promise<{ id: string; name: string }[]>;
}

/** Injected so plans are deterministic under test. */
export interface SlaPolicyIds {
  id(): string;
  now(): string;
}

export function systemSlaPolicyIds(): SlaPolicyIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What an author supplies. Minutes arrive as numbers, or as raw form text. */
export interface SlaPolicyInput {
  name: string;
  priority?: TicketPriority | null;
  responseMinutes: number | string;
  resolutionMinutes: number | string;
  /** `undefined` on an edit means "leave the scope as it is". */
  clientId?: string | null;
  queueId?: string | null;
  hours?: SlaHours;
  warningFraction?: number | string;
}

/** How a stored policy reads back to the console, in one line. */
export function describeScope(policy: Pick<SlaPolicy, "clientId" | "queueId" | "priority">): string {
  const owner = policy.clientId ? "this client" : policy.queueId ? "its queue" : "the desk";
  return policy.priority ? `${owner}, ${policy.priority} only` : `${owner}, any priority`;
}

/**
 * Read a form field as a number of minutes. A blank is *not* a zero: it becomes
 * NaN, which `validateSlaPolicy` reports as "zero or more minutes" rather than
 * storing a promise nobody can meet.
 */
function minutes(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (value === undefined) return Number.NaN;
  const trimmed = value.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

function fraction(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** A policy name is how a breach is argued about, so it has to be a name. */
const POLICY_NAME_MAX = 120;

export class SlaPolicyService {
  constructor(
    private readonly store: SlaPolicyStore,
    private readonly audit: AuditSink | null = null,
    /** Used to check that the client a promise names is one of this desk's. */
    private readonly clients: ClientService | null = null,
    private readonly ids: SlaPolicyIds = systemSlaPolicyIds(),
    /** Used to check that the queue a promise names is one of this desk's. */
    private readonly directory: QueueLookup | null = null,
  ) {}

  /** The desk's queues, so the console can offer them as a promise's scope. */
  async deskQueues(actor: Actor): Promise<ServiceResult<{ id: string; name: string }[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's queues." };
    }
    if (!this.directory) return { ok: true, value: [] };
    return { ok: true, value: await this.directory.listQueues(actor.tenantId) };
  }

  /** Every policy in the tenant, so a page can render the ladder. */
  async list(actor: Actor): Promise<ServiceResult<SlaPolicyRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's promises." };
    }
    return { ok: true, value: await this.store.listForTenant(actor.tenantId) };
  }

  /** The promises written for one client. */
  async forClient(actor: Actor, clientId: string): Promise<ServiceResult<SlaPolicyRecord[]>> {
    const all = await this.list(actor);
    if (!all.ok) return all;
    return { ok: true, value: all.value.filter((policy) => policy.clientId === clientId) };
  }

  /** Write a new promise. */
  async create(actor: Actor, input: SlaPolicyInput): Promise<ServiceResult<SlaPolicyRecord>> {
    const denied = this.authorable(actor);
    if (denied) return denied;

    const drafted = this.draft(actor.tenantId, input);
    if (!drafted.ok) return drafted;

    const unknown = await this.clientExists(actor, drafted.value.clientId);
    if (unknown) return unknown;

    const badQueue = await this.queueExists(actor, drafted.value.queueId);
    if (badQueue) return badQueue;

    const clash = await this.store.findByName(actor.tenantId, drafted.value.name);
    if (clash) return { ok: false, error: `The desk already has a promise called “${drafted.value.name}”.` };

    await this.store.insert(drafted.value);
    await this.append(actor, "sla.policy.create", drafted.value.id, drafted.value);
    return { ok: true, value: drafted.value };
  }

  /** Change a promise. A policy that is already in force keeps its id. */
  async update(actor: Actor, policyId: string, input: SlaPolicyInput): Promise<ServiceResult<SlaPolicyRecord>> {
    const denied = this.authorable(actor);
    if (denied) return denied;

    const existing = await this.store.findById(actor.tenantId, policyId);
    if (!existing) return { ok: false, error: "That promise is not on this desk." };

    const drafted = this.draft(actor.tenantId, input, existing);
    if (!drafted.ok) return drafted;

    const unknown = await this.clientExists(actor, drafted.value.clientId);
    if (unknown) return unknown;

    const badQueue = await this.queueExists(actor, drafted.value.queueId);
    if (badQueue) return badQueue;

    const clash = await this.store.findByName(actor.tenantId, drafted.value.name);
    if (clash && clash.id !== policyId) {
      return { ok: false, error: `The desk already has a promise called “${drafted.value.name}”.` };
    }

    await this.store.update(drafted.value);
    await this.append(actor, "sla.policy.update", drafted.value.id, drafted.value);
    return { ok: true, value: drafted.value };
  }

  /**
   * Remove a promise. Refused while tickets are measured against it: their
   * clocks are the record of what the desk promised, and a deleted policy turns
   * a defensible breach (or a defensible miss) into an argument.
   */
  async remove(actor: Actor, policyId: string): Promise<ServiceResult<{ id: string; name: string }>> {
    const denied = this.authorable(actor);
    if (denied) return denied;

    const existing = await this.store.findById(actor.tenantId, policyId);
    if (!existing) return { ok: false, error: "That promise is not on this desk." };

    const attached = await this.store.countTickets(actor.tenantId, policyId);
    if (attached > 0) {
      return {
        ok: false,
        error: `${attached} ticket${attached === 1 ? " is" : "s are"} measured against “${existing.name}”. Edit it instead, so their clocks stay explainable.`,
      };
    }

    await this.store.remove(actor.tenantId, policyId);
    await this.append(actor, "sla.policy.delete", existing.id, existing);
    return { ok: true, value: { id: existing.id, name: existing.name } };
  }

  /* ------------------------------------------------------------ internals */

  /** Assemble and validate a policy. Pure apart from the ids it is given. */
  private draft(
    tenantId: string,
    input: SlaPolicyInput,
    existing?: SlaPolicyRecord,
  ): ServiceResult<SlaPolicyRecord> {
    const name = (input.name ?? "").trim();
    if (name.length > POLICY_NAME_MAX) {
      return { ok: false, error: `A promise's name may be at most ${POLICY_NAME_MAX} characters.` };
    }

    const priority = input.priority ?? null;
    if (priority !== null && !TICKET_PRIORITIES.includes(priority)) {
      return { ok: false, error: "That is not a priority this desk uses." };
    }

    const responseMinutes = minutes(input.responseMinutes);
    const resolutionMinutes = minutes(input.resolutionMinutes);
    if (Number.isFinite(responseMinutes) && responseMinutes <= 0) {
      return { ok: false, error: "A promise of zero minutes is not a promise. Give it a first-response target." };
    }
    if (Number.isFinite(resolutionMinutes) && resolutionMinutes <= 0) {
      return { ok: false, error: "A promise of zero minutes is not a promise. Give it a resolution target." };
    }

    // A promise belongs to one owner. Naming both a client and a queue would put
    // it on two rungs of the ladder at once, and `resolveSlaPolicy` would have to
    // guess which one won — so the pair is refused rather than resolved.
    const scope = {
      queueId: input.queueId === undefined ? (existing?.queueId ?? null) : (input.queueId?.trim() ? input.queueId.trim() : null),
      clientId: input.clientId === undefined ? (existing?.clientId ?? null) : (input.clientId?.trim() ? input.clientId.trim() : null),
    };
    if (scope.queueId && scope.clientId) {
      return { ok: false, error: "A promise belongs to a client or a queue, not both. Pick one scope." };
    }

    const candidate: SlaPolicyRecord = {
      id: existing?.id ?? this.ids.id(),
      tenantId,
      name,
      priority: priority ?? undefined,
      responseMinutes,
      resolutionMinutes,
      calendar: calendarFor(input.hours ?? "business"),
      warningFraction: fraction(input.warningFraction) ?? existing?.warningFraction ?? 0.2,
      // An edit that does not mention the scope keeps it. Otherwise a form that
      // only carries the numbers would quietly turn a client's promise into the
      // desk's, or a queue's into everybody's.
      queueId: scope.queueId,
      clientId: scope.clientId,
    };

    const issues = validateSlaPolicy(candidate);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
    return { ok: true, value: candidate };
  }

  /**
   * A promise written for a client that does not exist would price nothing and
   * be shown nowhere, so it is refused rather than stored as a row nobody can
   * explain. The id arrives in a form, and a form is a suggestion.
   */
  private async clientExists(
    actor: Actor,
    clientId: string | null | undefined,
  ): Promise<{ ok: false; error: string } | null> {
    if (!clientId || !this.clients) return null;
    const known = await this.clients.list(actor);
    if (!known.ok) return { ok: false, error: known.error };
    if (!known.value.some((entry) => entry.client.id === clientId)) {
      return { ok: false, error: "Client not found." };
    }
    return null;
  }

  /**
   * A promise written for a queue that does not exist would sit on the ladder
   * and never win, which is worse than being refused: it looks like cover that
   * is not there. The id arrives in a form, and a form is a suggestion.
   */
  private async queueExists(
    actor: Actor,
    queueId: string | null | undefined,
  ): Promise<{ ok: false; error: string } | null> {
    if (!queueId || !this.directory) return null;
    const known = await this.directory.listQueues(actor.tenantId);
    if (!known.some((queue) => queue.id === queueId)) {
      return { ok: false, error: "Queue not found." };
    }
    return null;
  }

  private authorable(actor: Actor): { ok: false; error: string } | null {
    if (!hasPermission(actor.role, "queue:manage")) return { ok: false, error: "You do not manage the desk's promises." };
    return null;
  }

  private async append(actor: Actor, action: string, targetId: string, policy: SlaPolicyRecord): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "sla-policy",
      targetId,
      detail: {
        name: policy.name,
        clientId: policy.clientId ?? null,
        queueId: policy.queueId ?? null,
        priority: policy.priority ?? null,
        responseMinutes: policy.responseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        hours: policy.calendar.name,
      },
    };
    await this.audit.append(event);
  }
}

/** An in-memory store, used by tests and local development. */
export class MemorySlaPolicyStore implements SlaPolicyStore {
  private readonly policies = new Map<string, SlaPolicyRecord>();
  private readonly attached = new Map<string, number>();

  /** Seed a ticket count against a policy, standing in for the tickets table. */
  attach(policyId: string, count: number): void {
    this.attached.set(policyId, count);
  }

  async listForTenant(tenantId: string): Promise<SlaPolicyRecord[]> {
    return [...this.policies.values()]
      .filter((policy) => policy.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((policy) => structuredClone(policy));
  }

  async findById(tenantId: string, policyId: string): Promise<SlaPolicyRecord | null> {
    const found = this.policies.get(policyId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findByName(tenantId: string, name: string): Promise<SlaPolicyRecord | null> {
    const found = [...this.policies.values()].find(
      (policy) => policy.tenantId === tenantId && policy.name.toLowerCase() === name.toLowerCase(),
    );
    return found ? structuredClone(found) : null;
  }

  async insert(record: SlaPolicyRecord): Promise<void> {
    this.policies.set(record.id, structuredClone(record));
  }

  async update(record: SlaPolicyRecord): Promise<void> {
    this.policies.set(record.id, structuredClone(record));
  }

  async remove(tenantId: string, policyId: string): Promise<void> {
    const found = this.policies.get(policyId);
    if (found && found.tenantId === tenantId) this.policies.delete(policyId);
  }

  async countTickets(_tenantId: string, policyId: string): Promise<number> {
    return this.attached.get(policyId) ?? 0;
  }
}
