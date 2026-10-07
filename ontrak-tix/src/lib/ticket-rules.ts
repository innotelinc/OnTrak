/**
 * Ticket rules (M0): the value types, the status machine, input validation and
 * the append-only conversation rule. Pure, so the lifecycle is unit-testable
 * without a database.
 */

export type TicketStatus = "NEW" | "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TicketType = "INCIDENT" | "REQUEST";
export type MessageKind = "PUBLIC_REPLY" | "INTERNAL_NOTE" | "SYSTEM";

export const TICKET_STATUSES: readonly TicketStatus[] = ["NEW", "OPEN", "PENDING", "RESOLVED", "CLOSED"];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const TICKET_TYPES: readonly TicketType[] = ["INCIDENT", "REQUEST"];
export const MESSAGE_KINDS: readonly MessageKind[] = ["PUBLIC_REPLY", "INTERNAL_NOTE", "SYSTEM"];

/**
 * Allowed status moves. The desk deliberately cannot jump from `NEW` straight
 * to `RESOLVED` without passing through work, and a resolved ticket may be
 * reopened. `CLOSED` is the only end state, and even it can be reopened.
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  NEW: ["OPEN", "PENDING"],
  OPEN: ["PENDING", "RESOLVED", "CLOSED"],
  PENDING: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "OPEN"],
  CLOSED: ["OPEN"],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: TicketStatus): boolean {
  return status === "CLOSED";
}

/** A ticket that is still someone's responsibility. */
export function isOpen(status: TicketStatus): boolean {
  return status === "NEW" || status === "OPEN" || status === "PENDING";
}

export type TransitionResult =
  | { ok: true; status: TicketStatus }
  | { ok: false; reason: string };

/** Apply a status change, refusing an illegal move with a readable reason. */
export function transition(from: TicketStatus, to: TicketStatus): TransitionResult {
  if (from === to) return { ok: false, reason: `This ticket is already ${to.toLowerCase()}.` };
  if (!canTransition(from, to)) {
    return { ok: false, reason: `A ${from.toLowerCase()} ticket cannot move straight to ${to.toLowerCase()}.` };
  }
  return { ok: true, status: to };
}

/* -------------------------------------------------------------------------- */
/*  Priority                                                                  */
/* -------------------------------------------------------------------------- */

const PRIORITY_RANK: Record<TicketPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

export function priorityRank(priority: TicketPriority): number {
  return PRIORITY_RANK[priority];
}

/** The more urgent of two priorities (used when merging duplicates). */
export function highestPriority(a: TicketPriority, b: TicketPriority): TicketPriority {
  return priorityRank(a) >= priorityRank(b) ? a : b;
}

/* -------------------------------------------------------------------------- */
/*  Input validation                                                          */
/* -------------------------------------------------------------------------- */

export const SUBJECT_MAX = 200;
export const DESCRIPTION_MAX = 20_000;

export interface TicketInput {
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  requesterId: string;
}

export interface TicketIssue {
  field: string;
  message: string;
}

/** Validate a ticket before it is written. Returns every problem, not the first. */
export function validateTicketInput(input: Partial<TicketInput>): TicketIssue[] {
  const issues: TicketIssue[] = [];

  const subject = input.subject?.trim() ?? "";
  if (!subject) issues.push({ field: "subject", message: "A subject is required." });
  else if (subject.length > SUBJECT_MAX) {
    issues.push({ field: "subject", message: `The subject may be at most ${SUBJECT_MAX} characters.` });
  }

  const description = input.description?.trim() ?? "";
  if (!description) issues.push({ field: "description", message: "A description is required." });
  else if (description.length > DESCRIPTION_MAX) {
    issues.push({ field: "description", message: `The description may be at most ${DESCRIPTION_MAX} characters.` });
  }

  if (!input.requesterId) issues.push({ field: "requesterId", message: "A requester is required." });

  if (input.type && !TICKET_TYPES.includes(input.type)) {
    issues.push({ field: "type", message: `Unknown ticket type "${input.type}".` });
  }
  if (input.priority && !TICKET_PRIORITIES.includes(input.priority)) {
    issues.push({ field: "priority", message: `Unknown priority "${input.priority}".` });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  The append-only conversation                                              */
/* -------------------------------------------------------------------------- */

export interface MessageLike {
  id: string;
  kind: MessageKind;
  createdAt: number;
}

export type MessageMutation = { ok: false; reason: string };

/**
 * The conversation is the record of what was actually said, so messages are
 * append-only: an edit or a delete is never allowed, even for an administrator.
 * Corrections are new messages. This is the same "no silent edits" rule the
 * Assurance model depends on.
 */
export function canMutateMessage(_message: MessageLike): MessageMutation {
  return { ok: false, reason: "Conversation messages are append-only and can never be edited or deleted." };
}

/* -------------------------------------------------------------------------- */
/*  References                                                                */
/* -------------------------------------------------------------------------- */

/** A human-facing ticket reference, e.g. `TIX-000123`. */
export function ticketRef(seq: number, prefix = "TIX"): string {
  return `${prefix}-${String(Math.max(1, Math.trunc(seq))).padStart(6, "0")}`;
}

/**
 * The sequence inside a reference we issued, or `0` when it is not one we
 * recognise.
 *
 * The inverse of `ticketRef`, and the reader that lets the store keep its
 * high-water mark *after a delete*: a row count would hand a deleted ticket's
 * number to the next one and collide with `@@unique([tenantId, ref])`, so the
 * next reference is derived from the highest number already spent. A reference
 * from another prefix, or a malformed one, contributes nothing rather than
 * poisoning the count.
 */
export function refSequence(ref: string | null | undefined, prefix = "TIX"): number {
  // The prefix is a literal we choose, never user input, but it still goes
  // through a regex: escape it so a future caller passing one with a `-` or `.`
  // does not silently match more than it should.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}-(\\d+)$`).exec((ref ?? "").trim());
  return match ? Number(match[1]) : 0;
}
