"use server";

/**
 * Rule console actions (M5): the app-facing entry points for `/rules`.
 *
 * As everywhere else in the desk, these only marshal form data and translate a
 * `ServiceResult` into a redirect. The permission (`rule:manage`), the
 * validation and the audit event all belong to `RuleService` — putting a second
 * copy of the rule here is how two copies drift apart.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { ruleServicesFor } from "../../lib/db";
import { parseActions, parseConditions } from "../../lib/rule-form-rules";

const HOME = "/rules";

function fail(message: string): never {
  redirect(`${HOME}?error=${encodeURIComponent(message)}`);
}

function done(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?flash=${encodeURIComponent(message)}`);
}

/** The parallel arrays a rule form posts, as the parser wants them. */
function columns(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => String(value ?? ""));
}

/** Write a rule from the console form. */
export async function createRuleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const result = await ruleServicesFor().create(actor, {
    name: String(formData.get("name") ?? ""),
    trigger: String(formData.get("trigger") ?? ""),
    conditions: parseConditions(
      columns(formData, "conditionField"),
      columns(formData, "conditionOperator"),
      columns(formData, "conditionValue"),
    ),
    actions: parseActions(columns(formData, "actionKind"), columns(formData, "actionValue")),
  });

  if (!result.ok) fail(result.error);
  done(`Rule “${result.value.name}” saved`);
}

/** Switch a rule on or off, without losing anything about it. */
export async function setRuleEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const ruleId = String(formData.get("ruleId") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!ruleId) fail("Choose a rule first.");

  const result = await ruleServicesFor().setEnabled(actor, ruleId, enabled);
  if (!result.ok) fail(result.error);
  done(`${enabled ? "Rule switched on" : "Rule switched off"}: ${result.value.name}`);
}

/** Move a rule one place in the order it runs. */
export async function moveRuleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const ruleId = String(formData.get("ruleId") ?? "");
  const direction = String(formData.get("direction") ?? "") === "up" ? "up" : "down";
  if (!ruleId) fail("Choose a rule first.");

  const result = await ruleServicesFor().move(actor, ruleId, direction);
  if (!result.ok) fail(result.error);
  done("Rule order updated");
}

/** Remove a rule. What it did stays on the audit chain. */
export async function removeRuleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const ruleId = String(formData.get("ruleId") ?? "");
  if (!ruleId) fail("Choose a rule first.");

  const result = await ruleServicesFor().remove(actor, ruleId);
  if (!result.ok) fail(result.error);
  done("Rule removed");
}
