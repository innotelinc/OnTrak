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

import { canAssignTicket, canReplyToTicket, canUpdateTicket, actorHasPermission, type Actor } from "./access-rules";
import {
  TICKET_PRIORITIES,
  TICKET_TYPES,
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
import type { RuleTrigger } from "./rule-rules";
import type { RuleApplication, RuleIntake } from "./rule-intake";
import type { MacroIntake } from "./macro-intake";
import type { SlaPause } from "./sla-rules";
import type { CustomValues } from "./form-rules";

/**
 * What the ticket path needs of the M6 forms: the values this queue's form accepts.
 *
 * A port rather than the service itself, so the ticket lifecycle depends on the question
 * and not on how the desk stores fields — and so a test can answer it with one line.
 */
export interface TicketFormGate {
  validateTicketValues(tenantId: string, queueId: string | null, values: unknown): Promise<ServiceResult<CustomValues>>;
}

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
  /**
   * The client the work is for (M4). Optional so the records written before
   * clients existed remain valid — and because a ticket with no client is a
   * legitimate thing: the desk's own work.
   */
  clientId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** The first public *agent* reply — the input to the SLA response clock. */
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Windows during which the SLA clock did not run (see `sla-rules`). */
  pauses: SlaPause[];
  /**
   * Tags applied by hand or by a rule's `add_tag` action (M5). A scoring axis
   * rather than a classification, so a ticket may carry several or none;
   * optional so records written before rules existed stay valid.
   */
  tags?: readonly string[];
  /**
   * The desk's own fields (M6), keyed by `CustomField.key`. Values are strings whatever
   * the field's type, so a ticket reads back the same in the console, the API and a CSV
   * export; optional so records written before a desk defined any stay valid.
   */
  customFields?: CustomValues;
  messages: TicketMessage[];
}

/**
 * What it takes to raise a ticket. A requester supplies only the first four
 * fields; staff raising work on somebody's behalf may also name the requester,
 * the queue it lands in and the client it is for.
 */
export type TicketCreationInput = Omit<TicketInput, "requesterId"> & {
  requesterId?: string;
  queueId?: string | null;
  /**
   * The client the work is for (M4). Optional because the desk's own work —
   * a printer in the server room — belongs to no client, and because the caller
   * has to check the client is in the actor's scope before passing it.
   */
  clientId?: string | null;
  /**
   * The desk's own fields (M6). Validated against the form the queue actually shows before
   * the ticket is planned, so the same answer holds whether it arrived from the portal, the
   * console or the API.
   */
  customFields?: CustomValues;
};

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
  input: TicketCreationInput,
  nextSeq: number,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; audit: AuditEventInput }> {
  if (!actorHasPermission(actor, "ticket:create")) {
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
    // Omitted rather than set to `null` when there is no client, so a record
    // written for the desk's own work is shaped like the ones written before
    // clients existed.
    ...(input.clientId ? { clientId: input.clientId } : {}),
    createdAt: at,
    updatedAt: at,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    pauses: [],
    // Omitted rather than set to an empty object, so a ticket raised on a desk with no
    // custom fields is shaped exactly like the records written before it had them.
    ...(input.customFields && Object.keys(input.customFields).length > 0 ? { customFields: { ...input.customFields } } : {}),
    messages: [],
  };
  return {
    ok: true,
    value: {
      ticket,
      audit: audit(actor, "ticket.create", ticket, at, {
        ref: ticket.ref,
        queueId: ticket.queueId,
        ...(ticket.customFields ? { customFields: Object.keys(ticket.customFields) } : {}),
      }),
    },
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
  if (kind === "INTERNAL_NOTE" && !actorHasPermission(actor, "ticket:update")) {
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
    kind === "PUBLIC_REPLY" && ticket.firstResponseAt === null && actorHasPermission(actor, "ticket:update");
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

/**
 * The sighting a reclassification is: the type and priority the desk settled on,
 * and the queue the work now belongs to.
 *
 * All three travel together because they are one *answer* — a ticket is a report of
 * something broken, and it is urgent, and it is the Network queue. The queue is
 * checked by the caller that knows the desk's queues (the assist service holds them
 * already); this plan validates the two closed sets because those it can know on its
 * own.
 */
export interface TicketReclassification {
  type: TicketType;
  priority: TicketPriority;
  queueId: string | null;
}

/**
 * Change what a ticket *is*: its type, its priority and the queue it belongs to.
 *
 * A reclassification is a staff write like any other — it needs `ticket:update` on
 * the ticket and moves `updatedAt` — and it is on the chain as `ticket.reclassify`,
 * carrying the old and new value of each field it touched so the change is readable
 * without replaying the row. Only the closed-set fields it understands are accepted:
 * an unknown type or priority is refused rather than written, because a ticket whose
 * type is not one of the two the product knows is a ticket every later reader has to
 * special-case.
 */
export function planReclassification(
  actor: Actor,
  ticket: TicketRecord,
  change: TicketReclassification,
  ids: IdSource,
): ServiceResult<{ ticket: TicketRecord; audit: AuditEventInput }> {
  if (!canUpdateTicket(actor, ticket)) {
    return { ok: false, error: "You cannot update this ticket." };
  }
  if (!TICKET_TYPES.includes(change.type)) {
    return { ok: false, error: `Unknown ticket type "${change.type}".` };
  }
  if (!TICKET_PRIORITIES.includes(change.priority)) {
    return { ok: false, error: `Unknown priority "${change.priority}".` };
  }

  const at = ids.now();
  const next: TicketRecord = {
    ...ticket,
    type: change.type,
    priority: change.priority,
    queueId: change.queueId,
    updatedAt: at,
  };
  return {
    ok: true,
    value: {
      ticket: next,
      audit: audit(actor, "ticket.reclassify", ticket, at, {
        type: { from: ticket.type, to: change.type },
        priority: { from: ticket.priority, to: change.priority },
        ...(ticket.queueId !== change.queueId ? { queueId: { from: ticket.queueId, to: change.queueId } } : {}),
      }),
    },
  };
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
    /**
     * The M5 rules engine, when the deployment has one. Absent in tests and in
     * stacks built before rules existed, in which case every path behaves
     * exactly as it did — the engine is an addition, not a rewrite.
     */
    private readonly rules: RuleIntake | null = null,
    /**
     * The M5 macro intake, when the deployment has one. Optional for the same
     * reason the rules engine is: a desk with no shortcuts behaves exactly as it
     * did before macros existed.
     */
    private readonly macros: MacroIntake | null = null,
    /**
     * The M6 custom fields, when the deployment has any. Optional for the same reason the
     * rules engine is: a desk with no custom fields behaves exactly as it did before they
     * existed, and every older stack keeps working untouched.
     */
    private readonly forms: TicketFormGate | null = null,
  ) {}

  /**
   * Raise a ticket, applying the desk's `ticket.created` rules to it.
   *
   * The rules run *before* the row is written, so the ticket is born with the
   * priority, queue, assignee and tags the desk asked for: one insert, and no
   * moment in which the inbox shows work the rules have not yet seen. The plan
   * is recorded on the chain, so "why did this arrive urgent?" has an answer
   * that outlives the rule that made it so.
   */
  async createTicket(actor: Actor, input: TicketCreationInput): Promise<ServiceResult<TicketRecord>> {
    // The desk's own fields are checked against the form the queue actually shows, before
    // anything is planned. A caller that passes none is asked for none *only* if the form
    // asks for none; a required field left blank is refused here, where every entry point
    // — portal, console and API — meets.
    let validated = input;
    if (this.forms) {
      const values = await this.forms.validateTicketValues(actor.tenantId, input.queueId ?? null, input.customFields ?? {});
      if (!values.ok) return values;
      validated = { ...input, customFields: values.value };
    }

    const plan = planTicketCreation(actor, validated, await this.store.nextTicketSeq(actor.tenantId), this.ids);
    if (!plan.ok) return plan;

    const applied = await this.runRules(plan.value.ticket, "ticket.created");
    const ticket = applied?.ticket ?? plan.value.ticket;

    await this.store.insertTicket(ticket);
    // The create event carries the queue the ticket actually landed in, so the
    // chain never claims it was filed somewhere the rules moved it out of — and it names
    // the desk's own fields the ticket answered, so "who filled this in, and when did the
    // form change?" is answerable from the chain without replaying the values themselves.
    await this.audit.append({
      ...plan.value.audit,
      detail: {
        ref: ticket.ref,
        queueId: ticket.queueId,
        ...(ticket.customFields ? { customFields: Object.keys(ticket.customFields) } : {}),
      },
    });
    await this.settle(applied);
    return { ok: true, value: ticket };
  }

  async reply(actor: Actor, ticketId: string, body: string, kind: MessageKind = "PUBLIC_REPLY"): Promise<ServiceResult<TicketMessage>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planReply(actor, ticket, body, kind, this.ids);
    if (!plan.ok) return plan;

    const applied = await this.runRules(plan.value.ticket, "ticket.replied");
    await this.store.updateTicket(applied?.ticket ?? plan.value.ticket);
    await this.audit.append(plan.value.audit);
    await this.settle(applied);
    return { ok: true, value: plan.value.message };
  }

  async setStatus(actor: Actor, ticketId: string, to: TicketStatus): Promise<ServiceResult<TicketRecord>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planStatusChange(actor, ticket, to, this.ids);
    if (!plan.ok) return plan;

    const applied = await this.runRules(plan.value.ticket, "ticket.updated");
    const next = applied?.ticket ?? plan.value.ticket;
    await this.store.updateTicket(next);
    await this.audit.append(plan.value.audit);
    await this.settle(applied);
    return { ok: true, value: next };
  }

  async assign(actor: Actor, ticketId: string, assigneeId: string | null): Promise<ServiceResult<TicketRecord>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planAssignment(actor, ticket, assigneeId, this.ids);
    if (!plan.ok) return plan;

    const applied = await this.runRules(plan.value.ticket, "ticket.updated");
    const next = applied?.ticket ?? plan.value.ticket;
    await this.store.updateTicket(next);
    await this.audit.append(plan.value.audit);
    await this.settle(applied);
    return { ok: true, value: next };
  }

  /**
   * Change a ticket's type, priority and queue (M7).
   *
   * The write an accepted classification becomes. It is deliberately a first-class
   * method here rather than something the assistant does for itself: the permission
   * check, the validation and the audit event are the ticket stack's, so applying a
   * suggestion cannot be broader than an agent editing the same three fields by hand.
   * The `ticket.updated` rules run, because this *is* the ticket being updated.
   */
  async reclassify(actor: Actor, ticketId: string, change: TicketReclassification): Promise<ServiceResult<TicketRecord>> {
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    const plan = planReclassification(actor, ticket, change, this.ids);
    if (!plan.ok) return plan;

    const applied = await this.runRules(plan.value.ticket, "ticket.updated");
    const next = applied?.ticket ?? plan.value.ticket;
    await this.store.updateTicket(next);
    await this.audit.append(plan.value.audit);
    await this.settle(applied);
    return { ok: true, value: next };
  }

  /**
   * Run a macro on a ticket (M5).
   *
   * Unlike a rule, this is not triggered: an agent chose the macro and the
   * ticket, so the check is `ticket:update` and the audit names the person
   * rather than the desk. The rules engine is deliberately **not** re-run here —
   * an explicit instruction from the agent should not be silently outvoted by
   * automation that fires on `ticket.updated`. The ticket's `updatedAt` still
   * moves, so the work reads as recently touched.
   */
  async applyMacro(actor: Actor, ticketId: string, macroId: string): Promise<ServiceResult<TicketRecord>> {
    if (!this.macros) return { ok: false, error: "The desk has no macros configured." };
    const ticket = await this.load(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };

    const applied = await this.macros.apply(actor, ticket, macroId, this.ids);
    if (!applied.ok) return applied;

    await this.store.updateTicket(applied.value.ticket);
    await this.audit.append(applied.value.audit);
    await this.macros.settle(applied.value);
    return { ok: true, value: applied.value.ticket };
  }

  private async runRules(ticket: TicketRecord, trigger: RuleTrigger): Promise<RuleApplication | null> {
    if (!this.rules) return null;
    return this.rules.apply(ticket, trigger, this.ids);
  }

  /** Record the firing on the chain, then deliver what it asked for. */
  private async settle(applied: RuleApplication | null): Promise<void> {
    if (!applied) return;
    await this.audit.append(applied.audit);
    await this.rules?.settle(applied);
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
