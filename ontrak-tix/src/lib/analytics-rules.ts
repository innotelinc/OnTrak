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

import { isOpen, type TicketPriority, type TicketStatus } from "./ticket-rules";
import { buildSlaReport, type ReportTicket, type TimingStats } from "./report-rules";
import type { SlaClockKind, SlaClockView, SlaPolicy } from "./sla-rules";

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
/*  Forecast                                                                  */
/* -------------------------------------------------------------------------- */

/** One projected day. `created`/`closed` are the recent daily averages; `backlog` is cumulative. */
export interface ForecastPoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  created: number;
  closed: number;
  /** Projected still open at the end of this day. */
  backlog: number;
}

export type ForecastOutlook = "clearing" | "stable" | "accumulating";

export interface ForecastReport {
  horizonDays: number;
  /** How many recent days the per-day averages are taken from. */
  basisDays: number;
  /** Recent average intake, per day. */
  dailyCreated: number;
  /** Recent average closures, per day. */
  dailyClosed: number;
  points: ForecastPoint[];
  /** Projected backlog at the end of the horizon. */
  projectedBacklog: number;
  /** Change in backlog over the horizon: `projectedBacklog - backlogNow`. */
  projectedBacklogDelta: number;
  outlook: ForecastOutlook;
}

const DEFAULT_BASIS_DAYS = 7;
const DEFAULT_HORIZON_DAYS = 14;
/** Small enough to catch a real drift, wide enough not to flip on one day's rounding. */
const OUTLOOK_TOLERANCE = 0.05;

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Project the backlog forward from the trend.
 *
 * Deliberately a straight line and not a model: intake and closures are held at their
 * average over the last `basisDays`, and the two are poured into the backlog. The shape
 * of the *question* is what matters — "at this rate, is the desk falling behind?" — and a
 * moving average answers it, where a curve fitted to three weeks of a small desk's data
 * would only look more certain than it is. `outlook` names the answer so the page need
 * not re-derive it, and the delta stays readable when the backlog is going nowhere.
 */
export function forecastVolume(
  report: TrendReport,
  options: { horizonDays?: number; basisDays?: number } = {},
): ForecastReport {
  const horizon = Math.max(1, Math.floor(options.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const basis = Math.max(1, Math.floor(options.basisDays ?? DEFAULT_BASIS_DAYS));
  const recent = report.points.slice(-basis);
  const dailyCreated = mean(recent.map((point) => point.created));
  const dailyClosed = mean(recent.map((point) => point.closed));

  const lastDay = report.points.length > 0
    ? report.points[report.points.length - 1].day
    : dayOf(new Date().toISOString());
  const lastMs = Date.parse(`${lastDay}T00:00:00.000Z`);
  let backlog = report.backlogNow;
  const points: ForecastPoint[] = [];
  for (let offset = 1; offset <= horizon; offset++) {
    backlog += dailyCreated - dailyClosed;
    points.push({
      day: new Date(lastMs + offset * DAY_MS).toISOString().slice(0, 10),
      created: Math.round(dailyCreated),
      closed: Math.round(dailyClosed),
      backlog: Math.round(backlog),
    });
  }

  const drift = dailyClosed - dailyCreated;
  return {
    horizonDays: horizon,
    basisDays: Math.min(basis, recent.length) || basis,
    dailyCreated: round1(dailyCreated),
    dailyClosed: round1(dailyClosed),
    points,
    projectedBacklog: Math.round(backlog),
    projectedBacklogDelta: Math.round(backlog - report.backlogNow),
    outlook: drift > OUTLOOK_TOLERANCE
      ? "clearing"
      : drift < -OUTLOOK_TOLERANCE
        ? "accumulating"
        : "stable",
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
/*  SLA risk                                                                  */
/* -------------------------------------------------------------------------- */

export type RiskBand = "critical" | "high" | "medium" | "low";

/** Half a working day: near enough to act on, far enough ahead to warn. */
export const RISK_HORIZON_MINUTES = 240;

/** One open ticket, placed by how soon its nearest running clock will lapse. */
export interface SlaRiskItem {
  ticketId: string;
  ref: string;
  subject: string;
  priority: TicketPriority;
  assigneeId: string | null;
  /** The running clock that is closest to its deadline. */
  clock: SlaClockKind;
  /** Business minutes left on that clock (`0` once past). */
  remainingMinutes: number;
  dueAt: string;
  /** An open pause is holding the clock, so the risk is not moving. */
  paused: boolean;
  band: RiskBand;
  /** A short sentence for the row, so the band is legible without a legend. */
  reason: string;
}

export interface SlaRiskReport {
  horizonMinutes: number;
  items: SlaRiskItem[];
  counts: Record<RiskBand, number>;
  /** Critical plus high: the tickets expected to breach inside the horizon. */
  projectedBreaches: number;
  /** Open tickets with no policy, so no clock and therefore no risk to model. */
  withoutPolicy: number;
}

const RISK_ORDER: Record<RiskBand, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function bandFor(remainingMinutes: number, horizonMinutes: number): RiskBand {
  if (remainingMinutes <= 0) return "critical";
  if (remainingMinutes <= horizonMinutes * 0.25) return "high";
  if (remainingMinutes <= horizonMinutes) return "medium";
  return "low";
}

function riskReason(band: RiskBand, clock: SlaClockKind, remainingMinutes: number): string {
  if (band === "critical") return `past its ${clock} target`;
  const minutes = `${Math.round(remainingMinutes)} business min`;
  return band === "high"
    ? `${minutes} left on ${clock} — a breach is inside the horizon`
    : `${minutes} left on ${clock}`;
}

function byRisk(a: SlaRiskItem, b: SlaRiskItem): number {
  return (
    RISK_ORDER[a.band] - RISK_ORDER[b.band] ||
    a.remainingMinutes - b.remainingMinutes ||
    a.ref.localeCompare(b.ref)
  );
}

/**
 * Rank the open work by how soon it will breach, not by whether it already has.
 *
 * The report above answers "what is breached" and "what is in its warning window"; both
 * are facts about the clocks as they stand. This answers the question a lead acts on —
 * "what will breach if nobody touches it?" — by placing every open ticket on the running
 * clock nearest its deadline and banding it by how much of the horizon is left. A ticket
 * three hours from its target is on no at-risk list yet, and is exactly the one worth
 * seeing while there is still time to answer it.
 *
 * Built on `buildSlaReport`, so it can never disagree with the breach lists beside it,
 * and a ticket whose clocks are both met contributes nothing — there is nothing left to
 * breach. A ticket with no policy has no clock and is counted, not silently dropped.
 */
export function slaRisk(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  now: Date | string,
  horizonMinutes = RISK_HORIZON_MINUTES,
): SlaRiskReport {
  const horizon = Math.max(1, horizonMinutes);
  const report = buildSlaReport(tickets, policies, now);
  const items: SlaRiskItem[] = [];

  for (const row of report.tickets) {
    if (!isOpen(row.status)) continue;
    const running = [row.response, row.resolution].filter(
      (clock): clock is SlaClockView => clock !== null && clock.metAt === null,
    );
    if (running.length === 0) continue; // both clocks met: nothing left to breach
    const driving = running.reduce((soonest, clock) =>
      clock.remainingMinutes < soonest.remainingMinutes ? clock : soonest,
    );
    const remainingMinutes = Math.max(0, driving.remainingMinutes);
    const band = bandFor(remainingMinutes, horizon);
    items.push({
      ticketId: row.ticketId,
      ref: row.ref,
      subject: row.subject,
      priority: row.priority,
      assigneeId: row.assigneeId,
      clock: driving.kind,
      remainingMinutes,
      dueAt: driving.dueAt.toISOString(),
      paused: driving.paused,
      band,
      reason: riskReason(band, driving.kind, remainingMinutes),
    });
  }

  items.sort(byRisk);
  const counts: Record<RiskBand, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of items) counts[item.band] += 1;

  return {
    horizonMinutes: horizon,
    items,
    counts,
    projectedBreaches: counts.critical + counts.high,
    withoutPolicy: report.totals.withoutPolicy,
  };
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
