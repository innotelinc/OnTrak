/**
 * Authoring review (2.1): who may move a scenario, and when a review expires.
 *
 * A scenario is a graded artifact, and the person who wrote the checks is the
 * worst-placed person to notice that a check asks the wrong thing. The review is
 * therefore a **second reader**: a scenario is submitted, somebody other than its
 * author approves it, and only then may it be published.
 *
 * Three decisions live here, pure:
 *
 *   * **The gate is a deployment's choice.** `ONTRAK_SCENARIO_REVIEW_REQUIRED` is
 *     off by default, because a single-instructor deployment has no second reader
 *     and refusing to let them publish would take the product away. When it is on,
 *     publishing without an approval is refused with the state it is in.
 *   * **The reviewer cannot be the author.** Approving your own work is not a
 *     review; it is a second click. This is the one rule the switch does not
 *     loosen.
 *   * **An approval covers the checks that were read.** An edit that changes the
 *     grading shape drops an APPROVED scenario back to DRAFT, so the approval
 *     cannot be inherited by checks nobody reviewed. A title or briefing edit
 *     leaves it alone: it cannot move a score.
 *
 * The state lives in `Scenario.reviewStatus`; this module is the only place the
 * transitions are decided, and the actions re-run them rather than trusting a
 * form.
 */

export type ReviewStatus = "DRAFT" | "IN_REVIEW" | "APPROVED";

export const REVIEW_STATUSES: readonly ReviewStatus[] = ["DRAFT", "IN_REVIEW", "APPROVED"];

/** True when the deployment makes review a precondition for publishing. */
export function reviewRequired(value: string | undefined = process.env.ONTRAK_SCENARIO_REVIEW_REQUIRED): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** Why publishing is refused right now, or null when it may proceed. */
export function publishBlocker(status: ReviewStatus, required: boolean): string | null {
  if (!required || status === "APPROVED") return null;
  if (status === "IN_REVIEW") {
    return "It is still in review. A second reader has to approve it before it can be published.";
  }
  return "Submit it for review and have another instructor approve it before publishing.";
}

/** Why it cannot be submitted, or null when it can. */
export function submitBlocker(status: ReviewStatus): string | null {
  if (status === "DRAFT") return null;
  if (status === "IN_REVIEW") return "It is already waiting for review.";
  return "It is already approved. An edit that changes a check will send it back for review.";
}

/** Whether this person may approve, and why not when they may not. */
export function reviewBlocker(
  status: ReviewStatus,
  authorId: string,
  reviewerId: string,
): string | null {
  if (status !== "IN_REVIEW") {
    return status === "APPROVED"
      ? "It is already approved."
      : "It has not been submitted for review yet.";
  }
  if (authorId === reviewerId) {
    return "A scenario cannot be approved by the person who wrote it. Ask another instructor to read it.";
  }
  return null;
}

/**
 * The state a saved edit leaves behind.
 *
 * Only a grading-shape change invalidates an approval. Renaming a scenario or
 * rewording its briefing is still a save, but it cannot change what a learner is
 * asked to do, so it must not make a reviewer read the checks again.
 */
export function statusAfterEdit(current: ReviewStatus, gradingShapeChanged: boolean): ReviewStatus {
  return current === "APPROVED" && gradingShapeChanged ? "DRAFT" : current;
}

/** A label for the badge, in the reader's terms rather than the column's. */
export function reviewStatusLabel(status: ReviewStatus): string {
  if (status === "IN_REVIEW") return "In review";
  if (status === "APPROVED") return "Approved";
  return "Draft";
}
