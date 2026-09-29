/**
 * Rule rules (M5): trigger + conditions → actions, and what a rule is allowed to
 * decide about a ticket.
 *
 * A desk's intake is repetitive in a way nobody enjoys handling: the same
 * subject line from the same monitoring system, the same request from the same
 * client, the same phrase that means "this is urgent, whatever the form said".
 * Rules exist to answer those once. Everything hard about them is about
 * *accountability*, not about matching:
 *
 *  - **A rule that fires must be explainable.** Conditions are ANDed and there
 *    is deliberately no OR: "which rule did this?" has one answer per rule, and
 *    a match list that reads back is worth more than an expression language
 *    nobody can predict. The cost is a second rule when you mean "or", which is
 *    cheap and legible.
 *  - **Two rules must not fight over one field.** Rules apply in order and the
 *    *first* one to set a field owns it; a later rule that wants the same field
 *    is recorded as skipped, with the reason. Silently letting the last rule win
 *    would make the outcome depend on a position nobody looked at.
 *  - **A rule that acts on the customer is not the same as a rule that files
 *    work.** Setting a priority is internal. Replying is a message leaving the
 *    desk under the desk's name, so it is flagged rather than merely allowed.
 *  - **A rule that matches everything is a loaded gun.** It is valid — a
 *    catch-all acknowledgement is a real thing to want — so it is not refused;
 *    it is *reported* by `ruleHazards`, and the dry run shows the blast radius
 *    before anything is switched on.
 *
 * Everything here is pure: no Prisma, no framework, no clock. The service stores
 * what these functions decide; the console renders the sentences they produce.
 */

/* -------------------------------------------------------------------------- */
/*  The records                                                              */
/* -------------------------------------------------------------------------- */

export type RuleTrigger = "ticket.created" | "ticket.updated" | "ticket.replied";

export const RULE_TRIGGERS: readonly RuleTrigger[] = ["ticket.created", "ticket.updated", "ticket.replied"];

export function isRuleTrigger(value: unknown): value is RuleTrigger {
  return typeof value === "string" && (RULE_TRIGGERS as readonly string[]).includes(value);
}

export type ConditionField =
  | "subject"
  | "description"
  | "type"
  | "priority"
  | "status"
  | "queueId"
  | "clientId"
  | "requesterEmail"
  | "tag";

export const CONDITION_FIELDS: readonly ConditionField[] = [
  "subject",
  "description",
  "type",
  "priority",
  "status",
  "queueId",
  "clientId",
  "requesterEmail",
  "tag",
];

/**
 * The operators, and nothing more. There is no regex operator on purpose: a
 * pattern is a small program, and the whole value of a rule is that a person
 * reading it can say what it will do to the ticket in front of them.
 */
export type ConditionOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "is_one_of"
  | "is_not_one_of"
  | "is_empty"
  | "is_not_empty";

export const CONDITION_OPERATORS: readonly ConditionOperator[] = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "is_one_of",
  "is_not_one_of",
  "is_empty",
  "is_not_empty",
];

/** The operators that need no value: the field's emptiness *is* the test. */
export const VALUELESS: readonly ConditionOperator[] = ["is_empty", "is_not_empty"];

/** The operators whose value is a list. */
export const LIST_OPERATORS: readonly ConditionOperator[] = ["is_one_of", "is_not_one_of"];

export interface RuleCondition {
  field: ConditionField;
  operator: ConditionOperator;
  /**
   * A string, or a list for the `is_one_of` family. Absent for the valueless
   * operators (`is_empty`, `is_not_empty`), where the field's emptiness *is* the
   * test — carrying a value there would only invite a reader to wonder what it
   * meant.
   */
  value?: string | readonly string[];
}

export type ActionKind =
  | "set_priority"
  | "set_type"
  | "route_queue"
  | "assign_agent"
  | "add_tag"
  | "notify"
  | "reply"
  | "escalate";

export const ACTION_KINDS: readonly ActionKind[] = [
  "set_priority",
  "set_type",
  "route_queue",
  "assign_agent",
  "add_tag",
  "notify",
  "reply",
  "escalate",
];

export interface RuleAction {
  kind: ActionKind;
  /** The field value, id, tag or text the action carries. */
  value?: string;
}

export interface RuleRecord {
  id: string;
  tenantId: string;
  name: string;
  trigger: RuleTrigger;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
  enabled: boolean;
  /** Lower runs first; the first rule to set a field owns it. */
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The subset of a ticket a rule may read. Deliberately narrower than the row. */
export interface RuleTicketView {
  subject: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  queueId: string | null;
  clientId: string | null;
  requesterId: string;
  requesterEmail?: string | null;
  tags?: readonly string[];
}

export const RULE_NAME_MAX = 120;
export const TAG_MAX = 40;
export const MAX_CONDITIONS = 12;
export const MAX_ACTIONS = 8;

export const TICKET_PRIORITIES: readonly string[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const TICKET_TYPES: readonly string[] = ["INCIDENT", "REQUEST"];

export interface RuleIssue {
  field: string;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything wrong with a rule, before it is stored.
 *
 * A rule that cannot be evaluated is worse than no rule: it looks like
 * automation while quietly doing nothing, or — with a half-typed condition —
 * matching far more than intended. So every unknown field, unknown operator and
 * missing value is refused at the point of writing rather than tolerated at
 * evaluation time.
 */
export function validateRule(input: {
  name?: string;
  trigger?: string;
  conditions?: readonly RuleCondition[];
  actions?: readonly RuleAction[];
}): RuleIssue[] {
  const issues: RuleIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A rule name is required." });
  else if (name.length > RULE_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${RULE_NAME_MAX} characters.` });
  }

  if (!isRuleTrigger(input.trigger)) {
    issues.push({ field: "trigger", message: "Choose when this rule runs." });
  }

  const conditions = input.conditions ?? [];
  if (conditions.length > MAX_CONDITIONS) {
    issues.push({ field: "conditions", message: `A rule may carry at most ${MAX_CONDITIONS} conditions.` });
  }
  conditions.forEach((condition, index) => {
    const at = `conditions.${index}`;
    if (!CONDITION_FIELDS.includes(condition?.field)) {
      issues.push({ field: at, message: `“${String(condition?.field)}” is not something a rule can look at.` });
    }
    if (!CONDITION_OPERATORS.includes(condition?.operator)) {
      issues.push({ field: at, message: `“${String(condition?.operator)}” is not a comparison a rule can make.` });
      return;
    }
    if (VALUELESS.includes(condition.operator)) return;

    if (LIST_OPERATORS.includes(condition.operator)) {
      const list = Array.isArray(condition.value) ? condition.value : [];
      if (list.length === 0 || list.some((entry) => !String(entry ?? "").trim())) {
        issues.push({ field: at, message: "Choose at least one value to compare against." });
      }
      return;
    }

    if (typeof condition.value !== "string" || !condition.value.trim()) {
      issues.push({ field: at, message: "This comparison needs a value." });
    }
  });

  const actions = input.actions ?? [];
  if (actions.length === 0) {
    issues.push({ field: "actions", message: "A rule has to do something, or it is only a comment." });
  }
  if (actions.length > MAX_ACTIONS) {
    issues.push({ field: "actions", message: `A rule may carry at most ${MAX_ACTIONS} actions.` });
  }
  issues.push(...validateActions(actions));

  return issues;
}

/**
 * Everything wrong with a list of actions, before it is stored.
 *
 * Shared with macros (M5), because a macro is the same actions applied on
 * demand rather than when a trigger fires. Two validators would eventually
 * disagree about what "set the priority to URGENT" accepts, and the one nobody
 * tested would be the one that shipped. `noun` changes only the wording of the
 * refusal; `base` is the field path prefix, so an error points at the row.
 */
export function validateActions(actions: readonly RuleAction[], base = "actions", noun = "rule"): RuleIssue[] {
  const issues: RuleIssue[] = [];
  actions.forEach((action, index) => {
    const at = `${base}.${index}`;
    if (!ACTION_KINDS.includes(action?.kind)) {
      issues.push({ field: at, message: `“${String(action?.kind)}” is not something a ${noun} can do.` });
      return;
    }
    const value = action.value?.trim() ?? "";
    switch (action.kind) {
      case "set_priority":
        if (!TICKET_PRIORITIES.includes(value)) {
          issues.push({ field: at, message: `“${value}” is not a priority.` });
        }
        break;
      case "set_type":
        if (!TICKET_TYPES.includes(value)) issues.push({ field: at, message: `“${value}” is not a ticket type.` });
        break;
      case "route_queue":
      case "assign_agent":
        if (!value) issues.push({ field: at, message: "Choose what this action points at." });
        break;
      case "add_tag": {
        if (!value) issues.push({ field: at, message: "A tag needs a name." });
        else if (value.length > TAG_MAX) {
          issues.push({ field: at, message: `A tag may be at most ${TAG_MAX} characters.` });
        } else if (!/^[a-z0-9][a-z0-9 _-]*$/i.test(value)) {
          issues.push({ field: at, message: `“${value}” is not a tag: letters, digits, spaces, dashes and underscores.` });
        }
        break;
      }
      case "notify":
      case "reply":
        if (!value) issues.push({ field: at, message: "This action needs something to say." });
        break;
      case "escalate":
        break;
    }
  });
  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                 */
/* -------------------------------------------------------------------------- */

/** The ticket's value for a field, as a string, or `null` when it has none. */
function fieldValue(ticket: RuleTicketView, field: ConditionField): string | null {
  switch (field) {
    case "subject":
      return ticket.subject ?? "";
    case "description":
      return ticket.description ?? "";
    case "type":
      return ticket.type ?? null;
    case "priority":
      return ticket.priority ?? null;
    case "status":
      return ticket.status ?? null;
    case "queueId":
      return ticket.queueId ?? null;
    case "clientId":
      return ticket.clientId ?? null;
    case "requesterEmail":
      return ticket.requesterEmail ?? null;
    case "tag":
      // Tags are the one multi-valued field: any tag may satisfy the condition.
      return (ticket.tags ?? []).join("\n");
  }
}

function compare(actual: string | null, operator: ConditionOperator, value: string): boolean {
  if (LIST_OPERATORS.includes(operator)) return false;
  const subject = (actual ?? "").toLowerCase();
  const needle = value.toLowerCase();
  switch (operator) {
    case "contains":
      return subject.includes(needle);
    case "not_contains":
      return !subject.includes(needle);
    case "equals":
      return subject === needle;
    case "not_equals":
      return subject !== needle;
    default:
      return false;
  }
}

/** Whether one condition holds for a ticket. */
export function conditionMatches(condition: RuleCondition, ticket: RuleTicketView): boolean {
  const raw = fieldValue(ticket, condition.field);

  if (condition.operator === "is_empty") return !raw || !raw.trim();
  if (condition.operator === "is_not_empty") return Boolean(raw && raw.trim());

  if (LIST_OPERATORS.includes(condition.operator)) {
    const list = (Array.isArray(condition.value) ? condition.value : [condition.value])
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean);
    // A tag condition asks about the *set* of tags; the others about one value.
    const candidates =
      condition.field === "tag" ? (ticket.tags ?? []).map((tag) => String(tag).trim().toLowerCase()) : [(raw ?? "").trim().toLowerCase()];
    const hit = candidates.some((candidate) => list.includes(candidate));
    return condition.operator === "is_one_of" ? hit : !hit;
  }

  // A tag condition with a scalar operator tests each tag in turn.
  if (condition.field === "tag") {
    const tags = ticket.tags ?? [];
    if (condition.operator === "equals") {
      return tags.some((tag) => String(tag).trim().toLowerCase() === String(condition.value).trim().toLowerCase());
    }
    if (condition.operator === "not_equals") {
      return !tags.some((tag) => String(tag).trim().toLowerCase() === String(condition.value).trim().toLowerCase());
    }
    return tags.some((tag) => compare(String(tag), condition.operator, String(condition.value)));
  }

  return compare(raw, condition.operator, String(condition.value ?? ""));
}

/**
 * Whether a rule applies to a ticket: it is switched on, it is listening for
 * this trigger, and **every** condition holds.
 */
export function ruleMatches(rule: RuleRecord, ticket: RuleTicketView, trigger?: RuleTrigger): boolean {
  if (!rule.enabled) return false;
  if (trigger && rule.trigger !== trigger) return false;
  return (rule.conditions ?? []).every((condition) => conditionMatches(condition, ticket));
}

/** The rules that matched, in the order they run. */
export function evaluateRules(rules: readonly RuleRecord[], ticket: RuleTicketView, trigger?: RuleTrigger): RuleRecord[] {
  return [...rules]
    .filter((rule) => ruleMatches(rule, ticket, trigger))
    .sort((a, b) => a.position - b.position);
}

/* -------------------------------------------------------------------------- */
/*  Planning                                                                 */
/* -------------------------------------------------------------------------- */

export interface SkippedAction {
  ruleId: string;
  ruleName: string;
  action: RuleAction;
  because: string;
}

export interface AppliedAction {
  ruleId: string;
  ruleName: string;
  action: RuleAction;
}

/**
 * What the matched rules would actually do to one ticket.
 *
 * Singular fields are first-writer-wins; tags accumulate; the outward-facing
 * actions (notify, reply, escalate) all accumulate, because dropping one silently
 * is exactly the failure a rule is supposed to prevent.
 */
export interface RulePlan {
  priority: string | null;
  type: string | null;
  queueId: string | null;
  assigneeId: string | null;
  addTags: string[];
  notify: { value: string; ruleId: string; ruleName: string }[];
  reply: { value: string; ruleId: string; ruleName: string }[];
  escalate: { value: string; ruleId: string; ruleName: string }[];
  /** Every action that took effect, in order — the explanation of the outcome. */
  applied: AppliedAction[];
  /** Every action that was outvoted, and by what. */
  skipped: SkippedAction[];
}

const SINGULAR: readonly ActionKind[] = ["set_priority", "set_type", "route_queue", "assign_agent"];

/** Fold the matched rules into one plan. */
export function planTicketChanges(matched: readonly RuleRecord[]): RulePlan {
  const plan: RulePlan = {
    priority: null,
    type: null,
    queueId: null,
    assigneeId: null,
    addTags: [],
    notify: [],
    reply: [],
    escalate: [],
    applied: [],
    skipped: [],
  };

  const owner: Partial<Record<ActionKind, { ruleId: string; ruleName: string }>> = {};

  for (const rule of [...matched].sort((a, b) => a.position - b.position)) {
    for (const action of rule.actions ?? []) {
      const value = action.value?.trim() ?? "";
      const where = { ruleId: rule.id, ruleName: rule.name };

      if (SINGULAR.includes(action.kind)) {
        const previous = owner[action.kind];
        if (previous) {
          plan.skipped.push({ ...where, action, because: `“${previous.ruleName}” already set this, and rules run in order.` });
          continue;
        }
        owner[action.kind] = where;
        if (action.kind === "set_priority") plan.priority = value;
        else if (action.kind === "set_type") plan.type = value;
        else if (action.kind === "route_queue") plan.queueId = value;
        else if (action.kind === "assign_agent") plan.assigneeId = value;
        plan.applied.push({ ...where, action });
        continue;
      }

      if (action.kind === "add_tag") {
        if (!plan.addTags.some((tag) => tag.toLowerCase() === value.toLowerCase())) plan.addTags.push(value);
        plan.applied.push({ ...where, action });
        continue;
      }

      if (action.kind === "notify") plan.notify.push({ value, ...where });
      else if (action.kind === "reply") plan.reply.push({ value, ...where });
      else if (action.kind === "escalate") plan.escalate.push({ value, ...where });
      plan.applied.push({ ...where, action });
    }
  }

  return plan;
}

/** One ticket's outcome in a dry run. */
export interface DryRunTicket {
  ticketId: string;
  subject: string;
  matched: { ruleId: string; ruleName: string }[];
  plan: RulePlan;
}

/** What a rule *would* do — the answer to "what happens if I switch this on?". */
export interface DryRunReport {
  tickets: DryRunTicket[];
  /** How many tickets matched at least one rule. */
  touched: number;
  /** How many were left alone. */
  untouched: number;
}

/**
 * Run the rules over real tickets and report, without writing anything.
 *
 * This is the test harness: the same `evaluateRules` + `planTicketChanges` the
 * live path uses, applied to tickets that already exist, so the preview cannot
 * disagree with what switching the rule on will do.
 */
export function dryRun(
  rules: readonly RuleRecord[],
  tickets: readonly (RuleTicketView & { id: string })[],
  trigger?: RuleTrigger,
): DryRunReport {
  const report: DryRunReport = { tickets: [], touched: 0, untouched: 0 };
  for (const ticket of tickets) {
    const matched = evaluateRules(rules, ticket, trigger);
    if (matched.length === 0) {
      report.untouched += 1;
      continue;
    }
    report.touched += 1;
    report.tickets.push({
      ticketId: ticket.id,
      subject: ticket.subject,
      matched: matched.map((rule) => ({ ruleId: rule.id, ruleName: rule.name })),
      plan: planTicketChanges(matched),
    });
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/*  Hazards                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What is worth saying out loud about a rule before it is switched on.
 *
 * None of these are refusals. A catch-all is a legitimate rule and an automatic
 * reply is a legitimate rule; both are also the two ways a desk automates
 * something it did not mean to, so they are named rather than left to be
 * discovered from a customer's reply.
 */
export function ruleHazards(rule: { conditions?: readonly RuleCondition[]; actions?: readonly RuleAction[]; enabled?: boolean }): string[] {
  const hazards: string[] = [];
  const conditions = rule.conditions ?? [];

  if (conditions.length === 0) {
    hazards.push("No conditions, so this rule matches every ticket the trigger sees.");
  }
  hazards.push(...actionHazards(rule.actions ?? []));
  if (rule.enabled === false) {
    hazards.push("It is switched off, so none of this is happening yet.");
  }
  return hazards;
}

/**
 * The hazards that belong to the actions themselves, whatever ran them.
 *
 * Shared with macros (M5): running a macro is a deliberate act, but a macro that
 * replies to the customer or pages the on-call is still the same two ways a desk
 * does something it did not mean to, so the console says so either way. The
 * "no conditions" hazard is a rule's alone — a macro has no conditions by design.
 */
export function actionHazards(actions: readonly RuleAction[]): string[] {
  const hazards: string[] = [];
  if (actions.some((action) => action.kind === "reply")) {
    hazards.push("It replies to the customer by itself, under the desk's name, without an agent reading the thread.");
  }
  if (actions.some((action) => action.kind === "escalate")) {
    hazards.push("It can raise an escalation on its own, which will page whoever is on call.");
  }
  if (actions.some((action) => action.kind === "assign_agent")) {
    hazards.push("It assigns work to a named person rather than a queue.");
  }
  return hazards;
}

/** A short human sentence for one action, for a console or a dry-run table. */
export function describeAction(action: RuleAction): string {
  const value = action.value?.trim() ?? "";
  switch (action.kind) {
    case "set_priority":
      return `Set the priority to ${value}`;
    case "set_type":
      return `Set the type to ${value}`;
    case "route_queue":
      return "Route it to the chosen queue";
    case "assign_agent":
      return "Assign it to the chosen agent";
    case "add_tag":
      return `Tag it “${value}”`;
    case "notify":
      return `Notify: ${value}`;
    case "reply":
      return `Reply to the customer: ${value}`;
    case "escalate":
      return value ? `Escalate: ${value}` : "Escalate it";
  }
}

/** A short human sentence for one condition. */
export function describeCondition(condition: RuleCondition): string {
  const list = Array.isArray(condition.value) ? condition.value.join(", ") : String(condition.value ?? "");
  const field = condition.field === "requesterEmail" ? "the requester's address" : condition.field;
  switch (condition.operator) {
    case "contains":
      return `${field} contains “${list}”`;
    case "not_contains":
      return `${field} does not contain “${list}”`;
    case "equals":
      return `${field} is “${list}”`;
    case "not_equals":
      return `${field} is not “${list}”`;
    case "is_one_of":
      return `${field} is one of ${list}`;
    case "is_not_one_of":
      return `${field} is none of ${list}`;
    case "is_empty":
      return `${field} is empty`;
    case "is_not_empty":
      return `${field} is not empty`;
  }
}
