import "server-only";

/**
 * The portal's session, in one signed cookie.
 *
 * A signed JWT rather than a server-side session table, and that is a deliberate
 * difference from OnTrak Sync: this portal holds no data of its own — it decides
 * where to send somebody and then hands them to a product that checks them again.
 * A session store here would be a second place a person's role lived, and the two
 * would disagree the first time a group changed.
 *
 * What that costs is revocation: a signed cookie cannot be withdrawn before it
 * expires. The mitigations are that the lifetime is short (one working day), that
 * the cookie is `HttpOnly` so no script can read or rewrite it, and that the
 * cookie is only ever a *routing* hint — every product behind a tile authorises
 * the caller from its own credential, so a stale portal cookie cannot grant
 * anything at a product.
 *
 * `HttpOnly` plus `SameSite=Lax` is the CSRF posture: a cross-site form POST does
 * not carry the cookie, and the few endpoints that change something are POSTs.
 */

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import {
  isAuthorizationState,
  isPortalSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  type AuthorizationState,
  type PortalSession,
} from "./oidc-rules";
import { portalConfig, sessionCookieSecure } from "./config";

const ALGORITHM = "HS256";

/** The signing key. Deliberately not optional — see `config.ts`. */
function signingKey(): Uint8Array {
  const secret = portalConfig().sessionSecret;
  if (!secret) {
    throw new Error(
      "ONTRAK_PORTAL_SESSION_SECRET is not set. There is no default: a session " +
      "cookie signed with a placeholder is a session cookie anybody can mint.",
    );
  }
  return new TextEncoder().encode(secret);
}

export function sessionTtlSeconds(): number {
  return SESSION_TTL_SECONDS;
}

/** Write the portal session cookie. */
export async function setSession(session: PortalSession): Promise<void> {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setSubject(session.sub)
    .sign(signingKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/**
 * The session, or null when there is none or it is unusable.
 *
 * Null for every failure — absent, tampered, expired — because the caller only
 * ever has one question ("is this person signed in") and a distinction between
 * four kinds of no would be four ways to get the handling wrong.
 */
export async function readSession(): Promise<PortalSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(), { algorithms: [ALGORITHM] });
    return isPortalSession(payload) ? (payload as unknown as PortalSession) : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** The pending authorization state, short-lived and signed. */
export async function setSsoState(state: AuthorizationState): Promise<void> {
  const token = await new SignJWT({ ...state })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(signingKey());
  const store = await cookies();
  store.set(STATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
}

export async function readSsoState(): Promise<AuthorizationState | null> {
  const store = await cookies();
  const token = store.get(STATE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(), { algorithms: [ALGORITHM] });
    return isAuthorizationState(payload) ? (payload as unknown as AuthorizationState) : null;
  } catch {
    return null;
  }
}

export async function clearSsoState(): Promise<void> {
  const store = await cookies();
  store.delete(STATE_COOKIE);
}
