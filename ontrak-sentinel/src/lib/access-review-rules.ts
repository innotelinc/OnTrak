/**
 * Access reviews (S2): the rules, with no store and no clock of their own.
 *
 * Provisioning answers “who exists”. This answers the question provisioning cannot:
 * *should these people still have this access?* A directory drains on its own schedule,
 * and its failure is silent — nobody removes a leaver's group membership, and a year
 * later the roster is everybody who ever joined. An access review is the periodic act
 * of a named person saying, per identity, that the access is still warranted.
 *
 * Four decisions live here rather than in the service, because each one is a judgement
 * that a test can state and a service would bury:
 *
 *  - **Being late is derived, never stored.** A review's `status` is what somebody did
 *    to it; whether it is overdue is `dueAt` against the clock. A stored `OVERDUE` flag
 *    would be one that a scheduler which did not run leaves wrong — and the review that
 *    most needs to look late is exactly the one nobody is scheduling.
 *  - **`PENDING` is the default and is not an approval.** The difference between
 *    “reviewed and kept” and “nobody got to it” is the only thing an auditor is
 *    actually asking about.
 *  - **A schedule that was missed opens one review, not thirty.** A deployment that was
 *    down for a month has the same amount of work to do whether the scheduler noticed
 *    once or thirty times, and thirty reviews would bury the one that matters. The
 *    number of missed intervals is *reported* instead, because it is worth knowing.
 *  - **A review can always be closed, even with items unattested.** Refusing would mean
 *    a review stays open forever the moment the reviewer leaves, which is how a
 *    compliance register fills with things that are open and meaningless. Closing
 *    reports what was never looked at; the report is the accountability.
 *
 * The clock is always an argument (`nowMs`), so nothing here is time-dependent and the
 * tests read as arithmetic rather than as waiting.
 */

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a review covers.
 *
 * `ORGANIZATION` is the honest default for a first review — you cannot miss anybody if
 * the scope is everybody — and `GROUP` is for the narrower, more common case of
 * attesting one team's access to one thing. There is deliberately no “role” scope: a
 * role is a property of a person that an administrator changes, so a review scoped to
 * one would silently change its own population the next time somebody was promoted,
 * and a list that moves under a reviewer is a list nobody finishes.
 */
export const ACCESS_REVIEW_SCOPES = ["ORGANIZATION", "GROUP"] as const;
export type AccessReviewScope = (typeof ACCESS_REVIEW_SCOPES)[number];

export function isAccessReviewScope(value: string): value is AccessReviewScope {
  return (ACCESS_REVIEW_SCOPES as readonly string[]).includes(value);
}

/** What a reviewer decided about one identity on one review. */
export const ACCESS_REVIEW_DECISIONS = ["PENDING", "KEPT", "REVOKED"] as const;
export type AccessReviewDecision = (typeof ACCESS_REVIEW_DECISIONS)[number];

export function isAccessReviewDecision(value: string): value is AccessReviewDecision {
  return (ACCESS_REVIEW_DECISIONS as readonly string[]).includes(value);
}

/** What somebody did to the review itself. */
export const ACCESS_REVIEW_STATUSES = ["OPEN", "COMPLETED", "CANCELLED"] as const;
export type AccessReviewStatus = (typeof ACCESS_REVIEW_STATUSES)[number];

export function isAccessReviewStatus(value: string): value is AccessReviewStatus {
  return (ACCESS_REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * How a review looks *now*: the stored status, plus lateness derived from the clock.
 * Kept separate from `AccessReviewStatus` so a reader can never mistake a derived
 * `OVERDUE` for something that was written down.
 */
export type AccessReviewState = AccessReviewStatus | "OVERDUE";

/* -------------------------------------------------------------------------- */
/*  Bounds                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long a review runs before it is late. A fortnight, because the work is “look at
 * each person's access and decide” and a deadline measured in months is one nobody
 * starts. A deployment that wants longer can say so; the default is what most reviews
 * should use.
 */
export const DEFAULT_REVIEW_WINDOW_DAYS = 14;

/**
 * How often a schedule may open a review.
 *
 * One day at the bottom: reviewing daily is unusual but legitimate for a privileged
 * group, and it is the interval that makes a typo visible rather than the one that
 * hides it — an interval of zero would open a review on every scheduler tick, which is
 * a denial of service written as a configuration.
 *
 * A year at the top: a schedule longer than the thing it reviews is a schedule that
 * exists to be pointed at, and a review nobody will reach is one nobody maintains.
 */
export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Validation — every message names the field it is about                    */
/* -------------------------------------------------------------------------- */

/** What a caller has to supply to open a review. */
export interface ReviewInput {
  name: string;
  scopeKind: string;
  /** A group id when the scope is `GROUP`; empty otherwise. */
  scopeValue: string;
  reviewerId: string;
  dueAtMs: number;
}

export function validateReview(input: ReviewInput, nowMs: number): string[] {
  const problems: string[] = [];

  if (!input.name.trim()) problems.push("A review needs a name somebody will recognise in a list.");
  if (input.name.trim().length > 120) problems.push("That name is longer than 120 characters.");

  if (!isAccessReviewScope(input.scopeKind)) {
    problems.push(`An unknown scope “${input.scopeKind}”. Use ${ACCESS_REVIEW_SCOPES.join(" or ")}.`);
  }
  // A group scope with no group would resolve to nobody, and a review of nobody looks
  // exactly like a review that passed — the failure mode is silence, which is why this
  // is an error rather than a default.
  if (input.scopeKind === "GROUP" && !input.scopeValue.trim()) {
    problems.push("A group review has to name the group it covers.");
  }

  if (!input.reviewerId.trim()) problems.push("A review needs a reviewer: an attestation nobody signed is not one.");

  // A deadline in the past is a review that is late the moment it opens, which means the
  // lateness signal stops meaning anything on the first day.
  if (!Number.isFinite(input.dueAtMs)) {
    problems.push("The due date is not a time.");
  } else if (input.dueAtMs <= nowMs) {
    problems.push("The due date is already in the past, so the review would open late.");
  }

  return problems;
}

/** What a caller has to supply to schedule a recurring review. */
export interface ScheduleInput {
  name: string;
  scopeKind: string;
  /** A group id when the scope is `GROUP`; empty otherwise. */
  scopeValue: string;
  reviewerId: string;
  intervalDays: number;
  firstRunAtMs: number;
}

export function validateSchedule(input: ScheduleInput, nowMs: number): string[] {
  const problems: string[] = [];

  if (!input.name.trim()) problems.push("A schedule needs a name; it becomes the name of every review it opens.");
  if (!isAccessReviewScope(input.scopeKind)) {
    problems.push(`An unknown scope “${input.scopeKind}”. Use ${ACCESS_REVIEW_SCOPES.join(" or ")}.`);
  }
  if (input.scopeKind === "GROUP" && !input.scopeValue.trim()) {
    problems.push("A group schedule has to name the group it covers.");
  }
  if (!input.reviewerId.trim()) problems.push("A schedule needs a reviewer, or every review it opens has nobody to answer.");

  if (!Number.isInteger(input.intervalDays)) {
    problems.push("The interval has to be a whole number of days.");
  } else if (input.intervalDays < MIN_INTERVAL_DAYS || input.intervalDays > MAX_INTERVAL_DAYS) {
    problems.push(`The interval has to be between ${MIN_INTERVAL_DAYS} and ${MAX_INTERVAL_DAYS} days.`);
  }

  if (!Number.isFinite(input.firstRunAtMs)) problems.push("The first run is not a time.");

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How the review looks now. `OVERDUE` only means anything while the review is open:
 * a completed review that ran past its deadline is completed, and reporting it as late
 * forever would make the one thing a reader wants to know — “is this finished?” —
 * harder to see than the thing they already know.
 */
export function reviewState(status: AccessReviewStatus, dueAtMs: number, nowMs: number): AccessReviewState {
  if (status !== "OPEN") return status;
  return nowMs > dueAtMs ? "OVERDUE" : "OPEN";
}

export interface ReviewProgress {
  total: number;
  kept: number;
  revoked: number;
  /** Items nobody has decided on. The number that makes a review honest. */
  pending: number;
}

export function reviewProgress(items: readonly { decision: string }[]): ReviewProgress {
  const progress: ReviewProgress = { total: items.length, kept: 0, revoked: 0, pending: 0 };
  for (const item of items) {
    // An unrecognised value counts as pending rather than as a decision: a row this
    // code does not understand must never be reported as somebody having approved it.
    if (item.decision === "KEPT") progress.kept += 1;
    else if (item.decision === "REVOKED") progress.revoked += 1;
    else progress.pending += 1;
  }
  return progress;
}

export type CloseCheck = { ok: true } | { ok: false; reason: string };

/**
 * Closing is always allowed on an open review — see the module header for why — but two
 * states cannot be closed because they are not open.
 */
export function canClose(status: AccessReviewStatus): CloseCheck {
  if (status === "OPEN") return { ok: true };
  return { ok: false, reason: status === "COMPLETED" ? "That review is already completed." : "That review was cancelled." };
}

/* -------------------------------------------------------------------------- */
/*  Scheduling arithmetic                                                     */
/* -------------------------------------------------------------------------- */

export interface ScheduleTick {
  /** Whether a review should be opened now. */
  open: boolean;
  /** How many intervals had passed unseen — reported, never multiplied into reviews. */
  missed: number;
  /** Where `nextRunAt` lands after this tick. */
  nextRunAtMs: number;
}

/**
 * What a scheduler tick should do with one schedule.
 *
 * The single decision worth stating: a schedule that is far overdue opens **one** review.
 * Multiplying a month's outage by a weekly interval into four reviews would bury the one
 * that matters, and they would all cover the same people anyway. `missed` comes back so
 * the run can say what happened rather than quietly pretending it was on time.
 */
export function scheduleTick(
  schedule: { enabled: boolean; nextRunAtMs: number; intervalDays: number },
  nowMs: number,
): ScheduleTick {
  if (!schedule.enabled) return { open: false, missed: 0, nextRunAtMs: schedule.nextRunAtMs };
  if (nowMs < schedule.nextRunAtMs) return { open: false, missed: 0, nextRunAtMs: schedule.nextRunAtMs };

  const intervalMs = schedule.intervalDays * DAY_MS;
  const elapsed = nowMs - schedule.nextRunAtMs;
  const missed = Math.floor(elapsed / intervalMs) + 1;

  // Advance to the first slot strictly in the future, so a tick that runs twice in the
  // same second does not open a second review.
  let nextRunAtMs = schedule.nextRunAtMs + missed * intervalMs;
  while (nextRunAtMs <= nowMs) nextRunAtMs += intervalMs;

  return { open: true, missed, nextRunAtMs };
}

/** When a review opened now should be due, by default. */
export function defaultDueAt(nowMs: number, windowDays: number = DEFAULT_REVIEW_WINDOW_DAYS): number {
  return nowMs + windowDays * DAY_MS;
}

/** When a schedule that just ran should next be due. */
export function nextRunAfter(ranAtMs: number, intervalDays: number): number {
  return ranAtMs + intervalDays * DAY_MS;
}
