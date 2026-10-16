/**
 * One entitlement question, asked of Magnate.
 *
 * The platform sells several things a console can grant, and Genie now asks about
 * two of them: a *named* preview address (the `genie` plan, checked in
 * `preview-hosting.ts`) and Atlas, the ecosystem's forge, which is an add-on of its
 * own. Both questions have the same shape — one plan, one subscriber, one bearer,
 * one `entitled` in the answer — and the contract belongs to Magnate, so it lives
 * in one place rather than in two copies that can drift apart.
 *
 * The distinction that matters is between a *refusal* and a *failure*. A plan that
 * does not include the add-on is `entitled: false` and the caller says so; a
 * Magnate that cannot be reached, or is not configured, is an **error**, because
 * telling a paying subscriber their subscription is inactive when the billing
 * platform is simply down is the one wrong answer here. Each caller decides what
 * to do about that — a preview name is refused, while Atlas falls back to the
 * deployment's own credential when it holds one.
 */

import { config } from "./config.js";

/** A question that could not be answered at all, as opposed to answered "no". */
export class EntitlementError extends Error {}

export interface Entitlement {
  /** `false` is a real refusal; `null` means it could not be checked. */
  entitled: boolean | null;
  reason: string;
}

/** The shape of the answer Magnate's entitlement API returns. */
interface EntitlementAnswer {
  entitled?: boolean | null;
  reason?: string;
}

export interface EntitlementQuestion {
  /** The plan slug this deployment sells for the thing being asked about. */
  plan: string;
  /** The subscriber identity — an address, in Magnate's terms. */
  user: string;
  /**
   * The tail of the message when Magnate is not configured at all, phrased to
   * complete "MAGNATE_ENTITLEMENTS_URL is not set, so …" — e.g. "custom preview
   * names are unavailable".
   */
  unavailable: string;
}

/**
 * Ask Magnate whether `user` holds `plan`.
 *
 * Throws `EntitlementError` when the question cannot be asked or answered, so the
 * two failure modes stay distinguishable at the call site: an unconfigured
 * deployment and an unreachable billing platform are not refusals, and neither is
 * a silent "no" either.
 */
export async function checkEntitlement(question: EntitlementQuestion): Promise<Entitlement> {
  const base = config.magnateEntitlementsUrl;
  if (base === "") {
    throw new EntitlementError(`MAGNATE_ENTITLEMENTS_URL is not set, so ${question.unavailable}`);
  }
  const url = `${base}?plan=${encodeURIComponent(question.plan)}&user=${encodeURIComponent(question.user)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.magnateEntitlementsToken !== "") {
    headers.Authorization = `Bearer ${config.magnateEntitlementsToken}`;
  }

  let answer: EntitlementAnswer;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    answer = (await response.json()) as EntitlementAnswer;
  } catch (error) {
    throw new EntitlementError(`could not reach Magnate to check the entitlement: ${(error as Error).message}`);
  }

  return {
    entitled: answer.entitled === true,
    reason: typeof answer.reason === "string" ? answer.reason : "",
  };
}

/**
 * Where a person buys a plan, when this deployment can tell them.
 *
 * Derived from the entitlements endpoint rather than configured separately, so the
 * link a person is sent to is on the same Magnate the console asked — a second
 * setting could point at a different environment and sell the wrong thing.
 */
export function signupUrlFor(plan: string): string {
  const base = config.magnateEntitlementsUrl;
  if (base === "") return "";
  try {
    return `${new URL(base).origin}/signup?plan=${encodeURIComponent(plan)}`;
  } catch {
    return "";
  }
}
