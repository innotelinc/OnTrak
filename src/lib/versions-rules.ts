/**
 * Scenario versioning: what a saved revision is, and what rolling back *is*.
 *
 * A scenario is a graded artifact. An instructor who changes a check after a class
 * has taken it has to be able to answer "what did they run?" — and the row's current
 * shape cannot answer it, because it is the new shape. So every save writes the
 * shape it replaced to `ScenarioRevision`, and the live row is the newest revision.
 *
 * Three decisions live in this file, all pure so they can be tested without a
 * database:
 *
 *   * **What counts as a change.** `updatedAt` moves on any write; a save that
 *     changed nothing must not produce a revision, or the history becomes a list of
 *     timestamps rather than a list of edits. The comparison is over the fields a
 *     learner's attempt actually depends on — the definition, the pass score, the
 *     time limit — and not over the title, because renaming a scenario does not
 *     change what the grader checks.
 *   * **What the history says.** A diff is stated in the terms an instructor thinks
 *     in: checks added, removed, reweighted; the pass mark moved; the time limit.
 *     "definition changed" would be true and useless.
 *   * **What rollback restores.** Rolling back is a *new save* carrying the old
 *     shape, not a delete of the revisions after it. History is append-only: undoing
 *     an undo is another edit, and nobody's attempt loses the revision it ran under.
 *
 * The snapshot excludes the slug. A slug is the catalog's address for the scenario
 * and is unique across it; restoring an old one would either collide with whatever
 * took the address since, or silently move the scenario out from under a link in a
 * class packet. A rollback restores what the learner sees and the grader runs, and
 * leaves the address alone.
 */

import type { ScenarioDefinition } from "./sim/types";

/** The fields a revision holds: everything an attempt depends on. */
export interface ScenarioSnapshot {
  title: string;
  summary: string;
  description: string;
  platform: string;
  engine: string;
  difficulty: string;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: ScenarioDefinition;
}

/** A row as the rules read it — the live scenario, or a stored revision. */
export interface SnapshotSource {
  title: string;
  summary: string;
  description: string;
  platform: string;
  engine: string;
  difficulty: string;
  timeLimitSec: number;
  passScore: number;
  tags: string[];
  definition: unknown;
}

/** Copy a scenario row (or a revision) into the shape a revision stores. */
export function snapshotOf(row: SnapshotSource): ScenarioSnapshot {
  return {
    title: row.title,
    summary: row.summary,
    description: row.description,
    platform: row.platform,
    engine: row.engine,
    difficulty: row.difficulty,
    timeLimitSec: row.timeLimitSec,
    passScore: row.passScore,
    tags: [...row.tags],
    definition: row.definition as ScenarioDefinition,
  };
}

/** One check, in the terms a diff compares them by. */
interface CheckShape {
  id: string;
  weight: number;
  label: string;
}

function checksOf(definition: ScenarioDefinition | undefined): CheckShape[] {
  const checks = Array.isArray(definition?.checks) ? definition.checks : [];
  return checks.map((check, index) => {
    const raw = check as { id?: unknown; label?: unknown; points?: unknown };
    // `points` defaults to 1 in the grader (see ScenarioCheckBase), so a check that
    // gained an explicit "1" is not a reweight — the shape is the same either way.
    const points = raw.points === undefined ? 1 : Number(raw.points);
    return {
      id: String(raw.id ?? `#${index}`),
      weight: Number.isFinite(points) ? points : 1,
      label: String(raw.label ?? "").trim(),
    };
  });
}

/** True when two snapshots ask the same thing of a learner. */
export function sameGradingShape(a: ScenarioSnapshot, b: ScenarioSnapshot): boolean {
  if (a.passScore !== b.passScore || a.timeLimitSec !== b.timeLimitSec) return false;
  if (a.platform !== b.platform || a.engine !== b.engine) return false;
  const left = checksOf(a.definition);
  const right = checksOf(b.definition);
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((check) => [check.id, check]));
  for (const check of left) {
    const other = byId.get(check.id);
    if (!other || other.weight !== check.weight) return false;
  }
  return true;
}

/**
 * Whether a save should produce a revision.
 *
 * `previous` is what the row held before this save. A change to the briefing or the
 * title alone is not a revision, because it cannot change a score — but it *is*
 * still a write, and the caller keeps the current row updated. What it must not do
 * is bury the last real edit under a pile of copy-edits.
 */
/**
 * The definition as the grader sees it.
 *
 * A check's `points` defaults to 1 (see `ScenarioCheckBase`), so a check that was
 * written without one and later had `"points": 1` added is the *same* check. Serialising
 * the raw JSON would call that a change and spend a revision on nothing.
 */
function gradingKey(definition: ScenarioDefinition | undefined): string {
  if (!definition) return "";
  const checks = Array.isArray(definition.checks) ? definition.checks : [];
  const normalized = {
    ...definition,
    checks: checks.map((check) => {
      const raw = check as { points?: unknown };
      return { ...(check as object), points: raw.points === undefined ? 1 : raw.points };
    }),
  };
  return JSON.stringify(normalized);
}

export function shouldRevise(previous: ScenarioSnapshot, next: ScenarioSnapshot): boolean {
  if (previous.passScore !== next.passScore) return true;
  if (previous.timeLimitSec !== next.timeLimitSec) return true;
  if (previous.platform !== next.platform || previous.engine !== next.engine) return true;
  if (gradingKey(previous.definition) !== gradingKey(next.definition)) return true;
  return false;
}

/** What changed between two snapshots, stated as edits rather than as JSON. */
export interface SnapshotDiff {
  checksAdded: string[];
  checksRemoved: string[];
  checksReweighted: Array<{ id: string; from: number; to: number }>;
  passScore: { from: number; to: number } | null;
  timeLimitSec: { from: number; to: number } | null;
  /** True when the change touches something a score depends on. */
  gradingChanged: boolean;
  /** Copy that changed and cannot move a score. */
  textChanged: boolean;
}

export function diffSnapshots(from: ScenarioSnapshot, to: ScenarioSnapshot): SnapshotDiff {
  const before = checksOf(from.definition);
  const after = checksOf(to.definition);
  const beforeIds = new Set(before.map((check) => check.id));
  const afterIds = new Set(after.map((check) => check.id));
  const beforeById = new Map(before.map((check) => [check.id, check]));

  const checksAdded = after.filter((check) => !beforeIds.has(check.id)).map((check) => check.label || check.id);
  const checksRemoved = before.filter((check) => !afterIds.has(check.id)).map((check) => check.label || check.id);
  const checksReweighted: Array<{ id: string; from: number; to: number }> = [];
  for (const check of after) {
    const old = beforeById.get(check.id);
    if (old && old.weight !== check.weight) {
      checksReweighted.push({ id: check.label || check.id, from: old.weight, to: check.weight });
    }
  }

  const passScore =
    from.passScore === to.passScore ? null : { from: from.passScore, to: to.passScore };
  const timeLimitSec =
    from.timeLimitSec === to.timeLimitSec ? null : { from: from.timeLimitSec, to: to.timeLimitSec };

  const textChanged =
    from.title !== to.title ||
    from.summary !== to.summary ||
    from.description !== to.description ||
    from.difficulty !== to.difficulty ||
    from.tags.join("\u0000") !== to.tags.join("\u0000");

  return {
    checksAdded,
    checksRemoved,
    checksReweighted,
    passScore,
    timeLimitSec,
    gradingChanged:
      checksAdded.length > 0 ||
      checksRemoved.length > 0 ||
      checksReweighted.length > 0 ||
      passScore !== null ||
      timeLimitSec !== null ||
      from.platform !== to.platform ||
      from.engine !== to.engine,
    textChanged,
  };
}

/** One line an instructor can read at a glance, from a diff. */
export function describeDiff(diff: SnapshotDiff): string {
  const parts: string[] = [];
  if (diff.checksAdded.length) parts.push(`+${diff.checksAdded.length} check${diff.checksAdded.length === 1 ? "" : "s"}`);
  if (diff.checksRemoved.length) parts.push(`−${diff.checksRemoved.length} check${diff.checksRemoved.length === 1 ? "" : "s"}`);
  if (diff.checksReweighted.length) parts.push(`${diff.checksReweighted.length} reweighted`);
  if (diff.passScore) parts.push(`pass ${diff.passScore.from}% → ${diff.passScore.to}%`);
  if (diff.timeLimitSec) parts.push(`limit ${Math.round(diff.timeLimitSec.from / 60)}m → ${Math.round(diff.timeLimitSec.to / 60)}m`);
  if (parts.length === 0 && diff.textChanged) parts.push("wording only");
  if (parts.length === 0) parts.push("no change");
  return parts.join(" · ");
}

/**
 * The snapshot a rollback restores, and the fields it may not touch.
 *
 * Returns the old shape ready to be written back as a *new* save. `slug` is
 * deliberately absent: the caller keeps the current one, so a rollback cannot take
 * over an address another scenario has since claimed.
 */
export function rollbackSnapshot(revision: { snapshot: unknown }): ScenarioSnapshot {
  const raw = revision.snapshot as Partial<ScenarioSnapshot> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("that revision has no snapshot to restore");
  }
  return {
    title: String(raw.title ?? ""),
    summary: String(raw.summary ?? ""),
    description: String(raw.description ?? ""),
    platform: String(raw.platform ?? ""),
    engine: String(raw.engine ?? ""),
    difficulty: String(raw.difficulty ?? "INTERMEDIATE"),
    timeLimitSec: Number(raw.timeLimitSec ?? 1800),
    passScore: Number(raw.passScore ?? 70),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    definition: raw.definition as ScenarioDefinition,
  };
}
