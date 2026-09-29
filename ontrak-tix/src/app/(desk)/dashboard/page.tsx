import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { TicketTable } from "../../../components/TicketTable";
import { hasPermission } from "../../../lib/access-rules";
import { clientServicesFor, prisma, slaPolicyStoreFor, ticketServicesFor } from "../../../lib/db";
import { scopeByClient } from "../../../lib/client-rules";
import { buildInboxView } from "../../../lib/inbox-view";
import { sortForInbox } from "../../../lib/inbox-rules";
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

function Tile({
  label,
  value,
  hint,
  tone = "none",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "bad" | "attention" | "ok" | "none";
}) {
  // A zero in red is noise, not a warning: the colour only appears when there is
  // something to look at.
  const wantsAttention = typeof value === "number" ? value > 0 : Boolean(value);
  const valueTone =
    !wantsAttention || tone === "none"
      ? "text-ink"
      : tone === "bad"
        ? "text-pink"
        : tone === "attention"
          ? "text-amber"
          : "text-teal";
  return (
    <div className="card-surface rounded-xl2 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <p className={`mt-1 font-display text-2xl font-semibold ${valueTone}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ot-panel">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {hint ? <p className="px-4 pt-3 text-xs text-ink-faint">{hint}</p> : null}
      <div className="p-1">{children}</div>
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
  const atRisk = sortForInbox(
    all.filter((ticket) => isOpen(ticket.status) && sla.get(ticket.id)?.atRisk && !sla.get(ticket.id)?.breached),
  );
  const mine = sortForInbox(all.filter((ticket) => isOpen(ticket.status) && ticket.assigneeId === actor.id));
  const triage = view.triage;

  const names = await displayNames(all, actor.tenantId);

  return (
    <div className="space-y-6">
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
        <Tile label="Open" value={counts.open} hint="not resolved or closed" />
        <Tile label="Unassigned" value={counts.unassigned} hint="waiting for triage" tone="attention" />
        <Tile label="Urgent" value={counts.urgent} hint="open and urgent" tone="bad" />
        <Tile label="SLA at risk" value={counts.slaAtRisk} hint="inside the warning window" tone="attention" />
        <Tile label="SLA breached" value={counts.slaBreached} hint="past their target" tone="bad" />
        <Tile label="Resolved today" value={resolvedToday} hint="since midnight" tone="ok" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="SLA breached"
          hint="Open work whose target has already passed. These come first — every one is a promise the desk has missed."
          action={
            <a href="/inbox?sla=breached" className="text-xs font-semibold text-brand hover:underline">
              Open in inbox →
            </a>
          }
        >
          <TicketTable
            tickets={breached.slice(0, 6)}
            policies={policies}
            now={now}
            names={names}
            empty="Nothing has breached. Good."
          />
        </Panel>

        <Panel
          title="SLA at risk"
          hint="Running clocks that are already in their warning window."
          action={
            <a href="/inbox?sla=at-risk" className="text-xs font-semibold text-brand hover:underline">
              Open in inbox →
            </a>
          }
        >
          <TicketTable
            tickets={atRisk.slice(0, 6)}
            policies={policies}
            now={now}
            names={names}
            empty="Nothing is close to its deadline."
          />
        </Panel>
      </div>

      <Panel
        title="Unassigned — triage queue"
        hint="Open work that names nobody. A dispatcher's job starts here."
        action={
          <a href="/inbox?assignee=unassigned" className="text-xs font-semibold text-brand hover:underline">
            Open in inbox →
          </a>
        }
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
        hint="Open tickets assigned to you, most urgent first."
        action={
          <a href={`/inbox?assignee=${encodeURIComponent(actor.id)}`} className="text-xs font-semibold text-brand hover:underline">
            Open in inbox →
          </a>
        }
      >
        <TicketTable
          tickets={mine.slice(0, 8)}
          policies={policies}
          now={now}
          names={names}
          empty="Nothing is assigned to you. Pull something from the triage queue above."
        />
      </Panel>

      <section aria-label="By status" className="ot-panel">
        <header>
          <h2>Where the work sits</h2>
        </header>
        <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
          {(["NEW", "OPEN", "PENDING", "RESOLVED", "CLOSED"] as const).map((status) => (
            <div key={status} className="rounded-xl2 border border-line bg-surface-muted px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{status}</p>
              <p className="mt-1 font-display text-xl font-semibold text-ink">{counts.byStatus[status]}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
