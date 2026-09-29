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

/* -------------------------------------------------------------------------- */
/*  Whether the cookie may travel only over TLS                               */
/* -------------------------------------------------------------------------- */

export type CookieSecurity = "auto" | "always" | "never";

/**
 * Read how a deployment wants the `Secure` flag decided.
 *
 * `TIX_COOKIE_SECURE` is an operator's statement, and it exists because the guess
 * that used to be here (`NODE_ENV === "production"`) was wrong in the shape this
 * product actually ships: every compose stack in this repository serves plain HTTP
 * with `NODE_ENV=production`, and a browser **drops a `Secure` cookie that arrives
 * over an insecure origin** — everywhere except `localhost`. So the desk worked on
 * the developer's own machine and signed everybody else out the moment they moved
 * to the address the LAN or another container uses, which reads as "login doesn't
 * stay signed in" rather than as anything to do with cookies.
 */
export function parseCookieSecurity(setting: string | null | undefined): CookieSecurity {
  const wanted = (setting ?? "").trim().toLowerCase();
  if (["always", "true", "1", "yes", "on"].includes(wanted)) return "always";
  if (["never", "false", "0", "no", "off"].includes(wanted)) return "never";
  return "auto";
}

/**
 * Whether to mark the cookie `Secure`, given what the request itself reports.
 *
 * `auto` follows the **request**, not the build: `https` means the cookie may be
 * restricted to TLS, and anything else — including no report at all, which is what
 * a connection that reached this process directly looks like — means it must not be,
 * because a restricted cookie would simply be discarded and nobody would be signed
 * in. A deployment behind a TLS terminator that does not set `X-Forwarded-Proto`
 * says so with `TIX_COOKIE_SECURE=always` instead of being guessed at.
 *
 * Honouring a client's own `X-Forwarded-Proto` is safe in the only direction that
 * matters here: a caller that claims `https` over a plain connection gets a `Secure`
 * cookie its own browser will drop, so it can break itself and nobody else.
 */
export function cookieIsSecure(
  setting: CookieSecurity,
  requestScheme: string | null | undefined,
): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  return (requestScheme ?? "").trim().toLowerCase() === "https";
}

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
