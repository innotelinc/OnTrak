import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import {
  clientServicesFor,
  clientSurveyServicesFor,
  csatServicesFor,
  escalationServicesFor,
  knowledgeServicesFor,
  prisma,
  slaPolicyStoreFor,
  ticketServicesFor,
} from "../../../lib/db";
import { actorHasPermission } from "../../../lib/access-rules";
import { buildSlaReport, clientScorecards, type ClientScorecard, type ReportSurvey, type TicketSlaStatus } from "../../../lib/report-rules";
import {
  csatByGroup,
  csatDashboard,
  type AttributedSurvey,
  type CsatBucket,
  type CsatGroupScore,
} from "../../../lib/csat-rules";
import { buildKnowledgeGapReport, type KnowledgeGapReport } from "../../../lib/knowledge-rules";
import {
  agentScorecards,
  forecastVolume,
  queueScorecards,
  slaRisk,
  ticketTrends,
  type ForecastReport,
  type RiskBand,
  type SlaRiskReport,
  type TrendReport,
  type WorkScorecard,
} from "../../../lib/analytics-rules";

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
  const tone = row.breached ? "text-bad" : row.atRisk ? "text-attention" : "text-ok";
  const label = row.breached ? "breached" : row.atRisk ? "at risk" : row.state;
  return <span className={`text-xs font-semibold ${tone}`}>{label}</span>;
}

/** One client's row: attainment, breaches and what their people said. */
function ClientRow({ card }: { card: ClientScorecard }) {
  return (
    <tr>
      <th scope="row" className="py-2 text-left font-semibold text-ink">
        {card.name}
        {card.withoutPolicy > 0 ? <span className="ml-2 text-[11px] text-attention">{card.withoutPolicy} without a policy</span> : null}
      </th>
      <td className="py-2 text-ink-soft">
        {card.open}
        <span className="text-ink-faint"> / {card.total}</span>
      </td>
      <td className={`py-2 ${card.breached > 0 ? "font-semibold text-bad" : "text-ink-soft"}`}>{card.breached}</td>
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

/**
 * The volume trend (M7): a compact table plus the change against the window before it.
 *
 * Days are UTC and read left-to-right oldest-first, and the backlog column is what was
 * open at the *end of that day* — recomputed from timestamps, so a chart of last week
 * does not change because somebody closed a ticket today.
 */
function TrendPanel({ report }: { report: TrendReport }) {
  const change = (value: number | null): string =>
    value === null ? "no prior window" : `${value >= 0 ? "+" : ""}${value}% vs previous`;
  const shown = report.points.slice(-14);
  return (
    <>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Stat label={`Opened (${report.days}d)`} value={String(report.createdTotal)} hint={change(report.createdChangePercent)} />
        <Stat label={`Closed (${report.days}d)`} value={String(report.closedTotal)} hint={change(report.closedChangePercent)} />
        <Stat label="Backlog now" value={String(report.backlogNow)} hint="open by the timeline" />
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] tracking-wide text-ink-faint uppercase">
            <tr>
              <th scope="col" className="py-1">Day</th>
              <th scope="col" className="py-1">Opened</th>
              <th scope="col" className="py-1">Closed</th>
              <th scope="col" className="py-1">Backlog</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((point) => (
              <tr key={point.day}>
                <th scope="row" className="py-1.5 text-left font-mono text-xs font-normal text-ink-soft">{point.day}</th>
                <td className="py-1.5 text-ink">{point.created}</td>
                <td className="py-1.5 text-ink">{point.closed}</td>
                <td className="py-1.5 text-ink-soft">{point.backlog}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        The last {shown.length} of {report.days} UTC days. Closed counts resolved and closed work; backlog is what was open at the
        end of each day.
      </p>
    </>
  );
}

/**
 * The projection (M7): the backlog if recent intake and closures both hold.
 *
 * A straight line from the recent average on purpose — see `forecastVolume`. The one
 * thing worth reading off it is the direction, which `outlook` names outright.
 */
function ForecastPanel({ forecast }: { forecast: ForecastReport }) {
  const outlook =
    forecast.outlook === "accumulating"
      ? "the backlog is projected to grow"
      : forecast.outlook === "clearing"
        ? "the backlog is projected to shrink"
        : "the backlog is projected to hold";
  const delta = forecast.projectedBacklogDelta;
  return (
    <>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Stat
          label={`Projected backlog (+${forecast.horizonDays}d)`}
          value={String(forecast.projectedBacklog)}
          hint={`${delta >= 0 ? "+" : ""}${delta} over the horizon`}
        />
        <Stat
          label="Intake rate"
          value={`${forecast.dailyCreated}/day`}
          hint={`mean of the last ${forecast.basisDays} days`}
        />
        <Stat
          label="Close rate"
          value={`${forecast.dailyClosed}/day`}
          hint={`mean of the last ${forecast.basisDays} days`}
        />
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        A straight line from the last {forecast.basisDays} days — intake and closures held at their recent
        average — so {outlook}. A warning, not a promise: one quiet week is not a trend.
      </p>
    </>
  );
}

/** The forward-looking risk list: worst band first, then nearest deadline. */
function SlaRiskTable({ report }: { report: SlaRiskReport }) {
  if (report.items.length === 0) {
    return <p className="mt-2 text-sm text-ink-faint">No open ticket is running a clock.</p>;
  }
  const tone: Record<RiskBand, string> = {
    critical: "text-bad",
    high: "text-attention",
    medium: "text-ink-soft",
    low: "text-ink-faint",
  };
  return (
    <ul className="mt-2 divide-y divide-line">
      {report.items.slice(0, 20).map((item) => (
        <li key={item.ticketId} className="flex flex-wrap items-center gap-2 py-2">
          <span className="font-mono text-[11px] font-semibold text-ink-faint">{item.ref}</span>
          <a href={`/inbox/${item.ticketId}`} className="truncate text-sm text-ink hover:text-brand">
            {item.subject}
          </a>
          <span className="text-[11px] text-ink-faint">{item.reason}</span>
          <span className="ml-auto flex items-center gap-3">
            {item.paused ? <span className="text-[11px] text-ink-faint">paused</span> : null}
            <span className="text-[11px] text-ink-faint">{item.priority}</span>
            <span className={`text-xs font-semibold ${tone[item.band]}`}>{item.band}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One group's row on the agents/queues scorecard. */
function WorkRow({ card }: { card: WorkScorecard }) {
  return (
    <tr>
      <th scope="row" className="py-2 text-left font-semibold text-ink">
        {card.name}
        {card.withoutPolicy > 0 ? <span className="ml-2 text-[11px] text-attention">{card.withoutPolicy} without a policy</span> : null}
      </th>
      <td className="py-2 text-ink-soft">
        {card.open}
        <span className="text-ink-faint"> / {card.total}</span>
      </td>
      <td className="py-2 text-ink-soft">{card.closed}</td>
      <td className={`py-2 ${card.breached > 0 ? "font-semibold text-bad" : "text-ink-soft"}`}>{card.breached}</td>
      <td className="py-2 text-ink-soft">{percent(card.response.attainmentPercent)}</td>
      <td className="py-2 text-ink-soft">{percent(card.resolution.attainmentPercent)}</td>
    </tr>
  );
}

/** A scorecard table: the same columns for a person and for a queue. */
function WorkTable({ cards, empty }: { cards: WorkScorecard[]; empty: string }) {
  if (cards.length === 0) return <p className="mt-2 text-sm text-ink-faint">{empty}</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] tracking-wide text-ink-faint uppercase">
          <tr>
            <th scope="col" className="py-1">Group</th>
            <th scope="col" className="py-1">Open</th>
            <th scope="col" className="py-1">Closed</th>
            <th scope="col" className="py-1">Breached</th>
            <th scope="col" className="py-1">Response SLA</th>
            <th scope="col" className="py-1">Resolution SLA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {cards.map((card) => (
            <WorkRow key={card.groupId ?? "none"} card={card} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A satisfaction distribution: each point on the scale, against the busiest. */
function Distribution({ buckets }: { buckets: CsatBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <ul className="mt-3 space-y-1.5">
      {buckets.map((bucket) => (
        <li key={bucket.score} className="flex items-center gap-2">
          <span className="w-36 shrink-0 text-xs text-ink-soft">
            {bucket.score} · {bucket.label}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
            <span className="block h-2 rounded-full bg-brand" style={{ width: `${(bucket.count / max) * 100}%` }} />
          </span>
          <span className="w-20 shrink-0 text-right text-xs text-ink-faint">
            {bucket.count}
            {bucket.percent === null ? "" : ` · ${bucket.percent}%`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Satisfaction split by whoever earned it, worst first. */
function SatisfactionTable({ rows }: { rows: CsatGroupScore[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] tracking-wide text-ink-faint uppercase">
          <tr>
            <th scope="col" className="py-1">Agent</th>
            <th scope="col" className="py-1">Answers</th>
            <th scope="col" className="py-1">Average</th>
            <th scope="col" className="py-1">Positive</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.groupId ?? "unassigned"}>
              <th scope="row" className="py-2 text-left font-semibold text-ink">
                {row.label}
              </th>
              <td className="py-2 text-ink-soft">{row.summary.responses}</td>
              <td className="py-2 text-ink-soft">{row.summary.average === null ? "\u2014" : `${row.summary.average}/5`}</td>
              <td className="py-2 text-ink-soft">
                {row.summary.positivePercent === null ? "\u2014" : `${row.summary.positivePercent}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The questions no article answered, repeats first. */
function KnowledgeGaps({ report }: { report: KnowledgeGapReport }) {
  if (report.gaps.length === 0) {
    return (
      <p className="mt-2 text-sm text-ink-faint">
        Every subject raised on the desk found something in the knowledge base.
      </p>
    );
  }
  return (
    <ul className="mt-3 divide-y divide-line">
      {report.gaps.map((gap) => (
        <li key={gap.terms.join(" ")} className="py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-semibold text-ink">{gap.terms.join(" · ")}</span>
            {gap.repeat ? (
              <span className="rounded-full bg-attention/10 px-2 py-0.5 text-[11px] font-semibold text-attention">
                repeat requester
              </span>
            ) : null}
            <span className="ml-auto text-[11px] text-ink-faint">
              {gap.tickets.length} ticket{gap.tickets.length === 1 ? "" : "s"} · {gap.requesters.length} requester
              {gap.requesters.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {gap.tickets.slice(0, 4).map((ticket) => (
              <li key={ticket.id} className="flex items-center gap-2 text-xs text-ink-soft">
                <span className="font-mono text-[11px] font-semibold text-ink-faint">{ticket.ref}</span>
                <a href={`/inbox/${ticket.id}`} className="truncate hover:text-brand">
                  {ticket.subject}
                </a>
              </li>
            ))}
            {gap.tickets.length > 4 ? (
              <li className="text-xs text-ink-faint">and {gap.tickets.length - 4} more</li>
            ) : null}
          </ul>
        </li>
      ))}
    </ul>
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
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");

  const now = new Date().toISOString();
  const [tickets, policies, escalations, csat, ticketSurveys, clients, clientSurveys, knowledge, queues] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    escalationServicesFor().list(actor.tenantId),
    csatServicesFor().summary(actor.tenantId),
    csatServicesFor().list(actor.tenantId),
    clientServicesFor().list(actor),
    clientSurveyServicesFor().all(actor),
    knowledgeServicesFor().list(actor),
    // Queue names for the scorecard, so an empty queue can be named rather than shown
    // as an id. The queue's routing lives in the rules engine; a scorecard only needs
    // what a ticket already carries.
    prisma.queue.findMany({
      where: { tenantId: actor.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const report = buildSlaReport(tickets, policies, now);
  const openEscalations = escalations.filter((escalation) => escalation.acknowledgedAt === null).slice(0, 10);

  // The satisfaction dashboard (M5). A survey row names only the ticket it came
  // from, so the ticket answers who did the work — which is what makes "which
  // agent is behind the unhappy ratings?" a question the report can answer at all.
  const assigneeOfTicket = new Map(tickets.map((ticket) => [ticket.id, ticket.assigneeId ?? null]));
  const attributed: AttributedSurvey[] = ticketSurveys.map((survey) => ({
    survey: {
      token: survey.token,
      requestedAt: survey.requestedAt,
      respondedAt: survey.respondedAt,
      score: survey.score,
      comment: survey.comment,
    },
    groupId: assigneeOfTicket.get(survey.ticketId) ?? null,
  }));
  const satisfaction = csatDashboard(
    attributed.map((entry) => entry.survey),
    ticketSurveys.length,
    { commentLimit: 6 },
  );
  const assigneeIds = [...new Set(tickets.map((ticket) => ticket.assigneeId).filter((id): id is string => !!id))];
  const staff = assigneeIds.length
    ? await prisma.user.findMany({
        where: { tenantId: actor.tenantId, id: { in: assigneeIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const agentName = new Map(staff.map((user) => [user.id, user.displayName]));
  const byAgent = csatByGroup(attributed, (groupId) =>
    groupId === null ? "Unassigned" : (agentName.get(groupId) ?? groupId),
  );

  // The knowledge gaps (M5): subjects the knowledge base could not answer, which
  // is the article backlog written by the desk's own tickets.
  const gapReport = buildKnowledgeGapReport(
    knowledge.ok ? knowledge.value.map((entry) => entry.article) : [],
    tickets.map((ticket) => ({
      id: ticket.id,
      ref: ticket.ref,
      subject: ticket.subject,
      requesterId: ticket.requesterId,
      clientId: ticket.clientId ?? null,
      status: ticket.status,
      createdAt: ticket.createdAt,
    })),
  );

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

  // The M7 analytics: where the volume is going, and who is carrying it. Both are
  // computed from the same tickets and policies the SLA report above uses, so an
  // agent's or a queue's attainment cannot drift from the desk-wide figure.
  const trends = ticketTrends(tickets, now, 30);
  const agentCards = agentScorecards(
    tickets,
    policies,
    staff.map((user) => ({ id: user.id, name: user.displayName })),
    now,
  );
  const queueCards = queueScorecards(tickets, policies, queues, now);
  // The projection is drawn from the same trend the table above shows, and the risk list
  // from the same SLA report — so neither can disagree with the numbers beside it.
  const forecast = forecastVolume(trends, { horizonDays: 14, basisDays: 7 });
  const risk = slaRisk(tickets, policies, now);

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

      <section aria-label="Satisfaction" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Satisfaction</h2>
        <p className="text-xs text-ink-faint">
          The ratings people left on their own resolved tickets. An average hides the shape of the answers, so the whole
          scale is shown — including the points nobody picked.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Stat
            label="Average"
            value={satisfaction.summary.average === null ? "\u2014" : `${satisfaction.summary.average}/5`}
            hint={`${satisfaction.summary.responses} answer${satisfaction.summary.responses === 1 ? "" : "s"}`}
          />
          <Stat
            label="Positive"
            value={satisfaction.summary.positivePercent === null ? "\u2014" : `${satisfaction.summary.positivePercent}%`}
            hint="4 or 5 out of 5"
          />
          <Stat
            label="Response rate"
            value={satisfaction.summary.responseRatePercent === null ? "\u2014" : `${satisfaction.summary.responseRatePercent}%`}
            hint="of the surveys offered"
          />
        </div>
        {satisfaction.summary.responses === 0 ? null : <Distribution buckets={satisfaction.distribution} />}

        {byAgent.length > 0 ? (
          <div className="mt-5">
            <h3 className="font-display text-xs font-semibold tracking-wide text-ink-soft uppercase">By agent</h3>
            <SatisfactionTable rows={byAgent} />
          </div>
        ) : null}

        {satisfaction.comments.length > 0 ? (
          <div className="mt-5">
            <h3 className="font-display text-xs font-semibold tracking-wide text-ink-soft uppercase">In their words</h3>
            <ul className="mt-2 space-y-2">
              {satisfaction.comments.map((comment, index) => (
                <li
                  key={`${comment.answeredAt}-${comment.score}-${index}`}
                  className="rounded-xl2 border border-line bg-surface-muted p-3 text-sm text-ink-soft"
                >
                  <span className="font-semibold text-ink">{comment.score}/5</span>
                  <span className="text-ink-faint"> · {comment.answeredAt.slice(0, 10)}</span>
                  <p className="mt-1 whitespace-pre-line">{comment.comment}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-label="Knowledge gaps" className="rounded-xl2 border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-display text-sm font-semibold text-ink">Knowledge gaps</h2>
          <span className="ml-auto text-[11px] text-ink-faint">
            {gapReport.unansweredPercent === null
              ? "no tickets to weigh"
              : `${gapReport.unansweredPercent}% of ${gapReport.considered} tickets found nothing`}
          </span>
        </div>
        <p className="text-xs text-ink-faint">
          Subjects whose words matched no article — the desk answered them by hand. A repeat requester is the loudest
          possible signal that an article is missing, so those clusters sort first.
        </p>
        <KnowledgeGaps report={gapReport} />
      </section>

      <section aria-label="Breaches" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Breached</h2>
        <StatusTable rows={report.breached} empty="No open ticket has passed its target." />
      </section>

      <section aria-label="At risk" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">At risk</h2>
        <p className="text-xs text-ink-faint">Running clocks already in their warning window.</p>
        <StatusTable rows={report.atRisk} empty="Nothing is close to its deadline." />
      </section>

      <section aria-label="SLA risk" className="rounded-xl2 border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="font-display text-sm font-semibold text-ink">SLA risk</h2>
          <span className="ml-auto text-[11px] text-ink-faint">
            {risk.projectedBreaches} ticket{risk.projectedBreaches === 1 ? "" : "s"} expected to breach inside{" "}
            {Math.round(risk.horizonMinutes / 60)} business hours
          </span>
        </div>
        <p className="text-xs text-ink-faint">
          Forward-looking, unlike the lists above: each open ticket is placed on the running clock nearest its deadline, so
          work that is not yet in its warning window is still visible while there is time to act.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          <Stat label="Critical" value={String(risk.counts.critical)} hint="past the target" />
          <Stat label="High" value={String(risk.counts.high)} hint="a breach is inside the horizon" />
          <Stat label="Medium" value={String(risk.counts.medium)} hint="inside the horizon" />
          <Stat label="Low" value={String(risk.counts.low)} hint="beyond the horizon" />
        </div>
        <SlaRiskTable report={risk} />
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

      <section aria-label="Trends" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Trends</h2>
        <p className="text-xs text-ink-faint">
          Ticket volume over the last thirty days and the backlog it left. A flat backlog with rising intake is the quiet
          warning; the change figure compares this window with the one before it.
        </p>
        <TrendPanel report={trends} />
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="font-display text-xs font-semibold tracking-wide text-ink-soft uppercase">Forecast</h3>
          <ForecastPanel forecast={forecast} />
        </div>
      </section>

      <section aria-label="By agent" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">By agent</h2>
        <p className="text-xs text-ink-faint">
          Attainment over each person&rsquo;s tickets whose clocks have closed, most-breached first. The parts add up to the
          desk: unassigned work is a row of its own rather than omitted.
        </p>
        <WorkTable cards={agentCards} empty="No ticket has been assigned yet." />
      </section>

      <section aria-label="By queue" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">By queue</h2>
        <p className="text-xs text-ink-faint">
          The same question asked of the routing: which queues are breaching, and how much is sitting in each.
        </p>
        <WorkTable cards={queueCards} empty="No queue has work in it yet." />
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
