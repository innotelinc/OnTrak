/**
 * A finished lab session, reported across the boundary from OnTrak-dev.
 *
 * The lab grades a task against a live machine and, when the session ends, tells
 * the family. This module is the door's rulebook: it reads the request the lab
 * makes and either describes exactly what is wrong with it or produces the
 * normalised facts the route writes. It is pure — no database, no request — so
 * every refusal is a case a test can state, which matters because this is the one
 * input in the family that arrives over HTTP from another product.
 *
 * WHY THE SHAPE IS RE-VALIDATED HERE
 * The lab has already validated the session it authored. This end does not trust
 * that — not because the lab is suspect, but because a request over HTTP is only
 * as trustworthy as the token in front of it, and the two products deploy and
 * upgrade independently. Every field is re-checked, and a body this end cannot
 * place is refused whole rather than half-applied.
 *
 * IDEMPOTENCY IS THE SESSION ID, ENFORCED BY THE DATABASE.
 * The lab may be interrupted between grading and reporting, so it may send the
 * same completion twice. `sessionId` becomes `Attempt.labSessionId`, which is
 * unique, so a retry is *recognised* (the route answers 200 with the attempt it
 * already has) instead of creating a second attempt. That is the same shape the
 * desk's scenario drafts use for `sourceRef`, and it is what makes the lab's sweep
 * safe to run on a schedule.
 *
 * THE MODE IS THE LAB'S, AND THE TASK HAS TO AGREE.
 * A completion here is evidence that a live machine graded the attempt, so the
 * mode is `lab` (docs/consolidation-audit.md §6/C2, §7 Step 6) and the scenario it
 * names must itself be tagged `lab`. The route enforces the second half; that is
 * what keeps the task's declared mode and the evidence from disagreeing.
 *
 * Bounds are deliberate: a session id, an email and a score are small facts, and
 * one that arrives implausibly large is a mistake or an attack rather than data.
 * Every cap here is a number the route can refuse by, not a silent truncation.
 */

/** The format this door accepts, when the body bothers to say. */
export const LAB_COMPLETION_FORMAT = "ontrak.lab.completion/v1";

/** Largest values this door will accept, so a bad body cannot overflow a column. */
export const MAX_SESSION_ID = 120;
export const MAX_LEARNER_EMAIL = 254;
export const MAX_SCENARIO_REF = 200;
export const MAX_LAB_CHECKS = 200;
export const MAX_CHECK_ID = 200;
export const MAX_CHECK_LABEL = 200;
export const MAX_SCORE = 100_000;
/** A week. A session longer than this is a clock problem, not a long lab. */
export const MAX_LAB_SECONDS = 7 * 24 * 3600;

/** `sessionId` is a filename-shaped token, not free text, because it is a key. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LabCompletionCheck {
  checkId: string;
  label: string;
  passed: boolean;
  points: number;
  maxPoints: number;
}

/** One finished lab session, normalised: what the route writes. */
export interface LabCompletion {
  sessionId: string;
  /** Lower-cased, so it matches the family's unique email the same way every other door does. */
  learnerEmail: string;
  /** Exactly one of these identifies the task; `scenarioId` wins when both are given. */
  scenarioId: string | null;
  scenarioSlug: string | null;
  score: number;
  maxScore: number;
  /** The lab's own pass mark, or `null` to use the scenario's. */
  passScore: number | null;
  startedAt: Date | null;
  completedAt: Date;
  checks: LabCompletionCheck[];
}

export type LabCompletionRead = { ok: true; value: LabCompletion } | { ok: false; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A non-negative integer within `max`, or `null` when the value is not one. */
function count(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
}

/** A parseable ISO instant, or `null`. */
function instant(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseChecks(raw: unknown, issues: string[]): LabCompletionCheck[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push("`checks` must be a list when it is present.");
    return [];
  }
  if (raw.length > MAX_LAB_CHECKS) {
    issues.push(`\`checks\` carries ${raw.length} entries; at most ${MAX_LAB_CHECKS} are accepted.`);
    return [];
  }

  const checks: LabCompletionCheck[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      issues.push(`Check ${index} is not an object.`);
      continue;
    }
    const checkId = text(entry.checkId);
    const label = text(entry.label);
    if (!checkId || checkId.length > MAX_CHECK_ID) {
      issues.push(`Check ${index} needs a \`checkId\` of at most ${MAX_CHECK_ID} characters.`);
      continue;
    }
    if (!label || label.length > MAX_CHECK_LABEL) {
      issues.push(`Check ${index} needs a \`label\` of at most ${MAX_CHECK_LABEL} characters.`);
      continue;
    }
    if (typeof entry.passed !== "boolean") {
      issues.push(`Check ${index} needs a boolean \`passed\`.`);
      continue;
    }
    const points = count(entry.points, MAX_SCORE);
    if (points === null) {
      issues.push(`Check ${index} needs a whole, non-negative \`points\` (max ${MAX_SCORE}).`);
      continue;
    }
    const maxPoints = count(entry.maxPoints, MAX_SCORE);
    if (maxPoints === null) {
      issues.push(`Check ${index} needs a whole, non-negative \`maxPoints\` (max ${MAX_SCORE}).`);
      continue;
    }
    if (points > maxPoints) {
      issues.push(`Check ${index} awards ${points} of ${maxPoints}; points cannot exceed maxPoints.`);
      continue;
    }
    checks.push({ checkId, label, passed: entry.passed, points, maxPoints });
  }
  return checks;
}

/**
 * Read a lab completion.
 *
 * `ok: false` names every problem at once rather than the first, because the
 * person reading it is looking at their lab's output and needs the whole list to
 * fix in one pass.
 */
export function readLabCompletion(raw: unknown): LabCompletionRead {
  if (!isRecord(raw)) return { ok: false, issues: ["The lab completion is not an object."] };

  const issues: string[] = [];

  if (raw.format !== undefined && raw.format !== LAB_COMPLETION_FORMAT) {
    issues.push(`\`format\` must be "${LAB_COMPLETION_FORMAT}".`);
  }

  const sessionId = text(raw.sessionId);
  if (!sessionId) issues.push("The lab completion has no `sessionId`.");
  else if (sessionId.length > MAX_SESSION_ID) issues.push(`\`sessionId\` is longer than ${MAX_SESSION_ID} characters.`);
  else if (!SESSION_ID.test(sessionId)) {
    issues.push("`sessionId` may contain only letters, digits, dot, underscore, colon and hyphen.");
  }

  const learnerEmail = text(raw.learnerEmail).toLowerCase();
  if (!learnerEmail) issues.push("The lab completion has no `learnerEmail`.");
  else if (learnerEmail.length > MAX_LEARNER_EMAIL || !EMAIL.test(learnerEmail)) {
    issues.push(`\`${learnerEmail.slice(0, 60)}\` is not an email address.`);
  }

  const scenarioId = text(raw.scenarioId);
  const scenarioSlug = text(raw.scenarioSlug);
  if (scenarioId.length > MAX_SCENARIO_REF || scenarioSlug.length > MAX_SCENARIO_REF) {
    issues.push(`A scenario reference is longer than ${MAX_SCENARIO_REF} characters.`);
  }
  if (!scenarioId && !scenarioSlug) issues.push("The lab completion names no scenario (`scenarioId` or `scenarioSlug`).");

  const score = count(raw.score, MAX_SCORE);
  const maxScore = count(raw.maxScore, MAX_SCORE);
  if (score === null) issues.push(`\`score\` must be a whole number between 0 and ${MAX_SCORE}.`);
  if (maxScore === null || maxScore === 0) issues.push(`\`maxScore\` must be a whole number between 1 and ${MAX_SCORE}.`);
  if (score !== null && maxScore !== null && maxScore > 0 && score > maxScore) {
    issues.push(`\`score\` ${score} is greater than \`maxScore\` ${maxScore}.`);
  }

  let passScore: number | null = null;
  if (raw.passScore !== undefined && raw.passScore !== null) {
    const parsed = count(raw.passScore, 100);
    if (parsed === null) issues.push("`passScore`, when given, must be a whole number between 0 and 100.");
    else passScore = parsed;
  }

  const completedAt = instant(raw.completedAt);
  if (!completedAt) issues.push("`completedAt` must be an ISO-8601 date-time.");
  let startedAt: Date | null = null;
  if (raw.startedAt !== undefined && raw.startedAt !== null) {
    startedAt = instant(raw.startedAt);
    if (!startedAt) issues.push("`startedAt`, when given, must be an ISO-8601 date-time.");
    else if (completedAt && startedAt.getTime() > completedAt.getTime()) {
      issues.push("`startedAt` is after `completedAt`.");
    }
  }

  const checks = parseChecks(raw.checks, issues);

  if (
    issues.length > 0 ||
    !sessionId ||
    !learnerEmail ||
    !completedAt ||
    score === null ||
    maxScore === null ||
    maxScore === 0
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      sessionId,
      learnerEmail,
      scenarioId: scenarioId || null,
      scenarioSlug: scenarioSlug || null,
      score,
      maxScore,
      passScore,
      startedAt,
      completedAt,
      checks,
    },
  };
}

/**
 * Seconds the session took, clamped to a week.
 *
 * `timeSpentSec` is an `Int` column, so an unbounded subtraction on a wrong clock
 * could overflow it. The clamp is the honest ceiling: a session longer than a week
 * is a clock problem, and the grade above is unaffected.
 */
export function labTimeSpentSec(startedAt: Date | null, completedAt: Date): number {
  if (!startedAt) return 0;
  const seconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, Math.min(MAX_LAB_SECONDS, seconds));
}
