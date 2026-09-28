/**
 * Inbox view model (M0): everything the agent inbox screen needs, derived once
 * from the raw worklist so the component stays a renderer.
 *
 * The ordering/filtering rules themselves live in `inbox-rules.ts`; this layer
 * only assembles the screen's data and parses the URL that drives it, which
 * keeps both halves unit-testable without React.
 */

import {
  inboxCounts,
  matchesFilter,
  sortForInbox,
  triageQueue,
  type InboxCounts,
  type InboxFilter,
  type InboxSlaFlags,
  type InboxSlaFilter,
} from "./inbox-rules";
import { TICKET_STATUSES, type TicketStatus } from "./ticket-rules";
import type { TicketRecord } from "./ticket-service";

export interface InboxView {
  filter: InboxFilter;
  /** The filtered, ordered worklist the agent sees. */
  tickets: TicketRecord[];
  /** Counts over the whole tenant, not just the visible filter. */
  counts: InboxCounts;
  /** Open, unassigned work — the queue a dispatcher triages from. */
  triage: TicketRecord[];
}

export function buildInboxView(
  all: readonly TicketRecord[],
  filter: InboxFilter = {},
  sla?: ReadonlyMap<string, InboxSlaFlags>,
): InboxView {
  return {
    filter,
    tickets: sortForInbox(all.filter((ticket) => matchesFilter(ticket, filter, sla?.get(ticket.id)))),
    counts: inboxCounts(all, sla),
    triage: triageQueue(all),
  };
}

export type InboxSearchParams = Readonly<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read the inbox filter from a URL. Unknown values are ignored rather than
 * rejected, so a hand-edited link degrades to the default view instead of
 * erroring — the same forgiving posture the training app's search params take.
 */
export function parseInboxFilter(params: InboxSearchParams = {}): InboxFilter {
  const status = first(params.status);
  const assignee = first(params.assignee);
  const queue = first(params.queue);
  const search = first(params.search)?.trim();
  const sla = first(params.sla);

  const filter: InboxFilter = {};
  if (status === "all") filter.status = "all";
  else if (status && (TICKET_STATUSES as readonly string[]).includes(status)) filter.status = status as TicketStatus;

  if (assignee === "unassigned") filter.assigneeId = "unassigned";
  else if (assignee) filter.assigneeId = assignee;

  if (queue) filter.queueId = queue;
  if (search) filter.search = search;
  if (sla === "at-risk" || sla === "breached") filter.sla = sla as InboxSlaFilter;

  return filter;
}

/**
 * A filter as a query string (no leading `?`), omitting the default `open`
 * status so a plain view stays a clean URL. Shared by the inbox links and the
 * saved-view chips, so a saved view and a hand-built link never diverge.
 */
export function inboxFilterQuery(filter: InboxFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status && filter.status !== "open") params.set("status", filter.status);
  if (filter.assigneeId) params.set("assignee", filter.assigneeId);
  if (filter.queueId) params.set("queue", filter.queueId);
  if (filter.search) params.set("search", filter.search);
  if (filter.sla) params.set("sla", filter.sla);
  return params.toString();
}

/** The ticket the detail pane should show: the requested one if it is visible. */
export function selectedTicket(view: InboxView, ticketId: string | null | undefined): TicketRecord | null {
  if (!ticketId) return null;
  return view.tickets.find((ticket) => ticket.id === ticketId) ?? null;
}
