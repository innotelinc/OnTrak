/**
 * Ticket service (M0): persistence and audit emission for the ticket lifecycle.
 *
 * The shape is deliberately two-layered:
 *
 *  - `plan*` functions are pure: given an actor, the current ticket and an id
 *    source, they decide and return the next value plus the audit event. They
 *    are where every access and validation rule is enforced, and they are
 *    trivial to test.
 *  - `TicketService` wires those plans to a `TicketStore` port and an
 *    `AuditLog`, so the app layer only has to implement the store against
 *    Prisma. No business rule lives in the wiring.
 */

import { randomUUID } from "node:crypto";

import { canAssignTicket, canReplyToTicket, canUpdateTicket, hasPermission, type Actor } from "./access-rules";
import {
  ticketRef,
  transition,
  validateTicketInput,
  type MessageKind,
  type TicketInput,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "./ticket-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import type { SlaPause } from "./sla-rules";

export interface TicketMessage {
  id: string;
  kind: MessageKind;
  body: string;
  authorId: string | null;
  createdAt: string;
}

export interface TicketRecord {
  id: string;
  tenantId: string;
  ref: string;
  subject: string;
  description: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  queueId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The first public *agent* reply — the input to the SLA response clock. */
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Windows during which the SLA clock did not run (see `sla-rules`). */
  pauses: SlaPause[];
  messages: TicketMessage[];
}

/**
 * The pause that a status implies. Moving into `PENDING` means the desk is
 * waiting on the requester, so the SLA clock stops; leaving it starts again.
 * This is the one place the ticket lifecycle and the SLA engine meet.
 */
export function applyPauseForStatus(pauses: readonly SlaPause[], from: TicketStatus, to: TicketStatus, at: string): SlaPause[] {
  if (to === from) return [...pauses];
  if (to === "PENDING") return [...pauses, { startedAt: at, endedAt: null }];
  if (from !== "PENDING") return [...pauses];

  const next = [...pauses];
  const open = next.findIndex((pause) => pause.endedAt === null);
  if (open >= 0) next[open] = { ...next[open], endedAt: at };
  return next;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Injected so plans are deterministic under test. */
export interface IdSource {
  ticketId(): string;
  messageId(): string;
  now(): string;
}

export function systemIds(): IdSource {
  return { ticketId: () => randomUUID(), messageId: () => randomUUID(), now: () => new Date().toISOString() };
}

/* -------------------------------------------------------------------------- */
/*  Pure plans                                                                */
/* -------------------------------------------------------------------------- */

function audit(actor: Actor, action: string, ticket: Pick<TicketRecord, "id" | "tenantId">, at: string, detail?: Record<string, unknown>): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: ticket.tenantId,
    at,
    actor: actor.id,
    action,
    targetType: "ticket",
    targetId: ticket.id,
    detail,
  };
}

/**
 * Create a ticket. A requester always creates it for themselves; staff may
 * raise one on behalf of a requester by supplying `requesterId`.
 */
export function planTicketCreation(
  actor: Actor,
  input: Omit<TicketInput, "requesterId"> & { requesterId?: string; queueId?: string | null },
  nextSeq: number,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; audit: AuditEventInput }> {
  if (!hasPermission(actor.role, "ticket:create")) {
    return { ok: false, error: "You cannot create tickets." };
  }

  const requesterId = actor.role === "REQUESTER" ? actor.id : (input.requesterId ?? actor.id);
  const issues = validateTicketInput({ ...input, requesterId });
  if (issues.length > 0) return { ok: false, error: issues[0].message };

  const at = ids.now();
  const ticket: TicketRecord = {
    id: ids.ticketId(),
    tenantId: actor.tenantId,
    ref: ticketRef(nextSeq),
    subject: input.subject.trim(),
    description: input.description.trim(),
    type: input.type,
    status: "NEW",
    priority: input.priority,
    requesterId,
    assigneeId: null,
    queueId: input.queueId ?? null,
    createdAt: at,
    updatedAt: at,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    pauses: [],
    messages: [],
  };
  return {
    ok: true,
    value: { ticket, audit: audit(actor, "ticket.create", ticket, at, { ref: ticket.ref, queueId: ticket.queueId }) },
  };
}

/**
 * Append a message to a ticket's immutable thread. The ticket is returned with
 * the message and a bumped `updatedAt`; the original is never mutated.
 */
export function planReply(
  actor: Actor,
  ticket: TicketRecord,
  body: string,
  kind: MessageKind,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; message: TicketMessage; audit: AuditEventInput }> {
  if (!canReplyToTicket(actor, ticket)) {
    return { ok: false, error: "You cannot reply on this ticket." };
  }
  // An internal note is staff-only work product; a requester may never write one.
  if (kind === "INTERNAL_NOTE" && !hasPermission(actor.role, "ticket:update")) {
    return { ok: false, error: "You cannot add internal notes." };
  }
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "A reply cannot be empty." };

  const at = ids.now();
  const message: TicketMessage = {
    id: ids.messageId(),
    kind,
    body: trimmed,
    authorId: actor.id,
    createdAt: at,
  };
  // The response clock starts when an *agent* first answers in public. A
  // requester's own reply or an internal note never stops the clock.
  const isFirstAgentResponse =
    kind === "PUBLIC_REPLY" && ticket.firstResponseAt === null && hasPermission(actor.role, "ticket:update");
  const next: TicketRecord = {
    ...ticket,
    updatedAt: at,
    firstResponseAt: isFirstAgentResponse ? at : ticket.firstResponseAt,
    messages: [...ticket.messages, message],
  };
  return {
    ok: true,
    value: {
      ticket: next,
      message,
      audit: audit(actor, "ticket.reply", ticket, at, {
        messageId: message.id,
        kind,
        ...(isFirstAgentResponse ? { firstResponseAt: at } : {}),
      }),
    },
  };
}

/** Change a ticket's status along a legal edge of the lifecycle. */
export function planStatusChange(
  actor: Actor,
  ticket: TicketRecord,
  to: TicketStatus,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; audit: AuditEventInput }> {
  if (!canUpdateTicket(actor, ticket)) {
    return { ok: false, error: "You cannot update this ticket." };
  }
  const moved = transition(ticket.status, to);
  if (!moved.ok) return { ok: false, error: moved.reason };

  const at = ids.now();
  const pauses = applyPauseForStatus(ticket.pauses, ticket.status, moved.status, at);
  const next: TicketRecord = {
    ...ticket,
    status: moved.status,
    updatedAt: at,
    resolvedAt: moved.status === "RESOLVED" ? at : null,
    closedAt: moved.status === "CLOSED" ? at : null,
    pauses,
  };
  return {
    ok: true,
    value: {
      ticket: next,
      audit: audit(actor, "ticket.status", ticket, at, {
        from: ticket.status,
        to: moved.status,
        // Record which way the SLA clock moved with the status, so a pause is
        // visible in the tamper-evident history without cross-referencing.
        ...(moved.status === "PENDING" ? { slaPaused: true } : ticket.status === "PENDING" ? { slaResumed: true } : {}),
      }),
    },
  };
}

/** Assign or reassign a ticket. Only staff who may assign, in their own tenant. */
export function planAssignment(
  actor: Actor,
  ticket: TicketRecord,
  assigneeId: string | null,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; audit: AuditEventInput }> {
  if (!canAssignTicket(actor, ticket)) {
    return { ok: false, error: "You cannot assign this ticket." };
  }
  const at = ids.now();
  const next: TicketRecord = { ...ticket, assigneeId, updatedAt: at };
  return { ok: true, value: { ticket: next, audit: audit(actor, "ticket.assign", ticket, at, { assigneeId }) } };
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The persistence port the app implements against Prisma. Keeping it this small
 * is the point: the store never decides anything, it only reads and writes.
 */
export interface TicketStore {
  nextTicketSeq(tenantId: string): Promise<number>;
  /** Every ticket in a tenant — the agent inbox needs the whole worklist. */
  listTickets(tenantId: string): Promise<TicketRecord[]>;
  findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null>;
  insertTicket(ticket: TicketRecord): Promise<void>;
  updateTicket(ticket: TicketRecord): Promise<void>;
}

export class TicketService {
  constructor(
    private readonly store: TicketStore,
    private readonly audit: AuditSink,
    private readonly ids: IdSource = systemIds(),
  ) {}

  async createTicket(
    actor: Actor,
    input: Omit<TicketInput, "requesterId"> & { requesterId?: string; queueId?: string | null },
  ): Promise<ServiceResult<TicketRecord>> {
    const plan = planTicketCreation(actor, input, await this.store.nextTicketSeq(actor.tenantId), this.ids);
    if (!plan.ok) return plan;
    await this.store.insertTicket(plan.value.ticket);
    await this.audit.append(plan.value.audit);
    return { ok: true, value: plan.value.ticket };
  }

  async reply(actor: Actor, ticketId: string, body: string, kind: MessageKind = "PUBLIC_REPLY"): Promise<ServiceResult<TicketMessage>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planReply(actor, ticket, body, kind, this.ids);
    if (!plan.ok) return plan;
    await this.store.updateTicket(plan.value.ticket);
    await this.audit.append(plan.value.audit);
    return { ok: true, value: plan.value.message };
  }

  async setStatus(actor: Actor, ticketId: string, to: TicketStatus): Promise<ServiceResult<TicketRecord>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planStatusChange(actor, ticket, to, this.ids);
    if (!plan.ok) return plan;
    await this.store.updateTicket(plan.value.ticket);
    await this.audit.append(plan.value.audit);
    return { ok: true, value: plan.value.ticket };
  }

  async assign(actor: Actor, ticketId: string, assigneeId: string | null): Promise<ServiceResult<TicketRecord>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planAssignment(actor, ticket, assigneeId, this.ids);
    if (!plan.ok) return plan;
    await this.store.updateTicket(plan.value.ticket);
    await this.audit.append(plan.value.audit);
    return { ok: true, value: plan.value.ticket };
  }

  private async load(tenantId: string, ticketId: string): Promise<TicketRecord | null> {
    return this.store.findTicket(tenantId, ticketId);
  }
}

/**
 * An in-memory store, used by the tests and by local development before a
 * database exists. It stores clones, so callers cannot alias what they read.
 */
export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly seq = new Map<string, number>();

  async nextTicketSeq(tenantId: string): Promise<number> {
    const next = (this.seq.get(tenantId) ?? 0) + 1;
    this.seq.set(tenantId, next);
    return next;
  }

  async listTickets(tenantId: string): Promise<TicketRecord[]> {
    return [...this.tickets.entries()]
      .filter(([key]) => key.startsWith(`${tenantId}:`))
      .map(([, ticket]) => structuredClone(ticket));
  }

  async findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null> {
    const ticket = this.tickets.get(`${tenantId}:${ticketId}`);
    return ticket ? structuredClone(ticket) : null;
  }

  async insertTicket(ticket: TicketRecord): Promise<void> {
    this.tickets.set(`${ticket.tenantId}:${ticket.id}`, structuredClone(ticket));
  }

  async updateTicket(ticket: TicketRecord): Promise<void> {
    this.tickets.set(`${ticket.tenantId}:${ticket.id}`, structuredClone(ticket));
  }
}
