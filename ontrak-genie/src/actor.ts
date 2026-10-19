/**
 * A service acting for a person.
 *
 * Genie's turns are attributed: the account decides which gateway key pays, which
 * workspace the tools may touch, and which quota the turn is measured against. That
 * is why a bare bearer cannot start one — there is no account to attribute it to, and
 * the console says so ("cannot tell which account this belongs to") rather than
 * quietly spending the deployment's key.
 *
 * G0DM0D3 needs exactly that missing piece: it is a page in front of Genie, it has
 * already authenticated somebody through oauth2-proxy, and it wants the turn to
 * belong to *them*. So a second way in is added, and it is deliberately narrow:
 *
 *   * the request must carry the deployment's shared bearer (`WEB_TOKEN`), so it
 *     comes from a service this deployment named, not from a browser;
 *   * it must say who it acts for, in `x-genie-actor`;
 *   * the deployment must have turned this on (`TRUSTED_ACTOR_HEADER`), because a
 *     header is only an identity when a proxy that checks identities is the only
 *     thing that can set it;
 *   * and the address is resolved against the control plane, so the subject that
 *     ends up on the turn is the account's real subject — this module never invents
 *     one, and never creates an account for an address nobody has.
 *
 * With any of those missing, `null` comes back and the caller is treated as
 * unidentified, which is the answer Genie already gives a browser that is not signed
 * in. The consequence worth stating: turning this on is a deployment decision about
 * who may speak for whom, and it is off unless an operator says otherwise.
 */

import type http from "node:http";
import { config } from "./config.js";
import { ControlPlaneError, readControlPlaneConfig, type ControlPlaneConfig } from "./controlplane.js";
import type { Session } from "./oidc.js";

/** What a service says when it runs a turn for somebody. */
export const ACTOR_HEADER = "x-genie-actor";

/** Long enough for one request, short enough to be worth nothing if it leaks. */
const SESSION_TTL_SECONDS = 300;

export function actorEnabled(): boolean {
  return config.trustedActorHeader;
}

/** The shared bearer this deployment issues to its own services, if any. */
function bearerMatches(req: http.IncomingMessage): boolean {
  if (config.webToken === "") return false;
  return req.headers.authorization === `Bearer ${config.webToken}`;
}

function headerEmail(req: http.IncomingMessage): string {
  const raw = req.headers[ACTOR_HEADER];
  const value = Array.isArray(raw) ? raw[0] : (raw ?? "");
  return String(value).trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/**
 * The subject the control plane keys this address on, or null when it has none.
 *
 * A 4xx is an answer about this address (nobody here, or an account with no subject
 * to act for) and reads as "not identified". Anything else — a refusal that is not
 * about the person, a timeout, a 5xx, an unparseable answer — is the plane being
 * unreachable, which is an outage: the caller must hear that, because it is
 * retryable and a 401 is not.
 */
async function resolveSubject(email: string, plane: ControlPlaneConfig): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${plane.url}/api/internal/identity/resolve?email=${encodeURIComponent(email)}`, {
      method: "GET",
      headers: { "x-control-internal-token": plane.token, "cache-control": "no-store" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new ControlPlaneError(`could not resolve who ${email} is: ${(error as Error).message}`);
  }

  const text = await response.text().catch(() => "");
  if (response.status === 404 || response.status === 409) return null;
  if (!response.ok) {
    throw new ControlPlaneError(`the control plane refused to resolve ${email} (HTTP ${response.status})`, response.status);
  }
  let payload: unknown = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    throw new ControlPlaneError(`the control plane answered with something that is not JSON for ${email}`);
  }
  const sub = (payload as { sub?: unknown } | null)?.sub;
  return typeof sub === "string" && sub.trim() !== "" ? sub.trim() : null;
}

/**
 * The session a service caller asks for, or null when this request is not one.
 *
 * Never throws for a request that simply is not an actor request — that is `null`,
 * and the caller falls back to "not signed in". It throws only for an actor request
 * the plane could not answer, which the caller turns into a 503.
 */
export async function actorSession(
  req: http.IncomingMessage,
  plane: ControlPlaneConfig | null = readControlPlaneConfig(),
): Promise<Session | null> {
  if (!actorEnabled()) return null;
  if (!bearerMatches(req)) return null;

  const email = headerEmail(req);
  if (!looksLikeEmail(email)) return null;
  // No plane, no way to know which account this is — and inventing a subject here
  // is exactly the thing that would hand somebody else's workspace to a stranger.
  if (plane === null) return null;

  const sub = await resolveSubject(email, plane);
  if (sub === null) return null;

  return { sub, email, name: email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
}
