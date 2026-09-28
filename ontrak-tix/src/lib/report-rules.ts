/**
 * Reporting rules (M1): the numbers a dispatcher runs the desk on.
 *
 * Attainment, first-response and resolution times, and the at-risk/breached
 * lists are all derived here from the same clocks the SLA engine uses, so a
 * report can never disagree with an escalation. Pure and tested; the page only
 * renders what this returns.
 *
 * Times are reported in *business* minutes, matching how the targets are set —
 * a 4-hour target on a 9–5 calendar is not a wall-clock 4 hours.
 */

import {
  attainmentPercent,
  clockDurationMinutes,
  policyForPriority,
  resolutionClock,
  resolveSlaPolicy,
  responseClock,
  slaInstanceFor,
  slaSummary,
  type SlaClockState,
  type SlaClockView,
  type SlaPause,
  type SlaPolicy,
} from "./sla-rules";
import { summariseCsat, type CsatSummary, type CsatSurvey } from "./csat-rules";
import { isOpen, type TicketPriority, type TicketStatus } from "./ticket-rules";
import type { InboxSlaFlags } from "./inbox-rules";

/** The minimum a ticket must expose to appear in the report. */
export interface ReportTicket {
  id: string;
  ref: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId: string | null;
  /** The client the work is for, so a per-client policy can win (M4). */
  clientId?: string | null;
  queueId?: string | null;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  /** Paused windows (e.g. waiting on the customer); optional for minimal callers. */
  pauses?: readonly SlaPause[];
}

export interface TicketSlaStatus {
  ticketId: string;
  ref: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId: string | null;
  state: SlaClockState;
  atRisk: boolean;
  breached: boolean;
  /** An open pause is holding the clock, so its numbers are frozen. */
  paused: boolean;
  response: SlaClockView | null;
  resolution: SlaClockView | null;
}

export interface TimingStats {
  /** How many tickets contributed a number. */
  measured: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
}

export interface SlaReport {
  totals: {
    total: number;
    open: number;
    unassigned: number;
    resolvedOrClosed: number;
    /** Tickets with no policy, so no clock: they are invisible to SLAs. */
    withoutPolicy: number;
  };
  response: { attainmentPercent: number | null; timing: TimingStats };
  resolution: { attainmentPercent: number | null; timing: TimingStats };
  atRisk: TicketSlaStatus[];
  breached: TicketSlaStatus[];
  /** Every ticket's status row, in inbox-ish order, for a table. */
  tickets: TicketSlaStatus[];
}

/** The p-th percentile of a list (nearest-rank), or `null` when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function timing(values: readonly number[]): TimingStats {
  return {
    measured: values.length,
    medianMinutes: percentile(values, 50),
    p90Minutes: percentile(values, 90),
  };
}

/** Whether a ticket is worth escalating/reporting on: still open. */
function isLive(status: TicketStatus): boolean {
  return isOpen(status);
}

/**
 * Build the report. Only tickets with an applicable policy get clocks; the
 * count of the rest is surfaced so "no SLA" is visible rather than silently
 * counted as attainment.
 */
export function buildSlaReport(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  now: Date | string,
): SlaReport {
  const responseClocks: SlaClockView[] = [];
  const resolutionClocks: SlaClockView[] = [];
  const firstResponseTimes: number[] = [];
  const resolutionTimes: number[] = [];
  const rows: TicketSlaStatus[] = [];

  let open = 0;
  let unassigned = 0;
  let withoutPolicy = 0;

  for (const ticket of tickets) {
    if (isLive(ticket.status)) {
      open += 1;
      if (ticket.assigneeId === null) unassigned += 1;
    }

    const { policy } = resolveSlaPolicy({
      policies,
      priority: ticket.priority,
      clientId: ticket.clientId,
      queueId: ticket.queueId,
    });
    if (!policy) {
      withoutPolicy += 1;
      continue;
    }

    const row = statusRow(ticket, policy, now);
    const response = row.response as SlaClockView;
    const resolution = row.resolution as SlaClockView;

    responseClocks.push(response);
    resolutionClocks.push(resolution);

    const firstResponseDuration = response.metAt === null ? null : clockDurationMinutes(response);
    if (firstResponseDuration !== null && ticket.firstResponseAt !== null) firstResponseTimes.push(firstResponseDuration);
    const resolutionDuration = resolution.metAt === null ? null : clockDurationMinutes(resolution);
    if (resolutionDuration !== null && ticket.resolvedAt !== null) resolutionTimes.push(resolutionDuration);

    rows.push(row);
  }

  const atRisk = rows.filter((row) => row.atRisk).sort(byUrgency);
  const breached = rows.filter((row) => row.breached).sort(byUrgency);

  return {
    totals: {
      total: tickets.length,
      open,
      unassigned,
      resolvedOrClosed: tickets.filter((ticket) => !isLive(ticket.status)).length,
      withoutPolicy,
    },
    response: {
      attainmentPercent: attainmentPercent(responseClocks),
      timing: timing(firstResponseTimes),
    },
    resolution: {
      attainmentPercent: attainmentPercent(resolutionClocks),
      timing: timing(resolutionTimes),
    },
    atRisk,
    breached,
    tickets: rows.sort(byUrgency),
  };
}

/** The status row for one ticket: its clocks, state and risk flags. */
function statusRow(ticket: ReportTicket, policy: SlaPolicy, now: Date | string): TicketSlaStatus {
  const summary = slaSummary(slaInstanceFor(ticket, policy.id), policy, now);
  return {
    ticketId: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    assigneeId: ticket.assigneeId,
    state: summary.state,
    atRisk: isLive(ticket.status) && summary.atRisk,
    breached: isLive(ticket.status) && summary.breached,
    paused: isLive(ticket.status) && summary.paused,
    response: summary.response,
    resolution: summary.resolution,
  };
}

/**
 * The SLA status of a single ticket, or `null` when no policy applies.
 * Reused by the detail pages so the badge and the report never disagree.
 */
export function slaStatusFor(
  ticket: ReportTicket,
  policies: readonly SlaPolicy[],
  now: Date | string,
): TicketSlaStatus | null {
  // Which policy applies is the client-aware resolver's call (M4): a policy
  // written for this client outranks the queue's and the desk's own default.
  const { policy } = resolveSlaPolicy({
    policies,
    priority: ticket.priority,
    clientId: ticket.clientId,
    queueId: ticket.queueId,
  });
  return policy ? statusRow(ticket, policy, now) : null;
}

/**
 * The SLA risk flags for a whole worklist, keyed by ticket id, so the inbox can
 * filter and count without recomputing a report per ticket. Tickets with no
 * policy are omitted rather than defaulted, so "no SLA" stays distinguishable
 * from "on track".
 */
export function slaFlagsByTicket(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  now: Date | string,
): Map<string, InboxSlaFlags> {
  const flags = new Map<string, InboxSlaFlags>();
  for (const ticket of tickets) {
    const status = slaStatusFor(ticket, policies, now);
    if (status) flags.set(ticket.id, { atRisk: status.atRisk, breached: status.breached });
  }
  return flags;
}

/**
 * A compact, serializable picture of a report run. The scheduler writes this to
 * the audit chain so a weekly attainment figure leaves tamper-evident evidence
 * even before anyone exports a spreadsheet.
 */
export interface SlaReportSnapshot {
  generatedAt: string;
  totals: SlaReport["totals"];
  responseAttainmentPercent: number | null;
  resolutionAttainmentPercent: number | null;
  responseMedianMinutes: number | null;
  resolutionMedianMinutes: number | null;
  breached: string[];
  atRisk: string[];
}

/** Reduce a report to its headline numbers, keeping ticket refs for the lists. */
export function reportSnapshot(report: SlaReport, generatedAt: string): SlaReportSnapshot {
  return {
    generatedAt,
    totals: report.totals,
    responseAttainmentPercent: report.response.attainmentPercent,
    resolutionAttainmentPercent: report.resolution.attainmentPercent,
    responseMedianMinutes: report.response.timing.medianMinutes,
    resolutionMedianMinutes: report.resolution.timing.medianMinutes,
    breached: report.breached.map((row) => row.ref),
    atRisk: report.atRisk.map((row) => row.ref),
  };
}

/** Business minutes as `3h 15m`; a missing number is a dash, never a zero. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** A short badge line: the risk, or the soonest running clock's remaining time. */
export function slaRemainingLabel(status: TicketSlaStatus): string {
  if (status.breached) return "SLA breached";
  if (status.state === "met") return "SLA met";
  // A paused clock is frozen: say so rather than showing a countdown that will
  // not actually move until the ticket stops waiting on someone else.
  if (status.paused) return "SLA paused";

  const running = [status.response, status.resolution]
    .filter((clock): clock is SlaClockView => clock !== null && clock.metAt === null)
    .sort((a, b) => a.remainingMinutes - b.remainingMinutes);
  if (running.length === 0) return "SLA met";
  return `SLA in ${formatMinutes(running[0].remainingMinutes)}`;
}

/* -------------------------------------------------------------------------- */
/*  The per-client view (M4)                                                  */
/* -------------------------------------------------------------------------- */

/** A client, as a scorecard needs it. */
export interface ReportClient {
  id: string;
  name: string;
}

/** A survey, reduced to what a per-client roll-up needs from it. */
export interface ReportSurvey {
  clientId: string | null;
  requestedAt: string;
  respondedAt: string | null;
  score: number | null;
}

/**
 * One client's numbers, in the same shape the desk-wide report uses — the two
 * are built by the same function, so a client's attainment can never disagree
 * with the report it was read off.
 *
 * `clientId` is null for the bucket every desk has: work that names no client.
 * Dropping it would make the client figures add up to less than the whole desk.
 */
export interface ClientScorecard {
  clientId: string | null;
  name: string;
  total: number;
  open: number;
  breached: number;
  atRisk: number;
  withoutPolicy: number;
  response: { attainmentPercent: number | null; timing: TimingStats };
  resolution: { attainmentPercent: number | null; timing: TimingStats };
  csat: CsatSummary;
}

/**
 * What every client's work came to, worst attainment first.
 *
 * The order is the point: a report whose first row is the client about to call
 * is a report a dispatcher can act on. Clients with nothing measurable sit last,
 * because "no data" is not "doing badly", and the two must not be confused by a
 * sort.
 */
export function clientScorecards(
  tickets: readonly ReportTicket[],
  policies: readonly SlaPolicy[],
  clients: readonly ReportClient[],
  now: Date | string,
  surveys: readonly ReportSurvey[] = [],
): ClientScorecard[] {
  const buckets: { clientId: string | null; name: string; mine: ReportTicket[] }[] = clients.map((client) => ({
    clientId: client.id,
    name: client.name,
    mine: tickets.filter((ticket) => ticket.clientId === client.id),
  }));

  const unassigned = tickets.filter((ticket) => !ticket.clientId);
  if (unassigned.length > 0) buckets.push({ clientId: null, name: "No client recorded", mine: unassigned });

  return buckets
    .map((bucket) => {
      const report = buildSlaReport(bucket.mine, policies, now);
      const mine = surveys.filter((survey) => survey.clientId === bucket.clientId);
      const csat = summariseCsat(
        mine.map(toCsatSurvey),
        mine.length,
      );
      return {
        clientId: bucket.clientId,
        name: bucket.name,
        total: report.totals.total,
        open: report.totals.open,
        breached: report.breached.length,
        atRisk: report.atRisk.length,
        withoutPolicy: report.totals.withoutPolicy,
        response: report.response,
        resolution: report.resolution,
        csat,
      };
    })
    .sort(byClientHealth);
}

function toCsatSurvey(survey: ReportSurvey): CsatSurvey {
  return {
    token: "",
    requestedAt: survey.requestedAt,
    respondedAt: survey.respondedAt,
    score: (survey.score ?? null) as CsatSurvey["score"],
    comment: null,
  };
}

/** Most breached, then worst attainment, then whichever answered least. */
function byClientHealth(a: ClientScorecard, b: ClientScorecard): number {
  return (
    b.breached - a.breached ||
    (a.resolution.attainmentPercent ?? 101) - (b.resolution.attainmentPercent ?? 101) ||
    a.name.localeCompare(b.name)
  );
}

const PRIORITY_ORDER: Record<TicketPriority, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/** Breached first, then most urgent, then oldest — the order a lead triages in. */
function byUrgency(a: TicketSlaStatus, b: TicketSlaStatus): number {
  const stateRank = (row: TicketSlaStatus) => (row.breached ? 0 : row.atRisk ? 1 : 2);
  return (
    stateRank(a) - stateRank(b) ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    a.ref.localeCompare(b.ref)
  );
}
