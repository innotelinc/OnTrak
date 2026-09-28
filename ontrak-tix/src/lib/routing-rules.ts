/**
 * Queue routing rules (M1): which worklist a ticket lands in.
 *
 * A desk's routing is configuration, so it is modelled as data and evaluated by
 * a pure function — no hard-coded `if` chains buried in an action. Queues are
 * ordered; the first one that accepts a ticket wins, and a queue with no
 * criteria is a catch-all. Every ticket must end up in *some* queue, so the
 * result carries an explicit reason even when it fell through to the default.
 */

import type { TicketPriority, TicketType } from "./ticket-rules";

/** The minimum a ticket must expose for a routing decision. */
export interface RoutableTicket {
  type: TicketType;
  priority: TicketPriority;
  subject: string;
  description: string;
}

export interface QueueDefinition {
  id: string;
  slug: string;
  name: string;
  /** Lower numbers are evaluated first. Ties keep declaration order. */
  order?: number;
  /** Empty or omitted means "any". */
  types?: readonly TicketType[];
  priorities?: readonly TicketPriority[];
  /** Case-insensitive substrings matched against the subject + description. */
  keywords?: readonly string[];
}

export interface RoutingDecision {
  queue: QueueDefinition | null;
  reason: string;
}

function listMatches<T>(wanted: readonly T[] | undefined, value: T): boolean {
  return wanted === undefined || wanted.length === 0 || wanted.includes(value);
}

function hasKeyword(ticket: RoutableTicket, keywords: readonly string[] | undefined): boolean {
  if (keywords === undefined || keywords.length === 0) return true;
  const haystack = `${ticket.subject} ${ticket.description}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.trim().toLowerCase()));
}

/** Whether a single queue accepts a ticket. */
export function queueAccepts(queue: QueueDefinition, ticket: RoutableTicket): boolean {
  return (
    listMatches(queue.types, ticket.type) &&
    listMatches(queue.priorities, ticket.priority) &&
    hasKeyword(ticket, queue.keywords)
  );
}

/** Queues in evaluation order: explicit `order` first, then declaration order. */
export function orderQueues(queues: readonly QueueDefinition[]): QueueDefinition[] {
  return queues
    .map((queue, index) => ({ queue, index }))
    .sort((a, b) => (a.queue.order ?? Number.MAX_SAFE_INTEGER) - (b.queue.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ queue }) => queue);
}

/**
 * Route a ticket to exactly one queue. The first queue that accepts it wins;
 * otherwise the first catch-all (one with no criteria) is used. Returns `null`
 * only when there is genuinely nowhere to put the ticket.
 */
export function routeTicket(ticket: RoutableTicket, queues: readonly QueueDefinition[]): RoutingDecision {
  const ordered = orderQueues(queues);

  // A queue that states no criteria is a catch-all, not a rule: skip those in
  // the first pass so a real match always wins, then fall through deliberately.
  for (const queue of ordered) {
    if (hasCriteria(queue) && queueAccepts(queue, ticket)) {
      return { queue, reason: `Matched the ${queue.name} queue.` };
    }
  }

  const fallback = ordered.find((queue) => !hasCriteria(queue));
  if (fallback) return { queue: fallback, reason: `No rule matched; fell through to ${fallback.name}.` };

  return { queue: null, reason: "No queue accepts this ticket and there is no catch-all queue." };
}

function hasCriteria(queue: QueueDefinition): boolean {
  return Boolean(queue.types?.length || queue.priorities?.length || queue.keywords?.length);
}
