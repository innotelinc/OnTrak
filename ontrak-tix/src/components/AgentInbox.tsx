/**
 * Agent inbox: the worklist an agent or dispatcher starts from.
 *
 * A pure renderer over `buildInboxView`: it decides nothing itself, so the same
 * ordering, filtering and counts are exercised in tests as server components
 * without a browser. Filter state travels in the URL, so the screen works as a
 * server component with no client JavaScript.
 *
 * The worklist is a *table*. It used to be a stack of badge rows, which reads fine
 * for three tickets and becomes unreadable at thirty — and thirty is a quiet
 * morning. A comparison task wants columns: an agent scanning for "urgent,
 * unassigned, about to breach" is doing exactly that.
 *
 * Bulk actions are a plain form: checkboxes name the tickets and the submit buttons
 * carry the operation, so selecting and acting still works without JS. Every ticket
 * is re-validated by the service, so a selection can never widen what a caller is
 * allowed to do.
 */

import { buildInboxView, inboxFilterQuery, parseInboxFilter, type InboxSearchParams } from "../lib/inbox-view";
import type { InboxFilter, InboxSlaFlags } from "../lib/inbox-rules";
import { TICKET_STATUSES } from "../lib/ticket-rules";
import type { TicketRecord } from "../lib/ticket-service";
import type { AssigneeOption } from "../lib/assignee-rules";
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
  /**
   * The staff a selected ticket may be handed to. When supplied the bulk toolbar's
   * assign control is a real picker; when omitted it falls back to asking for a raw
   * user id, so the toolbar still works on a caller that has not read the desk's people.
   */
  assignees?: AssigneeOption[];
}

function inboxHref(basePath: string, filter: InboxFilter, ticketId?: string): string {
  const params = new URLSearchParams(inboxFilterQuery(filter));
  if (ticketId) params.set("ticket", ticketId);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * One filter, as a pill.
 *
 * The active state is a *tint plus a border*, never a solid fill. A solid fill
 * means picking a text colour that has to be legible on top of it in both light and
 * dark and in both palettes — and the first time that is got wrong, the label of
 * the tab you are currently on is the one you cannot read.
 */
function FilterTab({
  active,
  href,
  label,
  count,
  tone,
}: {
  active: boolean;
  href: string;
  label: string;
  count?: number;
  tone?: "risk" | "breach";
}) {
  const activeTone =
    tone === "breach"
      ? "border-bad/50 bg-bad/12 text-bad"
      : tone === "risk"
        ? "border-attention/50 bg-attention/15 text-attention"
        : "border-brand/40 bg-brand-soft text-brand";
  const idleTone =
    tone === "breach"
      ? "border-transparent text-bad hover:bg-bad/10"
      : tone === "risk"
        ? "border-transparent text-attention hover:bg-attention/10"
        : "border-transparent text-ink-soft hover:bg-surface-muted hover:text-ink";
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
        active ? activeTone : idleTone
      }`}
    >
      {label}
      {count === undefined ? null : <span className="tabular-nums">{count}</span>}
    </a>
  );
}

/** The search field, as a GET form so the query lands in the URL like every filter. */
function SearchBox({ basePath, active }: { basePath: string; active: InboxFilter }) {
  return (
    <form method="get" action={basePath} className="flex items-center gap-2">
      {Object.entries(inboxFilterQuery({ ...active, search: undefined }))
        .filter(([key]) => key !== "search")
        .map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
      <input
        type="search"
        name="search"
        defaultValue={active.search ?? ""}
        placeholder="Search ref or subject…"
        aria-label="Search tickets"
        className="ot-input w-56 py-1.5 text-xs"
      />
      <button type="submit" className="ot-btn px-3 py-1.5 text-xs">
        Search
      </button>
    </form>
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
    <tr className={selected ? "bg-brand-soft" : undefined}>
      {selectable ? (
        <td className="w-8">
          <input
            type="checkbox"
            name="ticketIds"
            value={ticket.id}
            aria-label={`Select ${ticket.ref}`}
            className="size-4 accent-brand"
          />
        </td>
      ) : null}
      <td className="whitespace-nowrap">
        <a href={href} className="font-mono text-[11px] font-semibold text-ink-faint hover:text-brand">
          {ticket.ref}
        </a>
      </td>
      <td className="max-w-[28rem]">
        <a
          href={href}
          aria-current={selected ? "true" : undefined}
          className="block truncate font-semibold text-ink hover:text-brand"
          title={ticket.subject}
        >
          {ticket.subject}
        </a>
      </td>
      <td>
        <TicketStatusBadge status={ticket.status} />
      </td>
      <td>
        <TicketPriorityBadge priority={ticket.priority} />
      </td>
      <td>
        <TicketTypeBadge type={ticket.type} />
      </td>
      <td className="whitespace-nowrap text-ink-soft">
        {ticket.assigneeId ? <span className="ot-mono text-[11px]">{ticket.assigneeId}</span> : "Unassigned"}
      </td>
      <td className="whitespace-nowrap">
        {risk?.breached ? (
          <span className="inline-flex rounded-full border border-bad/40 bg-bad/10 px-2 py-0.5 text-[11px] font-semibold text-bad">
            Breached
          </span>
        ) : risk?.atRisk ? (
          <span className="inline-flex rounded-full border border-attention/40 bg-attention/10 px-2 py-0.5 text-[11px] font-semibold text-attention">
            At risk
          </span>
        ) : (
          <span className="text-[11px] text-ink-faint">—</span>
        )}
      </td>
    </tr>
  );
}

export function AgentInbox({
  all,
  filter,
  params,
  basePath = "/inbox",
  selectedId = null,
  sla,
  bulk,
  assignees,
}: AgentInboxProps) {
  const active = filter ?? parseInboxFilter(params);
  const view = buildInboxView(all, active, sla);
  const counts = view.counts;
  const activeKey = active.assigneeId === "unassigned" ? "unassigned" : (active.status ?? "open") === "all" ? "all" : "open";

  const tabs = [
    { key: "open", label: "Open", filter: { status: "open" } as InboxFilter, count: counts.open },
    { key: "unassigned", label: "Unassigned", filter: { status: "open", assigneeId: "unassigned" } as InboxFilter, count: counts.unassigned },
    { key: "all", label: "All", filter: { status: "all" } as InboxFilter, count: undefined as number | undefined },
  ];

  const selectable = bulk !== undefined;
  const columns = selectable ? 8 : 7;

  const rows = view.tickets.map((ticket) => (
    <TicketRow
      key={ticket.id}
      ticket={ticket}
      href={inboxHref(basePath, active, ticket.id)}
      selected={ticket.id === selectedId}
      risk={sla?.get(ticket.id)}
      selectable={selectable}
    />
  ));

  const table = (
    <div className="overflow-x-auto">
      <table className="ot-table">
        <thead>
          <tr>
            {selectable ? (
              <th scope="col">
                <span className="ot-sr">Select</span>
              </th>
            ) : null}
            <th scope="col">Ref</th>
            <th scope="col">Subject</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Type</th>
            <th scope="col">Assignee</th>
            <th scope="col">SLA</th>
          </tr>
        </thead>
        <tbody>
          {view.tickets.length === 0 ? (
            <tr>
              <td colSpan={columns} className="py-8 text-center text-sm text-ink-faint">
                Nothing matches this view. Try &ldquo;All&rdquo;, or clear the search.
              </td>
            </tr>
          ) : (
            rows
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <section aria-label="Ticket worklist" className="space-y-3">
      {/* The toolbar: what you are looking at, and the two things you do to it. */}
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
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
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
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-ink-faint">
            {counts.open} open · {counts.unassigned} unassigned · {counts.urgent} urgent
          </span>
          <SearchBox basePath={basePath} active={active} />
        </div>
      </div>

      {bulk ? (
        <form action={bulk.action} className="card-surface overflow-hidden rounded-xl2">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-muted px-3 py-2">
            <span className="text-xs font-semibold text-ink-faint">With selected:</span>
            <select
              name="status"
              defaultValue="OPEN"
              aria-label="Set status"
              className="ot-input w-auto py-1 text-xs"
            >
              {TICKET_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <button type="submit" name="op" value="status" className="ot-btn px-3 py-1 text-xs">
              Set status
            </button>
            <span aria-hidden className="text-ink-faint">
              ·
            </span>
            {assignees && assignees.length > 0 ? (
              <select
                name="assigneeId"
                defaultValue=""
                aria-label="Assignee"
                className="ot-input w-auto py-1 text-xs"
              >
                <option value="">Unassigned</option>
                {assignees.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name="assigneeId"
                aria-label="Assignee id"
                placeholder="Assignee id (blank to unassign)"
                className="ot-input w-56 py-1 text-xs"
              />
            )}
            <button type="submit" name="op" value="assign" className="ot-btn px-3 py-1 text-xs">
              Assign
            </button>
          </div>
          {table}
        </form>
      ) : (
        <div className="card-surface overflow-hidden rounded-xl2">{table}</div>
      )}
    </section>
  );
}
