/**
 * Access rules (M0): roles, permissions, and the tenant-isolation checks that
 * every server action must run *before* it touches a row.
 *
 * These are pure and framework-free on purpose: the app imports them from
 * middleware and from each server action, and the tests exercise the exact same
 * functions. No request context, no Prisma.
 */

export type Role = "ADMIN" | "DISPATCHER" | "AGENT" | "REQUESTER";

export const ROLES: readonly Role[] = ["ADMIN", "DISPATCHER", "AGENT", "REQUESTER"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export type Permission =
  | "ticket:create"
  | "ticket:read"
  | "ticket:read:any"
  | "ticket:reply"
  | "ticket:update"
  | "ticket:assign"
  | "ticket:close"
  | "ticket:delete"
  | "queue:manage"
  | "client:manage"
  | "rule:manage"
  | "user:manage"
  | "tenant:manage"
  | "audit:read";

/**
 * Every permission this release knows, in the order the role screen lists them.
 *
 * A tenant role (M6, `role-rules.ts`) may name any of these, so the closed set is written down
 * once here rather than being inferable only from the union type — a screen cannot offer a
 * permission that does not exist, nor miss one that does.
 */
export const PERMISSIONS: readonly Permission[] = [
  "ticket:create",
  "ticket:read",
  "ticket:read:any",
  "ticket:reply",
  "ticket:update",
  "ticket:assign",
  "ticket:close",
  "ticket:delete",
  "queue:manage",
  "client:manage",
  "rule:manage",
  "user:manage",
  "tenant:manage",
  "audit:read",
];

/**
 * The permission matrix. `ticket:read` means "may read a ticket I am in scope
 * for"; `ticket:read:any` means "may read any ticket in my tenant". Requesters
 * get the former and are scoped to their own tickets by `canReadTicket`.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: [
    "ticket:create",
    "ticket:read",
    "ticket:read:any",
    "ticket:reply",
    "ticket:update",
    "ticket:assign",
    "ticket:close",
    "ticket:delete",
    "queue:manage",
    "client:manage",
    "rule:manage",
    "user:manage",
    "tenant:manage",
    "audit:read",
  ],
  DISPATCHER: [
    "ticket:create",
    "ticket:read",
    "ticket:read:any",
    "ticket:reply",
    "ticket:update",
    "ticket:assign",
    "ticket:close",
    "queue:manage",
    "client:manage",
    "rule:manage",
    "user:manage",
  ],
  AGENT: [
    "ticket:create",
    "ticket:read",
    "ticket:read:any",
    "ticket:reply",
    "ticket:update",
    "ticket:close",
  ],
  REQUESTER: ["ticket:create", "ticket:read", "ticket:reply"],
};

/** The permissions a role holds. */
export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Whether a role holds a permission. Unknown roles hold nothing. */
export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Whether an *actor* holds a permission.
 *
 * This is the function a page or a server action should ask, because it is the one that knows
 * about tenant roles (M6): an actor carrying a resolved `permissions` set is judged by that,
 * and an actor that carries none is judged by their built-in role — which is every actor that
 * existed before this, and every actor on a desk that has written no roles at all.
 */
export function actorHasPermission(actor: Actor, permission: Permission): boolean {
  if (actor.permissions) return actor.permissions.includes(permission);
  return hasPermission(actor.role, permission);
}

/** The authenticated caller, as resolved from the session. */
export interface Actor {
  id: string;
  /** The tenant the caller belongs to. Cross-tenant reads are never implied. */
  tenantId: string;
  role: Role;
  /**
   * The permissions this actor actually holds (M6), when a tenant role has narrowed them.
   *
   * Absent means "the built-in role's own set", which is what every caller had before tenant
   * roles existed — so a session that never resolved one behaves exactly as it used to.
   */
  permissions?: readonly Permission[];
}

/** The minimum a ticket has to expose for an access decision. */
export interface TicketScope {
  tenantId: string;
  requesterId: string;
  assigneeId?: string | null;
}

/** Tenant isolation: an actor may only ever act inside their own tenant. */
export function isSameTenant(actor: Actor, tenantId: string): boolean {
  return actor.tenantId === tenantId;
}

/**
 * Whether an actor may read a ticket. Staff with `ticket:read:any` may read any
 * ticket in their tenant; everyone else may read only tickets they raised.
 * A ticket in another tenant is never readable.
 */
export function canReadTicket(actor: Actor, ticket: TicketScope): boolean {
  if (!isSameTenant(actor, ticket.tenantId)) return false;
  if (actorHasPermission(actor, "ticket:read:any")) return true;
  return ticket.requesterId === actor.id;
}

/**
 * Whether an actor may change a ticket. Requester scope is handled separately
 * (a requester may reply, but never assigns or closes), so this expresses the
 * staff path plus the tenant rule.
 */
export function canUpdateTicket(actor: Actor, ticket: TicketScope): boolean {
  if (!isSameTenant(actor, ticket.tenantId)) return false;
  return actorHasPermission(actor, "ticket:update");
}

/** Only staff who may assign, and only inside their own tenant. */
export function canAssignTicket(actor: Actor, ticket: TicketScope): boolean {
  if (!isSameTenant(actor, ticket.tenantId)) return false;
  return actorHasPermission(actor, "ticket:assign");
}

/**
 * Whether an actor may reply on a ticket. Requesters may reply on their own
 * tickets; staff who may read the ticket may reply on it.
 */
export function canReplyToTicket(actor: Actor, ticket: TicketScope): boolean {
  if (!isSameTenant(actor, ticket.tenantId)) return false;
  if (!actorHasPermission(actor, "ticket:reply")) return false;
  return canReadTicket(actor, ticket);
}

/**
 * A one-line reason an action was refused, or `null` when it is allowed.
 * Server actions turn this into a user-facing error, so the wording is kept
 * deliberately vague about *why* (no tenant probing).
 */
export function accessDenial(
  actor: Actor,
  action: "read" | "reply" | "update" | "assign",
  ticket: TicketScope,
): string | null {
  switch (action) {
    case "read":
      return canReadTicket(actor, ticket) ? null : "You do not have access to this ticket.";
    case "reply":
      return canReplyToTicket(actor, ticket) ? null : "You cannot reply on this ticket.";
    case "update":
      return canUpdateTicket(actor, ticket) ? null : "You cannot update this ticket.";
    case "assign":
      return canAssignTicket(actor, ticket) ? null : "You cannot assign this ticket.";
  }
}
