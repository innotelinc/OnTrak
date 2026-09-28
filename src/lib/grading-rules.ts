/**
 * Re-grading rules, as pure functions.
 *
 * Re-grading replays a stored snapshot against the scenario's *current* checks.
 * That only makes sense for an attempt that has a final, submitted state worth
 * scoring: an attempt still in progress (or one a student abandoned) has no end
 * state, and marking it GRADED would quietly finalise work that was never
 * handed in — locking the student out of their own attempt.
 *
 * Keeping the decision here means the action and the review page agree, and the
 * rule can be pinned by a unit test.
 */

import type { AttemptStatus } from "@prisma/client";

/** Statuses that carry a final state a re-grade can score. */
export const REGRADABLE_STATUSES: readonly AttemptStatus[] = ["SUBMITTED", "GRADED", "EXPIRED"];

/** May this attempt's stored state be re-scored against the current checks? */
export function canRegrade(status: AttemptStatus): boolean {
  return (REGRADABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The status a re-grade should leave behind. A timed-out attempt stays EXPIRED
 * so the record still shows *why* it ended; everything else becomes GRADED.
 */
export function regradedStatus(status: AttemptStatus): AttemptStatus {
  return status === "EXPIRED" ? "EXPIRED" : "GRADED";
}
