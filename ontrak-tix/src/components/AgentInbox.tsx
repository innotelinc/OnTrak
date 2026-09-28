/**
 * Agent inbox (M0): the worklist an agent or dispatcher starts from.
 *
 * A pure renderer over `buildInboxView`: it decides nothing itself, so the same
 * ordering, filtering and counts are exercised in tests as server components
 * without a browser. Filter state travels in the URL, so the screen works as a
 * server component with no client JavaScript.
 *
 * Bulk actions are a plain form: checkboxes name the tickets and the submit
 * buttons carry the operation, so selecting and acting still works without JS.
 * Every ticket is re-validated by the service, so a selection can never widen
 * what a caller is allowed to do.
 */

import { buildInboxView, inboxFilterQuery, parseInboxFilter, type InboxSearchParams } from "../lib/inbox-view";
import type { InboxFilter, InboxSlaFlags } from "../lib/inbox-rules";
import { TICKET_STATUSES } from "../lib/ticket-rules";
import type { TicketRecord } from "../lib/ticket-service";
import { TicketPriorityBadge, TicketStatusBadge, TicketTypeBadge } from "./TicketBadges";

export interface AgentInboxProps {
  /** Every ticket in the tenant; the component applies the filter. */
  all: TicketRecord[];
  /** The active filter. When omitted it is parsed from `params`. */
  filter?: InboxFilter;
  params?: InboxSearchParams;
  /** Where ticket links point. Defaults to the current inbox route. */
  basePath?: string;
  selectedId?: string | null;
  /** SLA risk flags by ticket id, so the SLA chips can filter and count. */
  sla?: ReadonlyMap<string, InboxSlaFlags>;
  /** When supplied, rows gain checkboxes and the worklist gains a bulk toolbar. */
  bulk?: { action: (formData: FormData) => Promise<void> };
}

function inboxHref(basePath: string, filter: InboxFilter, ticketId?: string): string {
  const params = new URLSearchParams(inboxFilterQuery(filter));
  if (ticketId) params.set("ticket", ticketId);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function FilterTab({ active, href, label, count, tone }: { active: boolean; href: string; label: string; count?: number; tone?: "risk" | "breach" }) {
  const palette = active
    ? tone === "breach"
      ? "bg-pink text-white"
      : tone === "risk"
        ? "bg-amber text-white"
        : "bg-brand text-white"
    : tone === "breach"
      ? "bg-pink/12 text-pink"
      : tone === "risk"
        ? "bg-amber/10 text-amber"
        : "bg-surface-muted text-ink-soft";
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full px-3 py-1 text-xs font-semibold ${palette}`}
    >
      {label}
      {count === undefined ? null : <span className="ml-1.5 opacity-70">{count}</span>}
    </a>
  );
}

/** One worklist row; the checkbox is a sibling of the link so a click never navigates. */
function TicketRow({
  ticket,
  href,
  selected,
  risk,
  selectable,
}: {
  ticket: TicketRecord;
  href: string;
  selected: boolean;
  risk?: InboxSlaFlags;
  selectable: boolean;
}) {
  return (
    <li className={`flex items-start gap-2 px-4 py-3 ${selected ? "bg-surface-muted/70" : "hover:bg-surface-muted/50"}`}>
      {selectable ? (
        <input
          type="checkbox"
          name="ticketIds"
          value={ticket.id}
          aria-label={`Select ${ticket.ref}`}
          className="mt-1 size-4 shrink-0 accent-brand"
        />
      ) : null}
      <a href={href} aria-current={selected ? "true" : undefined} className="block min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] font-semibold text-ink-faint">{ticket.ref}</span>
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityBadge priority={ticket.priority} />
          <TicketTypeBadge type={ticket.type} />
          {risk?.breached ? (
            <span className="rounded-full bg-pink/12 px-2 py-0.5 text-[11px] font-semibold text-pink">SLA breached</span>
          ) : risk?.atRisk ? (
            <span className="rounded-full bg-amber/18 px-2 py-0.5 text-[11px] font-semibold text-amber">SLA at risk</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-sm font-semibold text-ink">{ticket.subject}</p>
        <p className="mt-0.5 text-xs text-ink-faint">
          {ticket.assigneeId ? `Assigned to ${ticket.assigneeId}` : "Unassigned"}
        </p>
      </a>
    </li>
  );
}

export function AgentInbox({ all, filter, params, basePath = "/inbox", selectedId = null, sla, bulk }: AgentInboxProps) {
  const active = filter ?? parseInboxFilter(params);
  const view = buildInboxView(all, active, sla);
  const counts = view.counts;
  const activeKey = active.assigneeId === "unassigned" ? "unassigned" : (active.status ?? "open") === "all" ? "all" : "open";

  const tabs = [
    { key: "open", label: "Open", filter: { status: "open" } as InboxFilter, count: counts.open },
    { key: "unassigned", label: "Unassigned", filter: { status: "open", assigneeId: "unassigned" } as InboxFilter, count: counts.unassigned },
    { key: "all", label: "All", filter: { status: "all" } as InboxFilter, count: undefined as number | undefined },
  ];

  const rows = view.tickets.map((ticket) => (
    <TicketRow
      key={ticket.id}
      ticket={ticket}
      href={inboxHref(basePath, active, ticket.id)}
      selected={ticket.id === selectedId}
      risk={sla?.get(ticket.id)}
      selectable={bulk !== undefined}
    />
  ));

  const list =
    view.tickets.length === 0 ? (
      <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
        Nothing matches this view. Try &ldquo;All&rdquo;, or clear the search.
      </p>
    ) : (
      <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">{rows}</ul>
    );

  return (
    <section aria-label="Ticket worklist" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => (
          <FilterTab
            key={tab.key}
            active={active.sla === undefined && activeKey === tab.key}
            href={inboxHref(basePath, tab.filter)}
            label={tab.label}
            count={tab.count}
          />
        ))}
        <FilterTab
          active={active.sla === "at-risk"}
          href={inboxHref(basePath, active.sla === "at-risk" ? { ...active, sla: undefined } : { ...active, sla: "at-risk" })}
          label="SLA at risk"
          count={counts.slaAtRisk}
          tone="risk"
        />
        <FilterTab
          active={active.sla === "breached"}
          href={inboxHref(basePath, active.sla === "breached" ? { ...active, sla: undefined } : { ...active, sla: "breached" })}
          label="SLA breached"
          count={counts.slaBreached}
          tone="breach"
        />
        <span className="ml-auto text-xs text-ink-faint">
          {counts.open} open · {counts.unassigned} unassigned · {counts.urgent} urgent
        </span>
      </div>

      {bulk ? (
        <form action={bulk.action} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-surface p-3">
            <span className="text-xs font-semibold text-ink-faint">With selected:</span>
            <select
              name="status"
              defaultValue="OPEN"
              aria-label="Set status"
              className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink"
            >
              {TICKET_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <button
              type="submit"
              name="op"
              value="status"
              className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft"
            >
              Set status
            </button>
            <span aria-hidden className="text-ink-faint">
              ·
            </span>
            <input
              name="assigneeId"
              aria-label="Assignee id"
              placeholder="Assignee id (blank to unassign)"
              className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-xs text-ink"
            />
            <button
              type="submit"
              name="op"
              value="assign"
              className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft"
            >
              Assign
            </button>
          </div>
          {list}
        </form>
      ) : (
        list
      )}
    </section>
  );
}
