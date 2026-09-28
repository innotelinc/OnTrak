/**
 * Client rules (M4): who a desk serves, who may see their work, and what it
 * takes to look through their eyes.
 *
 * One desk serving many clients is the thing that changes at this milestone, and
 * every hard question follows from it. A promise made to one client is not the
 * desk's default (so the SLA ladder needs a client rung — `resolveSlaPolicy`).
 * An agent who works two clients must not see the third (so visibility is a
 * *scope*, not a hope). And "view the portal as the client" is the most
 * dangerous convenience in an MSP helpdesk, because it is indistinguishable from
 * the client acting — so it takes a permission, a reason, a visible client and
 * an expiry, and it is recorded.
 *
 * Everything here is pure. The service stores what these rules decide; the
 * console renders the sentence they produce.
 */

import { hasPermission, type Role } from "./access-rules";

/* -------------------------------------------------------------------------- */
/*  The records                                                               */
/* -------------------------------------------------------------------------- */

export interface ClientRecord {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
}

export interface ContactRecord {
  id: string;
  tenantId: string;
  clientId: string;
  name: string;
  email: string;
  createdAt: string;
}

/** Which staff serve which client. The row *is* the scope. */
export interface ClientAssignmentRecord {
  id: string;
  tenantId: string;
  clientId: string;
  userId: string;
  assignedBy: string;
  assignedAt: string;
}

/** An "act as client" window: who, which client, why, and until when. */
export interface ClientActAsRecord {
  id: string;
  tenantId: string;
  clientId: string;
  actorId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export const CLIENT_NAME_MAX = 120;
export const CONTACT_NAME_MAX = 120;
export const EMAIL_MAX = 200;

export interface ClientIssue {
  field: string;
  message: string;
}

export function validateClient(input: { name?: string }): ClientIssue[] {
  const issues: ClientIssue[] = [];
  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A client name is required." });
  else if (name.length > CLIENT_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${CLIENT_NAME_MAX} characters.` });
  }
  return issues;
}

/**
 * A contact is how a client is reached, so the address has to be usable. The
 * check is deliberately loose — an address is valid if mail reaches it, and only
 * sending mail can prove that — but it rejects the shapes that are certainly
 * wrong rather than storing a typo nobody can reply to.
 */
export function validateContact(input: { name?: string; email?: string | null }): ClientIssue[] {
  const issues: ClientIssue[] = [];
  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A contact name is required." });
  else if (name.length > CONTACT_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${CONTACT_NAME_MAX} characters.` });
  }

  const email = input.email?.trim() ?? "";
  if (!email) issues.push({ field: "email", message: "An email address is required." });
  else if (email.length > EMAIL_MAX) {
    issues.push({ field: "email", message: `The address may be at most ${EMAIL_MAX} characters.` });
  } else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    issues.push({ field: "email", message: `“${email}” is not an email address a reply can reach.` });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Cross-client scoping                                                      */
/* -------------------------------------------------------------------------- */

export interface ClientScope {
  kind: "all" | "assigned";
  /** The client ids the actor may see, when the scope is `assigned`. */
  clientIds: readonly string[];
  /** Why, in words the console shows next to a filtered worklist. */
  because: string;
}

/**
 * What an actor may see, and why.
 *
 * `queue:manage` is the rung that means "runs the desk" (ADMIN and DISPATCHER
 * hold it), so those roles see every client. An agent sees the clients they are
 * assigned to. Work with **no** client belongs to nobody in particular, so it
 * stays visible to everyone — otherwise a desk that only sometimes records the
 * client would quietly hide its own work.
 */
export function clientScopeFor(input: {
  role: Role | string;
  userId: string;
  assignments: readonly ClientAssignmentRecord[];
}): ClientScope {
  const role = input.role as Role;
  if (hasPermission(role, "queue:manage")) {
    return { kind: "all", clientIds: [], because: "runs the desk, so every client is in scope" };
  }

  const mine = input.assignments.filter((assignment) => assignment.userId === input.userId).map((assignment) => assignment.clientId);
  return {
    kind: "assigned",
    clientIds: [...new Set(mine)],
    because:
      mine.length === 0
        ? "is assigned to no client, so only unassigned work is in scope"
        : `is assigned to ${mine.length} client${mine.length === 1 ? "" : "s"}`,
  };
}

/** Whether one client's work is visible. Unassigned work always is. */
export function canSeeClient(scope: ClientScope, clientId: string | null | undefined): boolean {
  if (!clientId) return true;
  return scope.kind === "all" || scope.clientIds.includes(clientId);
}

/**
 * The rows an actor may see, filtered by the client on each row. The *other*
 * dimensions of visibility (a requester's own tickets, an agent's queue) are
 * enforced where they already were; this is the client dimension only, and it is
 * deliberately a filter a caller cannot forget to apply — it returns the list.
 */
export function scopeByClient<T extends { clientId?: string | null }>(scope: ClientScope, rows: readonly T[]): T[] {
  return rows.filter((row) => canSeeClient(scope, row.clientId));
}

/* -------------------------------------------------------------------------- */
/*  Acting as a client                                                        */
/* -------------------------------------------------------------------------- */

/** How long an act-as window lasts before it has to be re-stated. */
export const ACT_AS_TTL_MINUTES = 30;

export interface ActAsDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Whether an actor may start acting as a client.
 *
 * Four things are required, and each is one someone has had to argue for:
 *
 *  - the `client:manage` permission, because looking through a client's eyes is
 *    the strongest read there is;
 *  - the client actually being in the actor's scope — otherwise act-as is a
 *    bypass of the scoping this module just defined;
 *  - a **reason**, because "why was this looked at?" is the question an audit
 *    asks, and a blank one is not an answer;
 *  - no window already open, so two identities are never live in one session.
 */
export function actAsClientDecision(input: {
  role: Role | string;
  scope: ClientScope;
  clientId: string;
  reason: string;
  active: { clientId: string; expiresAt: string } | null;
  now: string;
}): ActAsDecision {
  const role = input.role as Role;
  if (!hasPermission(role, "client:manage")) {
    return { allowed: false, reason: "Acting as a client needs a role that manages clients." };
  }
  if (!input.clientId) return { allowed: false, reason: "Choose a client to act as." };
  if (!canSeeClient(input.scope, input.clientId)) {
    return { allowed: false, reason: "Act as is not a way around the client scope: this client is not yours to view." };
  }
  if (input.reason.trim().length < 3) {
    return { allowed: false, reason: "Acting as a client needs a reason on the record." };
  }
  if (input.active && input.active.expiresAt > input.now) {
    return {
      allowed: false,
      reason: `Already acting as a client (until ${input.active.expiresAt}). End that window first.`,
    };
  }
  return { allowed: true, reason: `Acting as the client for ${ACT_AS_TTL_MINUTES} minutes, on the record.` };
}

/** When a window started now would end. */
export function actAsExpiry(now: string): string {
  return new Date(new Date(now).getTime() + ACT_AS_TTL_MINUTES * 60_000).toISOString();
}

/** An open window: started, not ended, and not expired. */
export function actAsActive(record: ClientActAsRecord, now: string): boolean {
  return record.endedAt === null && record.expiresAt > now;
}
