import "server-only";

import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import { cookieIsSecure, parseCookieSecurity } from "./auth-rules";
import { sessionSigningKey } from "./auth";
import { isAuthorizationState, SSO_STATE_COOKIE, SSO_STATE_TTL_SECONDS, type AuthorizationState } from "./oidc-rules";

/**
 * The SSO authorization state, in one signed, short-lived cookie.
 *
 * `state`, `nonce` and the PKCE verifier have to survive the trip to the
 * provider and back, and they must not be readable or forgeable by the browser.
 * Signing them with the deployment's secret means a tampered cookie fails
 * verification, and the ten-minute expiry means an abandoned handshake cannot be
 * resumed later.
 */

const ALGORITHM = "HS256";

// Re-exported so callers keep importing the cookie from where it is used.
export { SSO_STATE_COOKIE };

/**
 * Whether the cookie this request is about to receive may be restricted to TLS.
 *
 * The same answer the session cookie gets, and for the same reason: a browser
 * refuses to store a `Secure` cookie from an insecure origin, so a state cookie
 * that was dropped turns every sign-in into "this request could not be verified".
 */
async function stateCookieSecure(): Promise<boolean> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-proto");
  const scheme = forwarded ? forwarded.split(",")[0].trim() : null;
  return cookieIsSecure(parseCookieSecurity(process.env.AUTH_COOKIE_SECURE), scheme);
}

export async function setSsoState(state: AuthorizationState): Promise<void> {
  const token = await new SignJWT({ ...state })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${SSO_STATE_TTL_SECONDS}s`)
    .sign(sessionSigningKey());

  const store = await cookies();
  store.set(SSO_STATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await stateCookieSecure(),
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
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: [ALGORITHM] });
    return isAuthorizationState(payload) ? (payload as AuthorizationState) : null;
  } catch {
    return null;
  }
}

export async function clearSsoState(): Promise<void> {
  const store = await cookies();
  store.delete(SSO_STATE_COOKIE);
}
