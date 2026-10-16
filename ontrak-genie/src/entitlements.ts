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

/**
 * What a plan costs, as Magnate prices it.
 *
 * The console is not the price list: the number a person is shown has to be the
 * number the checkout charges, or the panel is quoting a price out of thin air.
 * Magnate publishes its own catalog at `/api/plans`, so a panel asks *it* rather
 * than hardcoding anything — which is also what makes a price change on the
 * billing side a change nobody has to mirror here.
 */
export interface PlanPrice {
  slug: string;
  name: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  /**
   * The unit a per-unit plan is sold in multiples of (e.g. `class`), and what
   * one of them costs per month.
   *
   * Atlas is priced per class rather than per subscription, and the two shapes
   * say different things: `$27.50 a month` is a price for the whole account, and
   * a panel that showed it beside a per-class plan would quote the price of one
   * class as the price of the add-on. Empty unit + `perUnit: false` is the usual
   * monthly/yearly plan.
   */
  billingUnit: string;
  pricePerUnitCents: number;
  /** Magnate's own answer to "is this sold per unit", not re-derived here. */
  perUnit: boolean;
}

/**
 * Magnate's origin, parsed from the entitlements endpoint this deployment sets.
 *
 * One address for the whole platform: the entitlement API, the signup pages and
 * the public plan catalog are routes on the same origin, so none of them takes a
 * setting of its own — a second one could point at another environment and sell
 * the wrong thing.
 */
export function magnateOrigin(): string {
  const configured = config.magnateEntitlementsUrl;
  if (configured === "") return "";
  try {
    return new URL(configured).origin;
  } catch {
    return "";
  }
}

/** Coerce one row of Magnate's public plan catalog into the shape a console renders. */
function coercePrice(row: unknown): PlanPrice | null {
  if (row === null || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (typeof value.slug !== "string" || value.slug === "") return null;
  const monthly = Number(value.priceMonthlyCents);
  const yearly = Number(value.priceYearlyCents);
  const perUnit = Number(value.pricePerUnitCents);
  const unit = typeof value.billingUnit === "string" ? value.billingUnit.trim() : "";
  return {
    slug: value.slug,
    name: typeof value.name === "string" && value.name !== "" ? value.name : value.slug,
    // A missing or nonsensical price is not corrected into a plausible one: the
    // caller is told there is no price rather than handed a number nobody set.
    priceMonthlyCents: Number.isFinite(monthly) && monthly >= 0 ? monthly : -1,
    priceYearlyCents: Number.isFinite(yearly) && yearly >= 0 ? yearly : -1,
    billingUnit: unit,
    pricePerUnitCents: Number.isFinite(perUnit) && perUnit >= 0 ? perUnit : -1,
    // Whether the plan is per-unit is Magnate's call, and it is the one field a
    // reader has to trust rather than infer: a unit with no price (or the
    // reverse) is a plan whose per-unit amount is not settled, and both halves
    // are needed before a panel may quote one.
    perUnit: value.perUnit === true && unit !== "" && Number.isFinite(perUnit) && perUnit > 0,
  };
}

const priceCache = new Map<string, { at: number; price: PlanPrice | null }>();
const PRICE_TTL_MS = 10 * 60_000;

/** Forget every cached price. For tests, which change what Magnate answers. */
export function resetPriceCache(): void {
  priceCache.clear();
}

/**
 * What Magnate charges for `service`, or `null` when it cannot be said.
 *
 * `null` is a real answer and deliberately distinct from a zero: a deployment with
 * no billing configured, or a catalog that does not carry the plan yet, has no
 * price to quote, and a console that showed one anyway would be inventing it. The
 * caller decides what to render — the signup link is still worth showing.
 *
 * Cached briefly per service, and never throws: a billing platform that is slow or
 * down must not turn a product panel into an error.
 */
export async function planPrice(service: string): Promise<PlanPrice | null> {
  const cached = priceCache.get(service);
  if (cached !== undefined && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;

  const origin = magnateOrigin();
  if (origin === "") return null;
  let price: PlanPrice | null = null;
  try {
    const response = await fetch(
      `${origin}/api/plans?service=${encodeURIComponent(service)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (response.ok) {
      const payload = (await response.json()) as { plans?: unknown[] };
      const rows = Array.isArray(payload.plans) ? payload.plans : [];
      const match = rows.find((row) => {
        const coerced = coercePrice(row);
        return coerced !== null && coerced.slug === service;
      });
      price = match === undefined ? null : coercePrice(match);
    }
  } catch {
    price = null;
  }
  priceCache.set(service, { at: Date.now(), price });
  return price;
}
