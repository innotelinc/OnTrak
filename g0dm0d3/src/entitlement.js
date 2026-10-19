/**
 * Is this account subscribed to this product?
 *
 * The control plane answers that (`/api/internal/entitlement`, which in turn asks
 * Magnate), and the answer has three states — not two:
 *
 *   * **entitled** — the subscription is live (or the account is the platform's own
 *     service account, which has no subscription and no limits).
 *   * **not entitled** — a real answer about a real account: there is no
 *     subscription, so the page offers one. This is the state a paywall exists for.
 *   * **unknown** — the plane or the billing service could not be asked. Saying
 *     "subscribe" here would be selling somebody a thing they may already own, and
 *     refusing would turn a billing outage into an outage of this product, so the
 *     page says it cannot check and the run is refused as *retryable*.
 *
 * Keeping those apart is the whole point of the module: the naive version — treat
 * anything that is not `true` as "not subscribed" — is a page that lies during an
 * outage.
 */

export class EntitlementError extends Error {
  constructor(message) {
    super(message);
    this.name = "EntitlementError";
  }
}

/** The plane, or null when this deployment has no billing wired at all. */
function planeConfig(env) {
  const url = String(env.CONTROL_PLANE_INTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.CONTROL_INTERNAL_TOKEN ?? "").trim();
  if (url === "" || token === "") return null;
  return { url, token };
}

/**
 * The subscription state for one address and one product.
 *
 * A deployment with no control plane is unmetered and unsubscribed-to-nothing: that
 * is `unknown` with `metered: false`, and the caller treats it as "no gate here"
 * rather than as a refusal (Genie ships as a single-operator tool, and a portal that
 * refused everything without a billing service would be useless on a laptop).
 */
export async function entitlementFor({ email, plan, env = process.env }) {
  const plane = planeConfig(env);
  if (plane === null) {
    return { state: "unknown", metered: false, plan: null, reason: "no control plane configured", service: false };
  }

  let response;
  try {
    response = await fetch(
      `${plane.url}/api/internal/entitlement?user=${encodeURIComponent(email)}&plan=${encodeURIComponent(plan)}`,
      {
        method: "GET",
        headers: { "x-control-internal-token": plane.token, "cache-control": "no-store" },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch (error) {
    return { state: "unknown", metered: true, plan: null, reason: `could not reach the control plane: ${error.message}`, service: false };
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok || payload === null || typeof payload !== "object") {
    return {
      state: "unknown",
      metered: true,
      plan: null,
      reason: `the control plane answered the entitlement question with ${response.ok ? "something unreadable" : `HTTP ${response.status}`}`,
      service: false,
    };
  }

  const plan_name = typeof payload.plan === "string" ? payload.plan : null;
  const service = payload.service === true;
  const source = typeof payload.source === "string" ? payload.source : "";

  if (service) return { state: "entitled", metered: true, plan: plan_name, reason: "service account: no subscription, no limits", service: true };

  if (payload.entitled === true) {
    return { state: "entitled", metered: true, plan: plan_name, reason: typeof payload.reason === "string" ? payload.reason : "subscribed", service: false };
  }

  if (payload.entitled === false) {
    return {
      state: "not_entitled",
      metered: true,
      plan: plan_name,
      reason: typeof payload.reason === "string" ? payload.reason : "no subscription",
      service: false,
    };
  }

  // `entitled: null` is the plane saying it could not get an answer from billing —
  // Magnate has no such plan, or did not answer. Either way it is not a verdict
  // about this person.
  return {
    state: "unknown",
    metered: true,
    plan: plan_name,
    reason: `billing did not answer for '${plan}' (${source || "no source"})`,
    service: false,
  };
}
