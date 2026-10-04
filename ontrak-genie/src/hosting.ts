import path from "node:path";

import { config } from "./config.js";
import { detectPreviewCommand } from "./preview.js";
import {
  createPreview,
  hostingEnabled,
  listPreviews,
  magnateEntitled,
  previewPublic,
  PreviewError,
  removePreview,
  stopPreview,
  type Preview,
} from "./preview-hosting.js";
import { workspaceRoot } from "./scope.js";

/**
 * Publish & host — the paid half of the preview feature.
 *
 * A local preview (`src/preview.ts`) is reached in this console only. Hosting
 * (`src/preview-hosting.ts`) puts an app on the network under
 * `*.genie.innotel.us`; an auto address is `p<port>`, free and temporary, and a
 * *named* one (`acme.genie.innotel.us`) is what the Magnate `genie` plan sells for
 * $5/month or $50/year.
 *
 * This module is the console's view of that bargain. It answers three questions
 * the UI cannot work out for itself — is hosting on, what does the plan cost, and
 * is *this* caller entitled — and it turns "publish" into the one call that
 * actually creates the address. The prices are read from Magnate's public
 * `/api/plans` so the console quotes the same number the checkout charges, with
 * the shipped price as the fallback when Magnate cannot be reached.
 *
 * Nothing here grants a name on the browser's say-so: a custom name goes through
 * `createPreview`, which asks Magnate's entitlement API before it registers
 * anything.
 */

export interface HostingPlan {
  slug: string;
  name: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
}

/**
 * The price the shipped plan sells for, used until Magnate answers.
 *
 * Duplicating the number here is deliberate: a console whose own status must not
 * depend on the billing platform being up still has to be able to say what
 * publishing costs, and these two values are the ones `lib/db.ts` seeds the plan
 * with. A read from Magnate overrides them the moment it succeeds.
 */
export const FALLBACK_PLAN: HostingPlan = {
  slug: "genie",
  name: "Genie Subdomain",
  priceMonthlyCents: 500,
  priceYearlyCents: 5000,
};

export interface HostingInfo {
  enabled: boolean;
  domain: string;
  scheme: string;
  plan: HostingPlan;
  /** Where a person buys the plan (Magnate's signup, prefilled with the slug). */
  subscribeUrl: string;
  /** The identity an entitlement is checked against, or "" when there is none. */
  user: string;
  /** null when the entitlement could not be checked (no URL, or Magnate is down). */
  entitled: boolean | null;
  /** A short reason, for the UI. Never a credential. */
  entitlementReason: string;
  /** Every published address, this account's and the deployment's. */
  previews: ReturnType<typeof previewPublic>[];
  /** The command publishing would run, when one can be worked out. */
  command: string | null;
}

/** Magnate's origin, parsed from the entitlements endpoint the deployment sets. */
function magnateOrigin(): string {
  const configured = config.magnateEntitlementsUrl;
  if (configured === "") return "";
  try {
    return new URL(configured).origin;
  } catch {
    return "";
  }
}

/** Where publishing is bought. Empty when Magnate is not configured. */
export function subscribeUrl(): string {
  const origin = magnateOrigin();
  if (origin === "") return "";
  return `${origin}/signup?plan=${encodeURIComponent(config.magnatePlan)}`;
}

let planCache: { at: number; plan: HostingPlan } | null = null;
const PLAN_TTL_MS = 10 * 60_000;

/** Coerce Magnate's public plan row into the shape the console renders. */
function coercePlan(row: unknown): HostingPlan | null {
  if (row === null || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (typeof value.slug !== "string" || value.slug === "") return null;
  const monthly = Number(value.priceMonthlyCents);
  const yearly = Number(value.priceYearlyCents);
  return {
    slug: value.slug,
    name: typeof value.name === "string" && value.name !== "" ? value.name : FALLBACK_PLAN.name,
    priceMonthlyCents: Number.isFinite(monthly) && monthly > 0 ? monthly : FALLBACK_PLAN.priceMonthlyCents,
    priceYearlyCents: Number.isFinite(yearly) && yearly >= 0 ? yearly : FALLBACK_PLAN.priceYearlyCents,
  };
}

/**
 * The plan as Magnate prices it, cached briefly.
 *
 * Best-effort on purpose: a billing platform that is slow or down must not turn
 * the console's hosting panel into an error, so the shipped price stands in.
 */
export async function hostingPlan(): Promise<HostingPlan> {
  if (planCache !== null && Date.now() - planCache.at < PLAN_TTL_MS) return planCache.plan;
  const origin = magnateOrigin();
  if (origin === "") return FALLBACK_PLAN;
  try {
    const response = await fetch(
      `${origin}/api/plans?service=${encodeURIComponent(config.magnatePlan)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return FALLBACK_PLAN;
    const payload = (await response.json()) as { plans?: unknown[] };
    const rows = Array.isArray(payload.plans) ? payload.plans : [];
    const plan = rows.map(coercePlan).find((row): row is HostingPlan => row !== null) ?? null;
    if (plan === null) return FALLBACK_PLAN;
    planCache = { at: Date.now(), plan };
    return plan;
  } catch {
    return FALLBACK_PLAN;
  }
}

/**
 * Is this caller allowed to hold a named address?
 *
 * Returns `null` rather than `false` when the question could not be asked, so the
 * UI can say "could not check" instead of telling a paying subscriber their
 * subscription is inactive because Magnate hiccupped.
 */
async function entitlement(user: string): Promise<{ entitled: boolean | null; reason: string }> {
  if (config.magnateEntitlementsUrl === "") {
    return { entitled: null, reason: "no billing platform is configured" };
  }
  if (user === "") {
    return { entitled: null, reason: "sign in to check your subscription" };
  }
  try {
    return { entitled: await magnateEntitled(user), reason: "" };
  } catch (error) {
    return { entitled: null, reason: (error as Error).message };
  }
}

/** Everything the hosting panel needs, in one round trip. */
export async function hostingInfo(user: string): Promise<HostingInfo> {
  const enabled = hostingEnabled();
  const [plan, entitlementResult, previews] = await Promise.all([
    hostingPlan(),
    enabled ? entitlement(user) : Promise.resolve({ entitled: null, reason: "" }),
    enabled ? listPreviews() : Promise.resolve([] as Preview[]),
  ]);
  const suggestion = enabled ? detectPreviewCommand(workspaceRoot()) : null;
  return {
    enabled,
    domain: config.previewDomain,
    scheme: config.previewScheme,
    plan,
    subscribeUrl: subscribeUrl(),
    user,
    entitled: entitlementResult.entitled,
    entitlementReason: entitlementResult.reason,
    previews: previews.map(previewPublic),
    command: suggestion?.command ?? (config.previewCommand !== "" ? config.previewCommand : null),
  };
}

export interface PublishResult {
  preview: ReturnType<typeof previewPublic>;
  url: string;
}

export interface PublishOptions {
  /** Requested label, or "" for a free `p<port>` address. */
  name?: string;
  /** The account the address is created under. */
  account?: string;
  /** Magnate subscriber identity — required for a custom name. */
  user?: string;
  /** Override the detected command (the UI shows what it will run). */
  command?: string;
}

/**
 * Publish the current workspace.
 *
 * The command is the one the console already detects for the local preview, so
 * "publish" runs the same thing "run" does — a second guess would be a second
 * answer to the same question. A named address is checked against Magnate by
 * `createPreview`; an auto one is free and needs no entitlement.
 */
export async function publish(options: PublishOptions = {}): Promise<PublishResult> {
  if (!hostingEnabled()) throw new PreviewError("preview hosting is not enabled");

  const requested = (options.name ?? "").trim();
  const suggestion = detectPreviewCommand(workspaceRoot());
  const command = options.command?.trim() || suggestion?.command || config.previewCommand;
  if (command === "") {
    throw new PreviewError(
      "no start command could be worked out for this workspace — ask the agent to run it, or set AGENT_PREVIEW_COMMAND",
    );
  }
  // `detectPreviewCommand` reports a workspace-relative cwd; the preview spawns
  // in it, so it has to be absolute.
  const cwd = path.join(workspaceRoot(), suggestion?.cwd === undefined ? "." : suggestion.cwd);

  const preview = await createPreview({
    ...(requested === "" ? {} : { name: requested }),
    command,
    cwd,
    account: options.account ?? "",
    ...(requested === "" ? {} : { user: options.user ?? "" }),
  });
  return { preview: previewPublic(preview), url: `${config.previewScheme}://${previewPublic(preview).host}` };
}

/** Stop a published app but keep its address registered. */
export async function stopHosting(name: string): Promise<boolean> {
  return await stopPreview(name);
}

/** Withdraw a published address entirely. */
export async function unpublish(name: string): Promise<boolean> {
  return await removePreview(name);
}

/** Only for tests: forget the cached price. */
export function resetPlanCache(): void {
  planCache = null;
}
