/**
 * Session rules (M0): how a signed-in caller becomes the `Actor` every access
 * decision is made against.
 *
 * Pure and framework-free, for the same reason as `access-rules.ts`: the
 * middleware, the server actions and the tests all agree on exactly what a
 * valid session is, and none of them needs a request context to check it. The
 * cookie/JWT plumbing that produces these claims lives in `session.ts`.
 */

import { isRole, type Actor, type Role } from "./access-rules";

export const TIX_SESSION_COOKIE = "ontrak_tix_session";

/**
 * What a session asserts. The tenant is part of the token, not looked up per
 * request, and every domain call re-checks it against the row it touches — so a
 * stolen token can never be pointed at another tenant.
 */
export interface TixSessionClaims {
  userId: string;
  tenantId: string;
  role: Role;
  email?: string;
  name?: string;
}

/** Whether an untrusted decoded token payload is a usable session. */
export function isTixSessionClaims(value: unknown): value is TixSessionClaims {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.userId === "string" &&
    claims.userId.length > 0 &&
    typeof claims.tenantId === "string" &&
    claims.tenantId.length > 0 &&
    isRole(claims.role)
  );
}

/** Turn validated claims into the actor the access rules expect. */
export function sessionActor(claims: TixSessionClaims): Actor {
  return { id: claims.userId, tenantId: claims.tenantId, role: claims.role };
}

/**
 * The claims for a request scoped to `tenantId`. A caller whose session belongs
 * to another tenant is refused outright — the guard middleware and every server
 * action call this before touching a row.
 */
export function claimsForTenant(claims: TixSessionClaims, tenantId: string): TixSessionClaims | null {
  return claims.tenantId === tenantId ? claims : null;
}

/** A short label for the header, falling back to the email or the user id. */
export function sessionDisplayName(claims: TixSessionClaims): string {
  return claims.name ?? claims.email ?? claims.userId;
}
