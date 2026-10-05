/**
 * Analytics rules (M7): trends, and scorecards for the people and queues doing the work.
 *
 * The M1 report answers "where do we stand right now"; this answers "which way are we
 * going, and who is carrying it". Both are derived from the same tickets and the same
 * SLA engine (`buildSlaReport`), so an agent's attainment on a scorecard can never
 * disagree with the desk-wide figure it was drawn from — the arithmetic exists once.
 *
 * Pure and dependency-free: the page hands over records it already has, and every
 * decision here is testable without a database.
 */

import { isOpen, type TicketStatus } from "./ticket-rules";
import { buildSlaReport, type ReportTicket, type TimingStats } from "./report-rules";
import type { SlaPolicy } from "./sla-rules";

/* -------------------------------------------------------------------------- */
/*  Trends                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum a ticket has to expose to be placed on a timeline.
 *
 * `closedAt` is optional so callers written before it existed still work; a closed
 * ticket without one falls back to `resolvedAt`, which is the moment it left the board
 * for the purposes of a trend.
 */
export interface TrendTicket {
  id: string;
  status: TicketStatus;
  createdAt: string;
  resolvedAt: string | null;
  closedAt?: string | null;
}

export interface TrendPoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  created: number;
  closed: number;
  /** Still open at the end of this day, by the timestamps. */
  backlog: number;
}

export interface TrendReport {
  days: number;
  points: TrendPoint[];
  createdTotal: number;
  closedTotal: number;
  /**
   * Change against the window immediately before this one, as a whole percent, or
   * `null` when the previous window was empty — "up from nothing" is not a percentage.
   */
  createdChangePercent: number | null;
  closedChangePercent: number | null;
  /** Open right now, by the same timestamp rule the per-day backlog uses. */
  backlogNow: number;
}

const DAY_MS = 24 * 3600 * 1000;

/** The UTC day of an instant, `YYYY-MM-DD`. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** The instant at the end of a UTC day, as the string the comparisons sort against. */
function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

function dayKeys(now: Date, days: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    keys.push(new Date(end - offset * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Ticket volume over the last `days` UTC days, with the backlog it left behind.
 *
 * The backlog is recomputed from timestamps rather than read off today's status, so a
 * point for a day last week says what was open *then* — a chart that redrew history
 * every time somebody closed a ticket would be worse than no chart. A ticket closed
 * with no `closedAt` falls back to `resolvedAt`; one with neither is still open.
 */
export function ticketTrends(tickets: readonly TrendTicket[], now: Date | string, days = 30): TrendReport {
  const moment = typeof now === "string" ? new Date(now) : now;
  const window = Math.max(1, Math.floor(days));
  const keys = dayKeys(moment, window);
  const inWindow = new Set(keys);

  const createdByDay = new Map<string, number>(keys.map((day) => [day, 0]));
  const closedByDay = new Map<string, number>(keys.map((day) => [day, 0]));

  let createdPrevious = 0;
  let closedPrevious = 0;
  // The window before this one, for the change figures: [start - window, start).
  const start = keys[0];
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const previousStartMs = startMs - window * DAY_MS;

  const closureOf = (ticket: TrendTicket): string | null => ticket.closedAt ?? ticket.resolvedAt;

  for (const ticket of tickets) {
    const created = dayOf(ticket.createdAt);
    if (inWindow.has(created)) createdByDay.set(created, (createdByDay.get(created) ?? 0) + 1);
    else {
      const at = Date.parse(`${created}T00:00:00.000Z`);
      if (at >= previousStartMs && at < startMs) createdPrevious += 1;
    }

    const closed = closureOf(ticket);
    if (closed === null) continue;
    const closedDay = dayOf(closed);
    if (inWindow.has(closedDay)) closedByDay.set(closedDay, (closedByDay.get(closedDay) ?? 0) + 1);
    else {
      const at = Date.parse(`${closedDay}T00:00:00.000Z`);
      if (at >= previousStartMs && at < startMs) closedPrevious += 1;
    }
  }

  const points: TrendPoint[] = keys.map((day) => {
    const end = endOfDay(day);
    const backlog = tickets.filter((ticket) => {
      if (ticket.createdAt > end) return false;
      const closed = closureOf(ticket);
      return closed === null || closed > end;
    }).length;
    return { day, created: createdByDay.get(day) ?? 0, closed: closedByDay.get(day) ?? 0, backlog };
  });

  const createdTotal = points.reduce((sum, point) => sum + point.created, 0);
  const closedTotal = points.reduce((sum, point) => sum + point.closed, 0);
  const nowIso = moment.toISOString();
  const backlogNow = tickets.filter((ticket) => {
    if (ticket.createdAt > nowIso) return false;
    const closed = closureOf(ticket);
    return closed === null || closed > nowIso;
  }).length;

  return {
    days: window,
    points,
    createdTotal,
    closedTotal,
    createdChangePercent: changePercent(createdTotal, createdPrevious),
    closedChangePercent: changePercent(closedTotal, closedPrevious),
    backlogNow,
  };
}

/* -------------------------------------------------------------------------- */
/*  Agent and queue scorecards                                                */
/* -------------------------------------------------------------------------- */

/** A group a scorecard can be built for: a person, a queue. */
export interface WorkGroup {
  id: string | null;
  name: string;
}

/** One group's numbers, in the shape the desk-wide report uses. */
export interface WorkScorecard {
  groupId: string | null;
  name: string;
  total: number;
  open: number;
  closed: number;
  breached: number;
  atRisk: number;
  /** No SLA policy, so no clock — surfaced so "no target" is not read as "on target". */
  withoutPolicy: number;
  response: { attainmentPercent: number | null; timing: TimingStats };
  resolution: { attainmentPercent: number | null; timing: TimingStats };
}

/**
 * Split a worklist into groups and score each one.
 *
 * The buckets are built from the *records*, not from a supplied roster, so a group with
 * no tickets is simply absent and a ticket whose group was removed still appears — under
 * its id, because a scorecard that quietly dropped work would understate the desk. Work
 * with no group (an unassigned ticket, a ticket with no queue) is a bucket of its own for
 * the same reason: the parts must add up to the whole.
 */
export function groupScorecards(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  groups: readonly WorkGroup[],
  idOf: (ticket: ReportTicket) => string | null,
  unassignedLabel: string,
  now: Date | string,
): WorkScorecard[] {
  const buckets = new Map<string | null, { name: string; mine: ReportTicket[] }>();
  for (const group of groups) buckets.set(group.id, { name: group.name, mine: [] });
  buckets.set(null, { name: unassignedLabel, mine: [] });
  const nameOf = new Map(groups.map((group) => [group.id, group.name]));

  for (const ticket of tickets) {
    const id = idOf(ticket);
    const bucket = buckets.get(id) ?? { name: nameOf.get(id) ?? id ?? unassignedLabel, mine: [] };
    bucket.mine.push(ticket);
    buckets.set(id, bucket);
  }

  return [...buckets.entries()]
    // A group nobody touched is not a row: a scorecard of empty rows hides the ones with
    // work in them.
    .filter(([, bucket]) => bucket.mine.length > 0)
    .map(([groupId, bucket]) => {
      const report = buildSlaReport(bucket.mine, policies, now);
      return {
        groupId,
        name: bucket.name,
        total: report.totals.total,
        open: report.totals.open,
        closed: report.totals.resolvedOrClosed,
        breached: report.breached.length,
        atRisk: report.atRisk.length,
        withoutPolicy: report.totals.withoutPolicy,
        response: report.response,
        resolution: report.resolution,
      };
    })
    .sort(byWorkHealth);
}

/** Who is carrying the work: one scorecard per assignee, worst first. */
export function agentScorecards(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  people: readonly WorkGroup[],
  now: Date | string,
): WorkScorecard[] {
  return groupScorecards(tickets, policies, people, (ticket) => ticket.assigneeId ?? null, "Unassigned", now);
}

/** Where the work is landing: one scorecard per queue, worst first. */
export function queueScorecards(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  queues: readonly WorkGroup[],
  now: Date | string,
): WorkScorecard[] {
  return groupScorecards(tickets, policies, queues, (ticket) => ticket.queueId ?? null, "No queue", now);
}

/**
 * Most breached first, then largest backlog, then worst resolution attainment, then name.
 *
 * A dispatcher reads the top of the list, so the order is the useful part: the group
 * about to cost the desk a promise comes first, and a group with a big but healthy
 * backlog is visible without outranking one that is actually breaching.
 */
function byWorkHealth(a: WorkScorecard, b: WorkScorecard): number {
  return (
    b.breached - a.breached ||
    b.open - a.open ||
    (a.resolution.attainmentPercent ?? 101) - (b.resolution.attainmentPercent ?? 101) ||
    a.name.localeCompare(b.name)
  );
}

/* -------------------------------------------------------------------------- */
/*  A compact, serializable picture                                           */
/* -------------------------------------------------------------------------- */

/** The headline numbers of a trend window, for the audit chain or an export. */
export interface TrendSnapshot {
  days: number;
  createdTotal: number;
  closedTotal: number;
  backlogNow: number;
  createdChangePercent: number | null;
  closedChangePercent: number | null;
}

export function trendSnapshot(report: TrendReport): TrendSnapshot {
  return {
    days: report.days,
    createdTotal: report.createdTotal,
    closedTotal: report.closedTotal,
    backlogNow: report.backlogNow,
    createdChangePercent: report.createdChangePercent,
    closedChangePercent: report.closedChangePercent,
  };
}
