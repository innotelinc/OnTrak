import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { probeToolCall } from "./modelHealth.js";
import { listModels } from "./omniroute.js";
import { accountDirName, currentScope } from "./scope.js";

/**
 * A catalog sweep, run from the browser rather than a terminal.
 *
 * `npm run model:health` already answers "which of these models actually work",
 * but only for whoever can reach a shell. This is the same question with the
 * answer rendered in the UI, because the catalog's real problem - a long list of
 * ids that cannot answer - is invisible from inside a model picker.
 *
 * Differences from the script, all deliberate:
 *   - it runs in the server process, so the results are pollable instead of
 *     printed, and a page reload does not lose them;
 *   - the probe logic is *shared* (`probeToolCall`), so the UI's verdict and the
 *     agent's own judgement cannot drift apart;
 *   - it is bounded by a timeout per model, and it never runs twice at once.
 *
 * The last finished report is written beside the account that asked for it and
 * read back on the next request, so a restart - or a container being rebuilt -
 * does not make the catalog look unexplored again.
 *
 * **The report is the asking account's own (v0.3).** The catalog it probes is
 * shared, but the report is not a fact about the catalog that one person is
 * entitled to overwrite for everyone - it is what *this* account last measured,
 * and the console shows it to that account. So the state is keyed the same way
 * the workspace is (`scope.ts`): `AGENT_DATA_DIR/sweep.json` in single-operator
 * mode, which is the file it has always been, and
 * `AGENT_DATA_DIR/accounts/<account>/sweep.json` once tenancy is on. Loading it
 * lazily per key is what lets one process hold several accounts' reports without
 * a scope existing at module load.
 */

export type SweepVerdict = "works" | "broken" | "throttled" | "slow";

export interface SweepResult {
  model: string;
  ok: boolean;
  ms: number | null;
  /** Set when the gateway rerouted the request to a different model. */
  servedAs: string | null;
  error: string | null;
  verdict: SweepVerdict;
}

export interface SweepState {
  running: boolean;
  /** "sample" or "all" - what the run was asked to cover. */
  scope: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  results: SweepResult[];
}

const PROBE_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

/** Probing everything is a burst, and a burst cools down what it is measuring. */
function classify(error: string | null): SweepVerdict {
  if (error === null) return "works";
  if (/429|cooling down|rate.?limit|quota|too many requests|overload|401/i.test(error)) {
    return "throttled";
  }
  if (/timed out|unreachable|timeout/i.test(error)) return "slow";
  return "broken";
}

const EMPTY: SweepState = {
  running: false,
  scope: null,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  results: [],
};

/**
 * One report per account, made when that account first looks.
 *
 * The key is the scope's account id (or `""` for single-operator), which is
 * also what names the file, so two accounts can never read or overwrite each
 * other's report — and an account that has never swept simply has none, rather
 * than inheriting the previous person's verdicts.
 */
const states = new Map<string, SweepState>();

function sweepKey(): string {
  return currentScope().userId ?? "";
}

function sweepFile(key: string): string {
  if (key === "") return path.join(config.dataDir, "sweep.json");
  // The same directory the account's sessions and snapshots live in, so one
  // account is one directory on disk and nothing has to be looked up twice.
  return path.join(config.dataDir, "accounts", accountDirName(key), "sweep.json");
}

/** The account's state, read off disk the first time it is asked for. */
function stateFor(key: string): SweepState {
  const held = states.get(key);
  if (held !== undefined) return held;
  const loaded = readSweepFile(key);
  states.set(key, loaded);
  return loaded;
}

const VERDICTS: readonly SweepVerdict[] = ["works", "broken", "throttled", "slow"];

/** Accept only rows shaped like a probe result; a half-written file is discarded. */
function readResult(value: unknown): SweepResult | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.model !== "string" || typeof row.ok !== "boolean") return null;
  if (!VERDICTS.includes(row.verdict as SweepVerdict)) return null;
  return {
    model: row.model,
    ok: row.ok,
    ms: typeof row.ms === "number" ? row.ms : null,
    servedAs: typeof row.servedAs === "string" ? row.servedAs : null,
    error: typeof row.error === "string" ? row.error : null,
    verdict: row.verdict as SweepVerdict,
  };
}

/**
 * Read the last finished sweep back off disk into the live state.
 *
 * Deliberately total: a missing file, a truncated write, or a shape from an older
 * version all mean "no report yet" rather than a server that will not start. A run
 * is never restored as running - nothing is probing after a restart.
 *
 * Called once at module load; calling it again is equivalent to a restart, which
 * is exactly how the test for this behaves.
 */
export function loadSweep(): SweepState {
  states.set(sweepKey(), readSweepFile(sweepKey()));
  return sweepState();
}

function readSweepFile(key: string): SweepState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sweepFile(key), "utf8"));
  } catch {
    return { ...EMPTY };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };

  const saved = parsed as Record<string, unknown>;
  const results = Array.isArray(saved.results)
    ? saved.results.map(readResult).filter((row): row is SweepResult => row !== null)
    : [];
  if (results.length === 0) return { ...EMPTY };

  return {
    running: false,
    scope: typeof saved.scope === "string" ? saved.scope : null,
    startedAt: typeof saved.startedAt === "string" ? saved.startedAt : null,
    finishedAt: typeof saved.finishedAt === "string" ? saved.finishedAt : null,
    // Derived from the results themselves, so the two can never disagree.
    total: results.length,
    done: results.length,
    results,
  };
}

/** Persist the finished report. Best effort: a read-only volume is not fatal. */
function saveSweep(key: string, state: SweepState): void {
  try {
    const file = sweepFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // The report still lives in memory; the next restart just has nothing to show.
  }
}

/**
 * This account's current state. A shallow copy, so a caller iterating `results`
 * while the sweep pushes onto it cannot see the array change under a `for..of`.
 */
export function sweepState(): SweepState {
  const state = stateFor(sweepKey());
  return { ...state, results: [...state.results] };
}

/**
 * How long a finished report still counts as describing the present.
 *
 * Persisting the report created a new way to be misled: a restart used to make
 * the catalog look unexplored, and now it can show a report from last week as if
 * it were this morning's. A day is the honest shelf life - the ids do not change
 * quickly, but which of them can get a tool call out of a rate-limited free tier
 * does.
 */
export const SWEEP_STALE_MS = 24 * 60 * 60 * 1000;

/** True when the last finished report is old enough to be worth re-running. */
export function sweepStale(now = Date.now()): boolean {
  const state = stateFor(sweepKey());
  if (state.finishedAt === null) return false;
  const finished = Date.parse(state.finishedAt);
  if (!Number.isFinite(finished)) return false;
  return now - finished > SWEEP_STALE_MS;
}

/**
 * Take up to `count` ids round-robin across prefixes.
 *
 * A plain slice of the catalog is all `auto/*` combos, since those sort first -
 * the least informative sample available, and one that hides which *providers*
 * are worth fixing.
 */
function spread(ids: string[], count: number): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.indexOf("/");
    const prefix = slash === -1 ? "(none)" : id.slice(0, slash);
    const bucket = byPrefix.get(prefix);
    if (bucket === undefined) byPrefix.set(prefix, [id]);
    else bucket.push(id);
  }

  const buckets = [...byPrefix.values()];
  const picked: string[] = [];
  for (let round = 0; picked.length < count; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      if (round >= bucket.length) continue;
      picked.push(bucket[round]!);
      added = true;
      if (picked.length >= count) break;
    }
    if (!added) break;
  }
  return picked;
}

const SAMPLE_SIZE = 24;

/** Kick off a sweep. Returns the state immediately; poll `sweepState()` for progress. */
export async function startSweep(all: boolean): Promise<SweepState> {
  // Whose report this run will be. Captured here rather than read again inside
  // the worker, because the worker outlives the request that started it.
  const key = sweepKey();
  let state = stateFor(key);
  if (state.running) return { ...state, results: [...state.results] };

  const previous = state;

  // Claim the slot *before* the first await. Checking and setting it around an
  // await would let two clicks arriving together both pass the check and start a
  // sweep each - which, against someone else's gateway, is exactly the burst this
  // is careful to avoid.
  state = {
    running: true,
    scope: all ? "all" : "sample",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    done: 0,
    results: [],
  };
  states.set(key, state);

  let catalog: string[];
  try {
    catalog = await listModels();
  } catch (error) {
    // Nothing was measured, so keep the last report instead of replacing it with
    // an empty one - and give the slot back, or one failure would disable sweeps
    // until a restart.
    states.set(key, { ...previous, running: false });
    throw new Error(`Could not read the model list: ${(error as Error).message.split("\n")[0]}`);
  }

  // Only ids that claim tool calling are worth asking: the rest can never drive
  // the agent, so probing them would burn rate limit for no answer.
  const candidates = all ? catalog : spread(catalog, SAMPLE_SIZE);
  state.total = candidates.length;
  states.set(key, state);

  // Deliberately not awaited: the caller wants the state back, and progress is
  // observed by polling. Errors are recorded as results, not thrown.
  void (async () => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const model = candidates[index];
        if (model === undefined) return;

        const probe = await probeToolCall({ model }, PROBE_TIMEOUT_MS);
        state.results.push({
          model,
          ok: probe.ok,
          ms: probe.ms,
          servedAs: probe.servedAs,
          error: probe.error,
          verdict: probe.ok ? "works" : classify(probe.error),
        });
        state.done += 1;
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
      );
    } finally {
      // Finished either way, so the UI never shows a sweep stuck at 90%.
      state.running = false;
      state.finishedAt = new Date().toISOString();
      saveSweep(key, state);
    }
  })();

  return { ...state, results: [...state.results] };
}
