/**
 * Post-incident review rules (M3): a review that produces work, not a document.
 *
 * The failure mode of a post-mortem is well known: a well-written document is
 * published, everyone agrees it was excellent, and none of the fixes are ever
 * made. So a review here is only *published* when it names at least one action
 * with an owner and a due date, and every action is a tracked row whose state is
 * derivable — open, in progress, done, dropped, or **overdue**.
 *
 * "Overdue" is computed, never stored: an action's due date is a fact and today
 * is a fact, so an action that is late must not depend on somebody having
 * remembered to flip a flag. Nothing here touches a store or a clock.
 */

/* -------------------------------------------------------------------------- */
/*  Actions                                                                   */
/* -------------------------------------------------------------------------- */

export type ReviewActionStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "DROPPED";
export const REVIEW_ACTION_STATUSES: readonly ReviewActionStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "DROPPED"];

export function isReviewActionStatus(value: unknown): value is ReviewActionStatus {
  return typeof value === "string" && (REVIEW_ACTION_STATUSES as readonly string[]).includes(value);
}

export const REVIEW_ACTION_TITLE_MAX = 200;
export const REVIEW_ACTION_NOTE_MAX = 2_000;

export interface ReviewActionInput {
  title: string;
  /** Who owes the action. A user id; the console picks from active staff. */
  ownerId: string;
  /** When it is due. A date, not a hope. */
  dueAt: string;
  note?: string | null;
}

/** One trackable action from a review. */
export interface ReviewActionRecord extends ReviewActionInput {
  id: string;
  tenantId: string;
  incidentId: string;
  reviewId: string;
  status: ReviewActionStatus;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
}

/** Validate one action. Returns every problem, not the first. */
export function validateReviewAction(input: Partial<ReviewActionInput>): string[] {
  const issues: string[] = [];

  const title = input.title?.trim() ?? "";
  if (!title) issues.push("An action needs a title.");
  else if (title.length > REVIEW_ACTION_TITLE_MAX) issues.push(`The title may be at most ${REVIEW_ACTION_TITLE_MAX} characters.`);

  if (!input.ownerId?.trim()) issues.push("An action needs an owner.");
  if (!input.dueAt?.trim()) issues.push("An action needs a due date.");
  else if (Number.isNaN(new Date(input.dueAt).getTime())) issues.push("The due date is not a valid date.");

  if (input.note != null && input.note.length > REVIEW_ACTION_NOTE_MAX) {
    issues.push(`The note may be at most ${REVIEW_ACTION_NOTE_MAX} characters.`);
  }

  return issues;
}

/** How an action stands right now. `OVERDUE` is the only computed state. */
export type ReviewActionState = "OPEN" | "IN_PROGRESS" | "OVERDUE" | "DONE" | "DROPPED";

export function actionState(action: ReviewActionRecord, now: string): ReviewActionState {
  if (action.status === "DONE") return "DONE";
  if (action.status === "DROPPED") return "DROPPED";
  if (now > action.dueAt) return "OVERDUE";
  return action.status;
}

export function actionStateLabel(state: ReviewActionState): string {
  switch (state) {
    case "OPEN":
      return "open";
    case "IN_PROGRESS":
      return "in progress";
    case "OVERDUE":
      return "overdue";
    case "DONE":
      return "done";
    case "DROPPED":
      return "dropped";
  }
}

/** Terminal states: an action can only be re-opened by a new action. */
export function isActionClosed(action: ReviewActionRecord): boolean {
  return action.status === "DONE" || action.status === "DROPPED";
}

/** Whether a status change is a move the desk can make from here. */
export function canChangeAction(action: ReviewActionRecord, to: ReviewActionStatus): { ok: true } | { ok: false; reason: string } {
  if (!isReviewActionStatus(to)) return { ok: false, reason: `Unknown action status "${to}".` };
  if (action.status === to) return { ok: false, reason: `This action is already ${actionStateLabel(action.status as ReviewActionState)}.` };
  if (isActionClosed(action) && (to === "OPEN" || to === "IN_PROGRESS")) {
    return { ok: false, reason: "A closed action is reopened by adding a new one, not by editing history." };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  The review                                                                */
/* -------------------------------------------------------------------------- */

export const REVIEW_FINDINGS_MAX = 20_000;
export const REVIEW_LESSONS_MAX = 20_000;

export interface ReviewInput {
  /** What happened, and why — the narrative a reader signs off on. */
  findings: string;
  /** What the desk is changing so it does not happen again. */
  lessons?: string;
  /** The work the review creates. At least one, or the review is a wish. */
  actions: ReviewActionInput[];
}

export interface ReviewRecord {
  id: string;
  tenantId: string;
  incidentId: string;
  findings: string;
  lessons: string | null;
  publishedBy: string;
  publishedAt: string;
}

/** Validate a review before it is published, including its actions. */
export function validateReview(input: Partial<ReviewInput>): string[] {
  const issues: string[] = [];

  const findings = input.findings?.trim() ?? "";
  if (!findings) issues.push("The review needs findings.");
  else if (findings.length > REVIEW_FINDINGS_MAX) issues.push(`The findings may be at most ${REVIEW_FINDINGS_MAX} characters.`);

  if (input.lessons != null && input.lessons.length > REVIEW_LESSONS_MAX) {
    issues.push(`The lessons may be at most ${REVIEW_LESSONS_MAX} characters.`);
  }

  const actions = input.actions ?? [];
  if (actions.length === 0) {
    issues.push("A review must name at least one action — otherwise nothing changes.");
  }
  actions.forEach((action, index) => {
    for (const issue of validateReviewAction(action)) issues.push(`Action ${index + 1}: ${issue}`);
  });

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Roll-up                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReviewSummary {
  total: number;
  open: number;
  inProgress: number;
  overdue: number;
  done: number;
  dropped: number;
  /** Share of the review's actions that are closed, 0–1. */
  closedShare: number;
  /** Whether anything is still owed. */
  settled: boolean;
}

/** Where a review's actions stand, for a page header and the exit criterion. */
export function reviewSummary(actions: readonly ReviewActionRecord[], now: string): ReviewSummary {
  const summary: ReviewSummary = { total: actions.length, open: 0, inProgress: 0, overdue: 0, done: 0, dropped: 0, closedShare: 0, settled: false };

  for (const action of actions) {
    switch (actionState(action, now)) {
      case "OPEN":
        summary.open += 1;
        break;
      case "IN_PROGRESS":
        summary.inProgress += 1;
        break;
      case "OVERDUE":
        summary.overdue += 1;
        break;
      case "DONE":
        summary.done += 1;
        break;
      case "DROPPED":
        summary.dropped += 1;
        break;
    }
  }

  const closed = summary.done + summary.dropped;
  summary.closedShare = actions.length === 0 ? 0 : closed / actions.length;
  summary.settled = actions.length > 0 && closed === actions.length;
  return summary;
}

/** What a reviewer would still say is missing from a published review. */
export function reviewCompleteness(
  review: ReviewRecord | null,
  actions: readonly ReviewActionRecord[],
  now: string,
): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!review) missing.push("the post-incident review has not been published");
  if (review && actions.length === 0) missing.push("the review names no actions");
  const summary = reviewSummary(actions, now);
  if (summary.overdue > 0) missing.push(`${summary.overdue} action${summary.overdue === 1 ? " is" : "s are"} overdue`);
  if (review && !summary.settled && actions.length > 0) missing.push("some actions are still open");
  return { complete: missing.length === 0, missing };
}
