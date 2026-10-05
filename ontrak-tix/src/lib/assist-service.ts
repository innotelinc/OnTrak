/**
 * The assist service (M7): the one place a suggestion is asked for, and the one place a
 * decision about it is written down.
 *
 * WHAT IT GUARANTEES
 * ------------------
 * A suggestion never touches a ticket. `suggest` reads; `decide` records *that somebody
 * took or left a suggestion* on the audit chain and nothing else. There is no method here
 * that replies, reassigns or resolves, so "never auto-send" is a property of the shape of
 * this class rather than a rule somebody has to remember. Applying an accepted
 * classification is a later slice, and it will go through the ticket service's own
 * permission checks like every other write.
 *
 * WHY THE DECISION IS WORTH RECORDING
 * -----------------------------------
 * The milestone's exit criterion is that suggestions are *measurable and reversible*. A
 * decision appended to the per-tenant hash chain gives both: the accept rate is a query
 * over one tenant's history, and because the chain is append-only, a dismissal is never
 * quietly turned into an acceptance. The event names a kind and a source, so "the model
 * proposed it and the desk took it" and "the rules did, and the desk ignored it" are
 * different facts afterwards.
 *
 * Every dependency is injected, so the whole thing is exercised in tests without a
 * database, a model or a network.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, canUpdateTicket, type Actor } from "./access-rules";
import type { AuditSink } from "./audit-chain";
import type { ServiceResult, TicketRecord } from "./ticket-service";
import type { AssistCandidate, AssistQueue, AssistRequest, AssistResult, AssistTicket } from "./assist-rules";

/** The four things a suggestion is made of. The verb on a decision event. */
export type AssistKind = "CLASSIFICATION" | "SUMMARY" | "DRAFT_REPLY" | "SIMILAR";

export const ASSIST_KINDS: readonly AssistKind[] = ["CLASSIFICATION", "SUMMARY", "DRAFT_REPLY", "SIMILAR"];

export interface AssistTicketSource {
  findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null>;
  listTickets(tenantId: string): Promise<TicketRecord[]>;
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
  /** Whether this desk asked for suggestions at all. */
  enabled: boolean;
  /** How many recent tickets are considered for similar-ticket retrieval. */
  historyLimit?: number;
}

export interface AssistDecision {
  kind: AssistKind;
  accepted: boolean;
  source: AssistResult["source"];
}

export const ASSIST_HISTORY_LIMIT = 200;

export class AssistService {
  constructor(private readonly ports: AssistPorts) {}

  /** Whether suggestions are switched on for this desk. */
  get enabled(): boolean {
    return this.ports.enabled;
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
    if (!this.ports.enabled) {
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

    const ids = this.ports.ids ?? systemAssistIds();
    await this.ports.audit.append({
      id: ids.eventId(),
      tenantId: actor.tenantId,
      at: ids.now(),
      actor: actor.id,
      action: decision.accepted ? "assist.accept" : "assist.dismiss",
      targetType: "ticket",
      targetId: ticketId,
      detail: { kind: decision.kind, source: decision.source },
    });

    return { ok: true, value: decision };
  }
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
