import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { TicketTable } from "../../../components/TicketTable";
import { hasPermission } from "../../../lib/access-rules";
import { clientServicesFor, prisma, slaPolicyStoreFor, ticketServicesFor } from "../../../lib/db";
import { scopeByClient } from "../../../lib/client-rules";
import { buildInboxView } from "../../../lib/inbox-view";
import { atRiskOnly, sortForInbox } from "../../../lib/inbox-rules";
import { slaFlagsByTicket } from "../../../lib/report-rules";
import { isOpen } from "../../../lib/ticket-rules";
import { requireActor } from "../../../lib/session";

export const metadata = { title: "Overview" };

/**
 * The service overview.
 *
 * This is the screen an agent or a service manager opens first, and it answers one
 * question: *what needs me now?* Everything on it is a live count or a real queue —
 * no decoration, no vanity metric, and never a number that cannot be clicked
 * through to the work behind it. A count you cannot act on is just anxiety.
 *
 * The layout is a hierarchy, not a list. A dashboard that renders six identically
 * weighted tables in a column makes the reader decide what matters, which is the
 * one thing the page is supposed to have already decided. So the order is the order
 * of the job: the promises already missed, then the work nobody owns, then your own
 * queue, and only then the things that are merely interesting.
 *
 * It is scoped exactly like the inbox, through `scopeByClient`, so an agent working
 * one client's desk sees that client's numbers and not the whole tenant's.
 */

/** Midnight today, in the server's own zone — "resolved today" is a local question. */
function startOfToday(): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/**
 * Display names for everyone named on these tickets, in one query.
 *
 * A worklist that shows a cuid where a person's name belongs is a worklist nobody
 * can triage, and one query for every id is the difference between a dashboard that
 * loads and one that does not.
 */
async function displayNames(
  tickets: readonly { requesterId: string; assigneeId: string | null }[],
  tenantId: string,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      tickets.flatMap((ticket) => [ticket.requesterId, ticket.assigneeId]).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}

/**
 * One headline number.
 *
 * The colour appears only when there is something to look at: a zero in red is
 * noise, and a dashboard that is always shouting is one nobody reads. The hint is
 * not decoration either — "Unassigned 4" is not actionable until it says what
 * unassigned means for this desk.
 */
function Tile({
  label,
  value,
  hint,
  href,
  tone = "none",
}: {
  label: string;
  value: number | string;
  hint: string;
  href: string;
  tone?: "bad" | "attention" | "ok" | "none";
}) {
  const wantsAttention = typeof value === "number" ? value > 0 : Boolean(value);
  const valueTone =
    !wantsAttention || tone === "none"
      ? "text-ink"
      : tone === "bad"
        ? "text-bad"
        : tone === "attention"
          ? "text-attention"
          : "text-ok";
  return (
    <a
      href={href}
      className="card-surface group rounded-xl2 p-4 transition-colors hover:border-brand"
      title={hint}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <p className={`mt-1 font-display text-2xl font-semibold ${valueTone}`}>{value}</p>
      <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>
    </a>
  );
}

/**
 * A queue.
 *
 * The count sits in the header beside the title rather than only in the row count,
 * because "SLA breached 3" is the sentence a manager reads and "SLA breached" then
 * six rows of table is not. `priority` marks the one panel on the page that is a
 * missed promise rather than a queue to work.
 */
function Panel({
  title,
  count,
  hint,
  href,
  actionLabel = "Open in inbox",
  priority = false,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  href: string;
  actionLabel?: string;
  priority?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ot-panel flex flex-col" aria-label={title}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2>{title}</h2>
        <span
          className={
            count > 0 && priority
              ? "text-sm font-semibold text-bad"
              : count > 0
                ? "text-sm font-semibold text-ink-soft"
                : "text-sm font-semibold text-ink-faint"
          }
        >
          {count}
        </span>
        <a href={href} className="ml-auto text-xs font-semibold text-brand hover:underline">
          {actionLabel} →
        </a>
      </header>
      <p className="px-4 pt-2 text-xs text-ink-faint">{hint}</p>
      <div className="flex-1 p-1">{children}</div>
    </section>
  );
}

export default async function DashboardPage() {
  const actor = await requireActor();
  // The overview is tenant-wide, so it is a staff view; a requester belongs in the
  // portal, which scopes every ticket through `canReadTicket`.
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const [everything, policies, scope] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    clientServicesFor().scope(actor),
  ]);

  const all = scopeByClient(scope, everything);
  const now = new Date();
  const sla = slaFlagsByTicket(all, policies, now);
  const view = buildInboxView(all, { status: "open" }, sla);
  const counts = view.counts;

  const sinceMidnight = startOfToday();
  const resolvedToday = all.filter(
    (ticket) => !isOpen(ticket.status) && ticket.resolvedAt !== null && ticket.resolvedAt >= sinceMidnight,
  ).length;

  const breached = sortForInbox(all.filter((ticket) => isOpen(ticket.status) && sla.get(ticket.id)?.breached));
  // `atRiskOnly` is the same definition the counters use, so the “SLA at risk”
  // tile and the panel under it can never disagree about the same ticket.
  const atRisk = sortForInbox(all.filter((ticket) => isOpen(ticket.status) && atRiskOnly(sla.get(ticket.id))));
  const mine = sortForInbox(all.filter((ticket) => isOpen(ticket.status) && ticket.assigneeId === actor.id));
  const triage = view.triage;

  const names = await displayNames(all, actor.tenantId);

  // The status strip is the one part of the page that is a distribution rather than
  // a queue, so it is read as a proportion of the open work rather than as five
  // unrelated numbers.
  const statuses = ["NEW", "OPEN", "PENDING", "RESOLVED", "CLOSED"] as const;
  const busiest = Math.max(1, ...statuses.map((status) => counts.byStatus[status]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Service overview</h1>
          <p className="text-sm text-ink-soft">
            Live work for the tickets in your scope.
            {scope.kind === "assigned" ? ` Scoped to your clients: ${scope.because}.` : ""}
          </p>
        </div>
        <a
          href="/inbox/new"
          className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:opacity-95"
        >
          New ticket
        </a>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label="Open" value={counts.open} hint="not resolved or closed" href="/inbox?status=open" />
        <Tile
          label="Unassigned"
          value={counts.unassigned}
          hint="waiting for triage"
          href="/inbox?assignee=unassigned"
          tone="attention"
        />
        {/* The inbox reads `?priority=` the same way it reads `?status=`, so this
            number opens exactly the urgent work it counts. */}
        <Tile label="Urgent" value={counts.urgent} hint="open and urgent" href="/inbox?priority=URGENT" tone="bad" />
        <Tile
          label="SLA at risk"
          value={counts.slaAtRisk}
          hint="inside the warning window"
          href="/inbox?sla=at-risk"
          tone="attention"
        />
        <Tile
          label="SLA breached"
          value={counts.slaBreached}
          hint="past their target"
          href="/inbox?sla=breached"
          tone="bad"
        />
        <Tile
          label="Resolved today"
          value={resolvedToday}
          hint="since midnight"
          href="/inbox?status=RESOLVED"
          tone="ok"
        />
      </div>

      {/* A missed promise outranks a queue: it is the only row on this page that is a
          failure rather than a workload, so it gets the full width and the most rows. */}
      <Panel
        title="SLA breached"
        count={breached.length}
        priority
        hint="Open work whose target has already passed. These come first — every one is a promise the desk has missed."
        href="/inbox?sla=breached"
      >
        <TicketTable
          tickets={breached.slice(0, 10)}
          policies={policies}
          now={now}
          names={names}
          empty="Nothing has breached. Good."
        />
      </Panel>

      {/* The two queues a person actually works, side by side: the pile nobody owns,
          and their own. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Unassigned — triage queue"
          count={triage.length}
          hint="Open work that names nobody. A dispatcher's job starts here."
          href="/inbox?assignee=unassigned"
        >
          <TicketTable
            tickets={triage.slice(0, 8)}
            policies={policies}
            now={now}
            names={names}
            empty="Every open ticket has an owner."
          />
        </Panel>

        <Panel
          title="Your work"
          count={mine.length}
          hint="Open tickets assigned to you, most urgent first."
          href={`/inbox?assignee=${encodeURIComponent(actor.id)}`}
        >
          <TicketTable
            tickets={mine.slice(0, 8)}
            policies={policies}
            now={now}
            names={names}
            empty="Nothing is assigned to you. Pull something from the triage queue."
          />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="SLA at risk"
          count={atRisk.length}
          hint="Running clocks that have entered their warning window."
          href="/inbox?sla=at-risk"
        >
          <TicketTable
            tickets={atRisk.slice(0, 6)}
            policies={policies}
            now={now}
            names={names}
            empty="Nothing is close to its deadline."
          />
        </Panel>

        <section className="ot-panel flex flex-col" aria-label="Where the work sits">
          <header>
            <h2>Where the work sits</h2>
          </header>
          <p className="px-4 pt-2 text-xs text-ink-faint">
            Every ticket in scope, by status. The bar is the share of the busiest column, so the shape of the desk is
            readable at a glance rather than by comparing five numbers.
          </p>
          <div className="flex-1 space-y-2 p-4">
            {statuses.map((status) => {
              const value = counts.byStatus[status];
              return (
                <a
                  key={status}
                  href={`/inbox?status=${status}`}
                  className="flex items-center gap-3 text-sm hover:text-brand"
                >
                  <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {status}
                  </span>
                  <span
                    aria-hidden
                    className="h-2 rounded-full bg-brand-soft"
                    style={{ width: `${Math.round((value / busiest) * 100)}%`, minWidth: value > 0 ? "0.5rem" : "0" }}
                  />
                  <span className="ml-auto font-display text-sm font-semibold tabular-nums text-ink">{value}</span>
                </a>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
