import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import {
  clientServicesFor,
  clientSurveyServicesFor,
  csatServicesFor,
  escalationServicesFor,
  slaPolicyStoreFor,
  ticketServicesFor,
} from "../../../lib/db";
import { hasPermission } from "../../../lib/access-rules";
import { buildSlaReport, clientScorecards, type ClientScorecard, type ReportSurvey, type TicketSlaStatus } from "../../../lib/report-rules";

export const metadata = { title: "Reports" };

/** Business minutes as `3h 15m`; an unmeasured clock shows a dash, not a zero. */
function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl2 border border-line bg-surface p-4">
      <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** A clock's state, as a small badge. */
function StateBadge({ row }: { row: TicketSlaStatus }) {
  const tone = row.breached ? "text-pink" : row.atRisk ? "text-amber" : "text-teal";
  const label = row.breached ? "breached" : row.atRisk ? "at risk" : row.state;
  return <span className={`text-xs font-semibold ${tone}`}>{label}</span>;
}

/** One client's row: attainment, breaches and what their people said. */
function ClientRow({ card }: { card: ClientScorecard }) {
  return (
    <tr>
      <th scope="row" className="py-2 text-left font-semibold text-ink">
        {card.name}
        {card.withoutPolicy > 0 ? <span className="ml-2 text-[11px] text-amber">{card.withoutPolicy} without a policy</span> : null}
      </th>
      <td className="py-2 text-ink-soft">
        {card.open}
        <span className="text-ink-faint"> / {card.total}</span>
      </td>
      <td className={`py-2 ${card.breached > 0 ? "font-semibold text-pink" : "text-ink-soft"}`}>{card.breached}</td>
      <td className="py-2 text-ink-soft">{percent(card.response.attainmentPercent)}</td>
      <td className="py-2 text-ink-soft">{percent(card.resolution.attainmentPercent)}</td>
      <td className="py-2 text-ink-soft">
        {card.csat.average === null ? (
          <span className="text-ink-faint">no answers</span>
        ) : (
          `${card.csat.average}/5 from ${card.csat.responses}`
        )}
      </td>
    </tr>
  );
}

function StatusTable({ rows, empty }: { rows: TicketSlaStatus[]; empty: string }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-faint">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-line">
      {rows.map((row) => (
        <li key={row.ticketId} className="flex flex-wrap items-center gap-2 py-2">
          <span className="font-mono text-[11px] font-semibold text-ink-faint">{row.ref}</span>
          <a href={`/inbox/${row.ticketId}`} className="truncate text-sm text-ink hover:text-brand">
            {row.subject}
          </a>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-[11px] text-ink-faint">{row.priority}</span>
            <StateBadge row={row} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function ReportsPage() {
  const actor = await requireActor();
  // A report is a tenant-wide view; a requester has no business here.
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const now = new Date().toISOString();
  const [tickets, policies, escalations, csat, ticketSurveys, clients, clientSurveys] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    escalationServicesFor().list(actor.tenantId),
    csatServicesFor().summary(actor.tenantId),
    csatServicesFor().list(actor.tenantId),
    clientServicesFor().list(actor),
    clientSurveyServicesFor().all(actor),
  ]);

  const report = buildSlaReport(tickets, policies, now);
  const openEscalations = escalations.filter((escalation) => escalation.acknowledgedAt === null).slice(0, 10);

  // Per-client attainment (M4). The survey answers come from both questions the
  // desk asks — the one on a resolved ticket and the one a client answers from a
  // link — because a client's satisfaction is not "whichever survey they used".
  const clientOfTicket = new Map(tickets.map((ticket) => [ticket.id, ticket.clientId ?? null]));
  const surveys: ReportSurvey[] = [
    ...ticketSurveys.map((survey) => ({
      clientId: clientOfTicket.get(survey.ticketId) ?? null,
      requestedAt: survey.requestedAt,
      respondedAt: survey.respondedAt,
      score: survey.score,
    })),
    ...(clientSurveys.ok ? clientSurveys.value : []).map((survey) => ({
      clientId: survey.clientId,
      requestedAt: survey.requestedAt,
      respondedAt: survey.respondedAt,
      score: survey.score,
    })),
  ];
  const scorecards = clientScorecards(
    tickets,
    policies,
    clients.ok ? clients.value.map((entry) => entry.client) : [],
    now,
    surveys,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="font-display text-xl font-semibold text-ink">Service report</h1>
        <p className="text-sm text-ink-soft">
          SLA attainment and timings across {report.totals.total} tickets. Times are business minutes.
          {report.totals.withoutPolicy > 0
            ? ` ${report.totals.withoutPolicy} ticket(s) have no SLA policy and no clock.`
            : ""}
        </p>
        </div>
        <a
          href="/reports/export"
          className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft hover:text-brand"
        >
          Download CSV
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Open" value={String(report.totals.open)} hint={`${report.totals.unassigned} unassigned`} />
        <Stat label="First response SLA" value={percent(report.response.attainmentPercent)} hint={`median ${formatMinutes(report.response.timing.medianMinutes)}`} />
        <Stat label="Resolution SLA" value={percent(report.resolution.attainmentPercent)} hint={`median ${formatMinutes(report.resolution.timing.medianMinutes)}`} />
        <Stat label="First response (p90)" value={formatMinutes(report.response.timing.p90Minutes)} hint={`${report.response.timing.measured} measured`} />
        <Stat label="Resolution (p90)" value={formatMinutes(report.resolution.timing.p90Minutes)} hint={`${report.resolution.timing.measured} measured`} />
        <Stat label="CSAT" value={csat.average === null ? "—" : `${csat.average}/5`} hint={csat.responses === 0 ? "no responses yet" : `${csat.positivePercent}% positive · ${csat.responseRatePercent}% response rate`} />
      </div>

      <section aria-label="Breaches" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Breached</h2>
        <StatusTable rows={report.breached} empty="No open ticket has passed its target." />
      </section>

      <section aria-label="At risk" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">At risk</h2>
        <p className="text-xs text-ink-faint">Running clocks already in their warning window.</p>
        <StatusTable rows={report.atRisk} empty="Nothing is close to its deadline." />
      </section>

      <section aria-label="By client" className="rounded-xl2 border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-display text-sm font-semibold text-ink">By client</h2>
          <a
            href="/reports/export?scope=clients"
            className="ml-auto rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:text-brand"
          >
            Download CSV
          </a>
        </div>
        {scorecards.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">No clients are in your scope yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] tracking-wide text-ink-faint uppercase">
                <tr>
                  <th scope="col" className="py-1">Client</th>
                  <th scope="col" className="py-1">Open</th>
                  <th scope="col" className="py-1">Breached</th>
                  <th scope="col" className="py-1">Response SLA</th>
                  <th scope="col" className="py-1">Resolution SLA</th>
                  <th scope="col" className="py-1">CSAT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {scorecards.map((card) => (
                  <ClientRow key={card.clientId ?? "desk"} card={card} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-ink-faint">
          Attainment is over the tickets whose clocks have closed, and a policy the client signed is the one they are judged
          against. Money and hours are on the{" "}
          <a href="/time" className="font-semibold text-brand hover:underline">
            Time
          </a>{" "}
          ledger.
        </p>
      </section>

      <section aria-label="Escalations" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Open escalations</h2>
        {openEscalations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">No escalations have been raised. The sweep runs on a schedule.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {openEscalations.map((escalation) => (
              <li key={escalation.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-mono text-[11px] font-semibold text-ink-faint">{escalation.ticketRef}</span>
                <span className="text-sm text-ink">{escalation.label}</span>
                <span className="ml-auto text-[11px] text-ink-faint">
                  L{escalation.level} · {escalation.audience} · {escalation.raisedAt.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
