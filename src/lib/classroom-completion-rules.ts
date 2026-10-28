/**
 * A finished classroom lesson, reported across the boundary from the learning
 * platform.
 *
 * The AI classroom (AthenIQ's OpenMAIC host) teaches a generated lesson and
 * assesses it with its own quizzes. This module is the door's rulebook for the
 * outcome it reports: it reads the request and either describes exactly what is
 * wrong with it or produces the normalised facts the route writes. It is pure —
 * no database, no request — because this is the second input the family accepts
 * over HTTP from another product, and every refusal has to be a case a test can
 * state.
 *
 * WHY THE SHAPE IS RE-VALIDATED HERE. The classroom validated the completion it
 * authored. This end does not trust that, for the same reason the lab's door does
 * not: a request over HTTP is only as trustworthy as the token in front of it, and
 * the two products deploy and upgrade independently. A body this end cannot place
 * is refused whole rather than half-applied.
 *
 * IDEMPOTENCY IS THE COMPLETION ID, ENFORCED BY THE DATABASE. A classroom may be
 * interrupted between finishing a lesson and reporting it, so it may send the same
 * completion twice. `completionId` becomes `ClassroomCompletion.completionId`,
 * which is unique, so a retry is recognised (the route answers 200 with the record
 * it already has) instead of creating a second record. The same shape the lab uses
 * for `sessionId` and the desk uses for `sourceRef`.
 *
 * THE CLASSROOM'S CHECK IS NOT THIS APP'S GRADE. Nothing here re-marks a quiz. The
 * score and the checks are the classroom's statements, recorded as reported; what
 * the family adds is a completion record that can be verified later and a row in
 * its own ledger. A certificate is issued exactly when the reported score clears
 * the reported pass mark (`score-rules.ts`), so a record cannot be issued for a
 * completion the payload itself calls a failure.
 *
 * COMPETENCIES COME FROM THE WORK. A passed check may name the `skill` it
 * demonstrated; when any does, those are the record's competencies. A classroom
 * that tags no check falls back to its own `skills` list, which is the weaker
 * claim but still a claim the classroom made about its own lesson.
 *
 * Bounds are deliberate: a completion id, an address, titles, a score and a short
 * skill list are small facts, and one that arrives implausibly large is a mistake
 * or an attack rather than data. Every cap here is a number the route can refuse
 * by, not a silent truncation.
 */

import {
  attemptPassed,
  skillsFor,
  type CertificateAttempt,
} from "./certificates";

/** The format this door accepts, when the body bothers to say. */
export const CLASSROOM_COMPLETION_FORMAT = "ontrak.classroom.completion/v1";

/** The pass mark a classroom completion uses when the report does not name one. */
export const DEFAULT_CLASSROOM_PASS_SCORE = 70;

/** Largest values this door will accept, so a bad body cannot overflow a column. */
export const MAX_COMPLETION_ID = 200;
export const MAX_LEARNER_EMAIL = 254;
export const MAX_COURSE_REF = 200;
export const MAX_COURSE_TITLE = 200;
export const MAX_LESSON_REF = 200;
export const MAX_LESSON_TITLE = 200;
export const MAX_CLASSROOM_CHECKS = 200;
export const MAX_CHECK_ID = 200;
export const MAX_CHECK_LABEL = 300;
export const MAX_CLASSROOM_SKILLS = 12;
export const MAX_SKILL = 120;
export const MAX_SCORE = 100_000;
/** A week. A lesson longer than this is a clock problem, not a long lesson. */
export const MAX_CLASSROOM_SECONDS = 7 * 24 * 3600;

/**
 * `completionId` is a bounded token, not free text, because it is a key.
 *
 * `@` is allowed on purpose: the sender derives the key from the classroom, the
 * learner **and** the lesson, and a learner is an address. A charset that
 * excluded `@` would have made the one documented key impossible to send — the
 * rule and the sender have to agree, or the door refuses its own client.
 */
const COMPLETION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ClassroomCompletionCheck {
  checkId: string;
  label: string;
  passed: boolean;
  points: number;
  maxPoints: number;
  /** The competency this check demonstrates, when the classroom names one. */
  skill?: string;
}

/** One finished classroom lesson, normalised: what the route writes. */
export interface ClassroomCompletion {
  completionId: string;
  /** Lower-cased, so it matches the family's unique email the same way every door does. */
  learnerEmail: string;
  courseRef: string;
  courseTitle: string;
  lessonRef: string;
  lessonTitle: string;
  score: number;
  maxScore: number;
  /** The classroom's own pass mark, or `null` to use the shipped default. */
  passScore: number | null;
  startedAt: Date | null;
  completedAt: Date;
  checks: ClassroomCompletionCheck[];
  /** The classroom's own competency list, used when no check names one. */
  skills: string[];
}

export type ClassroomCompletionRead =
  | { ok: true; value: ClassroomCompletion }
  | { ok: false; issues: string[] };

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

/** One named reference (the course or the lesson), read from its object. */
function reference(
  raw: unknown,
  field: "course" | "lesson",
  maxRef: number,
  maxTitle: number,
  issues: string[],
): { ref: string; title: string } {
  if (!isRecord(raw)) {
    issues.push(`The completion has no \`${field}\` object.`);
    return { ref: "", title: "" };
  }
  const ref = text(raw.ref);
  const title = text(raw.title);
  if (!ref) issues.push(`\`${field}.ref\` is required.`);
  else if (ref.length > maxRef) issues.push(`\`${field}.ref\` is longer than ${maxRef} characters.`);
  if (!title) issues.push(`\`${field}.title\` is required.`);
  else if (title.length > maxTitle) issues.push(`\`${field}.title\` is longer than ${maxTitle} characters.`);
  return { ref, title };
}

function parseChecks(raw: unknown, issues: string[]): ClassroomCompletionCheck[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push("`checks` must be a list when it is present.");
    return [];
  }
  if (raw.length > MAX_CLASSROOM_CHECKS) {
    issues.push(`\`checks\` carries ${raw.length} entries; at most ${MAX_CLASSROOM_CHECKS} are accepted.`);
    return [];
  }

  const checks: ClassroomCompletionCheck[] = [];
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
    const skill = text(entry.skill);
    if (skill.length > MAX_SKILL) {
      issues.push(`Check ${index} names a \`skill\` longer than ${MAX_SKILL} characters.`);
      continue;
    }
    checks.push({
      checkId,
      label,
      passed: entry.passed,
      points,
      maxPoints,
      ...(skill === "" ? {} : { skill }),
    });
  }
  return checks;
}

function parseSkills(raw: unknown, issues: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push("`skills` must be a list when it is present.");
    return [];
  }
  if (raw.length > MAX_CLASSROOM_SKILLS) {
    issues.push(`\`skills\` carries ${raw.length} entries; at most ${MAX_CLASSROOM_SKILLS} are accepted.`);
    return [];
  }
  const skills: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const skill = text(entry);
    if (!skill) {
      issues.push(`Skill ${index} is empty.`);
      continue;
    }
    if (skill.length > MAX_SKILL) {
      issues.push(`Skill ${index} is longer than ${MAX_SKILL} characters.`);
      continue;
    }
    skills.push(skill);
  }
  return skills;
}

/**
 * Read a classroom completion.
 *
 * `ok: false` names every problem at once rather than the first, because the
 * person reading it is looking at the classroom's output and needs the whole list
 * to fix in one pass.
 */
export function readClassroomCompletion(raw: unknown): ClassroomCompletionRead {
  if (!isRecord(raw)) return { ok: false, issues: ["The classroom completion is not an object."] };

  const issues: string[] = [];

  if (raw.format !== undefined && raw.format !== CLASSROOM_COMPLETION_FORMAT) {
    issues.push(`\`format\` must be "${CLASSROOM_COMPLETION_FORMAT}".`);
  }

  const completionId = text(raw.completionId);
  if (!completionId) issues.push("The classroom completion has no `completionId`.");
  else if (completionId.length > MAX_COMPLETION_ID) {
    issues.push(`\`completionId\` is longer than ${MAX_COMPLETION_ID} characters.`);
  } else if (!COMPLETION_ID.test(completionId)) {
    issues.push("`completionId` may contain only letters, digits, dot, underscore, colon, at-sign and hyphen.");
  }

  const learnerEmail = text(raw.learnerEmail).toLowerCase();
  if (!learnerEmail) issues.push("The classroom completion has no `learnerEmail`.");
  else if (learnerEmail.length > MAX_LEARNER_EMAIL || !EMAIL.test(learnerEmail)) {
    issues.push(`\`${learnerEmail.slice(0, 60)}\` is not an email address.`);
  }

  const course = reference(raw.course, "course", MAX_COURSE_REF, MAX_COURSE_TITLE, issues);
  const lesson = reference(raw.lesson, "lesson", MAX_LESSON_REF, MAX_LESSON_TITLE, issues);

  const score = count(raw.score, MAX_SCORE);
  const maxScore = count(raw.maxScore, MAX_SCORE);
  if (score === null) issues.push(`\`score\` must be a whole number between 0 and ${MAX_SCORE}.`);
  if (maxScore === null || maxScore === 0) {
    issues.push(`\`maxScore\` must be a whole number between 1 and ${MAX_SCORE}.`);
  }
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
  const skills = parseSkills(raw.skills, issues);

  if (
    issues.length > 0 ||
    !completionId ||
    !learnerEmail ||
    !course.ref ||
    !course.title ||
    !lesson.ref ||
    !lesson.title ||
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
      completionId,
      learnerEmail,
      courseRef: course.ref,
      courseTitle: course.title,
      lessonRef: lesson.ref,
      lessonTitle: lesson.title,
      score,
      maxScore,
      passScore,
      startedAt,
      completedAt,
      checks,
      skills,
    },
  };
}

/**
 * The pass mark this completion is judged by.
 *
 * A reported mark wins, because the classroom knows what its own lesson asked. The
 * default exists for a report that names none, and it is a percentage for the same
 * reason every other pass mark in this product is: `8/10` is a failure against 70%.
 */
export function classroomPassScore(completion: ClassroomCompletion): number {
  return completion.passScore ?? DEFAULT_CLASSROOM_PASS_SCORE;
}

/**
 * The competencies the completion demonstrated.
 *
 * A passed check that names a `skill` is evidence for it; a failed check names
 * nothing. When no check names one, the classroom's own list is used — the weaker
 * claim, but still one the classroom made. De-duplication and the cap are the same
 * rule a certificate has always used (`certificates.ts`).
 */
export function classroomSkills(completion: ClassroomCompletion): string[] {
  const fromChecks = completion.checks
    .filter((check) => check.passed && check.skill !== undefined)
    .map((check) => check.skill as string);
  return skillsFor(fromChecks.length > 0 ? fromChecks : completion.skills);
}

/**
 * The certificate facts behind a classroom completion.
 *
 * The record names the **course** as its task (`scenarioId`/`scenarioTitle`),
 * because a classroom lesson is not a scenario this app can grade — and says
 * `platform: "classroom"` so a pasted record cannot be mistaken for a simulated
 * exercise or a lab session. No `mode` is set on purpose: the family's modes are
 * `simulated` and `lab`, and defaulting this to `simulated` would put a false claim
 * in a signed record. An absent mode is the weaker, honest statement.
 */
export function classroomCertificateFacts(
  completion: ClassroomCompletion,
  learner: { id: string; name: string },
): CertificateAttempt {
  return {
    learnerId: learner.id,
    learnerName: learner.name,
    scenarioId: completion.courseRef,
    scenarioTitle: completion.courseTitle,
    platform: "classroom",
    score: completion.score,
    maxScore: completion.maxScore,
    passScore: classroomPassScore(completion),
    completedAt: completion.completedAt,
    skills: classroomSkills(completion),
  };
}

/** Did this completion clear its pass mark? The same rule the certificate uses. */
export function classroomCompletionPassed(completion: ClassroomCompletion): boolean {
  return attemptPassed({
    score: completion.score,
    maxScore: completion.maxScore,
    passScore: classroomPassScore(completion),
  });
}

/**
 * Seconds the lesson took, clamped to a week.
 *
 * `timeSpentSec` is an `Int` column, so an unbounded subtraction on a wrong clock
 * could overflow it. The clamp is the honest ceiling: a lesson longer than a week
 * is a clock problem, and the outcome above is unaffected.
 */
export function classroomTimeSpentSec(startedAt: Date | null, completedAt: Date): number {
  if (!startedAt) return 0;
  const seconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, Math.min(MAX_CLASSROOM_SECONDS, seconds));
}
