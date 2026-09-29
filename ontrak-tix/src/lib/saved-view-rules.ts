/**
 * Saved view rules (M0/M1): named inbox filters an agent can click back to.
 *
 * A saved view is just an `InboxFilter` with a name, so this module owns the two
 * things that must be strict: sanitizing whatever the filter came back as (a
 * hidden form field, a database row) into a value the inbox can trust, and
 * describing a filter in words so a chip is readable without opening it. Pure
 * and tested, like the filter rules it wraps.
 */

import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "./ticket-rules";
import type { InboxFilter, InboxSlaFilter } from "./inbox-rules";

export interface SavedView {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  filter: InboxFilter;
  /** Shared views are visible to the whole desk; private ones only to their owner. */
  shared: boolean;
  createdAt: string;
}

export const SAVED_VIEW_NAME_MAX = 60;
const SEARCH_MAX = 120;

/**
 * Coerce arbitrary (parsed-JSON, form, database) input into a filter the inbox
 * can trust. Unknown keys and unknown enum values are dropped rather than
 * rejected, so a stale saved view degrades to the closest valid filter instead
 * of erroring on load — the same forgiving posture the URL parser takes.
 */
export function sanitizeInboxFilter(raw: unknown): InboxFilter {
  const filter: InboxFilter = {};
  if (!raw || typeof raw !== "object") return filter;
  const value = raw as Record<string, unknown>;

  const status = value.status;
  if (status === "all" || status === "open") filter.status = status;
  else if (typeof status === "string" && (TICKET_STATUSES as readonly string[]).includes(status)) {
    filter.status = status as TicketStatus;
  }

  if (typeof value.assigneeId === "string" && value.assigneeId.trim()) filter.assigneeId = value.assigneeId.trim();
  if (typeof value.queueId === "string" && value.queueId.trim()) filter.queueId = value.queueId.trim();
  if (typeof value.priority === "string" && (TICKET_PRIORITIES as readonly string[]).includes(value.priority)) {
    filter.priority = value.priority as TicketPriority;
  }
  if (typeof value.search === "string" && value.search.trim()) filter.search = value.search.trim().slice(0, SEARCH_MAX);
  if (value.sla === "at-risk" || value.sla === "breached") filter.sla = value.sla as InboxSlaFilter;

  return filter;
}

/** Parse the JSON a saved-view form carries, tolerating junk. */
export function parseFilterJson(raw: unknown): InboxFilter {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return sanitizeInboxFilter(JSON.parse(raw));
  } catch {
    return {};
  }
}

export interface SavedViewIssue {
  field: string;
  message: string;
}

/** Validate a view before it is stored. Returns every problem, not the first. */
export function validateSavedView(input: { name?: string }): SavedViewIssue[] {
  const issues: SavedViewIssue[] = [];
  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A name is required." });
  else if (name.length > SAVED_VIEW_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${SAVED_VIEW_NAME_MAX} characters.` });
  }
  return issues;
}

const PRIORITY_LABELS: Record<string, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

const STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  all: "All",
  open: "Open",
};

/** A short human label for a filter, e.g. `Open · Unassigned · SLA breached`. */
export function describeInboxFilter(filter: InboxFilter = {}): string {
  const parts: string[] = [];

  const status = filter.status ?? "open";
  parts.push(STATUS_LABELS[status] ?? String(status));

  if (filter.assigneeId === "unassigned") parts.push("Unassigned");
  else if (filter.assigneeId) parts.push(`Assigned: ${filter.assigneeId}`);

  if (filter.queueId) parts.push(`Queue: ${filter.queueId}`);
  if (filter.priority) parts.push(`Priority: ${PRIORITY_LABELS[filter.priority] ?? filter.priority}`);
  if (filter.sla === "at-risk") parts.push("SLA at risk");
  if (filter.sla === "breached") parts.push("SLA breached");
  if (filter.search) parts.push(`“${filter.search}”`);

  return parts.join(" · ");
}

/** Whether two filters are the same view (used to highlight the active chip). */
export function sameFilter(a: InboxFilter = {}, b: InboxFilter = {}): boolean {
  const keys: (keyof InboxFilter)[] = ["status", "assigneeId", "queueId", "priority", "search", "sla"];
  return keys.every((key) => (a[key] ?? undefined) === (b[key] ?? undefined));
}
