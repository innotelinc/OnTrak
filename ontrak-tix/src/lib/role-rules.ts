/**
 * Granular roles (M6): the permission matrix stops being code.
 *
 * Until now `access-rules.ts` held the whole matrix and a desk that wanted "an agent who may
 * close but not delete" had to change a source file, ship a release and redeploy. This is the
 * data side of that: a tenant writes its own roles, and the four built-in roles stay exactly
 * what they were.
 *
 * Four decisions carry it.
 *
 * **A tenant role narrows its base role; it can never add to it.** A role is authored *on* one
 * of the four built-ins and holds a *subset* of that role's permissions, so a definition can
 * never become a privilege escalation — the worst a mistaken (or malicious) role can do is take
 * something away from somebody who already had it. It also means the base role goes on meaning
 * what it already meant everywhere else in the product: the tenant-isolation checks, the API
 * token scopes (which name the least role that could serve them) and SCIM's role mapping all
 * still read `Role`, and none of them has to learn about tenant roles.
 *
 * **The narrowing is a set intersection, computed here and nowhere else.** `effectivePermissions`
 * is the single answer to "what may this person do", so a page cannot disagree with a server
 * action about it.
 *
 * **An archived role is not a deleted one.** Removing a role leaves every audit entry that
 * named it readable and simply returns its holders to their base role — the opposite of a
 * cascade, which would silently widen everybody's access at the moment somebody tidied up.
 *
 * **A change that would strand the desk is refused.** Narrowing the last role that holds
 * `tenant:manage` would leave nobody able to undo it — a desk locked out of its own
 * administration by a correct-looking edit. `strandsTenant` answers that question purely, from
 * the member list, so the service can refuse before it writes anything.
 */

import { randomUUID } from "node:crypto";

import { PERMISSIONS, permissionsFor, type Permission, type Role } from "./access-rules";
import type { AuditEventInput } from "./audit-chain";

/**
 * The permission that administers the desk itself.
 *
 * Named once because two rules depend on it by name — the assignment guard below, and the
 * promise that an administrator can always put things back.
 */
export const ADMINISTRATION_PERMISSION: Permission = "tenant:manage";

/** A stable machine key: lower-case, dash-separated, 2–40 characters. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** How many roles one tenant may hold, so a catalogue cannot become a dropdown nobody can read. */
export const MAX_TENANT_ROLES = 50;

export const MAX_ROLE_NAME_LENGTH = 60;
export const MAX_ROLE_DESCRIPTION_LENGTH = 240;

/**
 * A role a tenant wrote.
 *
 * `baseRole` is what makes the narrowing meaningful: the holder is still an `AGENT` as far as
 * every other part of the product is concerned, and this role says which of an agent's powers
 * they actually keep.
 */
export interface TenantRole {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string | null;
  baseRole: Role;
  permissions: readonly Permission[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A role as it arrives from a form.
 *
 * `permissions` is `string[]` rather than `Permission[]` because the value is what somebody
 * typed or ticked; `effectivePermissions` is what turns it into a set this release understands,
 * and anything it does not recognise is dropped there rather than trusted here.
 */
export interface TenantRoleInput {
  key: string;
  name: string;
  description?: string | null;
  baseRole: Role;
  permissions: readonly string[];
}

/** A person on the desk, as the role screen needs to see them. */
export interface RoleMember {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  /** The built-in role: what they are, whatever their tenant role takes away. */
  role: Role;
  active: boolean;
  /** The tenant role assigned to them, if any. */
  tenantRoleId: string | null;
}

/**
 * Every permission, each with the words a person reads on the screen.
 *
 * The label is short enough for a checkbox and the hint says what the power actually reaches,
 * because "ticket:update" is not a phrase anybody can consent to.
 */
export const PERMISSION_CATALOGUE: readonly { permission: Permission; label: string; hint: string }[] = [
  { permission: "ticket:create", label: "Raise tickets", hint: "Open tickets on a requester's behalf." },
  { permission: "ticket:read", label: "Read a ticket in scope", hint: "Their own tickets, or their client's." },
  { permission: "ticket:read:any", label: "Read any ticket", hint: "Everything on this desk, not just their own." },
  { permission: "ticket:reply", label: "Reply", hint: "Post a public reply or an internal note." },
  { permission: "ticket:update", label: "Update a ticket", hint: "Change status, priority, fields and queue." },
  { permission: "ticket:assign", label: "Assign", hint: "Put a ticket on somebody, including themselves." },
  { permission: "ticket:close", label: "Close", hint: "Resolve and close work." },
  { permission: "ticket:delete", label: "Delete", hint: "Remove a ticket and what it holds. Cannot be undone." },
  { permission: "queue:manage", label: "Manage queues", hint: "Create and configure the queues work flows through." },
  { permission: "client:manage", label: "Manage clients", hint: "Create and edit the customer records a ticket belongs to." },
  { permission: "rule:manage", label: "Manage rules", hint: "Write the automations that act on the desk's work." },
  { permission: "user:manage", label: "Manage people", hint: "Add, deactivate and re-role the desk's own accounts." },
  { permission: "tenant:manage", label: "Administer the desk", hint: "Tenant-wide settings, integrations, API tokens and this screen." },
  { permission: "audit:read", label: "Read the audit trail", hint: "See — and export — the record of everything the desk did." },
];

/** Every permission this release knows, in the order the screen lists them. */
export function allPermissions(): readonly Permission[] {
  return PERMISSION_CATALOGUE.map((entry) => entry.permission);
}

export function permissionLabel(permission: Permission): string {
  return PERMISSION_CATALOGUE.find((entry) => entry.permission === permission)?.label ?? permission;
}

/** Turn a typed name into a key: lower-case, dash-separated, bounded. */
export function normalizeRoleKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * The permissions a role actually grants.
 *
 * An intersection with the base role's matrix, returned in catalogue order so two roles that
 * grant the same thing compare equal however they were written.
 */
export function effectivePermissions(
  baseRole: Role,
  wanted: readonly string[] | readonly Permission[],
): readonly Permission[] {
  const base = new Set<string>(permissionsFor(baseRole));
  const asked = new Set<string>(wanted);
  return allPermissions().filter((permission) => base.has(permission) && asked.has(permission));
}

/** The permissions an actor holds, given the tenant role they have been given. */
export function effectivePermissionSet(
  role: Role,
  assigned: Pick<TenantRole, "baseRole" | "permissions" | "archivedAt"> | null | undefined,
): readonly Permission[] {
  const base = permissionsFor(role);
  // A role authored on a *different* base role than the holder's is not theirs to narrow: the
  // holder's own role wins, which is what keeps `baseRole` from being a second way to spell
  // somebody's job.
  if (!assigned || assigned.archivedAt || assigned.baseRole !== role) return base;
  const granted = new Set<string>(assigned.permissions);
  return base.filter((permission) => granted.has(permission));
}

/** What a role takes away from its base, for the screen and the audit entry. */
export function withheldPermissions(
  baseRole: Role,
  permissions: readonly string[] | readonly Permission[],
): readonly Permission[] {
  const granted = new Set<string>(permissions);
  return permissionsFor(baseRole).filter((permission) => !granted.has(permission));
}

/** Validation for a role being written. Empty means fine. */
export function validateTenantRole(
  input: Partial<TenantRoleInput>,
  existingKeys: readonly string[] = [],
): string[] {
  const problems: string[] = [];

  const key = normalizeRoleKey(String(input.key ?? ""));
  if (!ROLE_KEY_PATTERN.test(key)) {
    problems.push("Give the role a key of two to forty lower-case letters, digits or dashes.");
  } else if (existingKeys.includes(key)) {
    problems.push(`A role with the key "${key}" already exists.`);
  }

  const name = String(input.name ?? "").trim();
  if (name.length < 2) problems.push("Give the role a name.");
  if (name.length > MAX_ROLE_NAME_LENGTH) {
    problems.push(`Keep the name under ${MAX_ROLE_NAME_LENGTH} characters.`);
  }

  if (String(input.description ?? "").length > MAX_ROLE_DESCRIPTION_LENGTH) {
    problems.push(`Keep the description under ${MAX_ROLE_DESCRIPTION_LENGTH} characters.`);
  }

  const baseRole = input.baseRole as Role | undefined;
  if (!baseRole || !permissionsFor(baseRole)) {
    problems.push("Choose the built-in role this role is based on.");
    return problems;
  }

  const unknown = (input.permissions ?? []).filter(
    (permission) => !allPermissions().includes(permission as Permission),
  );
  if (unknown.length > 0) {
    problems.push(`This release does not know the permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }

  // A permission the base role does not hold is dropped rather than refused: the screen shows
  // each permission against what the base role has, so an extra one can only arrive from a
  // hand-written request — and silently ignoring it is safer than honouring it.
  return problems;
}

/** A one-line description of what a role grants, for the list. */
export function roleSummary(role: Pick<TenantRole, "baseRole" | "permissions">): string {
  const granted = effectivePermissions(role.baseRole, role.permissions);
  if (granted.length === 0) return `Based on ${role.baseRole}, with every permission withdrawn.`;
  const withheld = withheldPermissions(role.baseRole, granted);
  if (withheld.length === 0) return `Based on ${role.baseRole}, taking nothing away.`;
  return `Based on ${role.baseRole}, without ${withheld.map(permissionLabel).join(", ").toLowerCase()}.`;
}

/**
 * Whether anybody on this desk may still administer it.
 *
 * The service asks this question twice — once about the picture as it is, and once about the
 * picture as it would be after a save, an archival or an assignment — and refuses a change
 * that would take the answer from yes to no. Phrasing the guard this way rather than as "is
 * this role's last holder an administrator" is what makes it cover all three edits with one
 * rule, and what makes it silent on a desk where nobody holds the permission to begin with:
 * there was nothing to keep, so every edit is allowed.
 *
 * Only **active** members count. A deactivated administrator is not a way back in, and
 * treating one as one would be the worst kind of false comfort.
 */
export function administrationHeld(
  members: readonly RoleMember[],
  roles: readonly TenantRole[],
): boolean {
  const byId = new Map(roles.filter((role) => !role.archivedAt).map((role) => [role.id, role]));
  return members.some(
    (member) =>
      member.active &&
      effectivePermissionSet(member.role, member.tenantRoleId ? byId.get(member.tenantRoleId) : null).includes(
        ADMINISTRATION_PERMISSION,
      ),
  );
}

/** The same member list, with one person's role changed — for asking about a picture to come. */
export function withAssignment(
  members: readonly RoleMember[],
  userId: string,
  tenantRoleId: string | null,
): RoleMember[] {
  return members.map((member) => (member.id === userId ? { ...member, tenantRoleId } : member));
}

/** The same role list, with one role replaced — or dropped, for an archival. */
export function withRole(
  roles: readonly TenantRole[],
  roleId: string,
  next: Pick<TenantRole, "baseRole" | "permissions"> | null,
): TenantRole[] {
  if (!next) return roles.filter((role) => role.id !== roleId);
  return roles.map((role) => (role.id === roleId ? { ...role, ...next } : role));
}

export type RoleAuditAction = "role.create" | "role.update" | "role.archive" | "role.assign" | "role.unassign";

/**
 * The audit event for a role being written, archived or handed to somebody.
 *
 * The permissions granted are carried by name, because "who could do what, and when did that
 * change" is the question an auditor asks about a role — and the *withheld* list is carried
 * too, so an entry says what a person lost as well as what they kept.
 */
export function roleAudit(
  action: RoleAuditAction,
  input: {
    tenantId: string;
    actorId: string;
    /** The role's key, or `user:<id>` for an assignment, so the entry is greppable either way. */
    targetId: string;
    targetType?: string;
    detail: Record<string, unknown>;
    at: string;
  },
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    at: input.at,
    actor: input.actorId,
    action,
    targetType: input.targetType ?? "role",
    targetId: input.targetId,
    detail: input.detail,
  };
}

/** Does this deployment know the permission at all? */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}
