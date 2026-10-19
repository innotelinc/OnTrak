/**
 * The control plane's credit routes, as G0DM0D3 needs them.
 *
 * Same wire contract as Genie's `engineer.ts` — the plane already serves it, and
 * two dialects for one ledger is how the two disagree. What this app adds is the
 * *refund*: a run that could not start has to give the credit back, or a customer
 * pays for an outage.
 */

/** A plane call that failed as opposed to one that answered. */
export class CreditError extends Error {
  constructor(message) {
    super(message);
    this.name = "CreditError";
  }
}

/** The plane, or null when this deployment meters nothing. */
export function planeConfig(env = process.env) {
  const url = String(env.CONTROL_PLANE_INTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.CONTROL_INTERNAL_TOKEN ?? "").trim();
  if (url === "" || token === "") return null;
  return { url, token };
}

async function call(plane, path, init) {
  let response;
  try {
    response = await fetch(`${plane.url}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        "x-control-internal-token": plane.token,
        // A balance is a decision about somebody's money; nothing may serve a
        // cached one.
        "cache-control": "no-store",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 8_000),
    });
  } catch (error) {
    throw new CreditError(`could not reach the control plane: ${error.message}`);
  }
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const reason = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new CreditError(`the control plane refused that call: ${reason}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CreditError("the control plane answered with something that is not an object");
  }
  return payload;
}

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseStatus(payload) {
  return {
    allowed: payload.allowed === true,
    balance: num(payload.balance),
    unlimited: payload.unlimited === true,
    creditsPerRun: num(payload.credits_per_project),
    pricePerCreditUsd: num(payload.price_per_credit_usd),
    reason: typeof payload.reason === "string" ? payload.reason : "",
  };
}

/** What this account may do next. Throws `CreditError` when the plane is unaskable. */
export async function creditStatus({ email, product, env }) {
  const plane = planeConfig(env);
  if (plane === null) return { metered: false, unlimited: true, allowed: true, balance: null, creditsPerRun: null, pricePerCreditUsd: null, reason: "no control plane configured: runs are not metered here" };
  const payload = await call(plane, `/api/internal/credits?user=${encodeURIComponent(email)}&product=${encodeURIComponent(product)}`, { method: "GET" });
  if (payload.reason === "user_not_found") {
    // Not a customer with an empty wallet: nobody here can tell us who they are.
    throw new CreditError(`${email} has no account in the control plane`);
  }
  return { metered: true, ...parseStatus(payload) };
}

/**
 * Take one run's credits.
 *
 * `reference` is the run id: the plane deduplicates on it, so a double-submit, a
 * retried request or a reloaded page charges once.
 */
export async function spend({ email, product, credits, reference, reason, env }) {
  const plane = planeConfig(env);
  if (plane === null) return { ok: true, metered: false, spent: 0, duplicate: false, balance: null, code: "" };
  const payload = await call(plane, "/api/internal/credits/spend", {
    method: "POST",
    body: { user: email, product, credits, reference, reason },
  });
  if (payload.ok === false) {
    return {
      ok: false,
      metered: true,
      spent: 0,
      duplicate: false,
      balance: num(payload.balance),
      code: typeof payload.code === "string" ? payload.code : "refused",
    };
  }
  return {
    ok: true,
    metered: true,
    spent: num(payload.spent) ?? 0,
    duplicate: payload.duplicate === true,
    balance: num(payload.balance),
    code: "",
  };
}

/** Give a charge back, for a run that never produced a single byte. */
export async function refund({ email, product, credits, reference, reason, env }) {
  const plane = planeConfig(env);
  if (plane === null) return { ok: true, metered: false };
  try {
    await call(plane, "/api/internal/credits/grant", {
      method: "POST",
      body: { user: email, product, credits, reference: `refund-${reference}`, reason },
    });
    return { ok: true, metered: true };
  } catch (error) {
    // A refund that fails is reported, never thrown: the run already failed, and
    // turning its cleanup into a second error hides the first.
    return { ok: false, metered: true, error: error.message };
  }
}
