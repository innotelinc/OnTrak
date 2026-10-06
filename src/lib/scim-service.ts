/**
 * SCIM service: what a directory push *does* to this deployment.
 *
 * `scim-rules.ts` decides what a SCIM body means; this module decides what it
 * changes. It is the training app's counterpart to the CSV roster import
 * (`src/app/api/v1/roster/route.ts`), and it borrows that path's philosophy
 * wholesale: an account created here has **no local password**, a class name nobody
 * recognises is reported rather than invented, and a rename is a *move* rather than
 * a second account.
 *
 * Three differences from the CSV path, all of them consequences of the protocol:
 *
 *  - **A person is found by `externalId` first, then by address.** The directory's
 *    own id is stable across a rename; the address is not. Matching on the id first
 *    is what makes a name change update the account instead of orphaning its
 *    attempts and classes.
 *  - **`DELETE` deactivates.** Training evidence cannot be deleted, so removing a
 *    user from the directory switches them off here and ends nothing.
 *  - **PATCH is a list of attributes, not a row.** The same `active` attribute
 *    arrives as `{op:"replace", path:"active", value:false}` from Entra and as
 *    `{op:"replace", value:{active:false}}` from Okta.
 *
 * The store and the audit sink are injected, so this runs against a fake and shares
 * the same audit trail the rest of the product writes to.
 */

import type { Role } from "@prisma/client";

import {
  parseScimPatch,
  parseScimQuery,
  parseScimUserReplace,
  scimError,
  scimGroupName,
  scimPage,
  scimUserInput,
  toScimGroup,
  toScimUser,
  type ScimAttribute,
  type ScimError,
  type ScimGroupResource,
  type ScimListResponse,
  type ScimUserResource,
} from "./scim-rules";

export type ScimOutcome<T> = { ok: true; value: T } | { ok: false; error: ScimError };

function fail<T>(error: ScimError): ScimOutcome<T> {
  return { ok: false, error };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export interface ScimUserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScimCohortRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScimMemberRecord {
  userId: string;
  email: string;
}

/**
 * What the SCIM path reads and writes.
 *
 * A port rather than `PrismaClient`, so the service is exercised against a fake and
 * this file never grows a reason to reach for anything the directory should not
 * touch. `passwordHash` is deliberately absent from every signature: nothing on this
 * path may read or write a credential.
 */
export interface ScimStore {
  listUsers(): Promise<ScimUserRecord[]>;
  findUserById(id: string): Promise<ScimUserRecord | null>;
  findUserByEmail(email: string): Promise<ScimUserRecord | null>;
  findUserByExternalId(externalId: string): Promise<ScimUserRecord | null>;
  createUser(input: { email: string; name: string; role: Role; active: boolean; externalId: string | null }): Promise<ScimUserRecord>;
  updateUser(
    id: string,
    patch: { email?: string; name?: string; role?: Role; active?: boolean; externalId?: string | null },
  ): Promise<ScimUserRecord>;

  listCohorts(): Promise<ScimCohortRecord[]>;
  findCohortById(id: string): Promise<ScimCohortRecord | null>;
  cohortMembers(cohortId: string): Promise<ScimMemberRecord[]>;
  setCohortMembers(cohortId: string, userIds: string[]): Promise<ScimCohortRecord>;
}

/* -------------------------------------------------------------------------- */
/*  The audit trail                                                           */
/* -------------------------------------------------------------------------- */

export interface ScimAuditEvent {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

export type ScimAuditSink = (event: ScimAuditEvent) => Promise<void>;

/**
 * The audit entries the SCIM path appends.
 *
 * A directory push is an administrator action taken by a machine, so the events
 * name the account, the action and what changed — never a secret and never the
 * token that did it. `provision` and `deprovision` are separate words rather than one
 * `update`, because "who was switched off, and when" is the question an access review
 * asks and it cannot be answered by diffing two update rows by eye.
 */
export function scimUserAudit(
  action: "scim.user.provision" | "scim.user.update" | "scim.user.deprovision",
  user: ScimUserRecord,
  detail: Record<string, unknown> = {},
): ScimAuditEvent {
  return {
    actorId: null,
    action,
    targetType: "user",
    targetId: user.id,
    detail: { email: user.email, role: user.role, ...detail },
  };
}

export function scimGroupAudit(cohort: ScimCohortRecord, members: number): ScimAuditEvent {
  return {
    actorId: null,
    action: "scim.group.members",
    targetType: "cohort",
    targetId: cohort.id,
    detail: { name: cohort.name, members },
  };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class ScimService {
  constructor(
    private readonly store: ScimStore,
    private readonly baseUrl: string,
    private readonly audit: ScimAuditSink | null = null,
  ) {}

  /* ---------------------------------------------------------------- users */

  async listUsers(params: URLSearchParams): Promise<ScimOutcome<ScimListResponse<ScimUserResource>>> {
    const query = parseScimQuery(params);
    if (query.error) return fail(query.error);

    let users = await this.store.listUsers();
    const filter = query.filter;
    if (filter) {
      users = users.filter((user) => {
        switch (filter.attribute) {
          case "userName":
            // SCIM compares `userName` case-insensitively; a directory that sends
            // `Ada@Acme.Test` must find the account stored as `ada@acme.test`.
            return user.email.toLowerCase() === filter.value.toLowerCase();
          case "externalId":
            return user.externalId === filter.value;
          case "displayName":
            return user.name === filter.value;
          case "id":
            return user.id === filter.value;
          default:
            return false;
        }
      });
    }

    const page = scimPage(users, { startIndex: query.startIndex, count: query.count });
    return {
      ok: true,
      value: { ...page, Resources: page.Resources.map((user) => toScimUser(user, this.baseUrl)) },
    };
  }

  async getUser(id: string): Promise<ScimOutcome<ScimUserResource>> {
    const user = await this.store.findUserById(id);
    if (!user) return fail(scimError(404, "No such user.", "noTarget"));
    return { ok: true, value: toScimUser(user, this.baseUrl) };
  }

  async createUser(body: unknown): Promise<ScimOutcome<ScimUserResource>> {
    const input = scimUserInput(body);
    if ("status" in input) return fail(input);

    const existingEmail = await this.store.findUserByEmail(input.userName);
    if (existingEmail) {
      return fail(
        scimError(409, `An account already exists for ${input.userName}.`, "uniqueness"),
      );
    }
    if (input.externalId) {
      const existingExternal = await this.store.findUserByExternalId(input.externalId);
      if (existingExternal) {
        return fail(
          scimError(409, `The directory id ${input.externalId} already belongs to ${existingExternal.email}.`, "uniqueness"),
        );
      }
    }

    const user = await this.store.createUser({
      email: input.userName,
      name: input.displayName,
      role: input.role,
      active: input.active,
      externalId: input.externalId,
    });
    await this.record(scimUserAudit("scim.user.provision", user, { provisioned: true }));
    return { ok: true, value: toScimUser(user, this.baseUrl) };
  }

  async replaceUser(id: string, body: unknown): Promise<ScimOutcome<ScimUserResource>> {
    const input = parseScimUserReplace(body);
    if ("status" in input) return fail(input);
    return this.applyUser(id, [
      { name: "userName", value: input.userName },
      { name: "displayName", value: input.displayName },
      { name: "externalId", value: input.externalId },
      { name: "active", value: input.active },
      { name: "role", value: input.role },
    ]);
  }

  async patchUser(id: string, body: unknown): Promise<ScimOutcome<ScimUserResource>> {
    const parsed = parseScimPatch(body);
    if ("status" in parsed) return fail(parsed);
    return this.applyUser(id, parsed.changes);
  }

  /**
   * The one place a user write happens, shared by PATCH and PUT.
   *
   * Writing through one function is what keeps the two verbs from disagreeing about
   * collisions: an address or directory id that already belongs to somebody else is
   * refused identically either way, with a `uniqueness` a sync engine can surface
   * rather than a generic 400 it retries forever.
   */
  private async applyUser(id: string, changes: ScimAttribute[]): Promise<ScimOutcome<ScimUserResource>> {
    const current = await this.store.findUserById(id);
    if (!current) return fail(scimError(404, "No such user.", "noTarget"));

    const patch: { email?: string; name?: string; role?: Role; active?: boolean; externalId?: string | null } = {};
    for (const change of changes) {
      switch (change.name) {
        case "userName": {
          const email = String(change.value).toLowerCase();
          if (email !== current.email) {
            const owner = await this.store.findUserByEmail(email);
            if (owner && owner.id !== id) {
              return fail(scimError(409, `An account already exists for ${email}.`, "uniqueness"));
            }
            patch.email = email;
          }
          break;
        }
        case "displayName":
          patch.name = String(change.value);
          break;
        case "externalId": {
          const externalId = change.value === null ? null : String(change.value);
          if (externalId && externalId !== current.externalId) {
            const owner = await this.store.findUserByExternalId(externalId);
            if (owner && owner.id !== id) {
              return fail(
                scimError(409, `The directory id ${externalId} already belongs to ${owner.email}.`, "uniqueness"),
              );
            }
          }
          patch.externalId = externalId;
          break;
        }
        case "active":
          patch.active = change.value === true;
          break;
        case "role":
          patch.role = change.value === null ? "STUDENT" : (change.value as Role);
          break;
        default:
          return fail(scimError(400, `“${change.name}” is not an attribute a user has.`, "invalidPath"));
      }
    }

    // A switch-off is its own audit event, before it takes effect, so a deprovision
    // is written down even if the write itself fails.
    if (patch.active === false && current.active) {
      await this.record(scimUserAudit("scim.user.deprovision", current, { deactivated: true }));
    }

    const updated = await this.store.updateUser(id, patch);
    if (patch.active !== false) {
      await this.record(scimUserAudit("scim.user.update", updated, { changed: Object.keys(patch) }));
    }
    return { ok: true, value: toScimUser(updated, this.baseUrl) };
  }

  /** Deleting a SCIM user deactivates it: the training evidence cannot be deleted. */
  async deleteUser(id: string): Promise<ScimOutcome<{ deactivated: true }>> {
    const current = await this.store.findUserById(id);
    if (!current) return fail(scimError(404, "No such user.", "noTarget"));
    if (current.active) {
      await this.store.updateUser(id, { active: false });
      await this.record(scimUserAudit("scim.user.deprovision", current, { deactivated: true }));
    }
    return { ok: true, value: { deactivated: true } };
  }

  /* --------------------------------------------------------------- groups */

  async listGroups(params: URLSearchParams): Promise<ScimOutcome<ScimListResponse<ScimGroupResource>>> {
    const query = parseScimQuery(params);
    if (query.error) return fail(query.error);

    let cohorts = await this.store.listCohorts();
    const filter = query.filter;
    if (filter) {
      cohorts = cohorts.filter((cohort) => {
        if (filter.attribute === "displayName") return cohort.name.toLowerCase() === filter.value.toLowerCase();
        if (filter.attribute === "id") return cohort.id === filter.value;
        return false;
      });
    }

    const page = scimPage(cohorts, { startIndex: query.startIndex, count: query.count });
    const resources: ScimGroupResource[] = [];
    for (const cohort of page.Resources) {
      resources.push(toScimGroup(cohort, await this.store.cohortMembers(cohort.id), this.baseUrl));
    }
    return { ok: true, value: { ...page, Resources: resources } };
  }

  async getGroup(id: string): Promise<ScimOutcome<ScimGroupResource>> {
    const cohort = await this.store.findCohortById(id);
    if (!cohort) return fail(scimError(404, "No such group.", "noTarget"));
    return { ok: true, value: toScimGroup(cohort, await this.store.cohortMembers(id), this.baseUrl) };
  }

  /**
   * A class cannot be invented by a group push.
   *
   * A cohort here is owned by an instructor and carries a join code a person chose,
   * so `POST /Groups` is refused with a reason rather than obeyed — the same rule the
   * CSV roster applies to a cohort name it does not recognise. The refusal is an
   * `invalidValue` a connector surfaces, not a 500 it retries.
   */
  async createGroup(body: unknown): Promise<ScimOutcome<ScimGroupResource>> {
    const name = scimGroupName(body);
    // A refused body comes back as the error itself; a name comes back as a string.
    if (typeof name !== "string") return fail(name);
    return fail(
      scimError(
        400,
        `“${name}” was not created: a class here is owned by an instructor and made in the console. This surface syncs a class's members, not its existence.`,
        "mutability",
      ),
    );
  }

  /**
   * A group PATCH replaces the class's membership with the list it names.
   *
   * Replacement rather than merge, because that is what a directory's Push Groups
   * sends: the complete list of who is in the group. A name change is refused — the
   * class's name and join code are the instructor's, and a rename over SCIM would
   * silently invalidate every code a learner was handed.
   */
  async patchGroup(id: string, body: unknown): Promise<ScimOutcome<ScimGroupResource>> {
    const cohort = await this.store.findCohortById(id);
    if (!cohort) return fail(scimError(404, "No such group.", "noTarget"));

    const parsed = parseScimPatch(body);
    if ("status" in parsed) return fail(parsed);

    for (const change of parsed.changes) {
      if (change.name === "displayName") {
        return fail(
          scimError(400, "A class's name is its instructor's; rename it in the console.", "mutability"),
        );
      }
      if (change.name !== "members") {
        return fail(scimError(400, `“${change.name}” is not an attribute a group has.`, "invalidPath"));
      }

      const userIds = change.value as string[];
      const unique = [...new Set(userIds)];
      for (const userId of unique) {
        if (!(await this.store.findUserById(userId))) {
          return fail(scimError(400, `No such user: ${userId}.`, "invalidValue"));
        }
      }
      const updated = await this.store.setCohortMembers(id, unique);
      await this.record(scimGroupAudit(updated, unique.length));
    }

    return { ok: true, value: toScimGroup(cohort, await this.store.cohortMembers(id), this.baseUrl) };
  }

  /** Deleting a class is deleting training history; the console owns that decision. */
  async deleteGroup(id: string): Promise<ScimOutcome<{ deleted: true }>> {
    const cohort = await this.store.findCohortById(id);
    if (!cohort) return fail(scimError(404, "No such group.", "noTarget"));
    return fail(
      scimError(
        400,
        `“${cohort.name}” was not deleted: a class holds its members' attempts, so it is removed in the console.`,
        "mutability",
      ),
    );
  }

  private async record(event: ScimAuditEvent): Promise<void> {
    if (this.audit) await this.audit(event);
  }
}

/* -------------------------------------------------------------------------- */
/*  A store for tests                                                         */
/* -------------------------------------------------------------------------- */

interface MemoryUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryCohort {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An in-memory store, so every decision above is testable without Postgres.
 *
 * `ids` and `now` are injectable so a test can make a run deterministic; the defaults
 * are what a real request would see.
 */
export class MemoryScimStore implements ScimStore {
  private readonly users: MemoryUser[] = [];
  private readonly cohorts: MemoryCohort[] = [];
  private readonly members = new Map<string, Set<string>>();
  private counter = 0;

  constructor(
    seed: { users?: Partial<MemoryUser>[]; cohorts?: Partial<MemoryCohort>[] } = {},
    private readonly ids: () => string = () => `id-${++this.counter}`,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    for (const user of seed.users ?? []) {
      this.users.push({
        id: user.id ?? this.ids(),
        email: user.email ?? `user-${this.users.length}@acme.test`,
        name: user.name ?? "User",
        role: user.role ?? "STUDENT",
        active: user.active ?? true,
        externalId: user.externalId ?? null,
        createdAt: user.createdAt ?? this.now(),
        updatedAt: user.updatedAt ?? this.now(),
      });
    }
    for (const cohort of seed.cohorts ?? []) {
      this.cohorts.push({
        id: cohort.id ?? this.ids(),
        name: cohort.name ?? "Class",
        createdAt: cohort.createdAt ?? this.now(),
        updatedAt: cohort.updatedAt ?? this.now(),
      });
    }
  }

  private toRecord(user: MemoryUser): ScimUserRecord {
    return { ...user };
  }

  async listUsers(): Promise<ScimUserRecord[]> {
    return this.users.map((user) => this.toRecord(user));
  }

  async findUserById(id: string): Promise<ScimUserRecord | null> {
    const user = this.users.find((entry) => entry.id === id);
    return user ? this.toRecord(user) : null;
  }

  async findUserByEmail(email: string): Promise<ScimUserRecord | null> {
    const user = this.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
    return user ? this.toRecord(user) : null;
  }

  async findUserByExternalId(externalId: string): Promise<ScimUserRecord | null> {
    const user = this.users.find((entry) => entry.externalId === externalId);
    return user ? this.toRecord(user) : null;
  }

  async createUser(input: {
    email: string;
    name: string;
    role: Role;
    active: boolean;
    externalId: string | null;
  }): Promise<ScimUserRecord> {
    const user: MemoryUser = {
      id: this.ids(),
      email: input.email,
      name: input.name,
      role: input.role,
      active: input.active,
      externalId: input.externalId,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.users.push(user);
    return this.toRecord(user);
  }

  async updateUser(
    id: string,
    patch: { email?: string; name?: string; role?: Role; active?: boolean; externalId?: string | null },
  ): Promise<ScimUserRecord> {
    const user = this.users.find((entry) => entry.id === id);
    if (!user) throw new Error(`no such user: ${id}`);
    if (patch.email !== undefined) user.email = patch.email;
    if (patch.name !== undefined) user.name = patch.name;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.active !== undefined) user.active = patch.active;
    if (patch.externalId !== undefined) user.externalId = patch.externalId;
    user.updatedAt = this.now();
    return this.toRecord(user);
  }

  async listCohorts(): Promise<ScimCohortRecord[]> {
    return this.cohorts.map((cohort) => ({ ...cohort }));
  }

  async findCohortById(id: string): Promise<ScimCohortRecord | null> {
    const cohort = this.cohorts.find((entry) => entry.id === id);
    return cohort ? { ...cohort } : null;
  }

  async cohortMembers(cohortId: string): Promise<ScimMemberRecord[]> {
    const ids = this.members.get(cohortId) ?? new Set<string>();
    return [...ids]
      .map((id) => this.users.find((user) => user.id === id))
      .filter((user): user is MemoryUser => user !== undefined)
      .map((user) => ({ userId: user.id, email: user.email }));
  }

  async setCohortMembers(cohortId: string, userIds: string[]): Promise<ScimCohortRecord> {
    const cohort = this.cohorts.find((entry) => entry.id === cohortId);
    if (!cohort) throw new Error(`no such cohort: ${cohortId}`);
    this.members.set(cohortId, new Set(userIds));
    cohort.updatedAt = this.now();
    return { ...cohort };
  }
}
