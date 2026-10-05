/**
 * The assist service (M7): the one place a suggestion is asked for, the one place a
 * decision about it is written down, and the one place an accepted classification is
 * applied — through the ticket service's own write path.
 *
 * WHAT IT GUARANTEES
 * ------------------
 * `suggest` reads. `decide` records *that somebody took or left a suggestion* on the
 * audit chain and nothing else. `applyClassification` is the only method that changes
 * a ticket, and it changes exactly three fields — type, priority and queue — by
 * delegating to the ticket service's own `reclassify`, which runs the permission
 * check, the validation and the audit event the desk already trusts for every other
 * edit. `history` reads those decisions back, so what a desk turned down is evidence
 * rather than a forgotten click. There is still no method here that replies, reassigns
 * or resolves, so "never auto-send" remains a property of the shape of this class
 * rather than a rule somebody has to remember.
 *
 * WHY THE DECISION IS WORTH RECORDING
 * -----------------------------------
 * The milestone's exit criterion is that suggestions are *measurable and reversible*. A
 * decision appended to the per-tenant hash chain gives both: the accept rate is a query
 * over one tenant's history, and because the chain is append-only, a dismissal is never
 * quietly turned into an acceptance. The event names a kind and a source, so "the model
 * proposed it and the desk took it" and "the rules did, and the desk ignored it" are
 * different facts afterwards. Applying a classification records the same `assist.accept`
 * event, extended with what was applied, so the rate counts it and the change is readable
 * from the chain without cross-referencing `ticket.reclassify`.
 *
 * WHETHER THIS DESK HAS AN ASSISTANT IS A TENANT'S OWN ANSWER
 * -----------------------------------------------------------
 * Opt-in is per tenant (`enabledFor`), not a deployment-wide switch: one desk on a
 * shared deployment asking for suggestions must not put an assistant in front of
 * another's agents. The port is a question rather than a flag because the answer lives
 * with the tenant, and it is asked on every call rather than cached at construction, so
 * switching it off takes effect on the next request.
 *
 * Every dependency is injected, so the whole thing is exercised in tests without a
 * database, a model or a network.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, canUpdateTicket, type Actor } from "./access-rules";
import { TICKET_PRIORITIES, TICKET_TYPES, type TicketPriority, type TicketType } from "./ticket-rules";
import type { AuditChain, AuditRecord, AuditSink } from "./audit-chain";
import type { ServiceResult, TicketRecord, TicketReclassification } from "./ticket-service";
import type { AssistCandidate, AssistQueue, AssistRequest, AssistResult, AssistTicket } from "./assist-rules";

/** The four things a suggestion is made of. The verb on a decision event. */
export type AssistKind = "CLASSIFICATION" | "SUMMARY" | "DRAFT_REPLY" | "SIMILAR";

export const ASSIST_KINDS: readonly AssistKind[] = ["CLASSIFICATION", "SUMMARY", "DRAFT_REPLY", "SIMILAR"];

export interface AssistTicketSource {
  findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null>;
  listTickets(tenantId: string): Promise<TicketRecord[]>;
  /**
   * The ticket service's own reclassification. A port rather than the service itself
   * so the assistant depends on the one write it is allowed to make and not on the
   * whole ticket stack — and so a test answers it with one line.
   */
  reclassify(actor: Actor, ticketId: string, change: TicketReclassification): Promise<ServiceResult<TicketRecord>>;
}

export interface AssistQueueSource {
  listQueues(tenantId: string): Promise<AssistQueue[]>;
}

/** Injected so events are deterministic under test. */
export interface AssistIds {
  eventId(): string;
  now(): string;
}

export interface AssistPorts {
  tickets: AssistTicketSource;
  queues: AssistQueueSource;
  /** How a suggestion is produced: the AI assist, or a fake in a test. */
  assist: (request: AssistRequest) => Promise<AssistResult>;
  audit: AuditSink;
  ids?: AssistIds;
  /** Whether *this tenant* asked for suggestions at all. */
  enabledFor: (tenantId: string) => Promise<boolean>;
  /** Reads the tenant's decision history back. Absent means "no history to show". */
  history?: AssistAuditReader;
  /** How many recent tickets are considered for similar-ticket retrieval. */
  historyLimit?: number;
}

/** Reads a tenant's persisted audit chain. The same reader the assurance packet uses. */
export interface AssistAuditReader {
  read(tenantId: string): Promise<AuditChain>;
}

/** One recorded decision about a suggestion, as a ticket's history shows it. */
export interface AssistDecisionRecord {
  at: string;
  actor: string;
  accepted: boolean;
  /** The suggestion it was about. A free string because it is read back, not trusted. */
  kind: string;
  source: AssistResult["source"];
  /** Whether the acceptance also changed the ticket (an applied classification). */
  applied: boolean;
}

export interface AssistDecision {
  kind: AssistKind;
  accepted: boolean;
  source: AssistResult["source"];
}

/**
 * The classification a person accepted, as the apply path receives it.
 *
 * `source` travels with the change rather than separately because the audit event
 * needs both together: "the model proposed this and the desk applied it" is one fact.
 */
export interface AssistClassification {
  type: TicketType;
  priority: TicketPriority;
  queueId: string | null;
  source: AssistResult["source"];
}

export const ASSIST_HISTORY_LIMIT = 200;

export class AssistService {
  constructor(private readonly ports: AssistPorts) {}

  /** Whether suggestions are switched on for this tenant. */
  async enabledFor(tenantId: string): Promise<boolean> {
    return this.ports.enabledFor(tenantId);
  }

  /**
   * Propose, for one ticket.
   *
   * A reader may ask; there is nothing in a suggestion they would not already see on the
   * ticket, and asking is not acting. The scope test is `ticket:read:any` — a staff
   * question — because the desk console is where this is asked from, and a requester has
   * no assistant in the portal to be told about.
   */
  async suggest(actor: Actor, ticketId: string): Promise<ServiceResult<AssistResult>> {
    if (!(await this.ports.enabledFor(actor.tenantId))) {
      return { ok: false, error: "AI assist is switched off for this desk." };
    }
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have permission to use the assistant." };
    }

    const ticket = await this.ports.tickets.findTicket(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };

    const [queues, all] = await Promise.all([
      this.ports.queues.listQueues(actor.tenantId),
      this.ports.tickets.listTickets(actor.tenantId),
    ]);

    const request: AssistRequest = {
      ticket: toAssistTicket(ticket),
      queues,
      candidates: recentCandidates(ticket.id, all, this.ports.historyLimit ?? ASSIST_HISTORY_LIMIT),
    };

    return { ok: true, value: await this.ports.assist(request) };
  }

  /**
   * Record what a person did with a suggestion.
   *
   * Written through the ticket stack's own audit sink, so a decision sits on the same
   * per-tenant hash chain as the ticket it was about. Recording a decision needs to be able
   * to *act* on the ticket, not merely read it: "I accepted the queue suggestion" is only
   * meaningful from somebody who could have changed the queue, and anything else would let a
   * reader pad the acceptance rate.
   */
  async decide(actor: Actor, ticketId: string, decision: AssistDecision): Promise<ServiceResult<AssistDecision>> {
    const ticket = await this.ports.tickets.findTicket(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    if (!canUpdateTicket(actor, ticket)) {
      return { ok: false, error: "You do not have permission to record a decision on this ticket." };
    }

    await appendDecision(this.ports, actor.id, actor.tenantId, ticketId, decision.kind, decision.accepted, decision.source);
    return { ok: true, value: decision };
  }

  /**
   * Apply an accepted classification to the ticket.
   *
   * This is the later M7 slice the milestone doc promised, and it goes through the ticket
   * service rather than editing the row here. Three things are true of it:
   *
   *  - **The ticket's own permission decides.** `reclassify` checks `ticket:update` on the
   *    ticket, so a suggestion can never widen what a caller could do by hand. The check
   *    is also made here first, so a refusal comes back as a sentence rather than as a
   *    failed write.
   *  - **Only closed sets and this desk's queues.** The client posts the type, priority
   *    and queue; an unknown type or priority is refused, and a queue that is not one of
   *    this tenant's is refused, because a suggestion names a queue from the list the
   *    desk was just shown and nothing else may be filed into.
   *  - **It is recorded as an acceptance.** The write is the acceptance, so the
   *    `assist.accept` event is appended with what changed; the accept rate counts it and
   *    the change is on the same chain as the ticket.
   */
  async applyClassification(
    actor: Actor,
    ticketId: string,
    change: AssistClassification,
  ): Promise<ServiceResult<TicketRecord>> {
    if (!(await this.ports.enabledFor(actor.tenantId))) {
      return { ok: false, error: "AI assist is switched off for this desk." };
    }
    const ticket = await this.ports.tickets.findTicket(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    if (!canUpdateTicket(actor, ticket)) {
      return { ok: false, error: "You do not have permission to update this ticket." };
    }
    if (!TICKET_TYPES.includes(change.type)) {
      return { ok: false, error: `Unknown ticket type "${change.type}".` };
    }
    if (!TICKET_PRIORITIES.includes(change.priority)) {
      return { ok: false, error: `Unknown priority "${change.priority}".` };
    }
    if (change.queueId !== null) {
      const queues = await this.ports.queues.listQueues(actor.tenantId);
      if (!queues.some((queue) => queue.id === change.queueId)) {
        return { ok: false, error: "That queue is not one of this desk's." };
      }
    }

    const applied = await this.ports.tickets.reclassify(actor, ticketId, {
      type: change.type,
      priority: change.priority,
      queueId: change.queueId,
    });
    if (!applied.ok) return applied;

    await appendDecision(this.ports, actor.id, actor.tenantId, ticketId, "CLASSIFICATION", true, change.source, {
      applied: true,
      type: change.type,
      priority: change.priority,
      queueId: change.queueId,
    });
    return { ok: true, value: applied.value };
  }

  /**
   * A ticket's recorded decisions, newest first.
   *
   * The milestone's point was that a suggestion is *reversible and measurable*, and
   * that is only true if what the desk turned down can be seen afterwards. This reads
   * the tenant's own hash chain back — the same chain `decide` and `applyClassification`
   * wrote to — and narrows it to the events about this ticket, so "we dismissed an
   * urgent classification twice, and it was right both times" is a question with an
   * answer rather than a memory.
   *
   * Reading needs only `ticket:read:any`: there is nothing in a decision that is not
   * already implied by the ticket being on the desk's screen, and the *actor* on each
   * event is already visible on the chain to anybody with `audit:read`. A deployment
   * with no reader wired reports an empty history rather than inventing one.
   */
  async history(actor: Actor, ticketId: string): Promise<ServiceResult<AssistDecisionRecord[]>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have permission to read the assistant's history." };
    }
    const ticket = await this.ports.tickets.findTicket(actor.tenantId, ticketId);
    if (!ticket) return { ok: false, error: "Ticket not found." };
    if (!this.ports.history) return { ok: true, value: [] };

    const chain = await this.ports.history.read(actor.tenantId);
    const decisions = chain.events
      .filter(isAssistDecision)
      .filter((event) => event.targetId === ticketId)
      .map(toDecisionRecord)
      .reverse();
    return { ok: true, value: decisions };
  }
}

/** Whether a chain event is a decision this service wrote about a suggestion. */
function isAssistDecision(event: AuditRecord): boolean {
  return event.action === "assist.accept" || event.action === "assist.dismiss";
}

/**
 * Read one stored event back into a decision.
 *
 * Every field is re-derived from the stored event rather than trusted from the event's
 * name: the detail is `unknown` by the time it comes off the chain, so a malformed or
 * older entry degrades to a sensible value (a dismissal with no kind reads as one) and
 * never throws on a page.
 */
function toDecisionRecord(event: AuditRecord): AssistDecisionRecord {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  return {
    at: event.at,
    actor: event.actor,
    accepted: event.action === "assist.accept",
    kind: typeof detail.kind === "string" ? detail.kind : "UNKNOWN",
    source: detail.source === "model" ? "model" : "rules",
    applied: detail.applied === true,
  };
}

/**
 * Append one decision to the tenant's chain.
 *
 * A module-level function rather than a private method so the class's prototype stays
 * exactly its verbs — the test that reads them is the enforcement of "no method that
 * could send anything", and it should not have to know about a helper.
 */
async function appendDecision(
  ports: AssistPorts,
  actorId: string,
  tenantId: string,
  ticketId: string,
  kind: AssistKind,
  accepted: boolean,
  source: AssistResult["source"],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ids = ports.ids ?? systemAssistIds();
  await ports.audit.append({
    id: ids.eventId(),
    tenantId,
    at: ids.now(),
    actor: actorId,
    action: accepted ? "assist.accept" : "assist.dismiss",
    targetType: "ticket",
    targetId: ticketId,
    detail: { kind, source, ...extra },
  });
}

/** The ticket, narrowed to what the assistant is allowed to read. */
export function toAssistTicket(ticket: TicketRecord): AssistTicket {
  return {
    id: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
    description: ticket.description,
    type: ticket.type,
    priority: ticket.priority,
    queueId: ticket.queueId,
    messages: ticket.messages,
  };
}

/**
 * The recent tickets a similar-ticket search may point at.
 *
 * Most recent first, capped, and never the ticket being worked on. A cap is a real
 * decision rather than a performance tweak: an unbounded scan would let a two-year-old
 * ticket with one word in common outrank last week's genuine duplicate, and it would make
 * the cost of a page view grow with the size of the desk.
 */
export function recentCandidates(
  ticketId: string,
  tickets: readonly TicketRecord[],
  limit: number,
): AssistCandidate[] {
  return tickets
    .filter((candidate) => candidate.id !== ticketId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(0, limit))
    .map((candidate) => ({
      id: candidate.id,
      ref: candidate.ref,
      subject: candidate.subject,
      description: candidate.description,
      queueId: candidate.queueId,
    }));
}

/**
 * Identity for decisions.
 *
 * The ticket stack's own `randomUUID`/`Date` pair, kept separate from its `IdSource`
 * because an audit event's id is this service's own concern — and injectable so tests
 * replace the pair whole and assert on a stable event.
 */
export function systemAssistIds(): AssistIds {
  return {
    eventId: () => randomUUID(),
    now: () => new Date().toISOString(),
  };
}
