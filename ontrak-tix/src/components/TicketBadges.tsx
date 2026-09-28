/**
 * Ticket badges (M0): the at-a-glance state of a ticket.
 *
 * Presentational only — no data access, no rules — so the same components can
 * render in the agent inbox, the requester portal and later in reports. Styles
 * follow the Innotel Labs design tokens (`text-ink`, `--teal`, …) so the shell
 * drops into the shared component language.
 */

import type { ReactNode } from "react";

import type { MessageKind, TicketPriority, TicketStatus, TicketType } from "../lib/ticket-rules";

const STATUS_LABELS: Record<TicketStatus, string> = {
  NEW: "New",
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

const STATUS_TONES: Record<TicketStatus, string> = {
  NEW: "bg-sky/15 text-sky",
  OPEN: "bg-brand/15 text-brand",
  PENDING: "bg-amber/15 text-amber",
  RESOLVED: "bg-teal/15 text-teal",
  CLOSED: "bg-surface-muted text-ink-faint",
};

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

const PRIORITY_TONES: Record<TicketPriority, string> = {
  LOW: "bg-surface-muted text-ink-faint",
  NORMAL: "bg-surface-muted text-ink-soft",
  HIGH: "bg-amber/15 text-amber",
  URGENT: "bg-pink/15 text-pink",
};

const KIND_LABELS: Record<MessageKind, string> = {
  PUBLIC_REPLY: "Reply",
  INTERNAL_NOTE: "Internal note",
  SYSTEM: "System",
};

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>
  );
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Pill>;
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Pill tone={PRIORITY_TONES[priority]}>{PRIORITY_LABELS[priority]}</Pill>;
}

export function TicketTypeBadge({ type }: { type: TicketType }) {
  return <Pill tone="bg-surface-muted text-ink-soft">{type === "INCIDENT" ? "Incident" : "Request"}</Pill>;
}

export function MessageKindBadge({ kind }: { kind: MessageKind }) {
  const tone = kind === "INTERNAL_NOTE" ? "bg-amber/15 text-amber" : "bg-surface-muted text-ink-faint";
  return <Pill tone={tone}>{KIND_LABELS[kind]}</Pill>;
}

export const TICKET_STATUS_LABELS = STATUS_LABELS;
export const TICKET_PRIORITY_LABELS = PRIORITY_LABELS;
