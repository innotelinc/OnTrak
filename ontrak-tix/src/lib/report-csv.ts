/**
 * SLA report CSV (M1): the exportable form of the dispatcher report.
 *
 * Pure and tested, because an export is the one artefact people paste into a
 * board pack — a mis-escaped subject or a locale-dependent number would be a
 * quiet embarrassment. Escaping follows RFC 4180 (CRLF rows, doubled quotes),
 * and the report's own `formatMinutes` is reused so the CSV and the screen
 * never disagree.
 */

import { formatMinutes, type ClientScorecard, type SlaReport, type TicketSlaStatus } from "./report-rules";
import type { ForecastReport, SlaRiskReport, TrendReport } from "./analytics-rules";

/** Quote a cell only when it needs it; `null`/`undefined` export as empty. */
export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvEscape).join(",");
}

export interface CsvOptions {
  generatedAt: string;
  appName?: string;
}

const TICKET_HEADER = [
  "Ref",
  "Subject",
  "Status",
  "Priority",
  "Assignee",
  "SLA state",
  "At risk",
  "Breached",
  "First response due",
  "First response state",
  "Resolution due",
  "Resolution state",
];

function dueIso(clock: TicketSlaStatus["response"]): string {
  return clock ? clock.dueAt.toISOString() : "";
}

function ticketRow(row: TicketSlaStatus): string {
  return csvRow([
    row.ref,
    row.subject,
    row.status,
    row.priority,
    row.assigneeId ?? "unassigned",
    row.breached ? "breached" : row.atRisk ? "at-risk" : row.state,
    row.atRisk ? "yes" : "no",
    row.breached ? "yes" : "no",
    dueIso(row.response),
    row.response?.state ?? "",
    dueIso(row.resolution),
    row.resolution?.state ?? "",
  ]);
}

/**
 * The per-client report as CSV (M4): one row per client, worst attainment first,
 * which is the order somebody chases them in. It matters more than the ticket
 * export because this is the file an account manager forwards.
 */
export function buildClientCsv(
  scorecards: readonly ClientScorecard[],
  { generatedAt, appName = "OnTrak Tix" }: CsvOptions,
): string {
  const lines: string[] = [
    csvRow([`${appName} report by client`]),
    csvRow(["Generated", generatedAt]),
    "",
    csvRow([
      "Client",
      "Tickets",
      "Open",
      "Breached",
      "At risk",
      "Without SLA policy",
      "First response attainment %",
      "First response median (business minutes)",
      "Resolution attainment %",
      "Resolution median (business minutes)",
      "CSAT average",
      "CSAT responses",
      "CSAT positive %",
      "CSAT response rate %",
    ]),
  ];

  for (const card of scorecards) {
    lines.push(
      csvRow([
        card.name,
        card.total,
        card.open,
        card.breached,
        card.atRisk,
        card.withoutPolicy,
        card.response.attainmentPercent ?? "",
        formatMinutes(card.response.timing.medianMinutes),
        card.resolution.attainmentPercent ?? "",
        formatMinutes(card.resolution.timing.medianMinutes),
        card.csat.average ?? "",
        card.csat.responses,
        card.csat.positivePercent ?? "",
        card.csat.responseRatePercent ?? "",
      ]),
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The whole report as CSV: a title/summary block, a blank line, then one row per
 * ticket (in the report's own triage order — breached first).
 */
export function buildSlaCsv(report: SlaReport, { generatedAt, appName = "OnTrak Tix" }: CsvOptions): string {
  const lines: string[] = [
    csvRow([`${appName} SLA report`]),
    csvRow(["Generated", generatedAt]),
    "",
    csvRow(["Metric", "Value"]),
    csvRow(["Tickets", report.totals.total]),
    csvRow(["Open", report.totals.open]),
    csvRow(["Unassigned", report.totals.unassigned]),
    csvRow(["Resolved or closed", report.totals.resolvedOrClosed]),
    csvRow(["Without SLA policy", report.totals.withoutPolicy]),
    csvRow(["First response attainment %", report.response.attainmentPercent ?? ""]),
    csvRow(["First response median (business minutes)", formatMinutes(report.response.timing.medianMinutes)]),
    csvRow(["First response p90 (business minutes)", formatMinutes(report.response.timing.p90Minutes)]),
    csvRow(["Resolution attainment %", report.resolution.attainmentPercent ?? ""]),
    csvRow(["Resolution median (business minutes)", formatMinutes(report.resolution.timing.medianMinutes)]),
    csvRow(["Resolution p90 (business minutes)", formatMinutes(report.resolution.timing.p90Minutes)]),
    csvRow(["Breached", report.breached.length]),
    csvRow(["At risk", report.atRisk.length]),
    "",
    csvRow(TICKET_HEADER),
  ];

  for (const row of report.tickets) lines.push(ticketRow(row));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The volume trend, the forecast and the SLA-risk list as CSV (M7), in the order the page
 * shows them.
 *
 * These are the three figures a lead takes to a review — "what has the desk been doing,
 * where is the backlog going, and what is about to breach" — and the last two are
 * forward-looking, which is exactly why writing them down is worth it: next week's file is
 * the check on this week's projection. The trend travels with them rather than being left
 * on the screen, because the projection is the recent intake and closures carried forward:
 * the days it was averaged from have to be in the same file, or the number cannot be
 * checked against the data it came from. The risk rows keep the report's own worst-first
 * order so the export and the screen agree.
 */
export function buildAnalyticsCsv(
  forecast: ForecastReport,
  risk: SlaRiskReport,
  trend: TrendReport,
  { generatedAt, appName = "OnTrak Tix" }: CsvOptions,
): string {
  const percent = (value: number | null): string | number => (value === null ? "" : value);
  const lines: string[] = [
    csvRow([`${appName} forecast and SLA risk`]),
    csvRow(["Generated", generatedAt]),
    "",
    csvRow(["Actual volume", `${trend.days} days by UTC day`]),
    csvRow(["Created in window", trend.createdTotal]),
    csvRow(["Closed in window", trend.closedTotal]),
    csvRow(["Backlog now", trend.backlogNow]),
    csvRow(["Change in intake vs the window before %", percent(trend.createdChangePercent)]),
    csvRow(["Change in closures vs the window before %", percent(trend.closedChangePercent)]),
    csvRow(["Day", "Opened", "Closed", "Backlog"]),
  ];
  for (const point of trend.points) {
    lines.push(csvRow([point.day, point.created, point.closed, point.backlog]));
  }

  lines.push(
    "",
    csvRow(["Forecast", `${forecast.horizonDays} days, from the last ${forecast.basisDays}`]),
    csvRow(["Outlook", forecast.outlook]),
    csvRow(["Intake rate per day", forecast.dailyCreated]),
    csvRow(["Close rate per day", forecast.dailyClosed]),
    csvRow(["Projected backlog", forecast.projectedBacklog]),
    csvRow(["Projected change in backlog", forecast.projectedBacklogDelta]),
    "",
    csvRow(["Day", "Projected opened", "Projected closed", "Projected backlog"]),
  );
  for (const point of forecast.points) {
    lines.push(csvRow([point.day, point.created, point.closed, point.backlog]));
  }

  lines.push(
    "",
    csvRow(["SLA risk", `horizon ${risk.horizonMinutes} business minutes`]),
    csvRow(["Critical", risk.counts.critical]),
    csvRow(["High", risk.counts.high]),
    csvRow(["Medium", risk.counts.medium]),
    csvRow(["Low", risk.counts.low]),
    csvRow(["Expected to breach inside the horizon", risk.projectedBreaches]),
    csvRow(["Open tickets with no SLA policy", risk.withoutPolicy]),
    "",
    csvRow([
      "Ref",
      "Subject",
      "Priority",
      "Assignee",
      "Clock",
      "Band",
      "Business minutes left",
      "Due",
      "Paused",
      "Why",
    ]),
  );
  for (const item of risk.items) {
    lines.push(
      csvRow([
        item.ref,
        item.subject,
        item.priority,
        item.assigneeId ?? "unassigned",
        item.clock,
        item.band,
        Math.round(item.remainingMinutes),
        item.dueAt,
        item.paused ? "yes" : "no",
        item.reason,
      ]),
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}
