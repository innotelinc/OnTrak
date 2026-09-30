/**
 * Granular roles service (M6): who may write a role, and what it takes to write one.
 *
 * The rules module owns every judgement; this owns the order they are asked in and the one
 * question that needs the whole picture — *would this leave the desk with nobody who can
 * administer it?* — which is why it is asked here, against the store, rather than inside a
 * validation function that only ever sees the role.
 *
 * Three decisions are worth reading.
 *
 * **Managing roles is `user:manage`, and reading them is `user:manage` too.** A role catalogue
 * is a map of the desk's own privileges, so it is not something a reply-only agent needs to
 * see; unlike the ticket surfaces there is no cheaper scope that answers the question.
 *
 * **The guard runs before the write, and only refuses a change that would remove the last way
 * back in.** A desk that has never written a role always keeps its administrators, and a desk
 * whose last administrator is being narrowed is told why rather than allowed to do it. That is
 * the difference between a permission system and a way to lock yourself out of one.
 *
 * **An assignment is an audit event about a person, and a save is an audit event about a
 * role.** Both land on the tenant's chain, so "who gave them that, and when" and "what did that
 * role mean in March" are both answerable after the fact — which is the only reason to have
 * roles rather than a boolean.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, permissionsFor, type Actor, type Permission, type Role } from "./access-rules";
import type { AuditSink } from "./audit-chain";
import {
  ADMINISTRATION_PERMISSION,
  PERMISSION_CATALOGUE,
  administrationHeld,
  effectivePermissions,
  effectivePermissionSet,
  normalizeRoleKey,
  roleAudit,
  roleSummary,
  validateTenantRole,
  withAssignment,
  withRole,
  type RoleMember,
  type TenantRole,
  type TenantRoleInput,
} from "./role-rules";

/** The rows this service needs. Nothing here decides anything. */
export interface RoleStore {
  list(tenantId: string): Promise<TenantRole[]>;
  find(tenantId: string, roleId: string): Promise<TenantRole | null>;
  insert(role: TenantRole): Promise<void>;
  update(role: TenantRole): Promise<void>;
  /** Everybody on the desk, with the role they have been handed. */
  members(tenantId: string): Promise<RoleMember[]>;
  /** The role one person has been handed, for resolving what they may actually do. */
  assignedRole(tenantId: string, userId: string): Promise<TenantRole | null>;
  assign(tenantId: string, userId: string, roleId: string | null): Promise<void>;
}

export type RoleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RoleIds {
  id(): string;
  now(): string;
}

export function systemRoleIds(): RoleIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What the role screen renders, in one call. */
export interface RoleOverview {
  roles: (TenantRole & { summary: string; holders: number })[];
  members: (RoleMember & { roleName: string | null })[];
  /** The closed permission set, each with the words the screen shows. */
  catalogue: readonly { permission: Permission; label: string; hint: string; inBaseRole?: Record<Role, boolean> }[];
  /** Whether anybody currently administers the desk — the guard's own answer, shown, not hidden. */
  administered: boolean;
}

export class RoleService {
  constructor(
    private readonly store: RoleStore,
    private readonly ids: RoleIds = systemRoleIds(),
    private readonly audit: AuditSink | null = null,
  ) {}

  /**
   * Whether an actor may manage roles at all.
   *
   * Written as a named function rather than repeated at each entry point, because a rule that
   * is copied is a rule that will be applied to one of the four methods and not the others.
   */
  private mayManage(actor: Actor): boolean {
    return actorHasPermission(actor, "user:manage");
  }

  /** Every role with its holders, every member with their role, and the permission catalogue. */
  async overview(actor: Actor): Promise<RoleResult<RoleOverview>> {
    if (!this.mayManage(actor)) return { ok: false, error: "You cannot manage roles." };

    const [roles, members] = await Promise.all([this.store.list(actor.tenantId), this.store.members(actor.tenantId)]);
    const byId = new Map(roles.map((role) => [role.id, role]));

    return {
      ok: true,
      value: {
        roles: roles
          .map((role) => ({
            ...role,
            summary: roleSummary(role),
            holders: members.filter((member) => member.tenantRoleId === role.id).length,
          }))
          .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.name.localeCompare(b.name)),
        members: members
          .map((member) => ({
            ...member,
            roleName: member.tenantRoleId ? (byId.get(member.tenantRoleId)?.name ?? null) : null,
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        catalogue: PERMISSION_CATALOGUE.map((entry) => ({
          ...entry,
          inBaseRole: Object.fromEntries(
            (["ADMIN", "DISPATCHER", "AGENT", "REQUESTER"] as Role[]).map((role) => [
              role,
              permissionsFor(role).includes(entry.permission),
            ]),
          ) as Record<Role, boolean>,
        })),
        administered: administrationHeld(members, roles),
      },
    };
  }

  /**
   * Create or update a role.
   *
   * A key is fixed once it is written: an audit entry names the role by key, and a role whose
   * key changed would leave every past entry pointing at something that no longer answers.
   * Renaming and re-permissioning are ordinary edits.
   */
  async save(actor: Actor, input: TenantRoleInput, roleId?: string | null): Promise<RoleResult<TenantRole>> {
    if (!this.mayManage(actor)) return { ok: false, error: "You cannot manage roles." };

    const roles = await this.store.list(actor.tenantId);
    const existing = roleId ? roles.find((role) => role.id === roleId) : null;
    if (roleId && !existing) return { ok: false, error: "That role does not exist." };

    const key = existing
      ? existing.key
      : normalizeRoleKey(String(input.key ?? input.name ?? ""));
    const problems = validateTenantRole(
      { ...input, key },
      roles.filter((role) => role.id !== roleId).map((role) => role.key),
    );
    if (problems.length > 0) return { ok: false, error: problems[0] };

    if (!existing && roles.filter((role) => !role.archivedAt).length >= 50) {
      return { ok: false, error: "This desk already has fifty active roles — archive one first." };
    }

    // A key that already exists and is archived is a resurrection of the same name, which is
    // refused rather than silently reusing an identity the audit trail has already described.
    const at = this.ids.now();
    const role: TenantRole = {
      id: existing?.id ?? this.ids.id(),
      tenantId: actor.tenantId,
      key,
      name: String(input.name ?? "").trim(),
      description: String(input.description ?? "").trim() || null,
      baseRole: input.baseRole,
      // Stored already narrowed, so the row cannot disagree with the rule that reads it.
      permissions: effectivePermissions(input.baseRole, input.permissions ?? []),
      archivedAt: null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };

    const members = await this.store.members(actor.tenantId);
    const nextRoles = withRole(roles, role.id, role);
    if (existing && administrationHeld(members, roles) && !administrationHeld(members, nextRoles)) {
      return {
        ok: false,
        error:
          "That would leave nobody able to administer this desk. Give somebody else the administration permission first.",
      };
    }

    if (existing) await this.store.update(role);
    else await this.store.insert(role);

    if (this.audit) {
      await this.audit.append(
        roleAudit(existing ? "role.update" : "role.create", {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: role.key,
          detail: {
            name: role.name,
            baseRole: role.baseRole,
            permissions: [...role.permissions],
            previous: existing ? [...existing.permissions] : null,
          },
          at,
        }),
      );
    }

    return { ok: true, value: role };
  }

  /**
   * Archive a role.
   *
   * Not a delete: the row stays, its holders fall back to their built-in role, and every audit
   * entry that named it still resolves.
   *
   * There is deliberately **no guard here**, and the reason is worth stating because the missing
   * guard looks like an oversight. A role can only ever narrow, so archiving one can only give
   * power *back* — a holder returns to their built-in role, which is a superset of whatever the
   * role left them. An archival therefore cannot take the last administrator away, and a check
   * that cannot fail is a check that hides the rule it is pretending to enforce.
   */
  async archive(actor: Actor, roleId: string): Promise<RoleResult<TenantRole>> {
    if (!this.mayManage(actor)) return { ok: false, error: "You cannot manage roles." };

    const roles = await this.store.list(actor.tenantId);
    const role = roles.find((candidate) => candidate.id === roleId);
    if (!role) return { ok: false, error: "That role does not exist." };
    if (role.archivedAt) return { ok: true, value: role };

    const at = this.ids.now();
    // How many people this actually moves, which is the number the entry is worth reading for.
    const members = await this.store.members(actor.tenantId);
    const archived: TenantRole = { ...role, archivedAt: at, updatedAt: at };
    await this.store.update(archived);

    if (this.audit) {
      await this.audit.append(
        roleAudit("role.archive", {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: role.key,
          detail: { name: role.name, holders: members.filter((m) => m.tenantRoleId === role.id).length },
          at,
        }),
      );
    }

    return { ok: true, value: archived };
  }

  /**
   * Hand a role to somebody, or take it away (`roleId === null`).
   *
   * The same guard applies, because assigning a narrow role to the last administrator is the
   * other way to strand a desk.
   */
  async assign(actor: Actor, userId: string, roleId: string | null): Promise<RoleResult<{ userId: string }>> {
    if (!this.mayManage(actor)) return { ok: false, error: "You cannot manage roles." };

    const members = await this.store.members(actor.tenantId);
    const member = members.find((candidate) => candidate.id === userId);
    if (!member) return { ok: false, error: "That person is not on this desk." };

    const roles = await this.store.list(actor.tenantId);
    const role = roleId ? roles.find((candidate) => candidate.id === roleId) : null;
    if (roleId && !role) return { ok: false, error: "That role does not exist." };
    if (role?.archivedAt) return { ok: false, error: "That role has been archived." };

    const nextMembers = withAssignment(members, userId, role?.id ?? null);
    if (administrationHeld(members, roles) && !administrationHeld(nextMembers, roles)) {
      return {
        ok: false,
        error:
          "That would leave nobody able to administer this desk. Give somebody else the administration permission first.",
      };
    }

    const at = this.ids.now();
    await this.store.assign(actor.tenantId, userId, role?.id ?? null);

    if (this.audit) {
      await this.audit.append(
        roleAudit(role ? "role.assign" : "role.unassign", {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetType: "user",
          targetId: member.email,
          detail: {
            userId: member.id,
            roleKey: role?.key ?? null,
            roleName: role?.name ?? null,
            baseRole: member.role,
          },
          at,
        }),
      );
    }

    return { ok: true, value: { userId } };
  }

  /** The role one person has been handed, for resolving what they may actually do. */
  async assignedRole(tenantId: string, userId: string): Promise<TenantRole | null> {
    return this.store.assignedRole(tenantId, userId);
  }
}

/**
 * The actor, with the permissions their tenant role leaves them.
 *
 * Called where an actor is built for a request rather than where one is stored, because the
 * narrowing must not be carried in the session cookie: an administrator who takes a permission
 * away expects it to be gone for the person who holds the cookie, not to survive until it
 * expires — and a token cannot be re-issued when a role changes.
 *
 * A desk that has written no roles adds one query and changes nothing else: `effectivePermissionSet`
 * returns the built-in role's own set, which is what `actor.permissions` being absent would have
 * meant anyway. **The store is optional** so that a caller which has not wired one (a page under
 * test, a route that only needs identity) keeps the old behaviour rather than failing shut.
 */
export async function withEffectivePermissions(
  store: Pick<RoleStore, "assignedRole"> | null,
  actor: Actor,
): Promise<Actor> {
  if (!store) return actor;
  const assigned = await store.assignedRole(actor.tenantId, actor.id);
  const permissions = effectivePermissionSet(actor.role, assigned);
  return { ...actor, permissions };
}

/** Whether an actor may see the role screen at all — used by the shell's own navigation. */
export function canManageRoles(actor: Actor): boolean {
  return actorHasPermission(actor, ADMINISTRATION_PERMISSION) || actorHasPermission(actor, "user:manage");
}

/** An in-memory store for tests and local development. */
export class MemoryRoleStore implements RoleStore {
  private readonly roles = new Map<string, TenantRole>();
  /** Public so a test can move somebody's built-in role or deactivate them mid-scenario. */
  readonly people: RoleMember[] = [];

  constructor(members: RoleMember[] = []) {
    this.people.push(...members);
  }

  async list(tenantId: string): Promise<TenantRole[]> {
    return [...this.roles.values()]
      .filter((role) => role.tenantId === tenantId)
      .map((role) => structuredClone(role));
  }

  async find(tenantId: string, roleId: string): Promise<TenantRole | null> {
    const found = this.roles.get(roleId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async insert(role: TenantRole): Promise<void> {
    this.roles.set(role.id, structuredClone(role));
  }

  async update(role: TenantRole): Promise<void> {
    if (this.roles.has(role.id)) this.roles.set(role.id, structuredClone(role));
  }

  async members(tenantId: string): Promise<RoleMember[]> {
    return this.people.filter((member) => member.tenantId === tenantId).map((member) => structuredClone(member));
  }

  async assignedRole(tenantId: string, userId: string): Promise<TenantRole | null> {
    const member = this.people.find((person) => person.id === userId && person.tenantId === tenantId);
    if (!member?.tenantRoleId) return null;
    return this.find(tenantId, member.tenantRoleId);
  }

  async assign(tenantId: string, userId: string, roleId: string | null): Promise<void> {
    const member = this.people.find((person) => person.id === userId && person.tenantId === tenantId);
    if (member) member.tenantRoleId = roleId;
  }
}
