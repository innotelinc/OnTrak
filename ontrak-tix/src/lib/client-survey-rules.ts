/**
 * Client-facing survey rules (M4).
 *
 * The M1 survey asks the person whose ticket it was. That is the right question
 * for an internal desk and the wrong one for an MSP, where the person who signs
 * the invoice is usually not the person who raised the ticket. So M4 adds a
 * **client-level** survey: one question per client per period, answered from a
 * link by whoever holds it — no portal account, because the person who owns the
 * relationship should not have to be provisioned to say whether they are happy.
 *
 * Same convention as everywhere else: the decisions are pure. The rules here are
 * small on purpose, and two of them are worth stating:
 *
 *  - **A period must have happened.** Surveying a month that has not finished
 *    invites a rating of an unfinished story, and the answer then means nothing.
 *  - **A period is surveyed once.** Asking twice for the same period is how a
 *    client learns to ignore the question.
 */

import {
  csatStatus,
  summariseCsat,
  validateCsatResponse,
  type CsatScore,
  type CsatStatus,
  type CsatSummary,
  type CsatSurvey,
  type CsatIssue,
} from "./csat-rules";
import { isWorkDate } from "./time-rules";

/** How long a client's survey link stays open before it has to be re-sent. */
export const CLIENT_SURVEY_TTL_DAYS = 45;

export interface ClientSurveyRecord {
  id: string;
  tenantId: string;
  clientId: string;
  /** The unguessable link. The token is the only credential the page needs. */
  token: string;
  /** The period being asked about, `YYYY-MM-DD` inclusive. */
  periodStart: string;
  periodEnd: string;
  requestedBy: string;
  requestedAt: string;
  score: CsatScore | null;
  comment: string | null;
  respondedAt: string | null;
}

/**
 * Whether a period can be surveyed. `today` is passed in rather than read, so the
 * answer is the same in a test, a sweep and a page.
 */
export function validateSurveyPeriod(
  input: { periodStart?: string; periodEnd?: string },
  today: string,
): CsatIssue[] {
  const issues: CsatIssue[] = [];

  if (!isWorkDate(input.periodStart)) {
    issues.push({ field: "periodStart", message: "Give the period's start as YYYY-MM-DD." });
  }
  if (!isWorkDate(input.periodEnd)) {
    issues.push({ field: "periodEnd", message: "Give the period's end as YYYY-MM-DD." });
  }
  if (issues.length > 0) return issues;

  const start = input.periodStart as string;
  const end = input.periodEnd as string;
  if (start > end) {
    issues.push({ field: "periodEnd", message: "A period cannot end before it starts." });
  } else if (end > today) {
    issues.push({ field: "periodEnd", message: `That period has not happened yet — it ends after ${today}.` });
  }
  return issues;
}

/** The status of a client's survey link, for a page deciding what to render. */
export function clientSurveyStatus(
  record: Pick<ClientSurveyRecord, "requestedAt" | "respondedAt" | "score">,
  now: Date | string,
  ttlDays = CLIENT_SURVEY_TTL_DAYS,
): CsatStatus {
  return csatStatus(toSurvey(record), now, ttlDays);
}

/** A survey that has been answered — which is the only thing worth counting. */
export function clientSurveyAnswered(record: Pick<ClientSurveyRecord, "respondedAt" | "score">): boolean {
  return record.respondedAt !== null && record.score !== null;
}

/**
 * What a client's surveys came to. `offered` is how many were sent, so a response
 * rate is honest about the ones never answered — a client that ignores the
 * question is information, not an absence of it.
 */
export function clientSurveySummary(records: readonly ClientSurveyRecord[]): CsatSummary {
  return summariseCsat(
    records.map(toSurvey),
    records.length,
  );
}

/** Reuse the M1 validator: the question is the same, whoever is answering it. */
export { validateCsatResponse };

/** The one-line question a client is asked, so the page and the report agree. */
export function surveyQuestion(clientName: string, periodStart: string, periodEnd: string): string {
  return `How was ${clientName}'s support between ${periodStart} and ${periodEnd}?`;
}

function toSurvey(record: Pick<ClientSurveyRecord, "requestedAt" | "respondedAt" | "score">): CsatSurvey {
  return {
    token: "",
    requestedAt: record.requestedAt,
    respondedAt: record.respondedAt,
    score: record.score,
    comment: null,
  };
}
