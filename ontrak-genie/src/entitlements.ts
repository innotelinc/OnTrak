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
 *
 * Since 2026-10-18 the question goes through the control plane
 * (`/api/internal/entitlement` on Distro) rather than straight to Magnate, so the
 * answer carries the whole subscription: Magnate's verdict, the plan's limits,
 * and the rule that a service account has no limits at all. Two things follow,
 * and both are handled here rather than at each call site:
 *
 *   * the credential changes with the route — Distro's internal route wants
 *     `x-control-internal-token`, Magnate's public one wants a `Bearer`;
 *   * a service account is `entitled: true` with no limits, so a preview name or
 *     an Atlas class is granted and nothing downstream tries to meter it.
 */

import { config } from "./config.js";

/** A question that could not be answered at all, as opposed to answered "no". */
export class EntitlementError extends Error {}

/**
 * What a plan allows, when the answer came from the control plane.
 *
 * `null` throughout means "no limit", which is not the same as zero: a service
 * account is unlimited, and a plan that meters only spend leaves the token caps
 * unset. Callers must not read `null` as "nothing allowed".
 */
export interface PlanLimits {
  requestsPerDay: number | null;
  tokensPerDay: number | null;
  spendCapUsd: number | null;
}

export interface Entitlement {
  /** `false` is a real refusal; `null` means it could not be checked. */
  entitled: boolean | null;
  reason: string;
  /** The plan the answer was keyed on, as the authority named it. */
  plan: string;
  /** Whether the subscriber is a service account (no subscription, no limits). */
  service: boolean;
  /** What the plan meters, or `null` when the answer carried none. */
  limits: PlanLimits | null;
}

/**
 * The shape of the answer, which is Magnate's contract whether the request went
 * to Magnate or to the control plane in front of it. The extra fields are
 * optional because a deployment still pointed straight at Magnate gets the
 * older, smaller answer.
 */
interface EntitlementAnswer {
  entitled?: boolean | null;
  reason?: string;
  plan?: string;
  service?: boolean;
  limits?: { requests_per_day?: number | null; tokens_per_day?: number | null; spend_cap_usd?: number | null } | null;
}

/** Whether a number from the answer is a real cap (not absent, not negative). */
function cap(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
 * Whether an endpoint is the control plane's internal entitlement route.
 *
 * Matched on the path rather than on the host: the plane runs on a container
 * address in one deployment and behind the edge in another, and the one thing
 * that stays true is the route it serves. A trailing slash is tolerated because
 * both forms appear in real `.env` files.
 */
export function isControlPlaneRoute(endpoint: string): boolean {
  try {
    const path = new URL(endpoint).pathname.replace(/\/+$/, "");
    return path === "/api/internal/entitlement";
  } catch {
    return false;
  }
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
  if (isControlPlaneRoute(base)) {
    // Distro's internal route authenticates a service with its shared internal
    // token, not with a billing bearer. Without it the route refuses outright,
    // and since this is a *configuration* question rather than a refusal it is
    // reported as an error instead of being allowed to look like "no".
    if (config.controlToken === "") {
      throw new EntitlementError(`MAGNATE_ENTITLEMENTS_URL points at the control plane but CONTROL_INTERNAL_TOKEN is unset, so ${question.unavailable}`);
    }
    headers["x-control-internal-token"] = config.controlToken;
  } else if (config.magnateEntitlementsToken !== "") {
    headers.Authorization = `Bearer ${config.magnateEntitlementsToken}`;
  }

  let answer: EntitlementAnswer;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    answer = (await response.json()) as EntitlementAnswer;
  } catch (error) {
    throw new EntitlementError(`could not reach Magnate to check the entitlement: ${(error as Error).message}`);
  }

  const raw = answer.limits;
  return {
    entitled: answer.entitled === true,
    reason: typeof answer.reason === "string" ? answer.reason : "",
    plan: typeof answer.plan === "string" && answer.plan !== "" ? answer.plan : question.plan,
    service: answer.service === true,
    limits: raw === null || raw === undefined
      ? null
      : {
          requestsPerDay: cap(raw.requests_per_day),
          tokensPerDay: cap(raw.tokens_per_day),
          spendCapUsd: cap(raw.spend_cap_usd),
        },
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
  const origin = magnateOrigin();
  if (origin === "") return "";
  return `${origin}/signup?plan=${encodeURIComponent(plan)}`;
}

/**
 * What a plan costs, as Magnate prices it.
 *
 * The console is not the price list: the number a person is shown has to be the
 * number the checkout charges, or the panel is quoting a price out of thin air.
 * Magnate publishes its own catalog at `/api/plans`, so a panel asks *it* rather
 * than hardcoding anything — which is also what makes a price change on the
 * billing side a change nobody has to mirror here.
 *
 * Asked of the *API* origin (`magnateApiOrigin`), not the shop: the shop is a
 * human page and answers a JSON request with HTML.
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
  // No entitlement endpoint means no billing on this deployment at all, and a
  // console with no billing has nothing to sell — the empty string is the
  // contract several call sites already branch on, so it comes first.
  if (config.magnateEntitlementsUrl === "") return "";
  return originOf([config.magnatePublicUrl, config.magnateEntitlementsUrl]);
}

/**
 * Where Magnate's API answers — the catalog and the account tools.
 *
 * Split from the shop by the estate's own layout: `subscribe.innotel.us` is a
 * page per service (and answers every other path with HTML), while
 * `app.magnate.innotel.us` is the API. A reader that asked the shop for JSON got
 * a 200 and no plans, which is exactly the silent nothing this module is written
 * to avoid — so the API gets its own setting and falls back to the entitlement
 * endpoint, which is right whenever one host does everything.
 */
export function magnateApiOrigin(): string {
  // Same contract as the shop above: a deployment with no billing configured has
  // no price to quote, so an API host typed into a `.env` alone must not conjure
  // one. `null` is what a panel renders as "no price", and it has to stay reachable.
  if (config.magnateEntitlementsUrl === "") return "";
  if (config.magnateApiUrl !== "") {
    const api = originOf([config.magnateApiUrl]);
    if (api !== "") return api;
  }
  return originOf([config.magnateEntitlementsUrl]);
}

/** The first candidate that parses as a URL, as an origin. `""` when none does. */
function originOf(candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return new URL(candidate).origin;
    } catch {
      continue;
    }
  }
  return "";
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

  const origin = magnateApiOrigin();
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
