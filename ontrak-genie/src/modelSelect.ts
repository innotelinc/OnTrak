import { config } from "./config.js";
import { modelHealth, type ModelHealthReport } from "./modelHealth.js";

/**
 * Which model a turn is served by, and who gets to choose one.
 *
 * Before this, every turn opened on `AGENT_MODEL` and walked
 * `AGENT_FALLBACK_MODELS` when it throttled — a *static* list, so a model whose
 * credentials were cooling down was still tried first, every turn, and the user
 * paid for it in `429 … retrying with …` notices and in wall-clock time. This
 * module is the other half of that: the free pool is ordered by reliability and
 * filtered by the *live* tool-call health probe, so a turn is placed on a model
 * that answered the last check rather than on one that happens to be first in a
 * file.
 *
 * Two rules, both deliberate:
 *
 *   * **A model the probe has not looked at is unknown, not broken.** It stays in
 *     the chain, behind the ones that passed. Ordering by a probe that has never
 *     run would otherwise silently drop the whole pool to one entry.
 *   * **The chain is never empty.** If every entry is cooling down there is
 *     nothing to prefer, so the pool is returned in configured order and the
 *     existing retry loop does what it always did. Returning `[]` would turn
 *     "everything is throttled" into "no model is configured", which is a
 *     different and much more confusing failure.
 *
 * This is the free half of the rule the console enforces: a paid account chooses
 * its model (`AGENT_MODEL` / the picker), and an account without a paid plan is
 * *served* one, because a free pool is a shared thing that somebody has to place
 * a turn in — and the person best placed to do that is the one holding the health
 * probe.
 */

/** Is this plan one of the free ones (and so served automatically)? */
export function isFreePlan(plan: string): boolean {
  const normalized = plan.trim().toLowerCase();
  if (normalized === "") return true;
  return config.freePlans.some((entry) => entry.trim().toLowerCase() === normalized);
}

/**
 * Does this plan get the automatic model, with no picker?
 *
 * `AGENT_FORCE_AUTO_MODEL` overrides everything: a deployment that does not want
 * the choice offered at all gets the automatic chain regardless of plan.
 */
export function autoSelection(plan: string): boolean {
  return config.forceAutoModel || isFreePlan(plan);
}

/** Drop duplicates, keeping first-seen order. */
function dedupe(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const id = model.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * The chain a turn without a paid plan is served from, strongest-*available*
 * first.
 *
 * The health probe is the whole point: it is the same check that asks a model for
 * one real tool call, so a model that failed it — cooling down, out of credit,
 * unconfigured provider — is moved behind the ones that passed rather than
 * dropped. The last entry of the pool is therefore always still reachable as a
 * last resort, which is what keeps "skip the cooling-down ones" from becoming
 * "give up when the good ones cool down mid-turn".
 */
export function autoFreeChain(report: ModelHealthReport = modelHealth()): string[] {
  const pool = dedupe(config.freeModels.length > 0 ? config.freeModels : [config.model]);
  if (pool.length === 0) return [config.model];

  // No check has run yet: prefer nothing, so return the pool in configured order
  // rather than pretending every model failed.
  if (report.checkedAt === null || report.entries.length === 0) return pool;

  const byModel = new Map(
    report.entries.filter((entry) => !entry.offline).map((entry) => [entry.model, entry]),
  );

  const healthy: string[] = [];
  const rest: string[] = [];
  for (const model of pool) {
    // Known-good first; unknown (never probed) and known-bad keep their order behind it.
    if (byModel.get(model)?.ok === true) healthy.push(model);
    else rest.push(model);
  }
  return healthy.length > 0 ? [...healthy, ...rest] : pool;
}

/**
 * What the UI and the API say about choice for this caller.
 *
 * `mode` is what the client keys off — `auto` hides the picker, `manual` shows it
 * — and it is derived from the same plan the turn gate reads, so a person cannot
 * be shown a picker whose choice the server would then ignore.
 */
export function selectionMode(plan: string): "auto" | "manual" {
  return autoSelection(plan) ? "auto" : "manual";
}
