import "server-only";

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import {
  isAuthorizationState,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_SECONDS,
  type AuthorizationState,
} from "./oidc-rules";
import { sessionCookieSecure, tixSigningKey } from "./session";

/**
 * The SSO authorization state, in one signed, short-lived cookie.
 *
 * `state`, `nonce` and the PKCE verifier must survive the trip to the IdP and
 * back, and they must not be readable or forgeable by the browser. Signing them
 * with the deployment's secret means a tampered cookie fails verification, and
 * the 10-minute expiry means an abandoned handshake cannot be replayed later.
 */

const ALGORITHM = "HS256";

// Re-exported so callers keep importing the cookie from where it is used.
export { SSO_STATE_COOKIE };

export async function setSsoState(state: AuthorizationState): Promise<void> {
  const token = await new SignJWT({ ...state })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${SSO_STATE_TTL_SECONDS}s`)
    .sign(tixSigningKey());

  const store = await cookies();
  store.set(SSO_STATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // The same answer the session cookie gets: a round trip whose state cookie is
    // dropped cannot complete, and a handshake that only works on `localhost` is not
    // one anybody can deploy.
    secure: await sessionCookieSecure(),
    path: "/",
    maxAge: SSO_STATE_TTL_SECONDS,
  });
}

/** The pending authorization state, or `null` when there is none or it is invalid. */
export async function readSsoState(): Promise<AuthorizationState | null> {
  const store = await cookies();
  const token = store.get(SSO_STATE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, tixSigningKey(), { algorithms: [ALGORITHM] });
    return isAuthorizationState(payload) ? (payload as AuthorizationState) : null;
  } catch {
    return null;
  }
}

export async function clearSsoState(): Promise<void> {
  const store = await cookies();
  store.delete(SSO_STATE_COOKIE);
}
