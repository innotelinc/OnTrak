/**
 * What a caller may ask the results feed for, and how the question becomes a
 * query — as pure rules.
 *
 * The feed is read by systems that are not here (docs/integrations.md): a
 * reconciler catching up after an outage, a spreadsheet somebody maintains. The
 * two rules that make it usable from that distance are that a bad filter is
 * *described* rather than silently ignored (a `?since=` that was not a date must
 * not quietly return the whole table), and that paging is a keyset rather than an
 * offset, because an offset over a table that keeps being written silently skips
 * records.
 *
 * `mode` (docs/consolidation-audit.md §7 Step 6, §9/Q7) narrows by grader: a
 * consumer that wants only the results produced on real machines asks for
 * `?mode=lab`, and one that wants everything omits it. A stored `simulated` and a
 * missing mode are the same fact — both were graded by the simulator — so asking
 * for `simulated` has to match rows with no mode as well.
 *
 * Pure: no database, no request object, so every filter and every clause is cheap
 * to assert. `_results.ts` does the reading; this only decides.
 */

import type { AttemptStatus, Prisma } from "@prisma/client";

import { GRADING_MODES, isGradingMode, type GradingMode } from "./grading-mode";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export const RESULT_STATUSES: readonly AttemptStatus[] = ["GRADED", "EXPIRED", "SUBMITTED", "ABANDONED"];

export interface ResultFilters {
  since: Date | null;
  scenarioId: string | null;
  cohortId: string | null;
  status: AttemptStatus[];
  /** Which graders to include; both unless the caller narrowed it. */
  mode: GradingMode[];
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

  const mode = (url.searchParams.get("mode") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const unknownModes = mode.filter((entry) => !isGradingMode(entry));
  if (unknownModes.length > 0) {
    return { ok: false, reason: `unknown mode ${unknownModes.join(", ")}; expected ${GRADING_MODES.join(", ")}` };
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
      mode: mode.length > 0 ? ([...new Set(mode)] as GradingMode[]) : [...GRADING_MODES],
      limit,
      cursor: emptyToNull(url.searchParams.get("cursor")),
    },
  };
}

function emptyToNull(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The grader clause, or `null` when both are wanted (so the query stays
 * unfiltered rather than naming the two modes it would accept anyway).
 */
function modeWhere(modes: readonly GradingMode[]): Prisma.AttemptWhereInput | null {
  if (modes.length !== 1) return null;
  return modes[0] === "lab"
    ? { gradingMode: "lab" }
    : { OR: [{ gradingMode: null }, { gradingMode: "simulated" }] };
}

/**
 * The filters as a Prisma `where`.
 *
 * Clauses are collected into an `AND` rather than spread into one object,
 * because two of them (`cohortId`, and `mode=simulated`) each need their own
 * `OR`, and two `OR` keys in one object would overwrite each other.
 */
export function resultWhere(filters: ResultFilters): Prisma.AttemptWhereInput {
  const clauses: Prisma.AttemptWhereInput[] = [{ status: { in: filters.status } }];
  if (filters.since) clauses.push({ gradedAt: { gte: filters.since } });
  if (filters.scenarioId) clauses.push({ scenarioId: filters.scenarioId });
  if (filters.cohortId) {
    clauses.push({
      OR: [
        { assignment: { cohortId: filters.cohortId } },
        { user: { memberships: { some: { cohortId: filters.cohortId } } } },
      ],
    });
  }
  const byMode = modeWhere(filters.mode);
  if (byMode) clauses.push(byMode);

  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}
