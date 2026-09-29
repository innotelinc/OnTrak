/**
 * Macro intake (M5): the moment a shortcut stops being a document and changes a
 * ticket.
 *
 * `macro-rules.ts` decides *what* a macro does to a ticket; `macro-service.ts`
 * decides *who may write one*; this file is the third piece — applying a chosen
 * macro to a real ticket and recording the result where an auditor can find it.
 *
 * Three choices are worth stating out loud:
 *
 *  - **A macro is attributed to the agent who ran it, not to the desk.** A rule
 *    acts as `rules:<trigger>` because nobody was there; a macro acts as the
 *    person who chose it. The audit line is `ticket.macro` and names both the
 *    agent and the macro, so "who reassigned this?" and "what did the shortcut
 *    do?" are two facts on one event.
 *  - **Running a macro does not run the rules.** An explicit instruction from an
 *    agent should not be silently outvoted by automation that fires on
 *    `ticket.updated` — the agent looked at the ticket and decided. The ticket's
 *    own `updatedAt` still moves, so it sorts and reports as recently worked.
 *  - **A macro's outward actions are delivered, not merely recorded.** A `reply`
 *    becomes a public message from the desk and stops the response clock exactly
 *    as an agent's own first reply does; `notify` and `escalate` go to staff
 *    through the same sink rules use, marked as the macro's so the notice names
 *    the shortcut rather than a rule.
 *
 * Everything here is pure except `settle`, which is best-effort by design: the
 * ticket is already written and the run is already on the chain, so a notice that
 * cannot be stored must not undo the work it describes.
 */

import { randomUUID } from "node:crypto";

import { canUpdateTicket, type Actor } from "./access-rules";
import type { AuditEventInput } from "./audit-chain";
import { planMacro, type MacroRecord } from "./macro-rules";
import type { RulePlan } from "./rule-rules";
import { foldPlanIntoTicket, type RuleEffectSink, type RuleIntakeIds } from "./rule-intake";
import type { ServiceResult, TicketRecord } from "./ticket-service";

/** The macro lookup the intake needs, so it does not depend on the whole service. */
export interface MacroPlannerPort {
  findMacro(tenantId: string, macroId: string): Promise<MacroRecord | null>;
}

/** What running one macro did to one ticket. */
export interface MacroApplication {
  macro: MacroRecord;
  /** The ticket after the macro ran. */
  ticket: TicketRecord;
  plan: RulePlan;
  /** How many automatic replies the macro appended to the thread. */
  autoReplies: number;
  /** The audit event describing the run. */
  audit: AuditEventInput;
}

/**
 * Apply a macro to a ticket. Pure, and the only place the access check happens
 * before the fold: a requester has no shortcut that reassigns work.
 */
export function applyMacroToTicket(
  actor: Actor,
  ticket: TicketRecord,
  macro: MacroRecord,
  at: string,
  newMessageId: () => string,
): ServiceResult<MacroApplication> {
  if (!canUpdateTicket(actor, ticket)) {
    return { ok: false, error: "You cannot change this ticket." };
  }
  if (!macro.enabled) {
    return { ok: false, error: `“${macro.name}” is switched off, so it cannot be run.` };
  }

  const plan = planMacro(macro);
  const { ticket: next, autoReplies } = foldPlanIntoTicket(ticket, plan, at, newMessageId);

  const audit: AuditEventInput = {
    id: randomUUID(),
    tenantId: ticket.tenantId,
    at,
    // The agent ran it: unlike a rule, there is a person to name.
    actor: actor.id,
    action: "ticket.macro",
    targetType: "ticket",
    targetId: ticket.id,
    detail: {
      macro: { id: macro.id, name: macro.name },
      applied: plan.applied.map((entry) => ({
        action: entry.action.kind,
        value: entry.action.value ?? null,
      })),
      skipped: plan.skipped.map((entry) => ({
        action: entry.action.kind,
        because: entry.because,
      })),
      autoReplies,
      notified: plan.notify.map((entry) => entry.value),
      escalated: plan.escalate.map((entry) => entry.value),
    },
  };

  return { ok: true, value: { macro, ticket: next, plan, autoReplies, audit } };
}

/**
 * The seam the ticket service calls. It holds the macro lookup and the effect
 * sink, so `TicketService` only has to say *when* a macro runs.
 */
export class MacroIntake {
  constructor(
    private readonly macros: MacroPlannerPort,
    private readonly effects: RuleEffectSink | null = null,
  ) {}

  /** Resolve the macro and apply it. Missing, switched-off and forbidden are distinct. */
  async apply(
    actor: Actor,
    ticket: TicketRecord,
    macroId: string,
    ids: RuleIntakeIds,
  ): Promise<ServiceResult<MacroApplication>> {
    const macro = await this.macros.findMacro(ticket.tenantId, macroId);
    if (!macro) return { ok: false, error: "That macro does not exist." };
    return applyMacroToTicket(actor, ticket, macro, ids.now(), () => ids.messageId());
  }

  /**
   * Deliver a macro's outward actions. Best-effort on purpose: the ticket is
   * already written and the run is already on the chain, so a notice that cannot
   * be stored must not make the run look like it failed.
   */
  async settle(application: MacroApplication): Promise<void> {
    if (!this.effects) return;
    const where = {
      tenantId: application.ticket.tenantId,
      ticketId: application.ticket.id,
      ticketRef: application.ticket.ref,
      source: "macro" as const,
    };
    for (const entry of application.plan.notify) {
      await this.effects
        .notify({ ...where, value: entry.value, ruleId: application.macro.id, ruleName: application.macro.name })
        .catch(() => undefined);
    }
    for (const entry of application.plan.escalate) {
      await this.effects
        .escalate({ ...where, value: entry.value, ruleId: application.macro.id, ruleName: application.macro.name })
        .catch(() => undefined);
    }
  }
}
