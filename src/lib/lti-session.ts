import "server-only";

import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import { cookieIsSecure, parseCookieSecurity } from "./auth-rules";
import { sessionSigningKey } from "./auth";
import {
  isLtiLaunchFacts,
  isLtiState,
  LTI_LAUNCH_COOKIE,
  LTI_LAUNCH_TTL_SECONDS,
  LTI_STATE_COOKIE,
  LTI_STATE_TTL_SECONDS,
  type LtiLaunchFacts,
  type LtiState,
} from "./lti-rules";

/**
 * Two short-lived signed cookies, and nothing else.
 *
 * **The state cookie** carries the `state` and `nonce` that make a launch *ours*
 * rather than one somebody else composed for us. It is the same mechanism, and the
 * same reasoning, as `sso-session.ts`: signed with the deployment's own secret so
 * a tampered cookie fails verification, and short-lived so an abandoned launch
 * cannot be resumed later.
 *
 * **The launch cookie** carries the grading context — which platform, which line
 * item, which course — from the launch to the moment the learner starts an
 * attempt, at which point it is copied onto the attempt row and the cookie is
 * cleared. It is not put in the session because the session outlives the launch by
 * design (people sign in from the LMS and come back next week), and it is not put
 * in a server-side table because it is a five-minute handoff, not a record.
 */

const ALGORITHM = "HS256";

export { LTI_LAUNCH_COOKIE, LTI_STATE_COOKIE };

/** The same TLS answer the session cookie gets, for the same reason. */
async function cookieSecure(): Promise<boolean> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-proto");
  const scheme = forwarded ? forwarded.split(",")[0].trim() : null;
  return cookieIsSecure(parseCookieSecurity(process.env.AUTH_COOKIE_SECURE), scheme);
}

export async function setLtiState(state: LtiState): Promise<void> {
  const token = await new SignJWT({ ...state })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${LTI_STATE_TTL_SECONDS}s`)
    .sign(sessionSigningKey());

  const store = await cookies();
  store.set(LTI_STATE_COOKIE, token, {
    httpOnly: true,
    sameSite: "none",
    secure: await cookieSecure(),
    path: "/",
    maxAge: LTI_STATE_TTL_SECONDS,
  });
}

/**
 * A launch begins in somebody else's frame, so the state cookie has to survive a
 * cross-site POST back to us: `SameSite=none` (with `Secure`, as every browser
 * requires in that combination) rather than the `lax` the sign-in flow can use.
 */
export async function readLtiState(): Promise<LtiState | null> {
  const store = await cookies();
  const token = store.get(LTI_STATE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: [ALGORITHM] });
    return isLtiState(payload) ? (payload as LtiState) : null;
  } catch {
    return null;
  }
}

export async function clearLtiState(): Promise<void> {
  const store = await cookies();
  store.delete(LTI_STATE_COOKIE);
}

export async function setLtiLaunch(facts: LtiLaunchFacts): Promise<void> {
  const token = await new SignJWT({ ...facts })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${LTI_LAUNCH_TTL_SECONDS}s`)
    .sign(sessionSigningKey());

  const store = await cookies();
  store.set(LTI_LAUNCH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await cookieSecure(),
    path: "/",
    maxAge: LTI_LAUNCH_TTL_SECONDS,
  });
}

/** The grading context this browser arrived with, or `null` when there is none. */
export async function readLtiLaunch(): Promise<LtiLaunchFacts | null> {
  const store = await cookies();
  const token = store.get(LTI_LAUNCH_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: [ALGORITHM] });
    return isLtiLaunchFacts(payload) ? (payload as LtiLaunchFacts) : null;
  } catch {
    return null;
  }
}

export async function clearLtiLaunch(): Promise<void> {
  const store = await cookies();
  store.delete(LTI_LAUNCH_COOKIE);
}
