/**
 * OnTrak Tix M7 tests: trends, and the agent/queue scorecards.
 *
 * The interesting properties are the ones a dashboard gets wrong: a point on the chart
 * says what was open *then*, not what is open now; the parts add up to the whole; and a
 * group with no work is absent rather than a zero row that hides the ones that matter.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m7-analytics.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALWAYS_OPEN_CALENDAR, type SlaPolicy } from "../src/lib/sla-rules";
import type { ReportTicket } from "../src/lib/report-rules";
import {
  agentScorecards,
  forecastVolume,
  queueScorecards,
  slaRisk,
  ticketTrends,
  trendSnapshot,
  type TrendReport,
  type TrendTicket,
} from "../src/lib/analytics-rules";

const policy: SlaPolicy = {
  id: "p-desk",
  name: "Desk default",
  responseMinutes: 120,
  resolutionMinutes: 480,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

function trendTicket(overrides: Partial<TrendTicket> = {}): TrendTicket {
  return {
    id: "t",
    status: "OPEN",
    createdAt: "2026-03-09T09:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

function reportTicket(overrides: Partial<ReportTicket> = {}): ReportTicket {
  return {
    id: "t",
    ref: "TIX-000000",
    subject: "s",
    status: "OPEN",
    priority: "NORMAL",
    assigneeId: null,
    queueId: null,
    createdAt: "2026-09-21T09:00:00.000Z",
    firstResponseAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Trends                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = "2026-03-10T12:00:00.000Z";

test("trends: each day is counted by the timestamps, and the backlog says what was open then", () => {
  const tickets: TrendTicket[] = [
    // Opened the 8th, closed the 9th.
    trendTicket({ id: "a", status: "RESOLVED", createdAt: "2026-03-08T09:00:00.000Z", resolvedAt: "2026-03-09T10:00:00.000Z" }),
    // Opened the 9th, still open.
    trendTicket({ id: "b", createdAt: "2026-03-09T09:00:00.000Z" }),
    // Opened the 10th, still open.
    trendTicket({ id: "c", createdAt: "2026-03-10T09:00:00.000Z" }),
    // Opened before the window and never closed: it stands in the 8th's backlog too.
    trendTicket({ id: "d", createdAt: "2026-03-07T09:00:00.000Z" }),
    // Opened and closed before the window: it counts in the previous window, not this one.
    trendTicket({ id: "e", status: "CLOSED", createdAt: "2026-03-07T08:00:00.000Z", closedAt: "2026-03-07T09:00:00.000Z" }),
  ];

  const report = ticketTrends(tickets, NOW, 3);
  assert.equal(report.days, 3);
  assert.deepEqual(report.points.map((point) => point.day), ["2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.deepEqual(
    report.points.map((point) => [point.created, point.closed, point.backlog]),
    [
      [1, 0, 2], // the one opened on the 8th, plus the older still-open one
      [1, 1, 2], // closed the 8th's ticket; the older one still open
      [1, 0, 3], // everything still open
    ],
  );
  assert.equal(report.createdTotal, 3);
  assert.equal(report.closedTotal, 1);
  assert.equal(report.backlogNow, 3);
  // Two opened in the previous window (d and e), so three is up 50%.
  assert.equal(report.createdChangePercent, 50);
  // One closed in the previous window, one here: unchanged.
  assert.equal(report.closedChangePercent, 0);
});

test("trends: an empty desk is zeros, and a window with no history has no percentage", () => {
  const report = ticketTrends([], NOW, 2);
  assert.equal(report.createdTotal, 0);
  assert.equal(report.closedTotal, 0);
  assert.equal(report.backlogNow, 0);
  assert.equal(report.createdChangePercent, null);
  assert.equal(report.closedChangePercent, null);
  assert.deepEqual(report.points.map((point) => point.backlog), [0, 0]);
});

test("trends: a day of one is a day of one", () => {
  const report = ticketTrends(
    [trendTicket({ createdAt: "2026-03-10T01:00:00.000Z" })],
    NOW,
    1,
  );
  assert.equal(report.points.length, 1);
  assert.equal(report.points[0].created, 1);
  assert.equal(report.points[0].backlog, 1);
});

test("snapshot: a trend reduces to headline numbers", () => {
  const report = ticketTrends([trendTicket({ createdAt: "2026-03-10T09:00:00.000Z" })], NOW, 1);
  const snapshot = trendSnapshot(report);
  assert.equal(snapshot.days, 1);
  assert.equal(snapshot.createdTotal, 1);
  assert.equal(snapshot.backlogNow, 1);
  assert.equal(snapshot.createdChangePercent, null);
});

/* -------------------------------------------------------------------------- */
/*  Agent and queue scorecards                                                */
/* -------------------------------------------------------------------------- */

const SCORED_AT = "2026-09-21T12:00:00.000Z";

const scored: ReportTicket[] = [
  // Agent 1, queue 1: answered in 30 and fixed in 60 — both met.
  reportTicket({ id: "a1", status: "RESOLVED", assigneeId: "agent-1", queueId: "q-1", firstResponseAt: "2026-09-21T09:30:00.000Z", resolvedAt: "2026-09-21T10:00:00.000Z" }),
  // Agent 1, queue 1: still open with no answer three hours on — the response target is
  // blown, but the clock has not *closed*, so it is counted as breached and not in
  // attainment. A running clock must not flatter a figure it has not finished.
  reportTicket({ id: "a2", assigneeId: "agent-1", queueId: "q-1" }),
  // Agent 2, queue 2: open, answered thirty minutes ago, comfortably on track.
  reportTicket({ id: "a3", assigneeId: "agent-2", queueId: "q-2", createdAt: "2026-09-21T11:30:00.000Z" }),
  // Nobody's yet: still the desk's, so it is a row and not a rounding error.
  reportTicket({ id: "a4", status: "RESOLVED", firstResponseAt: "2026-09-21T09:20:00.000Z", resolvedAt: "2026-09-21T09:40:00.000Z" }),
];

test("agents: the work splits by assignee, most-breached first, and unassigned is a row", () => {
  const cards = agentScorecards(
    scored,
    [policy],
    [
      { id: "agent-1", name: "Ada" },
      { id: "agent-2", name: "Grace" },
      // On the roster but carrying nothing: not a row.
      { id: "agent-3", name: "Alan" },
    ],
    SCORED_AT,
  );

  // Ada is breaching, Grace has the larger open backlog, and the desk's unassigned work
  // sits last of the three — most-breached first, then biggest backlog.
  assert.deepEqual(cards.map((card) => card.name), ["Ada", "Grace", "Unassigned"]);
  const ada = cards[0];
  assert.equal(ada.groupId, "agent-1");
  assert.equal(ada.total, 2);
  assert.equal(ada.open, 1);
  assert.equal(ada.closed, 1);
  assert.equal(ada.breached, 1);
  assert.equal(ada.response.attainmentPercent, 100, "only the closed clock is decided");
  assert.equal(ada.resolution.attainmentPercent, 100, "only the closed one has a decided resolution clock");

  const unassigned = cards.find((card) => card.groupId === null);
  assert.ok(unassigned);
  assert.equal(unassigned.name, "Unassigned");
  assert.equal(unassigned.total, 1);
  assert.equal(unassigned.closed, 1);
  assert.equal(unassigned.breached, 0);

  // The parts add up to the whole — no ticket is lost between buckets.
  assert.equal(cards.reduce((sum, card) => sum + card.total, 0), scored.length);
  assert.equal(cards.some((card) => card.name === "Alan"), false);
});

test("queues: the same question of the routing, with no-queue work counted", () => {
  const cards = queueScorecards(
    scored,
    [policy],
    [
      { id: "q-1", name: "Network" },
      { id: "q-2", name: "Billing" },
    ],
    SCORED_AT,
  );

  assert.deepEqual(cards.map((card) => card.name), ["Network", "Billing", "No queue"]);
  const network = cards[0];
  assert.equal(network.total, 2);
  assert.equal(network.breached, 1);
  assert.equal(network.open, 1);

  const none = cards.find((card) => card.groupId === null);
  assert.ok(none);
  assert.equal(none.name, "No queue");
  assert.equal(none.total, 1);
});

test("scorecards: a bucket with no work is absent rather than a zero row", () => {
  const cards = queueScorecards(scored, [policy], [{ id: "q-empty", name: "Empty" }], SCORED_AT);
  assert.equal(cards.some((card) => card.name === "Empty"), false);
});

test("scorecards: work in a queue that no longer exists is still scored, under its id", () => {
  // The queue was removed but its tickets remain; dropping them would understate the desk.
  const cards = queueScorecards(
    [reportTicket({ id: "orphan", queueId: "q-gone" })],
    [policy],
    [],
    SCORED_AT,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].groupId, "q-gone");
  assert.equal(cards[0].name, "q-gone");
  assert.equal(cards[0].total, 1);
});

test("scorecards: tickets with no applicable policy are surfaced, not counted as met", () => {
  const cards = agentScorecards(
    [reportTicket({ id: "x", assigneeId: "agent-1", priority: "LOW" })],
    [{ ...policy, priority: "URGENT" }],
    [{ id: "agent-1", name: "Ada" }],
    SCORED_AT,
  );
  assert.equal(cards[0].withoutPolicy, 1);
  assert.equal(cards[0].response.attainmentPercent, null);
});

/* -------------------------------------------------------------------------- */
/*  Forecast                                                                  */
/* -------------------------------------------------------------------------- */

/** A trend with one day's figures repeated, so the average is the figure. */
function flatTrend(created: number, closed: number, backlogNow: number, days = 3): TrendReport {
  const points = Array.from({ length: days }, (_, index) => ({
    day: `2026-03-${String(8 + index).padStart(2, "0")}`,
    created,
    closed,
    backlog: backlogNow,
  }));
  return {
    days,
    points,
    createdTotal: created * days,
    closedTotal: closed * days,
    createdChangePercent: null,
    closedChangePercent: null,
    backlogNow,
  };
}

test("forecast: intake above closures accumulates, and the days run forward from the last", () => {
  const forecast = forecastVolume(flatTrend(5, 1, 12), { horizonDays: 3, basisDays: 3 });
  assert.equal(forecast.dailyCreated, 5);
  assert.equal(forecast.dailyClosed, 1);
  assert.equal(forecast.outlook, "accumulating");
  assert.equal(forecast.projectedBacklog, 24); // 12 + (5 - 1) * 3
  assert.equal(forecast.projectedBacklogDelta, 12);
  assert.deepEqual(
    forecast.points.map((point) => point.day),
    ["2026-03-11", "2026-03-12", "2026-03-13"],
  );
  assert.deepEqual(forecast.points.map((point) => point.backlog), [16, 20, 24]);
});

test("forecast: closures above intake clears the backlog", () => {
  const forecast = forecastVolume(flatTrend(1, 4, 12), { horizonDays: 3, basisDays: 3 });
  assert.equal(forecast.outlook, "clearing");
  assert.equal(forecast.projectedBacklog, 3); // 12 - (4 - 1) * 3
  assert.equal(forecast.projectedBacklogDelta, -9);
});

test("forecast: a balanced desk holds, and the basis never exceeds the history", () => {
  const forecast = forecastVolume(flatTrend(3, 3, 7));
  assert.equal(forecast.outlook, "stable");
  assert.equal(forecast.projectedBacklog, 7);
  assert.equal(forecast.basisDays, 3, "only three days of history to average");
  assert.equal(forecast.points.length, 14, "the default horizon");
});

test("forecast: an empty desk projects nothing rather than dividing by zero", () => {
  const forecast = forecastVolume(flatTrend(0, 0, 0, 0), { horizonDays: 2 });
  assert.equal(forecast.dailyCreated, 0);
  assert.equal(forecast.dailyClosed, 0);
  assert.equal(forecast.outlook, "stable");
  assert.equal(forecast.projectedBacklog, 0);
  assert.equal(forecast.points.length, 2);
});

/* -------------------------------------------------------------------------- */
/*  SLA risk                                                                  */
/* -------------------------------------------------------------------------- */

const RISK_AT = "2026-09-21T12:00:00.000Z";

test("risk: open work is banded by the clock nearest its deadline, worst first", () => {
  const tickets: ReportTicket[] = [
    // Ten hours without a first reply: the response target is long gone.
    reportTicket({ id: "critical", ref: "TIX-000001", createdAt: "2026-09-21T02:00:00.000Z" }),
    // One hour of a two-hour target: sixty minutes left, a quarter of the horizon.
    reportTicket({ id: "high", ref: "TIX-000002", createdAt: "2026-09-21T11:00:00.000Z" }),
    // Half an hour in: ninety minutes left, inside the horizon but not the urgent band.
    reportTicket({ id: "medium", ref: "TIX-000003", createdAt: "2026-09-21T11:30:00.000Z" }),
    // Answered at once, so the response clock is met and the resolution clock drives.
    reportTicket({ id: "low", ref: "TIX-000004", createdAt: "2026-09-21T11:55:00.000Z", firstResponseAt: "2026-09-21T11:55:00.000Z" }),
  ];
  const risk = slaRisk(tickets, [policy], RISK_AT);
  assert.deepEqual(risk.items.map((item) => item.band), ["critical", "high", "medium", "low"]);
  assert.deepEqual(risk.counts, { critical: 1, high: 1, medium: 1, low: 1 });
  assert.equal(risk.projectedBreaches, 2, "critical plus high breach inside the horizon");
  assert.equal(risk.items[0].clock, "response");
  assert.equal(risk.items[0].remainingMinutes, 0, "a breach is not a negative runway");
  assert.equal(risk.items[0].reason, "past its response target");
  assert.equal(risk.items[3].clock, "resolution", "a met response leaves the resolution clock driving");
});

test("risk: a resolved ticket and one with no policy are not risk", () => {
  const tickets: ReportTicket[] = [
    reportTicket({ id: "done", status: "RESOLVED", firstResponseAt: "2026-09-21T09:10:00.000Z", resolvedAt: "2026-09-21T09:30:00.000Z" }),
    // A LOW priority, and the only policy is scoped to NORMAL: no clock, no risk.
    reportTicket({ id: "nopolicy", ref: "TIX-000002", priority: "LOW" }),
    reportTicket({ id: "soon", ref: "TIX-000003", createdAt: "2026-09-21T11:00:00.000Z" }),
  ];
  const risk = slaRisk(tickets, [{ ...policy, priority: "NORMAL" }], RISK_AT);
  assert.deepEqual(risk.items.map((item) => item.ticketId), ["soon"]);
  assert.equal(risk.withoutPolicy, 1);
});

test("risk: a paused clock is flagged, so its frozen numbers are not read as safe", () => {
  const tickets = [
    reportTicket({
      id: "paused",
      createdAt: "2026-09-21T11:00:00.000Z",
      pauses: [{ startedAt: "2026-09-21T11:30:00.000Z", endedAt: null }],
    }),
  ];
  const risk = slaRisk(tickets, [policy], RISK_AT);
  assert.equal(risk.items.length, 1);
  assert.equal(risk.items[0].paused, true);
});
