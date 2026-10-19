/**
 * OnTrak Engineer: the metered add-on, seen from the console that runs it.
 *
 * Engineer is Genie's reverse-engineering add-on. REA's tools do the analysis — they
 * arrive over MCP (see `mcp-tools.ts`) and Ghidra does the native work in this
 * image — and this module is the part that makes it *paid for*: one credit per
 * project, bought from Magnate at $5 a credit, spent against a balance the control
 * plane holds.
 *
 * WHY THE SPEND GOES THROUGH THE CONTROL PLANE AND NOT HERE
 * --------------------------------------------------------
 * A console that decided its own charges would be a second ledger, and the second
 * one is always the one that disagrees. So the console asks Distro for the balance,
 * asks Distro to spend, and reports Distro's answer — including a refusal, which is
 * a real answer a person can act on ("you have none left; buy some") rather than an
 * error. Three consequences worth stating:
 *
 *   * **The charge is idempotent**, because it carries the project as its
 *     reference: a retried request, a refreshed page, or a second tab starting the
 *     same project charges once. That property lives in the plane's ledger, and this
 *     module relies on it rather than re-implementing it.
 *   * **A service account is unlimited**, so the platform's own machines never need
 *     a balance — the plane answers that, not this file.
 *   * **A deployment with no control plane keeps working**: with no plane
 *     configured, or a plane that cannot be reached, the gate fails *open* for the
 *     operator and says so. Genie runs single-operator out of the box, and an
 *     operator's own console must not stop analysing things because a billing
 *     service is unset. `gated: false` is how a caller knows the charge did not
 *     happen.
 */

import { config } from "./config.js";
import { controlPlaneEnabled, readControlPlaneConfig, type ControlPlaneConfig } from "./controlplane.js";

/** The product key every ledger row for this add-on uses. */
export const ENGINEER_PRODUCT = "engineer";

/** What the control plane answers about a balance. */
export interface CreditStatus {
  /** Whether another project may be started. */
  allowed: boolean;
  /** Credits left, or `null` for a service account (which has no balance to run out of). */
  balance: number | null;
  /** True when the account is the platform's own machine rather than a customer. */
  unlimited: boolean;
  creditsPerProject: number | null;
  pricePerCreditUsd: number | null;
  reason: string;
  /** False when no charge was asked for — an unconfigured or unreachable plane. */
  gated: boolean;
}

/** The verdict for one charge. */
export interface CreditCharge extends CreditStatus {
  /** Credits actually taken by *this* call: 0 for a duplicate or a service account. */
  spent: number;
  /** True when the same project had already been charged. */
  duplicate: boolean;
}

/** A gate that could not be asked, as opposed to one that answered "no". */
export class CreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditError";
  }
}

/** The ungated answer: what a deployment with no billing returns. */
function ungated(reason: string): CreditStatus {
  return {
    allowed: true,
    balance: null,
    unlimited: true,
    creditsPerProject: null,
    pricePerCreditUsd: null,
    reason,
    gated: false,
  };
}

/** One JSON call to the plane's credit routes, with the service credential. */
async function callCredits(
  plane: ControlPlaneConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${plane.url}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        "x-control-internal-token": plane.token,
        // A balance that is even a minute old is a decision about somebody else's
        // money, so nothing between here and the plane may serve a cached answer.
        "cache-control": "no-store",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new CreditError(`could not reach the control plane to settle credits: ${(error as Error).message}`);
  }

  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const reason = typeof record.error === "string" && record.error !== "" ? record.error : `HTTP ${response.status}`;
    throw new CreditError(`the control plane refused that credit call: ${reason}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CreditError("the control plane answered the credit call with something that is not an object");
  }
  return payload as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStatus(payload: Record<string, unknown>): CreditStatus {
  const balance = numberOrNull(payload.balance);
  return {
    allowed: payload.allowed === true,
    balance,
    unlimited: payload.unlimited === true,
    creditsPerProject: numberOrNull(payload.credits_per_project),
    pricePerCreditUsd: numberOrNull(payload.price_per_credit_usd),
    reason: typeof payload.reason === "string" ? payload.reason : "",
    gated: true,
  };
}

/**
 * What this account may do next, in Engineer's terms.
 *
 * Never throws for a deployment without a control plane, and never throws for a
 * plane that is down either — a console must still render. It returns the ungated
 * answer with a reason saying why, and `gated: false` marks it as one.
 */
export async function creditStatusFor(email: string): Promise<CreditStatus> {
  if (!controlPlaneEnabled()) return ungated("no control plane configured: credits are not metered here");
  const plane = readControlPlaneConfig();
  if (plane === null) return ungated("control plane not configured");

  try {
    const payload = await callCredits(
      plane,
      `/api/internal/credits?user=${encodeURIComponent(email)}&product=${ENGINEER_PRODUCT}`,
    );
    if (payload.reason === "user_not_found") {
      // An account this console knows and the plane does not is a deployment
      // problem, not a customer with no credits — and charging nothing is the
      // honest response to "nobody here can tell me".
      return ungated("this address has no account in the control plane");
    }
    return parseStatus(payload);
  } catch (error) {
    return ungated((error as Error).message);
  }
}

/**
 * Charge one project, and say what happened.
 *
 * `reference` is the project — the idempotency key that makes a retry free. Without
 * one the charge still works and is simply not deduplicated, which is why callers
 * are expected to pass one: a project id, or the workspace path it ran in.
 */
export async function chargeProject(email: string, reference: string | null): Promise<CreditCharge> {
  if (!controlPlaneEnabled()) {
    return { ...ungated("no control plane configured: nothing was charged"), spent: 0, duplicate: false };
  }
  const plane = readControlPlaneConfig();
  if (plane === null) {
    return { ...ungated("control plane not configured"), spent: 0, duplicate: false };
  }

  const payload = await callCredits(plane, "/api/internal/credits/spend", {
    method: "POST",
    body: {
      user: email,
      product: ENGINEER_PRODUCT,
      ...(reference === null ? {} : { reference }),
      reason: reference === null ? "engineer project" : `engineer project ${reference}`,
    },
  });

  if (payload.ok === false) {
    // A refusal is an answer: the caller shows the balance and the price rather
    // than an error, and nothing was charged.
    const refused = parseStatus({ ...payload, allowed: false, reason: payload.code ?? payload.reason });
    return { ...refused, spent: 0, duplicate: false };
  }

  return {
    allowed: true,
    balance: numberOrNull(payload.balance),
    unlimited: payload.service === true,
    creditsPerProject: null,
    pricePerCreditUsd: null,
    reason: payload.service === true ? "service account: nothing to charge" : "charged",
    gated: true,
    spent: numberOrNull(payload.spent) ?? 0,
    duplicate: payload.duplicate === true,
  };
}

/** True when this deployment has an MCP server that can actually analyse something. */
export function engineerConfigured(): boolean {
  return config.mcpServers.trim() !== "" || config.mcpConfigPaths.length > 0;
}
