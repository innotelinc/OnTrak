/**
 * Agent inbox rules (M0): how the ticket list is filtered and ordered.
 *
 * A desk lives or dies by the ordering of its worklist, so this is pure and
 * tested rather than buried in a component. The default order is: still-open
 * work first, most urgent first, then oldest-touched first so nothing starves.
 */

import { isOpen, priorityRank, type TicketPriority, type TicketStatus } from "./ticket-rules";
import type { TicketRecord } from "./ticket-service";

export type InboxSlaFilter = "at-risk" | "breached";

export interface InboxFilter {
  /** `"open"` (the default) hides resolved and closed work; `"all"` shows everything. */
  status?: TicketStatus | "open" | "all";
  /** A specific assignee, or `"unassigned"` for the triage pile. */
  assigneeId?: string | "unassigned";
  queueId?: string;
  /** Case-insensitive match against the reference or subject. */
  search?: string;
  /** Restrict the worklist to tickets whose SLA needs attention. */
  sla?: InboxSlaFilter;
}

/** The SLA roll-up flags `matchesFilter` needs; supplied by the caller. */
export interface InboxSlaFlags {
  atRisk: boolean;
  breached: boolean;
}

function statusMatches(status: TicketStatus, filter: InboxFilter): boolean {
  const wanted = filter.status ?? "open";
  if (wanted === "all") return true;
  if (wanted === "open") return isOpen(status);
  return status === wanted;
}

export function matchesFilter(ticket: TicketRecord, filter: InboxFilter = {}, sla?: InboxSlaFlags | null): boolean {
  if (!statusMatches(ticket.status, filter)) return false;

  if (filter.assigneeId === "unassigned") {
    if (ticket.assigneeId !== null) return false;
  } else if (filter.assigneeId && ticket.assigneeId !== filter.assigneeId) {
    return false;
  }

  if (filter.queueId && ticket.queueId !== filter.queueId) return false;

  if (filter.search) {
    const needle = filter.search.trim().toLowerCase();
    if (needle) {
      const haystack = `${ticket.ref} ${ticket.subject}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
  }

  // A ticket with no policy has no SLA, so it can never appear in an SLA view —
  // silently including it would make the filter look like it had missed work.
  if (filter.sla === "at-risk" && !(sla?.atRisk ?? false)) return false;
  if (filter.sla === "breached" && !(sla?.breached ?? false)) return false;

  return true;
}

/**
 * Order a worklist. Open tickets come before resolved ones (a resolved ticket
 * still appearing above live work is the classic shared-inbox failure), then
 * by descending priority, then oldest update first.
 */
export function sortForInbox(tickets: readonly TicketRecord[]): TicketRecord[] {
  return [...tickets].sort((a, b) => {
    const openDelta = Number(isOpen(b.status)) - Number(isOpen(a.status));
    if (openDelta !== 0) return openDelta;

    const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;

    return a.updatedAt.localeCompare(b.updatedAt);
  });
}

export interface InboxCounts {
  open: number;
  unassigned: number;
  urgent: number;
  /** Open tickets whose SLA is warning or worse. */
  slaAtRisk: number;
  /** Open tickets whose SLA has already lapsed. */
  slaBreached: number;
  byStatus: Record<TicketStatus, number>;
}

/** The numbers an agent inbox header shows. */
export function inboxCounts(
  tickets: readonly TicketRecord[],
  sla?: ReadonlyMap<string, InboxSlaFlags>,
): InboxCounts {
  const byStatus: Record<TicketStatus, number> = { NEW: 0, OPEN: 0, PENDING: 0, RESOLVED: 0, CLOSED: 0 };
  let open = 0;
  let unassigned = 0;
  let urgent = 0;
  let slaAtRisk = 0;
  let slaBreached = 0;

  for (const ticket of tickets) {
    byStatus[ticket.status] += 1;
    if (isOpen(ticket.status)) {
      open += 1;
      if (ticket.assigneeId === null) unassigned += 1;
      if (isUrgent(ticket.priority)) urgent += 1;
      const flags = sla?.get(ticket.id);
      if (flags?.atRisk) slaAtRisk += 1;
      if (flags?.breached) slaBreached += 1;
    }
  }

  return { open, unassigned, urgent, slaAtRisk, slaBreached, byStatus };
}

function isUrgent(priority: TicketPriority): boolean {
  return priority === "URGENT";
}

/** The default inbox view: open, unassigned work first — the triage queue. */
export function triageQueue(tickets: readonly TicketRecord[]): TicketRecord[] {
  return sortForInbox(tickets.filter((ticket) => matchesFilter(ticket, { status: "open", assigneeId: "unassigned" })));
}
