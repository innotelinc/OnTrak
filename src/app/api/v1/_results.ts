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

import type { AttemptStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { certificateCode } from "@/lib/credentials";
import { readStoredCertificate } from "@/lib/certificates";
import { normalizeGradingMode } from "@/lib/grading-mode";
import type { ResultCsvRow } from "@/lib/csv-rules";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export const RESULT_STATUSES: readonly AttemptStatus[] = ["GRADED", "EXPIRED", "SUBMITTED", "ABANDONED"];

export interface ResultFilters {
  since: Date | null;
  scenarioId: string | null;
  cohortId: string | null;
  status: AttemptStatus[];
  limit: number;
  cursor: string | null;
}

export type FilterRead = { ok: true; filters: ResultFilters } | { ok: false; reason: string };

export function readResultFilters(url: URL): FilterRead {
  const sinceText = (url.searchParams.get("since") ?? "").trim();
  let since: Date | null = null;
  if (sinceText) {
    const parsed = new Date(sinceText);
    if (Number.isNaN(parsed.getTime())) return { ok: false, reason: "`since` must be an ISO-8601 date-time." };
    since = parsed;
  }

  const status = (url.searchParams.get("status") ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase() as AttemptStatus)
    .filter((entry) => entry.length > 0);
  const unknown = status.filter((entry) => !RESULT_STATUSES.includes(entry));
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown status ${unknown.join(", ")}; expected ${RESULT_STATUSES.join(", ")}` };
  }

  const rawLimit = Number((url.searchParams.get("limit") ?? "").trim());
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  return {
    ok: true,
    filters: {
      since,
      scenarioId: emptyToNull(url.searchParams.get("scenarioId")),
      cohortId: emptyToNull(url.searchParams.get("cohortId")),
      // Absent means "everything that finished", which is what a consumer wants by
      // default: an abandoned attempt is still a thing that happened to a learner.
      status: status.length > 0 ? status : [...RESULT_STATUSES],
      limit,
      cursor: emptyToNull(url.searchParams.get("cursor")),
    },
  };
}

function emptyToNull(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resultWhere(filters: ResultFilters) {
  return {
    status: { in: filters.status },
    ...(filters.since ? { gradedAt: { gte: filters.since } } : {}),
    ...(filters.scenarioId ? { scenarioId: filters.scenarioId } : {}),
    ...(filters.cohortId
      ? {
          OR: [
            { assignment: { cohortId: filters.cohortId } },
            { user: { memberships: { some: { cohortId: filters.cohortId } } } },
          ],
        }
      : {}),
  };
}

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
    passed: attempt.score >= attempt.scenario.passScore,
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
