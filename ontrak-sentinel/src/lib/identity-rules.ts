/**
 * Identity rules (S0): the small, pure decisions the login path and the
 * enforcement gate share with tests. Framework-free on purpose.
 */

export type IdentityRole = "ADMIN" | "AGENT" | "SERVICE" | "AUDITOR";

export interface IdentityPolicy {
  /** Require a second factor before any interactive session is granted. */
  requireMfa: boolean;
  /** Absolute session lifetime in seconds. */
  maxSessionSeconds: number;
  /** Idle timeout in seconds. */
  idleTimeoutSeconds: number;
}

export const DEFAULT_IDENTITY_POLICY: IdentityPolicy = {
  requireMfa: true,
  maxSessionSeconds: 60 * 60 * 12,
  idleTimeoutSeconds: 60 * 30,
};

export interface IdentitySummary {
  id: string;
  role: IdentityRole;
  active: boolean;
  mfaEnrolled: boolean;
}

export interface SessionInfo {
  /** Epoch milliseconds, server-authoritative. */
  issuedAt: number;
  lastSeenAt: number;
  revokedAt?: number | null;
}

export type SessionDecision = { active: true } | { active: false; reason: string };

/**
 * Decide whether a session is still usable. Order matters: a revoked or
 * deactivated identity is rejected before any timeout is considered.
 */
export function sessionDecision(
  identity: IdentitySummary,
  session: SessionInfo,
  policy: IdentityPolicy = DEFAULT_IDENTITY_POLICY,
  now: number = Date.now(),
): SessionDecision {
  if (!identity.active) return { active: false, reason: "identity is deactivated" };
  if (session.revokedAt != null) return { active: false, reason: "session was revoked" };
  if (policy.requireMfa && !identity.mfaEnrolled) {
    return { active: false, reason: "MFA is required but not enrolled" };
  }
  if (now - session.issuedAt >= policy.maxSessionSeconds * 1000) {
    return { active: false, reason: "session exceeded its maximum lifetime" };
  }
  if (now - session.lastSeenAt >= policy.idleTimeoutSeconds * 1000) {
    return { active: false, reason: "session idle timeout" };
  }
  return { active: true };
}

/**
 * Who may authorise a Guard prevention action. Prevention can break production,
 * so in v1 only an administrator can approve it — the safety rail that keeps
 * enforcement approval-gated and auditable.
 */
export function canApproveEnforcement(role: IdentityRole): boolean {
  return role === "ADMIN";
}

/* -------------------------------------------------------------------------- */
/*  The records the spine stores                                              */
/* -------------------------------------------------------------------------- */

/** An MSP, or one internal IT department — the isolation boundary, and nothing
 *  crosses it. Everything below carries the organization it belongs to so a
 *  query that forgets to scope itself is a visible mistake rather than a silent
 *  cross-tenant read. */
export interface OrganizationRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export type IdentityKind = "HUMAN" | "SERVICE";

export interface IdentityRecord {
  id: string;
  organizationId: string;
  /** Email for a human, a service name for a machine. */
  identifier: string;
  displayName: string;
  /**
   * The identifier the *source directory* knows this person by (SCIM's
   * `externalId`), or `null` for an identity that was never provisioned.
   *
   * This is the column that makes a rename safe: an administrator changing a
   * person's address moves the same person, while a connector that matched on the
   * name alone would create a second one and orphan the first. Unique within an
   * organization when it is present, and deliberately *not* unique across the NULLs
   * — an identity that came from a directory and one typed into the console are both
   * perfectly ordinary, and Postgres already treats NULLs as distinct.
   */
  externalId: string | null;
  kind: IdentityKind;
  role: IdentityRole;
  active: boolean;
  /** Derived from the enrolled factors; a session reads it, never recomputes it. */
  mfaEnrolled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A hash, never a secret: the spine never holds anything worth stealing. */
export interface CredentialRecord {
  id: string;
  organizationId: string;
  identityId: string;
  hash: string;
  createdAt: string;
}

/** Epoch milliseconds, matching `SessionInfo`, so the pure rules read it directly. */
export interface SessionRecord {
  id: string;
  organizationId: string;
  identityId: string;
  issuedAt: number;
  lastSeenAt: number;
  /** Whatever stopped being usable first, computed when the session is issued. */
  expiresAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  ipAddress: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export const ORG_SLUG_MAX = 60;
export const IDENTIFIER_MAX = 200;
export const DISPLAY_NAME_MAX = 120;
export const EXTERNAL_ID_MAX = 200;

export interface IdentityIssue {
  field: string;
  message: string;
}

export function validateOrganization(input: { name?: string; slug?: string }): IdentityIssue[] {
  const issues: IdentityIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "An organization name is required." });

  const slug = input.slug?.trim() ?? "";
  if (!slug) issues.push({ field: "slug", message: "A short slug is required." });
  else if (slug.length > ORG_SLUG_MAX) {
    issues.push({ field: "slug", message: `The slug may be at most ${ORG_SLUG_MAX} characters.` });
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    issues.push({ field: "slug", message: "A slug is lower-case letters, digits and dashes — it ends up in a URL." });
  }

  return issues;
}

/**
 * A human is identified by the address mail reaches; a service by a name an
 * operator can read back. Both are refused when blank, because an identity with
 * no identifier cannot be searched for, which is the whole point of having one.
 */
export function validateIdentity(input: {
  identifier?: string;
  displayName?: string;
  kind?: string;
  role?: string;
  externalId?: string | null;
}): IdentityIssue[] {
  const issues: IdentityIssue[] = [];

  // A source directory's id is opaque to us and only has to survive a round trip, so
  // the only thing worth refusing is one too long to store.
  if (input.externalId != null && input.externalId.length > EXTERNAL_ID_MAX) {
    issues.push({ field: "externalId", message: `The directory id may be at most ${EXTERNAL_ID_MAX} characters.` });
  }

  const kind = input.kind ?? "HUMAN";
  if (kind !== "HUMAN" && kind !== "SERVICE") {
    issues.push({ field: "kind", message: "An identity is either a human or a service." });
  }

  if (!["ADMIN", "AGENT", "SERVICE", "AUDITOR"].includes(input.role ?? "")) {
    issues.push({ field: "role", message: "Choose a role for this identity." });
  }

  const identifier = input.identifier?.trim() ?? "";
  if (!identifier) issues.push({ field: "identifier", message: "An identifier is required." });
  else if (identifier.length > IDENTIFIER_MAX) {
    issues.push({ field: "identifier", message: `The identifier may be at most ${IDENTIFIER_MAX} characters.` });
  } else if (kind === "HUMAN" && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(identifier)) {
    issues.push({ field: "identifier", message: `“${identifier}” is not an address a human can be reached at.` });
  }

  const displayName = input.displayName?.trim() ?? "";
  if (!displayName) issues.push({ field: "displayName", message: "A display name is required." });
  else if (displayName.length > DISPLAY_NAME_MAX) {
    issues.push({ field: "displayName", message: `The display name may be at most ${DISPLAY_NAME_MAX} characters.` });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Isolation, authorisation and session shape                                */
/* -------------------------------------------------------------------------- */

/**
 * The one rule the whole product hangs off: an actor may only ever act inside
 * their own organization. Stated as a function so it is *called* rather than
 * assumed, and so a test can point at it.
 */
export function isSameOrganization(actorOrganizationId: string, organizationId: string): boolean {
  return actorOrganizationId === organizationId;
}

/**
 * Who may create, activate or deactivate an identity. Reading is wider (an
 * auditor's whole job is reading), but changing who exists is an administrator's.
 */
export function canManageIdentities(role: IdentityRole): boolean {
  return role === "ADMIN";
}

/**
 * Whether a role change would leave the organization with no active administrator.
 *
 * The same rule `setActive` applies to deactivation, stated once so a *role* change
 * cannot walk around it: demoting the last admin takes the same administration away
 * as switching them off, and it does it more quietly.
 */
export function wouldStrandAdministration(
  others: IdentityRecord[],
  identityId: string,
  next: { role: IdentityRole; active: boolean },
): boolean {
  if (next.role === "ADMIN" && next.active) return false;
  return !others.some((entry) => entry.id !== identityId && entry.role === "ADMIN" && entry.active);
}

/** Who may read the directory and the audit trail. */
export function canReadDirectory(role: IdentityRole): boolean {
  return role === "ADMIN" || role === "AUDITOR" || role === "AGENT";
}

/** When a session issued at `issuedAt` stops being usable on age alone. */
export function sessionExpiry(issuedAt: number, policy: IdentityPolicy = DEFAULT_IDENTITY_POLICY): number {
  return issuedAt + policy.maxSessionSeconds * 1000;
}

/** Project a stored session onto the shape the pure session rules read. */
export function sessionInfo(session: SessionRecord): SessionInfo {
  return { issuedAt: session.issuedAt, lastSeenAt: session.lastSeenAt, revokedAt: session.revokedAt };
}

/** Project a stored identity onto the shape the pure session rules read. */
export function identitySummary(identity: IdentityRecord): IdentitySummary {
  return {
    id: identity.id,
    role: identity.role,
    active: identity.active,
    mfaEnrolled: identity.mfaEnrolled,
  };
}
