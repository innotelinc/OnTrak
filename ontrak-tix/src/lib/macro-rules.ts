/**
 * Macro rules (M5): the multi-step shortcuts an agent runs on one ticket.
 *
 * A rule and a macro are two ends of the same thing. A rule is *automation* — it
 * fires on a trigger, without anyone asking. A macro is an *instruction* — an
 * agent picks it and runs it on the ticket in front of them. They share the
 * action vocabulary and, more importantly, the same planner: `planMacro` folds a
 * macro's actions through `planTicketChanges`, the exact function the live rule
 * path uses, so "set the priority, then tag it" cannot mean one thing when a
 * rule says it and another when a person does.
 *
 * Three choices are worth stating out loud:
 *
 *  - **A macro carries no conditions and no trigger.** If it needs a condition
 *    it is a rule; a macro is the case where a person has already looked at the
 *    ticket and decided. That is why `macroHazards` never warns about a catch-all
 *    the way `ruleHazards` does — there is nothing for it to catch.
 *  - **Order still decides a tie.** Two actions in one macro that set the same
 *    field cannot both win, so the first wins and the second is recorded as
 *    skipped with the reason. Silently letting the last one win would make the
 *    outcome depend on a position nobody re-read.
 *  - **The wording of a refusal is the only thing a macro changes about the
 *    validator.** The action rules themselves are shared, not copied.
 *
 * Everything here is pure: no Prisma, no framework, no clock. The service stores
 * what these functions decide and the console renders the sentences they produce.
 */

import {
  actionHazards,
  planTicketChanges,
  validateActions,
  type RuleAction,
  type RuleIssue,
  type RulePlan,
  type RuleRecord,
} from "./rule-rules";

/* -------------------------------------------------------------------------- */
/*  The record                                                                */
/* -------------------------------------------------------------------------- */

export interface MacroRecord {
  id: string;
  tenantId: string;
  name: string;
  /** What the macro is for, shown to the agent who is about to run it. */
  description: string;
  actions: readonly RuleAction[];
  /** A retired macro is kept, not deleted, so past runs still read back. */
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const MACRO_NAME_MAX = 80;
export const MACRO_DESCRIPTION_MAX = 300;
/**
 * The same ceiling the engine puts on a rule's actions. A shortcut that takes
 * more than this to read is a workflow, and a workflow belongs in a playbook.
 */
export const MAX_MACRO_ACTIONS = 8;

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything wrong with a macro, before it is stored.
 *
 * A macro that cannot be evaluated is worse than no macro: an agent runs it,
 * believes the ticket is now routed, and the ticket is not. So the name, the
 * length and every action are checked at the point of writing, and the action
 * checks are the engine's own — the same ones a rule passes.
 */
export function validateMacro(input: {
  name?: string;
  description?: string;
  actions?: readonly RuleAction[];
}): RuleIssue[] {
  const issues: RuleIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A macro name is required." });
  else if (name.length > MACRO_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${MACRO_NAME_MAX} characters.` });
  }

  const description = input.description?.trim() ?? "";
  if (description.length > MACRO_DESCRIPTION_MAX) {
    issues.push({ field: "description", message: `The description may be at most ${MACRO_DESCRIPTION_MAX} characters.` });
  }

  const actions = input.actions ?? [];
  if (actions.length === 0) {
    issues.push({ field: "actions", message: "A macro has to do something, or it is only a comment." });
  }
  if (actions.length > MAX_MACRO_ACTIONS) {
    issues.push({ field: "actions", message: `A macro may carry at most ${MAX_MACRO_ACTIONS} actions.` });
  }
  issues.push(...validateActions(actions, "actions", "macro"));

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Planning                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A macro as the one rule the planner folds over.
 *
 * `planTicketChanges` reads a rule's `position`, `id` and `name` to attribute
 * what it applied and what it skipped; nothing else about the rule is consulted.
 * The trigger and conditions below are never matched — a macro is planned, not
 * evaluated — so they are fixed values rather than fields a caller could set.
 */
function asPlannableRule(macro: MacroRecord): RuleRecord {
  return {
    id: macro.id,
    tenantId: macro.tenantId,
    name: macro.name,
    trigger: "ticket.updated",
    conditions: [],
    actions: macro.actions,
    enabled: true,
    position: 1,
    createdBy: macro.createdBy,
    createdAt: macro.createdAt,
    updatedAt: macro.updatedAt,
  };
}

/** What a macro would do to a ticket, through the engine the rules path uses. */
export function planMacro(macro: MacroRecord): RulePlan {
  return planTicketChanges([asPlannableRule(macro)]);
}

/**
 * What is worth saying out loud about a macro before an agent runs it.
 *
 * The action hazards are the rule engine's own; a retired macro is named as
 * such, because "switched off" is the difference between a shortcut and a dead
 * button. There is deliberately no catch-all warning: a macro has no conditions,
 * so there is nothing for it to match by surprise.
 */
export function macroHazards(macro: { actions?: readonly RuleAction[]; enabled?: boolean }): string[] {
  const hazards = actionHazards(macro.actions ?? []);
  if (macro.enabled === false) {
    hazards.push("It is switched off, so an agent cannot run it yet.");
  }
  return hazards;
}
