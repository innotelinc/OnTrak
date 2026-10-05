/**
 * OnTrak Tix M7 tests: the forecast and SLA-risk CSV.
 *
 * The export exists so the two forward-looking figures can leave the screen — and the
 * point of writing them down is that next week's file is the check on this week's
 * projection. So the cases below pin the shape (a summary block, a day-by-day table, the
 * risk list), the order (worst band first, as on the page) and the escaping, rather than
 * the arithmetic — that lives in `tix-m7-analytics.test.ts`.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m7-export.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALWAYS_OPEN_CALENDAR, type SlaPolicy } from "../src/lib/sla-rules";
import type { ReportTicket } from "../src/lib/report-rules";
import { forecastVolume, slaRisk, ticketTrends } from "../src/lib/analytics-rules";
import { buildAnalyticsCsv } from "../src/lib/report-csv";

const policy: SlaPolicy = {
  id: "p-desk",
  name: "Desk default",
  responseMinutes: 120,
  resolutionMinutes: 480,
  calendar: ALWAYS_OPEN_CALENDAR,
  warningFraction: 0.5,
};

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

const NOW = "2026-09-21T12:00:00.000Z";

test("csv: the analytics export carries the forecast and the risk list", () => {
  const tickets: ReportTicket[] = [
    // Opened and closed on the 20th, so the trend has a day of finished work.
    reportTicket({
      id: "a",
      ref: "TIX-000001",
      status: "RESOLVED",
      subject: "VPN, broken",
      createdAt: "2026-09-20T09:00:00.000Z",
      firstResponseAt: "2026-09-20T09:10:00.000Z",
      resolvedAt: "2026-09-20T10:00:00.000Z",
    }),
    // Ten hours without a first reply: the response target is long gone. Its subject has
    // a comma, which is what makes the row force quoting rather than being unescaped.
    reportTicket({ id: "b", ref: "TIX-000002", subject: "Mail, down", createdAt: "2026-09-21T02:00:00.000Z" }),
  ];
  const forecast = forecastVolume(ticketTrends(tickets, NOW, 5), { horizonDays: 3, basisDays: 5 });
  const risk = slaRisk(tickets, [policy], NOW);
  const csv = buildAnalyticsCsv(forecast, risk, { generatedAt: NOW });

  assert.match(csv, /OnTrak Tix forecast and SLA risk/);
  assert.match(csv, /Generated,2026-09-21T12:00:00.000Z/);
  assert.match(csv, /Outlook,\w+/);
  assert.match(csv, /Day,Projected opened,Projected closed,Projected backlog/);
  assert.match(csv, /SLA risk,horizon 240 business minutes/);
  assert.match(csv, /Expected to breach inside the horizon,1/);
  assert.match(csv, /Ref,Subject,Priority,Assignee,Clock,Band,Business minutes left,Due,Paused,Why/);
  assert.ok(csv.includes('"Mail, down"'), "a comma in a subject is quoted");
  assert.ok(csv.endsWith("\r\n"), "rows are CRLF-terminated, per RFC 4180");
});

test("csv: the risk rows come out worst-first, carrying the clock and the reason", () => {
  const tickets: ReportTicket[] = [
    reportTicket({ id: "soon", ref: "TIX-000010", subject: "Answer me", createdAt: "2026-09-21T11:00:00.000Z" }),
    reportTicket({ id: "gone", ref: "TIX-000011", subject: "Too late", createdAt: "2026-09-21T02:00:00.000Z" }),
  ];
  const csv = buildAnalyticsCsv(
    forecastVolume(ticketTrends(tickets, NOW, 3), { horizonDays: 1, basisDays: 3 }),
    slaRisk(tickets, [policy], NOW),
    { generatedAt: NOW },
  );

  const late = csv.indexOf("TIX-000011");
  const soon = csv.indexOf("TIX-000010");
  assert.ok(late > -1 && soon > -1, "both risk rows are present");
  assert.ok(late < soon, "the breached ticket leads the risk table");
  assert.ok(csv.includes("response,critical"), "the row carries the driving clock and band");
  assert.ok(csv.includes("past its response target"), "the row carries its reason");
});

test("csv: an empty desk still exports a well-formed file", () => {
  const csv = buildAnalyticsCsv(
    forecastVolume(ticketTrends([], NOW, 3), { horizonDays: 2, basisDays: 3 }),
    slaRisk([], [policy], NOW),
    { generatedAt: NOW },
  );
  assert.match(csv, /Outlook,stable/);
  assert.match(csv, /Critical,0/);
  assert.match(csv, /Ref,Subject,Priority/);
  assert.ok(csv.endsWith("\r\n"));
});
