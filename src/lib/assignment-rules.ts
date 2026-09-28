/**
 * The "new assignment" form, as pure functions.
 *
 * `createAssignment` talks to Prisma and redirects; the field parsing has no
 * business being tangled up in that. Keeping it here means the units (minutes
 * in, seconds out) and the validation can be pinned by a unit test, and the
 * action is left with just the database work.
 */

import { assignmentTimeLimitSec, optionalId, parseDateTimeInput } from "./form-rules";

export interface AssignmentDraft {
  scenarioId: string;
  cohortId: string | null;
  studentId: string | null;
  /** `null` when the form left the deadline blank. */
  dueAt: Date | null;
  /** `null` means "use the scenario's own limit". */
  timeLimitSec: number | null;
  /** 0 means unlimited. */
  maxAttempts: number;
  instructions: string | null;
}

export type AssignmentDraftResult =
  | { ok: true; draft: AssignmentDraft }
  | { ok: false; reason: string };

/**
 * Read the new-assignment form into a validated draft.
 *
 * A class, a student, or both may be targeted; a blank deadline means "no
 * deadline"; and the attempt cap is clamped to a non-negative integer so a
 * crafted value cannot reach Prisma as a fraction or a negative.
 */
export function parseAssignmentForm(formData: FormData): AssignmentDraftResult {
  const scenarioId = String(formData.get("scenarioId") ?? "").trim();
  if (!scenarioId) return { ok: false, reason: "Choose a scenario to assign." };

  const cohortId = optionalId(formData.get("cohortId"));
  const studentId = optionalId(formData.get("studentId"));
  if (!cohortId && !studentId) {
    return { ok: false, reason: "Pick a class or a student to assign it to." };
  }

  // A blank deadline is a legitimate "no deadline"; a malformed one is rejected
  // rather than stored as an `Invalid Date` for Prisma to choke on.
  const due = parseDateTimeInput(formData.get("dueAt"));
  if (!due.ok) return { ok: false, reason: due.reason };

  return {
    ok: true,
    draft: {
      scenarioId,
      cohortId,
      studentId,
      dueAt: due.date,
      timeLimitSec: assignmentTimeLimitSec(formData.get("timeLimitMinutes")),
      maxAttempts: Math.max(0, Math.trunc(Number(formData.get("maxAttempts") ?? 0) || 0)),
      instructions: String(formData.get("instructions") ?? "").trim() || null,
    },
  };
}
