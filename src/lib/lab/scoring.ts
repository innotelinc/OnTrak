/**
 * Grading: turn guest output into a score report.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/scoring.py`. The guest contract it
 * reads is deliberately tiny, and it is the contract the scenario scripts already
 * speak, so the port reads the same bytes the Python did:
 *
 *     ###ONTRAK-JSON-BEGIN###
 *     {"checks":[{"objective":"restore-dns","passed":false,"detail":"still 10.20.0.99"}]}
 *     ###ONTRAK-JSON-END###
 *
 * Anything else on stdout (banners, warnings, native command noise) is ignored.
 * Objectives the script does not report are recorded as *unreported* and count as
 * failures, which is the safe default: a check that crashed must not look like a
 * pass, and the scenario validator exists to keep that from happening by accident.
 *
 * Four decisions the port keeps exactly, because each one is load-bearing:
 *
 * **A failure wins a duplicate.** The same objective reported twice (an early-exit
 * retry, a probe run again) keeps the failing report, so a flapping probe cannot
 * fake a pass by being asked twice.
 *
 * **An unreadable payload is an error, not a zero.** No markers, malformed JSON or
 * a payload that is not an object is `GradingError`, and the report says so: a
 * script that crashed produced no evidence, and a report that said "0%" would be
 * indistinguishable from a student who fixed nothing.
 *
 * **A critical objective blocks resolution regardless of the score.** 80% with the
 * critical objective still broken is not a pass, and the pass mark is applied to
 * the weighted score for the rest.
 *
 * **The pass mark itself is not decided here.** `clearedPassMark` in
 * `src/lib/score-rules.ts` is the app's one answer to "did this clear the bar" —
 * `tests/one-pass-rule.test.ts` refuses a second comparison anywhere under `src/`,
 * which is why a grader ported from another repository still asks that function
 * rather than repeating its arithmetic. What this module adds is the one thing the
 * app's rule does not contain: the lab's critical-objective condition.
 *
 * **The last payload between the markers wins**, so a script that retries can print
 * more than once and be graded on its final answer.
 *
 * Two deliberate divergences from the Python, both narrowing rather than widening
 * what is accepted, and both stated so a reader is not surprised later:
 *
 * - `_first` and Python's `or` chains test *Python* truthiness, where an empty list
 *   or dict is absent. `pyFalsy` below is that rule; without it a `checks: []`
 *   payload would be read as present-and-empty in one place and absent in another.
 * - A `checks` value that is neither a list nor an object is treated as `[]` rather
 *   than iterated for its characters (Python would walk a string's characters and
 *   skip each). Both end at "no reported outcomes", so no score changes.
 *
 * Pure: no I/O, no clock beyond `iso()` in `models.ts`.
 */

import {
  JSON_BEGIN,
  JSON_END,
  newCheckOutcome,
  newScoreReport,
  objectiveIn,
  scenarioTotalWeight,
  type CheckOutcome,
  type GradeableScenario,
  type ScoreReport,
} from "./models";
import { clearedPassMark } from "../score-rules";

/** Raised when the guest output cannot be interpreted at all. */
export class GradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingError";
  }
}

/** The objective id may be spelled any of these, in this order of preference. */
const OBJECTIVE_KEYS = ["objective", "objective_id", "id", "check", "name"] as const;
/** ...and the verdict any of these. */
const PASSED_KEYS = ["passed", "pass", "ok", "success"] as const;
/** ...and the free-text detail any of these. */
const DETAIL_KEYS = ["detail", "message", "evidence", "note"] as const;

/** `_as_bool`'s string spellings, which are what a PowerShell script tends to print. */
const PASS_SPELLINGS = new Set(["true", "yes", "1", "pass", "passed", "ok"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The marker pair, non-greedy, newline-crossing — Python's `re.DOTALL` pattern. */
const MARKER_PATTERN = `${escapeRegExp(JSON_BEGIN)}([\\s\\S]*?)${escapeRegExp(JSON_END)}`;

/**
 * Python truthiness, which the original module leans on.
 *
 * `payload.get("results") or payload.get("objectives") or []` treats an empty list
 * or dict as absent, and `str(x or "")` turns `0` and `false` into the empty string.
 * Reproducing the rule once is what keeps those two spellings of "nothing" meaning
 * the same thing on both sides of the port.
 */
function pyFalsy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** The first key present with a non-null value, or the fallback. */
function firstOf(
  item: Record<string, unknown>,
  keys: readonly string[],
  fallback: unknown = null,
): unknown {
  for (const key of keys) {
    if (key in item) {
      const value = item[key];
      if (value !== null && value !== undefined) return value;
    }
  }
  return fallback;
}

/** A verdict in any of the shapes a check script tends to emit. */
function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  // Python's `bool(n)`: zero is false, and a NaN is *true*.
  if (typeof value === "number") return value !== 0;
  return PASS_SPELLINGS.has(String(value).trim().toLowerCase());
}

/**
 * Python's `round(value, digits)`, which rounds a tie to even rather than up.
 *
 * `Math.round` alone would score 12.25 as 12.3 where the Python control plane
 * scored 12.2, and a lab host moving to this stack would see two figures for the
 * same attempt. The epsilon band absorbs the float error that a scaled value like
 * `0.5000000001` carries, which is the case that actually occurs.
 */
function roundHalfEven(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  if (!Number.isFinite(scaled)) return value;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const rounded =
    Math.abs(fraction - 0.5) < 1e-9 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(scaled);
  return rounded / factor;
}

/** `{value:.{digits}f}` — the display form of a score, a pass mark or a weight. */
function formatFixed(value: number, digits: number): string {
  return roundHalfEven(value, digits).toFixed(digits);
}

/**
 * Pull the JSON payload out of raw guest output.
 *
 * The **last** payload between the markers wins, so a retry loop that printed twice
 * is graded on its final answer, and stdout noise before or after it is ignored.
 */
export function extractPayload(text: string): Record<string, unknown> {
  const matches = [...(text ?? "").matchAll(new RegExp(MARKER_PATTERN, "g"))].map(
    (match) => match[1] ?? "",
  );
  if (matches.length === 0) {
    throw new GradingError(
      "no grading payload found between the OnTrak markers; check.ps1 must call " +
        "Write-OnTrakReport",
    );
  }
  const raw = (matches[matches.length - 1] ?? "").trim();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new GradingError(
      `grading payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new GradingError("grading payload must be a JSON object with a 'checks' list");
  }
  return data as Record<string, unknown>;
}

/**
 * Read the reported outcomes out of a payload.
 *
 * Returns a `Map` rather than an object on purpose: an objective id is guest-supplied
 * text, and `{"constructor": ...}` must be a key, not a prototype lookup.
 *
 * The list may be under `checks`, `results` or `objectives`; the `{"objective": bool}`
 * shorthand is accepted; and a duplicate id keeps the **failure**, so a probe that
 * answered yes then no is recorded as a no.
 */
export function collectChecks(payload: Record<string, unknown>): Map<string, CheckOutcome> {
  const checks = payload.checks;
  const items =
    checks === undefined || checks === null
      ? pyFalsy(payload.results)
        ? pyFalsy(payload.objectives)
          ? []
          : payload.objectives
        : payload.results
      : checks;

  let entries: unknown[];
  if (Array.isArray(items)) {
    entries = items;
  } else if (typeof items === "object" && items !== null) {
    entries = Object.entries(items as Record<string, unknown>).map(([objective, passed]) => ({
      objective,
      passed,
    }));
  } else {
    entries = [];
  }

  const outcomes = new Map<string, CheckOutcome>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const rawId = firstOf(item, OBJECTIVE_KEYS, "");
    const objectiveId = pyFalsy(rawId) ? "" : String(rawId).trim();
    if (!objectiveId) continue;

    const rawDetail = firstOf(item, DETAIL_KEYS, "");
    const outcome = newCheckOutcome({
      objectiveId,
      passed: asBool(firstOf(item, PASSED_KEYS, false)),
      detail: pyFalsy(rawDetail) ? "" : String(rawDetail),
    });

    const existing = outcomes.get(objectiveId);
    if (existing) {
      if (!outcome.passed) outcomes.set(objectiveId, outcome);
      continue;
    }
    outcomes.set(objectiveId, outcome);
  }
  return outcomes;
}

/**
 * Grade `guestOutput` against `scenario`.
 *
 * A scenario with no objectives is an error rather than a 0% — there is nothing the
 * student could have done. A payload the guest never printed is an error too, and
 * every objective is then recorded as unreported-and-failed so the report, the
 * feedback rows and the CSV all agree about what happened.
 */
export function evaluate(
  scenario: GradeableScenario,
  sessionId: number,
  guestOutput: string,
): ScoreReport {
  const report = newScoreReport({ sessionId, scenarioId: scenario.id });
  if (scenario.objectives.length === 0) {
    report.error = `scenario ${scenario.id} declares no objectives`;
    return report;
  }

  let payload: Record<string, unknown>;
  try {
    payload = extractPayload(guestOutput);
  } catch (error) {
    // Only the grading failure is turned into a report; anything else is a bug in
    // this process and must not be disguised as a student's zero.
    if (!(error instanceof GradingError)) throw error;
    report.error = error.message;
    report.resolved = false;
    report.score = 0;
    report.outcomes = scenario.objectives.map((objective) =>
      newCheckOutcome({
        objectiveId: objective.id,
        passed: false,
        detail: "grading could not run",
        weight: objective.weight,
        critical: objective.critical,
        reported: false,
      }),
    );
    return report;
  }

  const reported = collectChecks(payload);
  const knownIds = new Set(scenario.objectives.map((objective) => objective.id));

  for (const objective of scenario.objectives) {
    const outcome = reported.get(objective.id);
    if (!outcome) {
      report.outcomes.push(
        newCheckOutcome({
          objectiveId: objective.id,
          passed: false,
          detail: "check did not report this objective",
          weight: objective.weight,
          critical: objective.critical,
          reported: false,
        }),
      );
      continue;
    }
    // The scenario, not the guest, decides what an objective is worth and whether
    // it is critical: a script cannot promote its own objective by claiming a weight.
    report.outcomes.push({ ...outcome, weight: objective.weight, critical: objective.critical });
  }

  const unmapped = [...reported.keys()].filter((id) => !knownIds.has(id)).sort();
  if (unmapped.length > 0) {
    // Not fatal: a scenario may add extra telemetry. Surfaced as a note so it is
    // visible while authoring instead of being silently dropped.
    report.notes.push("check.ps1 reported unknown objective id(s): " + unmapped.join(", "));
  }

  // `or 1.0`: a scenario whose weights somehow total zero must not divide by it.
  const total = scenarioTotalWeight(scenario.objectives) || 1;
  const earned = report.outcomes.reduce(
    (sum, outcome) => (outcome.passed ? sum + outcome.weight : sum),
    0,
  );
  report.score = roundHalfEven((100 * earned) / total, 1);
  // Until a session blends in the ticket grade, the machine score *is* the score.
  report.machineScore = report.score;
  const criticalFailed = report.outcomes.some((outcome) => outcome.critical && !outcome.passed);
  // Raw points and the weighted total, not the rounded percentage: the app's rule
  // converts a score to a percentage itself, and handing it an already-converted
  // number would round twice. One consequence, stated because it is a real
  // difference from the Python: the verdict is now taken at the app's whole-percent
  // boundary, so a 79.6% weighted score clears an 80% mark where the Python's
  // one-decimal comparison called it short. That convergence is the point of the
  // port — a lab result and a simulated one must not disagree about what a pass is
  // when they quote the same percentage.
  report.resolved =
    !criticalFailed &&
    clearedPassMark({ score: earned, maxScore: total, passScore: scenario.passScore });
  return report;
}

/** One per-objective feedback row. A wire shape, so the keys stay snake_case. */
export interface FeedbackRow {
  objective_id: string;
  text: string;
  passed: boolean;
  critical: boolean;
  weight: number;
  detail: string;
  reported: boolean;
  hint: string;
}

/**
 * Per-objective feedback rows for the portal and the CLI.
 *
 * A hint is only exposed for an objective the student did **not** pass, and only
 * when the caller asks — the instructor view and the CLI export both call this, and
 * a hint beside a green tick would be advice for a problem the student already
 * solved.
 */
export function renderFeedback(
  scenario: GradeableScenario,
  report: ScoreReport,
  options: { showHints?: boolean } = {},
): FeedbackRow[] {
  const showHints = options.showHints ?? true;
  return report.outcomes.map((outcome) => {
    const objective = objectiveIn(scenario.objectives, outcome.objectiveId);
    return {
      objective_id: outcome.objectiveId,
      text: objective ? objective.text : outcome.objectiveId,
      passed: outcome.passed,
      critical: outcome.critical,
      weight: outcome.weight,
      detail: outcome.detail,
      reported: outcome.reported,
      hint: objective && showHints && !outcome.passed ? objective.hint : "",
    };
  });
}

/**
 * Plain-text report used by the CLI and by e-mail/CSV exports.
 *
 * Deliberately hint-free: this text is the thing that gets pasted into a ticket or a
 * gradebook, and the hints are the answer key.
 */
export function feedbackText(scenario: GradeableScenario, report: ScoreReport): string {
  const lines: string[] = [
    `Scenario: ${scenario.title} (${scenario.id})`,
    `Score:    ${formatFixed(report.score, 1)}%  ` +
      `(${report.resolved ? "RESOLVED" : "not yet resolved"}; pass mark ` +
      `${formatFixed(scenario.passScore, 0)}%, critical objectives must all pass)`,
  ];
  if (report.error) lines.push(`Error:    ${report.error}`);
  lines.push("");
  for (const row of renderFeedback(scenario, report, { showHints: false })) {
    const mark = row.passed ? "PASS" : "FAIL";
    const flag = row.critical ? " [critical]" : "";
    lines.push(`  [${mark}] ${row.text}${flag} (${formatFixed(row.weight, 0)} pts)`);
    if (row.detail) lines.push(`         ${row.detail}`);
  }
  return lines.join("\n");
}
