/**
 * Rule form rules (M5): what a console form's rows mean.
 *
 * A rule is written as a handful of rows — a field, a comparison, a value — and
 * rows are the awkward part of a form: there are always more of them on screen
 * than a person filled in. Two decisions, both about not lying to the reader:
 *
 *  - **A row nobody touched is not a condition.** Blank rows are ignored rather
 *    than turned into conditions on the empty string, which would silently make
 *    a rule match nothing at all.
 *  - **A half-filled row is kept.** If somebody chose a field and stopped, that
 *    is a mistake worth naming, and `validateRule` names it. Dropping it would
 *    save the rule with one condition fewer than its author counted on.
 *
 * Nothing here decides *policy* — that is `rule-rules.ts`. This only turns the
 * parallel arrays a browser posts into the shapes the engine reads.
 */

import {
  ACTION_KINDS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  LIST_OPERATORS,
  VALUELESS,
  type ActionKind,
  type ConditionField,
  type ConditionOperator,
  type RuleAction,
  type RuleCondition,
} from "./rule-rules";

/** How many rows the console offers. The engine's own limits are the ceiling. */
function rows(...columns: readonly (readonly string[])[]): number {
  return columns.reduce((most, column) => Math.max(most, column.length), 0);
}

/**
 * The condition rows a form posted. Parallel arrays (`conditionField[i]`,
 * `conditionOperator[i]`, `conditionValue[i]`) because that is what repeated
 * inputs post, and because it keeps the parser free of the framework.
 */
export function parseConditions(
  fields: readonly string[],
  operators: readonly string[],
  values: readonly string[],
): RuleCondition[] {
  const conditions: RuleCondition[] = [];
  for (let i = 0; i < rows(fields, operators, values); i += 1) {
    const field = (fields[i] ?? "").trim();
    const operator = (operators[i] ?? "").trim();
    if (!field && !operator) continue;

    const condition: RuleCondition = {
      field: field as ConditionField,
      operator: operator as ConditionOperator,
    };
    // The valueless operators carry their value in the field itself; a list
    // comparison takes comma-separated entries, which is what a person types.
    if (!VALUELESS.includes(condition.operator)) {
      const raw = (values[i] ?? "").trim();
      condition.value = LIST_OPERATORS.includes(condition.operator)
        ? raw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : raw;
    }
    conditions.push(condition);
  }
  return conditions;
}

/** The action rows a form posted. An untouched row is not an action. */
export function parseActions(kinds: readonly string[], values: readonly string[]): RuleAction[] {
  const actions: RuleAction[] = [];
  for (let i = 0; i < rows(kinds, values); i += 1) {
    const kind = (kinds[i] ?? "").trim();
    if (!kind) continue;
    const value = (values[i] ?? "").trim();
    actions.push({ kind: kind as ActionKind, ...(value ? { value } : {}) });
  }
  return actions;
}

/** The `datalist` a console offers: every value a rule may point at. */
export interface RuleValueOption {
  /** What is submitted — an id for a queue or an agent, the word itself otherwise. */
  value: string;
  /** What is shown, when it differs from the value. */
  label?: string;
}

/**
 * Everything a rule's `value` field may be, from the words it compares against
 * to the queues and people it can name.
 *
 * Rendered into one `datalist` so `route_queue` and `assign_agent` can name a
 * queue or a colleague without the console needing a script to swap the input
 * for the kind that was chosen.
 */
export function ruleValueOptions(input: {
  queues?: readonly { id: string; name: string }[];
  agents?: readonly { id: string; displayName: string }[];
}): RuleValueOption[] {
  const options: RuleValueOption[] = [
    { value: "URGENT" },
    { value: "HIGH" },
    { value: "NORMAL" },
    { value: "LOW" },
    { value: "INCIDENT" },
    { value: "REQUEST" },
  ];
  for (const queue of input.queues ?? []) options.push({ value: queue.id, label: `queue: ${queue.name}` });
  for (const agent of input.agents ?? []) options.push({ value: agent.id, label: `agent: ${agent.displayName}` });
  return options;
}

/** Whether a value is something the engine will accept for a condition field. */
export function isConditionField(value: string): value is ConditionField {
  return (CONDITION_FIELDS as readonly string[]).includes(value);
}

/** Whether a value is an operator the engine will accept. */
export function isConditionOperator(value: string): value is ConditionOperator {
  return (CONDITION_OPERATORS as readonly string[]).includes(value);
}

/** Whether a value is an action the engine will accept. */
export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}
