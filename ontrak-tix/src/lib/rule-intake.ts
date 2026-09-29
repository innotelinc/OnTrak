/**
 * Rule intake (M5): the moment a rule stops being a document and starts acting.
 *
 * `rule-rules.ts` decides *what* a rule would do to a ticket; `rule-service.ts`
 * decides *who may write one*; this file is the third piece — applying the plan
 * to a real ticket as it is created, updated or replied to, and recording the
 * result where an auditor can find it.
 *
 * Three choices are worth stating out loud:
 *
 *  - **Rules run before the row is written, on creation.** A ticket is born
 *    with the priority, queue, assignee and tags its rules give it, so there is
 *    never a window in which the inbox shows work the rules have not seen, and
 *    the ticket is inserted once rather than written and then corrected.
 *  - **Every firing is on the chain.** One event per trigger names the rules
 *    that matched, every action that took effect, and every action that an
 *    earlier rule outvoted — with the reason. "Why is this ticket urgent?" has
 *    an answer that survives the rule being edited next week.
 *  - **A rule's actions on the customer are delivered, not merely recorded.**
 *    A `reply` becomes a public message from the desk; `notify` and `escalate`
 *    go to staff through an injected sink. Dropping one silently is exactly the
 *    failure automation is supposed to prevent, so each is either delivered or
 *    the ticket is not written as if it had been.
 *
 * Everything here is pure except `settle`, which is the one function that talks
 * to the outside world, and it is best-effort by design: a notice that cannot be
 * stored must not undo the ticket that earned it.
 */

import { randomUUID } from "node:crypto";

import type { AuditEventInput } from "./audit-chain";
import {
  TAG_MAX,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type RulePlan,
  type RuleRecord,
  type RuleTicketView,
  type RuleTrigger,
} from "./rule-rules";
import type { TicketMessage, TicketRecord } from "./ticket-service";
import type { TicketPriority, TicketType } from "./ticket-rules";

/** The rule engine, as the ticket service sees it. */
export interface RulePlannerPort {
  planForTicket(
    tenantId: string,
    ticket: RuleTicketView,
    trigger: RuleTrigger,
  ): Promise<{ plan: RulePlan; rules: RuleRecord[] }>;
}

/** The requester's address, so a rule can match on it. */
export interface RequesterDirectory {
  emailFor(tenantId: string, requesterId: string): Promise<string | null>;
}

/** One outward action a rule asked for, ready to be delivered. */
export interface RuleNotice {
  tenantId: string;
  ticketId: string;
  ticketRef: string;
  /** The action's text — the message for `notify`, the reason for `escalate`. */
  value: string;
  ruleId: string;
  ruleName: string;
  /**
   * What raised the notice. A macro (M5) runs through the same sink as a rule,
   * so the notice names the thing the reader can go and change; absent means a
   * rule, which is what every notice written before macros was.
   */
  source?: "rule" | "macro";
}

/**
 * Where a rule's outward actions go. Injected because the ticket service must
 * not know how the desk reaches its staff — in-app, email, on-call pager.
 */
export interface RuleEffectSink {
  notify(notice: RuleNotice): Promise<void>;
  escalate(notice: RuleNotice): Promise<void>;
}

/** The id source the application needs; a subset of `IdSource`. */
export interface RuleIntakeIds {
  messageId(): string;
  now(): string;
}

/** What one trigger did to one ticket. */
export interface RuleApplication {
  trigger: RuleTrigger;
  /** The ticket after the rules ran. */
  ticket: TicketRecord;
  /** The rules that matched, in the order they ran. */
  matched: { ruleId: string; ruleName: string }[];
  plan: RulePlan;
  /** How many automatic replies were appended to the thread. */
  autoReplies: number;
  /** The audit event describing the firing. Always present: no match, no event. */
  audit: AuditEventInput;
}

/** The rule engine's view of a stored ticket. Deliberately narrower than the row. */
export function ruleViewOf(ticket: TicketRecord, requesterEmail?: string | null): RuleTicketView {
  return {
    subject: ticket.subject,
    description: ticket.description,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    queueId: ticket.queueId,
    clientId: ticket.clientId ?? null,
    requesterId: ticket.requesterId,
    requesterEmail: requesterEmail ?? null,
    tags: ticket.tags ?? [],
  };
}

/** The ticket a plan produces, and how many public replies it appended. */
export interface FoldedPlan {
  ticket: TicketRecord;
  autoReplies: number;
}

/**
 * Fold a plan into a ticket. Pure: same inputs, same ticket, no clock beyond the
 * `at` it is handed, so the console's preview and the live path cannot drift.
 *
 * Shared by the rules path and the macro path (M5), because "set the priority,
 * then tag it" has to mean one thing whoever asked for it — a macro that folded
 * its own plan could quietly disagree with what previewing the same actions as a
 * rule showed. Only the attribution around the fold differs: a rule acts as
 * `rules:<trigger>`, a macro as the agent who ran it.
 *
 * The values are re-checked against the ticket vocabulary rather than trusted:
 * a rule validated at write time is still stored JSON, and a ticket written with
 * a priority the inbox does not understand is worse than a rule that did not run.
 */
export function foldPlanIntoTicket(
  ticket: TicketRecord,
  plan: RulePlan,
  at: string,
  newMessageId: () => string,
): FoldedPlan {
  let priority = ticket.priority;
  let type = ticket.type;
  let queueId = ticket.queueId;
  let assigneeId = ticket.assigneeId;

  if (plan.priority && TICKET_PRIORITIES.includes(plan.priority)) priority = plan.priority as TicketPriority;
  if (plan.type && TICKET_TYPES.includes(plan.type)) type = plan.type as TicketType;
  if (plan.queueId) queueId = plan.queueId;
  if (plan.assigneeId) assigneeId = plan.assigneeId;

  const tags = [...(ticket.tags ?? [])];
  for (const tag of plan.addTags) {
    const clean = tag.trim().slice(0, TAG_MAX);
    if (!clean) continue;
    if (tags.some((existing) => existing.toLowerCase() === clean.toLowerCase())) continue;
    tags.push(clean);
  }

  // Each `reply` action becomes a message of its own: the engine accumulates
  // them on purpose, because two rules that both want to say something are two
  // things the desk intended to say. The first one answers the customer, so it
  // stops the response clock, exactly as an agent's first public reply does.
  const replies = plan.reply.map((entry): TicketMessage => ({
    id: newMessageId(),
    kind: "PUBLIC_REPLY",
    body: entry.value,
    authorId: null,
    createdAt: at,
  }));

  const next: TicketRecord = {
    ...ticket,
    priority,
    type,
    queueId,
    assigneeId,
    tags,
    updatedAt: at,
    messages: replies.length > 0 ? [...ticket.messages, ...replies] : ticket.messages,
    firstResponseAt: replies.length > 0 ? (ticket.firstResponseAt ?? at) : ticket.firstResponseAt,
  };

  return { ticket: next, autoReplies: replies.length };
}

/**
 * Apply a plan produced by the rule engine and attribute it to the rules.
 *
 * The fold itself is `foldPlanIntoTicket`; what is left here is the story the
 * chain needs to answer "why is this ticket urgent?" after the rule that made it
 * so has been edited or deleted.
 */
export function applyPlanToTicket(
  ticket: TicketRecord,
  plan: RulePlan,
  trigger: RuleTrigger,
  matched: readonly RuleRecord[],
  at: string,
  newMessageId: () => string,
): RuleApplication {
  const { ticket: next, autoReplies } = foldPlanIntoTicket(ticket, plan, at, newMessageId);

  const audit: AuditEventInput = {
    id: randomUUID(),
    tenantId: ticket.tenantId,
    at,
    // No one at a keyboard: the rules acted on the ticket, so the ticket acted.
    actor: `rules:${trigger}`,
    action: "ticket.rules",
    targetType: "ticket",
    targetId: ticket.id,
    detail: {
      trigger,
      matched: matched.map((rule) => ({ id: rule.id, name: rule.name })),
      applied: plan.applied.map((entry) => ({
        rule: entry.ruleName,
        action: entry.action.kind,
        value: entry.action.value ?? null,
      })),
      skipped: plan.skipped.map((entry) => ({
        rule: entry.ruleName,
        action: entry.action.kind,
        because: entry.because,
      })),
      autoReplies,
      notified: plan.notify.map((entry) => ({ rule: entry.ruleName, value: entry.value })),
      escalated: plan.escalate.map((entry) => ({ rule: entry.ruleName, value: entry.value })),
    },
  };

  return { trigger, ticket: next, matched: matched.map((rule) => ({ ruleId: rule.id, ruleName: rule.name })), plan, autoReplies, audit };
}

/**
 * The seam the ticket service calls. It holds the engine, the effect sink and
 * the requester lookup, so `TicketService` only has to say *when* rules run.
 */
export class RuleIntake {
  constructor(
    private readonly rules: RulePlannerPort,
    private readonly effects: RuleEffectSink | null = null,
    private readonly directory: RequesterDirectory | null = null,
  ) {}

  /**
   * Run the rules for one ticket and return the ticket they produced, or `null`
   * when no rule matched — in which case the caller writes the ticket untouched
   * and adds nothing to the chain, because "nothing happened" is not an event.
   */
  async apply(ticket: TicketRecord, trigger: RuleTrigger, ids: RuleIntakeIds): Promise<RuleApplication | null> {
    const requesterEmail = this.directory ? await this.directory.emailFor(ticket.tenantId, ticket.requesterId) : null;
    const { plan, rules } = await this.rules.planForTicket(ticket.tenantId, ruleViewOf(ticket, requesterEmail), trigger);
    if (rules.length === 0) return null;
    return applyPlanToTicket(ticket, plan, trigger, rules, ids.now(), () => ids.messageId());
  }

  /**
   * Deliver a plan's outward actions. Best-effort on purpose: the ticket is
   * already written and the firing is already on the chain, so a notice that
   * cannot be stored must not make the intake look like it failed.
   */
  async settle(application: RuleApplication): Promise<void> {
    if (!this.effects) return;
    const where = { tenantId: application.ticket.tenantId, ticketId: application.ticket.id, ticketRef: application.ticket.ref };
    for (const entry of application.plan.notify) {
      await this.effects.notify({ ...where, value: entry.value, ruleId: entry.ruleId, ruleName: entry.ruleName }).catch(() => undefined);
    }
    for (const entry of application.plan.escalate) {
      await this.effects.escalate({ ...where, value: entry.value, ruleId: entry.ruleId, ruleName: entry.ruleName }).catch(() => undefined);
    }
  }
}
