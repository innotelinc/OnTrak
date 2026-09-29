import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";

import type { Actor } from "./access-rules";
import {
  TIX_SESSION_COOKIE,
  cookieIsSecure,
  isTixSessionClaims,
  parseCookieSecurity,
  sessionActor,
  sessionDisplayName,
  type TixSessionClaims,
} from "./session-rules";

/**
 * Tenant-scoped session plumbing (M0): the cookie/JWT side of `session-rules.ts`.
 *
 * The token carries the tenant and role, so every request knows its isolation
 * boundary without a database round-trip; the rules that validate those claims
 * are pure and tested separately. This module is the only part that touches a
 * cookie or a signing key.
 */

const ALGORITHM = "HS256";

function secret(): Uint8Array {
  const value = process.env.TIX_AUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "TIX_AUTH_SECRET (or AUTH_SECRET) is missing or too short. Set a long random value before running OnTrak Tix.",
    );
  }
  return new TextEncoder().encode(value);
}

/**
 * The shared signing key. Exported so another short-lived signed cookie — the
 * SSO authorization state — is signed with the same secret and cannot be forged
 * by anyone who cannot already forge the session itself.
 */
export function tixSigningKey(): Uint8Array {
  return secret();
}

function sessionTtlSeconds(): number {
  const parsed = Number(process.env.TIX_SESSION_TTL_SECONDS ?? process.env.SESSION_TTL_SECONDS ?? "604800");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 604800;
}

/** Issue a signed session cookie for a staff or requester account. */
export async function createTixSession(claims: TixSessionClaims): Promise<void> {
  const ttl = sessionTtlSeconds();
  const token = await new SignJWT({ tenantId: claims.tenantId, role: claims.role, email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secret());

  const store = await cookies();
  store.set(TIX_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await sessionCookieSecure(),
    path: "/",
    maxAge: ttl,
  });
}

export async function destroyTixSession(): Promise<void> {
  const store = await cookies();
  store.delete(TIX_SESSION_COOKIE);
}

/**
 * The scheme this request arrived over, as the request reports it.
 *
 * `X-Forwarded-Proto` is what a TLS terminator sets; a connection that reached this
 * process directly usually has nothing to say, which is answered as "not https".
 */
async function requestScheme(): Promise<string | null> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-proto");
  if (!forwarded) return null;
  return forwarded.split(",")[0].trim();
}

/**
 * Whether the cookie this request is about to receive may be restricted to TLS.
 *
 * Exported because every signed cookie the desk writes shares the answer — the
 * session, the SSO authorization state and a revealed integration secret. Each of
 * them was `secure` in production, and on a plain-HTTP deployment that meant none of
 * them was ever stored.
 */
export async function sessionCookieSecure(): Promise<boolean> {
  return cookieIsSecure(parseCookieSecurity(process.env.TIX_COOKIE_SECURE), await requestScheme());
}

/** Verifying a raw token is shared with the middleware, which runs on the edge runtime. */
export async function verifyTixSessionToken(token: string): Promise<TixSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALGORITHM] });
    const claims = { ...payload, userId: payload.sub, tenantId: payload.tenantId, role: payload.role };
    return isTixSessionClaims(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** The current session claims, or null when signed out. Safe in any server component. */
export async function getTixSession(): Promise<TixSessionClaims | null> {
  const store = await cookies();
  const token = store.get(TIX_SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyTixSessionToken(token);
}

/** The current actor, or null when signed out. */
export async function currentActor(): Promise<Actor | null> {
  const claims = await getTixSession();
  return claims ? sessionActor(claims) : null;
}

/**
 * For pages and actions that require a signed-in user. A signed-out caller is
 * sent to the sign-in screen rather than shown a 500, which is what a bare
 * thrown error would produce.
 */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/sign-in");
  return actor;
}

/** The display name for the shell header, or null when signed out. */
export async function currentSessionName(): Promise<string | null> {
  const claims = await getTixSession();
  return claims ? sessionDisplayName(claims) : null;
}
