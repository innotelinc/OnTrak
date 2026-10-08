/**
 * Graded attempts, read the same way by the JSON feed and the CSV export.
 *
 * Both routes answer the same question — "what was graded?" — so the filters,
 * the ordering and the page shape live here rather than being written twice and
 * drifting. The CSV adds a rendering step to exactly the rows the JSON would
 * have returned, which is the property an administrator relies on when they
 * reconcile a spreadsheet against the API.
 *
 * Pagination is a keyset on the attempt id in `gradedAt` order rather than an
 * offset. An offset over a table that gets new rows while you page through it
 * silently skips records (everything shifts down by one), which is precisely the
 * bug a reconciliation feed must not have.
 */

import { prisma } from "@/lib/db";
import { certificateCode } from "@/lib/credentials";
import { readStoredCertificate } from "@/lib/certificates";
import { normalizeGradingMode } from "@/lib/grading-mode";
import { clearedPassMark } from "@/lib/score-rules";
import { resultWhere, type ResultFilters } from "@/lib/result-filters";
import type { ResultCsvRow } from "@/lib/csv-rules";

// The filters and the query they build live in a pure module so they can be
// tested without a database; re-exported here so callers keep one import site.
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RESULT_STATUSES,
  readResultFilters,
  type FilterRead,
  type ResultFilters,
} from "@/lib/result-filters";

const INCLUDE = {
  user: { select: { id: true, email: true, name: true } },
  scenario: { select: { id: true, title: true, platform: true, passScore: true } },
  assignment: { select: { cohortId: true, cohort: { select: { id: true, name: true } } } },
  checkResults: true,
};

export async function loadResultPage(filters: ResultFilters) {
  const rows = await prisma.attempt.findMany({
    where: resultWhere(filters),
    orderBy: [{ gradedAt: "desc" }, { id: "desc" }],
    take: filters.limit,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: INCLUDE,
  });
  const nextCursor = rows.length === filters.limit ? rows[rows.length - 1].id : null;
  return { rows, nextCursor };
}

export type AttemptRow = Awaited<ReturnType<typeof loadResultPage>>["rows"][number];

/** The certificate this attempt was issued, if it still stands. */
export function certificateOf(attempt: AttemptRow) {
  const stored = readStoredCertificate(attempt);
  if (!stored) return null;
  return {
    id: stored.record.id,
    code: certificateCode(stored.record),
    digest: stored.record.digest,
    issuedAt: stored.issuedAt,
    revokedAt: stored.revokedAt ?? null,
  };
}

export function toResultJson(attempt: AttemptRow) {
  return {
    attemptId: attempt.id,
    status: attempt.status,
    // Who graded it. Always present, never null: a consumer comparing scores
    // must be able to tell a simulator's pass from a live machine's (§7 Step 6).
    mode: normalizeGradingMode(attempt.gradingMode),
    learner: { id: attempt.user.id, email: attempt.user.email, name: attempt.user.name },
    scenario: {
      id: attempt.scenario.id,
      title: attempt.scenario.title,
      platform: attempt.scenario.platform,
      passScore: attempt.scenario.passScore,
    },
    cohort: attempt.assignment?.cohort
      ? { id: attempt.assignment.cohort.id, name: attempt.assignment.cohort.name }
      : null,
    score: attempt.score,
    maxScore: attempt.maxScore,
    // The pass mark is a percentage, so the score is compared as one, and a
    // scenario worth zero points is not a pass: the one rule every screen, the
    // certificate and the webhook use (`score-rules.ts`). A raw
    // `score >= passScore` would call an 8/10 attempt a failure against a 70% mark.
    passed: clearedPassMark({
      score: attempt.score,
      maxScore: attempt.maxScore,
      passScore: attempt.scenario.passScore,
    }),
    timeSpentSec: attempt.timeSpentSec,
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    gradedAt: attempt.gradedAt?.toISOString() ?? null,
    certificate: certificateOf(attempt),
    checks: attempt.checkResults.map((check) => ({
      checkId: check.checkId,
      label: check.label,
      passed: check.passed,
      points: check.points,
      maxPoints: check.maxPoints,
    })),
  };
}

export function toCsvRow(attempt: AttemptRow): ResultCsvRow {
  return {
    attemptId: attempt.id,
    learnerEmail: attempt.user.email,
    learnerName: attempt.user.name,
    scenarioId: attempt.scenario.id,
    scenarioTitle: attempt.scenario.title,
    platform: attempt.scenario.platform,
    status: attempt.status,
    score: attempt.score,
    maxScore: attempt.maxScore,
    passScore: attempt.scenario.passScore,
    startedAt: attempt.startedAt,
    gradedAt: attempt.gradedAt,
    timeSpentSec: attempt.timeSpentSec,
    certificateCode: certificateOf(attempt)?.code ?? null,
    mode: normalizeGradingMode(attempt.gradingMode),
  };
}
