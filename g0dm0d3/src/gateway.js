/**
 * The family's OmniRoute gateway, paid for by the caller's own account.
 *
 * Genie's console has spoken this contract since `src/tenancy.ts`: an OmniRoute
 * account is keyed **by API key**, so mapping `person ↔ gateway_key` in the
 * control plane gives attribution, quota and a usage ledger without touching the
 * gateway. G0DM0D3's studio is the other place a model is used, and it had no
 * such path: it asked every visitor for a personal OpenRouter key, which means
 * the spend and the account were somebody else's.
 *
 * So this module is the same three calls Genie makes, against the same plane:
 *
 *   resolve   `email` in, the account's OIDC subject out
 *             (the studio's identity is the proxy's header, which carries an
 *             address and no subject — inventing one here would mint a second
 *             account for a person Genie already knows)
 *   identity  `sub` + email in, that account's gateway key out
 *             (idempotent: the plane creates the account and its key the first
 *             time it sees the subject, and returns the same key after that)
 *   quota     the gateway key in, allow/deny out
 *   usage     a finished completion, recorded against the same key
 *
 * Three rules, each the strict mirror of Genie's:
 *
 *   * **The key is strict.** With a plane configured, a caller with no resolved
 *     account is refused rather than quietly spending the deployment's shared
 *     key — a shared key is how one person's spend becomes everybody's.
 *   * **The quota gate is fail-open**, because the key's own hard caps remain the
 *     backstop and a read-only hiccup on the plane must not become an outage.
 *   * **Accounting is best-effort**, because a completion that already happened
 *     must not fail on its way to the ledger.
 *
 * With no plane configured this is the single-operator tool it has always been:
 * `OMNIROUTE_API_KEY` pays, and an empty one is a real setting (a gateway on this
 * host may need no key at all).
 */

import { planeConfig } from "./credits.js";

/** Where the studio reaches the gateway: same origin, so no CSP exception and no key in the browser. */
export const GATEWAY_PATH = "/api/gateway/v1";

/** A gateway or plane call that failed, as opposed to one that answered. */
export class GatewayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The gateway's OpenAI-compatible base, or "" when this deployment has none.
 *
 * The address is the *base* (`https://gateway.innotel.us/v1`), because that is
 * what every caller of an OpenAI-compatible service expects; a trailing slash is
 * the one thing that would double a path segment.
 */
export function gatewayUrl(env = process.env) {
  return String(env.OMNIROUTE_URL ?? "").trim().replace(/\/+$/, "");
}

/** The shared key, for a deployment with no control plane. */
function sharedKey(env) {
  return String(env.OMNIROUTE_API_KEY ?? "").trim();
}

/** One call to the plane, with the answer's status kept rather than thrown. */
async function planeCall(plane, path, init = {}) {
  let response;
  try {
    response = await fetch(`${plane.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-control-internal-token": init.token ?? plane.token,
        // An identity or a quota answer that is a minute old is a decision about
        // somebody else's account.
        "cache-control": "no-store",
        ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GatewayError(`could not reach the tenancy service: ${error.message}`);
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
}

/**
 * The OIDC subject the plane keys this address on, or null when it has none.
 *
 * A 4xx is an answer about this address ("nobody here", "an account with no
 * subject to act for") and reads as "no account". Anything else is the plane
 * being unaskable, which is an outage: a 401 is not retryable and this is.
 */
async function resolveSubject(email, plane) {
  const answer = await planeCall(plane, `/api/internal/identity/resolve?email=${encodeURIComponent(email)}`);
  if (answer.status === 404 || answer.status === 409) return null;
  if (!answer.ok) {
    throw new GatewayError(`the tenancy service refused to resolve ${email} (HTTP ${answer.status})`, answer.status);
  }
  const sub = (answer.payload ?? {}).sub;
  return typeof sub === "string" && sub.trim() !== "" ? sub.trim() : null;
}

/**
 * In-process cache of `address → gateway key`, the same shape and lifetime as
 * Genie's caller cache: short enough that a revoked account stops working
 * promptly, because the quota verdict itself is never cached.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

/** Only for tests: a cached key would leak between cases. */
export function resetGatewayCache() {
  cache.clear();
}

/**
 * The account that pays for this address, or null when the plane does not know it.
 *
 * `key` may be "" on a single-operator deployment whose gateway wants no key; the
 * gateway then answers for itself. Throws `GatewayError` when a configured plane
 * cannot answer, because a configured-but-broken tenancy service must be loud,
 * not silently replaced by an unattributed shared key.
 */
export async function accountFor(email, { env = process.env, plane = planeConfig(env) } = {}) {
  if (plane === null) {
    return { key: sharedKey(env), sub: "", userId: "", plan: "operator", email };
  }

  const cached = cache.get(email);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.account;

  const sub = await resolveSubject(email, plane);
  if (sub === null) return null;

  const answer = await planeCall(plane, "/api/internal/identity", {
    method: "POST",
    body: { sub, email, name: email },
  });
  if (!answer.ok) {
    throw new GatewayError(`the tenancy service refused to identify ${email} (HTTP ${answer.status})`, answer.status);
  }

  const payload = answer.payload ?? {};
  const key = typeof payload.gatewayKey === "string" ? payload.gatewayKey.trim() : "";
  if (key === "") throw new GatewayError(`the tenancy service returned no gateway key for ${email}`);

  const account = {
    key,
    sub,
    userId: typeof payload.user?.id === "string" ? payload.user.id : "",
    plan: typeof payload.quota?.plan === "string" ? payload.quota.plan : "free",
    email,
  };
  cache.set(email, { at: Date.now(), account });
  return account;
}

/**
 * May this key start another completion?
 *
 * Fail-open, deliberately: see the module comment. The reasons are the plane's
 * own words and are shown to the person, which is why they are passed through
 * rather than replaced with "quota exceeded".
 */
export async function quotaFor(key, { env = process.env, plane = planeConfig(env) } = {}) {
  if (plane === null) return { allowed: true, reasons: [] };
  try {
    const answer = await planeCall(plane, "/api/internal/quota-check", { bearer: key });
    if (!answer.ok) return { allowed: true, reasons: [] };
    const reasons = Array.isArray(answer.payload?.reasons)
      ? answer.payload.reasons.filter((reason) => typeof reason === "string")
      : [];
    return { allowed: answer.payload?.allowed === true, reasons };
  } catch {
    return { allowed: true, reasons: [] };
  }
}

/**
 * What one completion cost, read from the gateway's own usage report.
 *
 * The OpenAI shape is `prompt_tokens` / `completion_tokens`; the aliases are
 * accepted because one gateway in front of many providers is exactly where a
 * second spelling turns up, and a ledger that silently counted zero would look
 * like a free month.
 */
export function usageFrom(payload, model = "") {
  const record =
    typeof payload === "object" && payload !== null && typeof payload.usage === "object" && payload.usage !== null
      ? payload.usage
      : {};
  const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const tokensIn = count(record.prompt_tokens ?? record.input_tokens ?? record.tokens_in);
  const tokensOut = count(record.completion_tokens ?? record.output_tokens ?? record.tokens_out);
  const served = typeof payload?.model === "string" && payload.model !== "" ? payload.model : model;
  return { tokensIn, tokensOut, requests: 1, model: String(served).slice(0, 200) };
}

/**
 * Record a finished completion. Best-effort, and never awaited by a response
 * path that could fail because of it.
 */
export async function reportUsage(key, usage, { env = process.env, plane = planeConfig(env) } = {}) {
  if (plane === null || usage === null) return;
  try {
    await planeCall(plane, "/api/internal/usage-report", {
      method: "POST",
      bearer: key,
      body: {
        tokensIn: Math.max(0, Math.round(usage.tokensIn) || 0),
        tokensOut: Math.max(0, Math.round(usage.tokensOut) || 0),
        requests: Math.max(1, Math.round(usage.requests) || 1),
        ...(usage.model ? { model: usage.model } : {}),
      },
    });
  } catch {
    // Deliberately swallowed, and never logged with the key: the completion has
    // already happened, so failing it after the fact trades an accounting gap for
    // a broken answer.
  }
}
