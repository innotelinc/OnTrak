/**
 * CSAT rules (M1): the satisfaction survey a resolved ticket earns.
 *
 * Same convention as the rest of the package: the decision (may we ask? is this
 * token still valid? is this score sane?) is pure and tested, and the app layer
 * only persists the outcome. A survey is never a gate on support — asking is
 * always optional and silence is a valid answer.
 */

export const CSAT_MIN_SCORE = 1;
export const CSAT_MAX_SCORE = 5;
export const CSAT_SCALE: readonly number[] = [1, 2, 3, 4, 5];

/** How long a survey link stays open, in days. */
export const CSAT_DEFAULT_TTL_DAYS = 30;

export type CsatScore = 1 | 2 | 3 | 4 | 5;

export interface CsatSurvey {
  token: string;
  /** Server-authoritative UTC timestamps. */
  requestedAt: string;
  respondedAt: string | null;
  score: CsatScore | null;
  comment: string | null;
}

export type CsatStatus = "pending" | "answered" | "expired";

/** The minimum a ticket must expose to decide whether to ask for a rating. */
export interface CsatEligibleTicket {
  status: string;
  resolvedAt: string | null;
}

/**
 * A survey is offered once a ticket is resolved and only then — asking while
 * work is still in flight invites a rating of the process, not the outcome.
 */
export function shouldRequestSurvey(ticket: CsatEligibleTicket, alreadyRequested: boolean): boolean {
  if (alreadyRequested) return false;
  return ticket.status === "RESOLVED" && ticket.resolvedAt !== null;
}

export function isValidCsatScore(value: unknown): value is CsatScore {
  return typeof value === "number" && Number.isInteger(value) && value >= CSAT_MIN_SCORE && value <= CSAT_MAX_SCORE;
}

export interface CsatIssue {
  field: string;
  message: string;
}

export const CSAT_COMMENT_MAX = 2_000;

/** Validate a submitted rating before it is written. A score is required. */
export function validateCsatResponse(score: unknown, comment?: string): CsatIssue[] {
  const issues: CsatIssue[] = [];
  if (!isValidCsatScore(score)) {
    issues.push({ field: "score", message: `Choose a rating from ${CSAT_MIN_SCORE} to ${CSAT_MAX_SCORE}.` });
  }
  if (comment !== undefined && comment.length > CSAT_COMMENT_MAX) {
    issues.push({ field: "comment", message: `A comment may be at most ${CSAT_COMMENT_MAX} characters.` });
  }
  return issues;
}

/** Whether a survey link is still usable at `now`. */
export function csatStatus(survey: CsatSurvey, now: Date | string, ttlDays = CSAT_DEFAULT_TTL_DAYS): CsatStatus {
  if (survey.respondedAt !== null) return "answered";
  const requested = new Date(survey.requestedAt).getTime();
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(requested) || !Number.isFinite(at)) return "expired";
  return at - requested > ttlMs ? "expired" : "pending";
}

/** A human label for a score, used in reports and the portal. */
export function satisfactionLabel(score: CsatScore): string {
  switch (score) {
    case 1:
      return "Very dissatisfied";
    case 2:
      return "Dissatisfied";
    case 3:
      return "Neutral";
    case 4:
      return "Satisfied";
    case 5:
      return "Very satisfied";
  }
}

/** A 4 or 5 is a satisfied response; the standard "positive" cut. */
export function isPositive(score: CsatScore): boolean {
  return score >= 4;
}

export interface CsatSummary {
  responses: number;
  pending: number;
  average: number | null;
  /** Percentage of answers that were positive, to one decimal place. */
  positivePercent: number | null;
  /** The share of resolved tickets that answered, to one decimal place. */
  responseRatePercent: number | null;
}

/**
 * Roll up surveys for a report. `offered` is how many tickets were sent a
 * survey, so the response rate is honest about the ones never answered.
 */
export function summariseCsat(surveys: readonly CsatSurvey[], offered: number): CsatSummary {
  const answered = surveys.filter((survey) => survey.respondedAt !== null && survey.score !== null);
  const average = answered.length === 0 ? null : round1(answered.reduce((sum, survey) => sum + (survey.score ?? 0), 0) / answered.length);
  const positive = answered.filter((survey) => isPositive(survey.score as CsatScore)).length;

  return {
    responses: answered.length,
    pending: surveys.length - answered.length,
    average,
    positivePercent: answered.length === 0 ? null : round1((positive / answered.length) * 100),
    responseRatePercent: offered === 0 ? null : round1((answered.length / offered) * 100),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/*  The dashboard (M5)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A satisfied customer is the same answer here as everywhere else, but a *report*
 * needs more than an average: one person who scored 1 and one who scored 5 also
 * average 3, and they are not the same desk. So the dashboard carries the shape
 * of the answers — every point on the scale, including the ones nobody picked —
 * and the words, because "the wait was fine but nobody explained" is the finding.
 */

/** One bar of the satisfaction distribution. */
export interface CsatBucket {
  score: CsatScore;
  label: string;
  count: number;
  /** Share of answers, to one decimal place; `null` when nothing was answered. */
  percent: number | null;
}

/** An answer somebody typed words into — what a bar chart cannot carry. */
export interface CsatComment {
  score: CsatScore;
  comment: string;
  answeredAt: string;
}

/** A survey attributed to the agent or queue that earned it. */
export interface AttributedSurvey {
  survey: CsatSurvey;
  /** The bucket it belongs to — an agent id, a queue id — or `null` for none. */
  groupId: string | null;
}

/** One agent's or queue's satisfaction. */
export interface CsatGroupScore {
  groupId: string | null;
  label: string;
  summary: CsatSummary;
  distribution: CsatBucket[];
}

export interface CsatDashboard {
  summary: CsatSummary;
  /** Every point on the scale, so a missing 1 is visibly a zero, not an absence. */
  distribution: CsatBucket[];
  /** Recent answers that came with words, newest first. */
  comments: CsatComment[];
}

/** The answers as a distribution over the whole scale. */
export function csatDistribution(surveys: readonly CsatSurvey[]): CsatBucket[] {
  const answered = surveys.filter((survey) => survey.respondedAt !== null && survey.score !== null);
  return CSAT_SCALE.map((score) => {
    const count = answered.filter((survey) => survey.score === score).length;
    return {
      score: score as CsatScore,
      label: satisfactionLabel(score as CsatScore),
      count,
      percent: answered.length === 0 ? null : round1((count / answered.length) * 100),
    };
  });
}

/** The answers that came with words, newest first. */
export function csatComments(surveys: readonly CsatSurvey[], limit = 10): CsatComment[] {
  return surveys
    .filter(
      (survey): survey is CsatSurvey & { score: CsatScore; comment: string; respondedAt: string } =>
        survey.respondedAt !== null &&
        survey.score !== null &&
        typeof survey.comment === "string" &&
        survey.comment.trim().length > 0,
    )
    .sort((a, b) => b.respondedAt.localeCompare(a.respondedAt))
    .slice(0, Math.max(0, limit))
    .map((survey) => ({ score: survey.score, comment: survey.comment.trim(), answeredAt: survey.respondedAt }));
}

/** Everything a satisfaction dashboard shows, from the one list of surveys. */
export function csatDashboard(
  surveys: readonly CsatSurvey[],
  offered: number,
  options: { commentLimit?: number } = {},
): CsatDashboard {
  return {
    summary: summariseCsat(surveys, offered),
    distribution: csatDistribution(surveys),
    comments: csatComments(surveys, options.commentLimit ?? 10),
  };
}

/**
 * Satisfaction split by whoever earned it, worst first.
 *
 * The order is the point — a table whose first row is the queue people are
 * complaining about is one a manager can act on. A group with no answers yet is
 * not "doing badly", so it sorts last rather than to the top on a null average.
 */
export function csatByGroup(
  entries: readonly AttributedSurvey[],
  labelOf: (groupId: string | null) => string,
): CsatGroupScore[] {
  const buckets = new Map<string | null, CsatSurvey[]>();
  for (const entry of entries) {
    const existing = buckets.get(entry.groupId);
    if (existing) existing.push(entry.survey);
    else buckets.set(entry.groupId, [entry.survey]);
  }

  return [...buckets.entries()]
    .map(([groupId, surveys]) => ({
      groupId,
      label: labelOf(groupId),
      // "Offered" for a group is every survey it was sent, so the response rate
      // is as honest per group as it is desk-wide.
      summary: summariseCsat(surveys, surveys.length),
      distribution: csatDistribution(surveys),
    }))
    .sort(bySatisfaction);
}

/** Worst average first, then whichever has more evidence, then by label. */
function bySatisfaction(a: CsatGroupScore, b: CsatGroupScore): number {
  return (
    (a.summary.average ?? 101) - (b.summary.average ?? 101) ||
    b.summary.responses - a.summary.responses ||
    a.label.localeCompare(b.label)
  );
}
