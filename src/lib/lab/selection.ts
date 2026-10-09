/**
 * Automatic scenario assignment.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/selection.py`. A student should not
 * have to choose which fault to hunt, and an instructor should not have to hand out
 * scenarios one by one: this picks a scenario that (a) the chosen workload can
 * actually run and (b) the class has not seen to death.
 *
 * **The scoring is deliberately explainable.** Every choice carries the reasons it
 * was made, so the instructor view can answer "why did this student get that ticket?"
 * without re-running the algorithm. An assignment nobody can explain is worse than a
 * manual one, which is why the reasons are part of the return value rather than a log
 * line and why `Choice.explain()` exists at all.
 *
 * Two deliberate differences from the Python, both stated rather than silent.
 *
 * **The catalogue and the scenario repository are not ported yet**, so the inputs are
 * described by the narrow structural interfaces below — `SelectableScenario` and
 * `WorkloadFacts` — that the later ports of `scenarios.py` and `catalog.py` will
 * satisfy as they are. Nothing here reaches for a field it does not score on, so the
 * grader can be proven against fixtures before either loader exists.
 *
 * **`random` is deterministic per seed within this port, not bit-compatible with
 * CPython.** Python seeded its own Mersenne Twister; reproducing that generator
 * exactly is possible but pointless, because nothing outside a single class run
 * depends on it. What the contract actually promises — the same seed and history
 * choose the same scenario, so a class can be replayed — is what the small PRNG here
 * provides. With no seed, the choice is genuinely unpredictable, as it was.
 *
 * Pure: no I/O, no clock, no randomness beyond the seeded generator.
 */

import type { Category } from "./models";

/** The strategies the lab accepts, in the order they are named in a refusal. */
export const STRATEGIES = ["balanced", "random", "family", "hardest", "easiest"] as const;

export type Strategy = (typeof STRATEGIES)[number];

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === "string" && (STRATEGIES as readonly string[]).includes(value);
}

/**
 * Categories that make sense when there is no guest automation at all: the student can
 * still be graded on what an observed fix looked like, and the write-up is the point.
 * Everything else would produce silent zeros.
 */
export const MANUAL_FRIENDLY: readonly Category[] = ["hardware", "software", "network", "os"];

/** The difficulty the catalogue is centred on; a scenario's distance from it is a penalty. */
export const TARGET_DIFFICULTY = 2.5;

const HARDWARE: Category = "hardware";

/** The scenario facts selection reads. A structural subset of the scenario loader's type. */
export interface SelectableScenario {
  id: string;
  category: string;
  difficulty: number;
  requiresInternet: boolean;
}

/**
 * The catalog facts selection reads.
 *
 * `kind` decides the hard rejections (`container` cannot host a hardware fault),
 * `scenarioFamilies` decides which categories the workload declares it can host,
 * `profile.devices` says whether there is anything to break, and `automation ===
 * "none"` says the workload cannot verify a network fault at all.
 */
export interface WorkloadFacts {
  id: string;
  kind: string;
  scenarioFamilies: readonly string[];
  profile?: Record<string, unknown>;
  automation?: string;
}

/** A scenario that was filtered out, and the reason to show for it. */
export interface RejectedScenario {
  id: string;
  reason: string;
}

/** The allowed pool and everything refused, each with its reason. */
export interface EligibleResult {
  pool: SelectableScenario[];
  rejected: RejectedScenario[];
}

/**
 * One assignment: what was chosen, its score, why, and what was not eligible.
 *
 * A class rather than a bare object because the Python had a method on it
 * (`Choice.explain()`) that the instructor view and the CLI both call, and because
 * `instanceof Choice` is the shape the tests check.
 */
export class Choice {
  constructor(
    public scenario: SelectableScenario,
    public score: number,
    public reasons: string[] = [],
    public rejected: RejectedScenario[] = [],
  ) {}

  /** The one-line answer to "why this one?", naming the scenario and its score. */
  explain(): string {
    const head = `${this.scenario.id} (score ${this.score.toFixed(2)})`;
    return [head, ...this.reasons].join(" | ");
  }
}

/** `not workload.profile.devices`, with an empty list counting as "no devices". */
function hasDevices(profile: Record<string, unknown> | undefined): boolean {
  const devices = profile ? profile["devices"] : undefined;
  if (Array.isArray(devices)) return devices.length > 0;
  return Boolean(devices);
}

/**
 * Filter scenarios down to what the workload can host, with reasons for the rest.
 *
 * `workload` and `maxDifficulty` are positional and both optional, in the Python's own
 * order, so a call site reads the same in either language. Never throws: an empty pool
 * is a fact for the caller to report (see `choose`), with the first refusal's reason
 * already attached.
 */
export function eligible(
  scenarios: readonly SelectableScenario[],
  workload: WorkloadFacts | null = null,
  maxDifficulty: number | null = null,
): EligibleResult {
  const pool: SelectableScenario[] = [];
  const rejected: RejectedScenario[] = [];
  const allowedFamilies: readonly string[] = workload ? workload.scenarioFamilies : [];

  for (const scenario of scenarios) {
    if (maxDifficulty !== null && scenario.difficulty > maxDifficulty) {
      rejected.push({
        id: scenario.id,
        reason: `difficulty ${scenario.difficulty} above the cap ${maxDifficulty}`,
      });
      continue;
    }
    if (workload) {
      // A container shares the host's kernel, so a device/driver/BCD fault has nothing
      // to be injected into. This is first because it is a fact about the platform
      // rather than a preference, and it is the refusal an operator is most likely to
      // meet when they offer a Windows-only scenario on a Linux container.
      if (workload.kind === "container" && scenario.category === HARDWARE) {
        rejected.push({ id: scenario.id, reason: "hardware scenarios need a VM, not a container" });
        continue;
      }
      if (scenario.category === HARDWARE && !hasDevices(workload.profile)) {
        rejected.push({ id: scenario.id, reason: "no devices to break in this workload profile" });
        continue;
      }
      if (allowedFamilies.length > 0 && !allowedFamilies.includes(scenario.category)) {
        rejected.push({
          id: scenario.id,
          reason: `workload declares families ${allowedFamilies.slice().sort().join(", ")}`,
        });
        continue;
      }
      if (scenario.requiresInternet && workload.automation === "none") {
        rejected.push({
          id: scenario.id,
          reason: "scenario needs internet, workload has no automation to verify it",
        });
        continue;
      }
    }
    pool.push(scenario);
  }
  return { pool, rejected };
}

/** How many times this scenario was already handed out in this class. */
function servedCount(history: readonly string[], scenarioId: string): number {
  return history.filter((served) => served === scenarioId).length;
}

/** The category of each history entry that names a scenario we know, in order. */
function categoriesOf(history: readonly string[], scenarios: readonly SelectableScenario[]): string[] {
  const categories: string[] = [];
  for (const scenarioId of history) {
    const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
    if (scenario) categories.push(scenario.category);
  }
  return categories;
}

/** How many of the class's served scenarios were in this category. */
function categoryCount(categories: readonly string[], category: string): number {
  return categories.filter((seen) => seen === category).length;
}

/** The categories present at least once, in first-seen order. */
function distinctValues(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Element access that satisfies the compiler rather than asserting it away. */
function elementAt<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`index ${index} is outside the list`);
  return value;
}

/**
 * Mulberry32.
 *
 * A small, well-distributed generator with a stable sequence for a given seed: that is
 * all the "random" strategy actually needs, because what has to repeat is the choice,
 * not the exact number stream a CPython process produced (see the module note).
 */
function makeRng(seed: number | null): () => number {
  if (seed === null) return () => Math.random();
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Score one scenario for this class, with the reasons that produced the number.
 *
 * The weights are the Python's and are quoted in the reasons themselves, so an
 * instructor reading the explanation sees the arithmetic rather than a verdict.
 */
function scoreScenario(
  scenario: SelectableScenario,
  workload: WorkloadFacts | null,
  history: readonly string[],
  categories: readonly string[],
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (workload) {
    if (workload.scenarioFamilies.includes(scenario.category)) {
      score += 3;
      reasons.push(`family ${scenario.category} is supported by ${workload.id}`);
    } else if (workload.kind === "vm") {
      score += 0.5;
      reasons.push("any VM scenario is runnable on this workload");
    }
  }

  const served = servedCount(history, scenario.id);
  if (served > 0) {
    // Capped so a scenario served six times is not excluded for the rest of the class:
    // the cap keeps "unseen" ahead of "seen" without ever making a repeat impossible.
    const penalty = Math.min(6, 3 * served);
    score -= penalty;
    reasons.push(`already served ${served}x in this class`);
  } else {
    score += 2;
    reasons.push("not yet served in this class");
  }

  const seenCategories = distinctValues(categories);
  if (seenCategories.length > 0) {
    let fewest = Number.POSITIVE_INFINITY;
    for (const category of seenCategories) {
      fewest = Math.min(fewest, categoryCount(categories, category));
    }
    if (categoryCount(categories, scenario.category) <= fewest) {
      score += 2;
      reasons.push(`category ${scenario.category} is the least used so far`);
    }
  }

  const distance = Math.abs(scenario.difficulty - TARGET_DIFFICULTY);
  score -= distance;
  reasons.push(
    `difficulty ${scenario.difficulty} (${distance <= 0.5 ? "close to" : "further from"} the usual 2-3)`,
  );

  if (scenario.requiresInternet) {
    score -= 1;
    reasons.push("needs internet access, so it is deprioritised");
  }
  return { score, reasons };
}

/**
 * Pick one scenario.
 *
 * Deterministic for a given seed and history. Parameters are positional and optional in
 * the Python's own order (`scenarios, workload, history, strategy, maxDifficulty, seed`),
 * so the two implementations can be read against each other.
 *
 * Throws with a specific message — rather than returning a sentinel — for the three
 * ways there is no assignment to make: an unknown strategy, an empty catalogue, and a
 * workload that fits nothing. Each is an operator error that wants to be read, not
 * handled.
 */
export function choose(
  scenarios: readonly SelectableScenario[],
  workload: WorkloadFacts | null = null,
  history: readonly string[] = [],
  strategy: Strategy | string = "balanced",
  maxDifficulty: number | null = null,
  seed: number | null = null,
): Choice {
  if (!isStrategy(strategy)) {
    throw new Error(`unknown strategy ${JSON.stringify(strategy)}; use one of ${STRATEGIES.join(", ")}`);
  }
  if (scenarios.length === 0) {
    throw new Error("no scenarios available to choose from");
  }

  const { pool: eligiblePool, rejected } = eligible(scenarios, workload, maxDifficulty);
  if (eligiblePool.length === 0) {
    const first = rejected[0];
    throw new Error(`no scenario fits this workload${first ? ` (${first.reason})` : ""}`);
  }
  let pool = eligiblePool;

  const rng = makeRng(seed);
  const categories = categoriesOf(history, scenarios);

  if (strategy === "random") {
    const picked = elementAt(pool, Math.floor(rng() * pool.length));
    return new Choice(picked, 0, ["random strategy"], rejected);
  }

  if (strategy === "hardest") {
    let best = elementAt(pool, 0);
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = elementAt(pool, index);
      // Ties break on the larger id, as Python's tuple key did, so the choice does not
      // depend on catalogue order.
      const order =
        compareNumber(candidate.difficulty, best.difficulty) || compareText(candidate.id, best.id);
      if (order > 0) best = candidate;
    }
    return new Choice(best, best.difficulty, ["hardest available"], rejected);
  }

  if (strategy === "easiest") {
    let best = elementAt(pool, 0);
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = elementAt(pool, index);
      const order =
        compareNumber(candidate.difficulty, best.difficulty) || compareText(candidate.id, best.id);
      if (order < 0) best = candidate;
    }
    return new Choice(best, -best.difficulty, ["easiest available"], rejected);
  }

  if (strategy === "family") {
    if (workload && workload.scenarioFamilies.length > 0) {
      const narrowed = pool.filter((scenario) => workload.scenarioFamilies.includes(scenario.category));
      // An empty narrowing falls back to the whole pool: the rejections were already
      // made by `eligible`, and refusing here would throw away a servable assignment.
      pool = narrowed.length > 0 ? narrowed : pool;
    }
    let best = elementAt(pool, 0);
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = elementAt(pool, index);
      // Fewest prior runs, then lower difficulty. Ties keep the earlier candidate, as
      // Python's `min` did.
      const order =
        compareNumber(servedCount(history, candidate.id), servedCount(history, best.id)) ||
        compareNumber(candidate.difficulty, best.difficulty);
      if (order < 0) best = candidate;
    }
    return new Choice(best, 1, [`family strategy, fewest prior runs (${servedCount(history, best.id)})`], rejected);
  }

  const scored: Choice[] = pool.map((scenario) => {
    const { score, reasons } = scoreScenario(scenario, workload, history, categories);
    return new Choice(scenario, score, reasons, rejected);
  });
  let best = elementAt(scored, 0);
  for (let index = 1; index < scored.length; index += 1) {
    const candidate = elementAt(scored, index);
    const order = compareNumber(candidate.score, best.score) || compareText(candidate.scenario.id, best.scenario.id);
    if (order > 0) best = candidate;
  }
  if (history.length > 0) {
    // Only when there is a history to compare against: a first assignment "chosen over
    // six others" says nothing an instructor can act on.
    best.reasons.push(`chosen over ${scored.length - 1} other candidate(s)`);
  }
  return best;
}

/**
 * A class's session history, flattened into the list `choose` expects.
 *
 * Reads the stored row shape, so it accepts both the snake_case keys the lab writes
 * (`scenario_id`) and the camelCase name this port uses, plus a bare `scenario` for a
 * row that carries the scenario rather than its id. A row with neither is skipped
 * rather than becoming an empty string in the history, where it would silently match
 * nothing and skew the counts.
 */
export function historyFromSessions(sessions: readonly Record<string, unknown>[]): string[] {
  const history: string[] = [];
  for (const session of sessions) {
    const raw =
      scenarioName(session["scenario_id"]) ??
      scenarioName(session["scenarioId"]) ??
      scenarioName(session["scenario"]);
    if (raw !== null) history.push(raw);
  }
  return history;
}

/**
 * One stored cell as a scenario name, or `null` when it names nothing.
 *
 * Only scalars are read. A column holding an object is a data bug, and `[object
 * Object]` in a history would match no scenario while still counting as an entry —
 * the same skew the empty string is skipped to avoid.
 */
function scenarioName(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" && value) return String(value);
  return null;
}
