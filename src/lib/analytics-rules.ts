/**
 * Instructor analytics, as pure functions.
 *
 * The dashboard's job is to turn raw attempt and check-result rows into the few
 * numbers an instructor actually acts on: which checks students miss, how long
 * work takes, and whether the class is trending up. Keeping the maths here — out
 * of the page and away from the database — means it can be unit-tested against
 * fixed fixtures.
 */

import { GRADING_MODES, normalizeGradingMode, type GradingMode } from "./grading-mode";
import { DEFAULT_PASS_SCORE } from "./scenario-rules";
import { clearedPassMark } from "./score-rules";

export interface CheckResultRow {
  checkId: string;
  label: string;
  passed: boolean;
}

export interface AttemptRow {
  id: string;
  scenarioId: string;
  status: string;
  startedAt: Date;
  submittedAt?: Date | null;
  timeSpentSec: number;
  score: number;
  maxScore: number;
  /** `simulated` | `lab`; absent reads as `simulated`. See `grading-mode.ts`. */
  mode?: string | null;
}

export interface CheckStat {
  checkId: string;
  label: string;
  attempts: number;
  passed: number;
  /** Whole percent, 0–100. */
  passRate: number;
}

export interface AttemptStat {
  attempts: number;
  /** Median seconds on task across attempts with a recorded time. */
  medianTimeSec: number;
  /** 90th-percentile seconds on task. */
  p90TimeSec: number;
  /** Whole percent average of score/maxScore. */
  averagePercent: number;
  passed: number;
  passRate: number;
  /**
   * The bar those attempts were actually judged against: the mean pass mark of
   * the scenarios involved. Surfaces so the UI can colour a cohort against its
   * own pass marks rather than a hard-coded 70 — a class held to 85% is not
   * failing when it averages 80.
   */
  passMark: number;
}

export interface ScenarioStat {
  scenarioId: string;
  attempts: number;
  averagePercent: number;
  passed: number;
  passRate: number;
  /** This scenario's own pass mark, so the row can show the bar it used. */
  passScore: number;
}

/** One grading mode's attempt statistics, so a figure can state its mode (audit Q7). */
export interface ModeStat extends AttemptStat {
  mode: GradingMode;
}

/**
 * The same attempt statistics, split by grading mode.
 *
 * A simulated pass and a lab pass are not the same claim, so the dashboard must
 * not average them into one number without saying so (docs/consolidation-audit.md
 * §9/Q7). Only the modes that actually appear are returned, in the canonical
 * order (`simulated` first), and the empty list is the honest answer when there
 * are no finished attempts.
 */
export function summariseByMode(
  rows: readonly AttemptRow[],
  passScoreByScenario: Record<string, number> = {},
): ModeStat[] {
  const byMode = new Map<GradingMode, AttemptRow[]>();
  for (const row of rows) {
    const mode = normalizeGradingMode(row.mode);
    const list = byMode.get(mode);
    if (list) list.push(row);
    else byMode.set(mode, [row]);
  }

  return GRADING_MODES.filter((mode) => byMode.has(mode)).map((mode) => ({
    mode,
    ...summariseAttempts(byMode.get(mode)!, passScoreByScenario),
  }));
}

/** Per-scenario rollup, busiest first. */
export function summariseByScenario(
  rows: readonly AttemptRow[],
  passScoreByScenario: Record<string, number> = {},
): ScenarioStat[] {
  const byScenario = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    const list = byScenario.get(row.scenarioId);
    if (list) list.push(row);
    else byScenario.set(row.scenarioId, [row]);
  }

  return [...byScenario.entries()]
    .map(([scenarioId, list]) => {
      const stat = summariseAttempts(list, passScoreByScenario);
      return {
        scenarioId,
        attempts: stat.attempts,
        averagePercent: stat.averagePercent,
        passed: stat.passed,
        passRate: stat.passRate,
        passScore: passScoreByScenario[scenarioId] ?? DEFAULT_PASS_SCORE,
      };
    })
    .sort((a, b) => b.attempts - a.attempts);
}

export interface TrendBucket {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  attempts: number;
  averagePercent: number;
}

/** Nearest-rank percentile (0–100). Returns 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function percent(score: number, maxScore: number): number {
  return maxScore > 0 ? (score / maxScore) * 100 : 0;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Per-check pass rates, hardest first — the most actionable view for an
 * instructor deciding where to add a hint or clarify the briefing.
 */
export function summariseChecks(rows: readonly CheckResultRow[]): CheckStat[] {
  const byCheck = new Map<string, { label: string; attempts: number; passed: number }>();

  for (const row of rows) {
    const entry = byCheck.get(row.checkId) ?? { label: row.label, attempts: 0, passed: 0 };
    entry.attempts += 1;
    if (row.passed) entry.passed += 1;
    byCheck.set(row.checkId, entry);
  }

  return [...byCheck.entries()]
    .map(([checkId, entry]) => ({
      checkId,
      label: entry.label,
      attempts: entry.attempts,
      passed: entry.passed,
      passRate: Math.round((entry.passed / entry.attempts) * 100),
    }))
    .sort((a, b) => a.passRate - b.passRate || a.label.localeCompare(b.label));
}

/**
 * Overall attempt statistics. `passScoreByScenario` supplies each scenario's
 * pass mark (defaulting to `DEFAULT_PASS_SCORE`) so "passed" is judged per
 * scenario, and `passMark` reports the mean bar so callers can compare against
 * it instead of the old hard-coded 70.
 */
export function summariseAttempts(
  rows: readonly AttemptRow[],
  passScoreByScenario: Record<string, number> = {},
): AttemptStat {
  const times = rows.map((row) => row.timeSpentSec).filter((seconds) => seconds > 0);
  const percentages = rows.map((row) => percent(row.score, row.maxScore));
  const marks = rows.map((row) => passScoreByScenario[row.scenarioId] ?? DEFAULT_PASS_SCORE);
  // The same rule every other surface uses, so a pass count cannot disagree with
  // the attempts it counts. The mean above stays fractional on purpose: it is an
  // average, not a score, and rounding each row first would move it.
  const passed = rows.filter((row, index) =>
    clearedPassMark({ score: row.score, maxScore: row.maxScore, passScore: marks[index] }),
  ).length;

  return {
    attempts: rows.length,
    medianTimeSec: percentile(times, 50),
    p90TimeSec: percentile(times, 90),
    averagePercent: rows.length > 0 ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / rows.length) : 0,
    passed,
    passRate: rows.length > 0 ? Math.round((passed / rows.length) * 100) : 0,
    passMark:
      marks.length > 0
        ? Math.round(marks.reduce((sum, value) => sum + value, 0) / marks.length)
        : DEFAULT_PASS_SCORE,
  };
}

/**
 * A daily trend for the last `days` days ending at `now`, oldest first. Days
 * with no submissions are included as zeroes so the chart has no gaps.
 */
export function trendByDay(rows: readonly AttemptRow[], days: number, now: Date): TrendBucket[] {
  const span = Math.max(1, Math.floor(days));
  const buckets = new Map<string, { attempts: number; total: number }>();

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const keys: string[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(start.getTime() - offset * 86_400_000);
    const key = utcDay(day);
    keys.push(key);
    buckets.set(key, { attempts: 0, total: 0 });
  }

  const firstKey = keys[0];
  for (const row of rows) {
    const when = row.submittedAt ?? row.startedAt;
    const key = utcDay(when);
    if (key < firstKey) continue;
    const bucket = buckets.get(key);
    if (!bucket) continue; // future-dated row; ignore rather than invent a day
    bucket.attempts += 1;
    bucket.total += percent(row.score, row.maxScore);
  }

  return keys.map((date) => {
    const bucket = buckets.get(date)!;
    return {
      date,
      attempts: bucket.attempts,
      averagePercent: bucket.attempts > 0 ? Math.round(bucket.total / bucket.attempts) : 0,
    };
  });
}
