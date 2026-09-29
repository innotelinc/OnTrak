"use server";

/**
 * Macro console actions (M5): the app-facing entry points for `/macros`.
 *
 * As everywhere else in the desk, these only marshal form data and translate a
 * `ServiceResult` into a redirect. The permission (`rule:manage`), the validation
 * and the audit event all belong to `MacroService` — a second copy of the rules
 * here is how two copies drift apart.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { macroServicesFor } from "../../lib/db";
import { parseActions } from "../../lib/rule-form-rules";

const HOME = "/macros";

function fail(message: string): never {
  redirect(`${HOME}?error=${encodeURIComponent(message)}`);
}

function done(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?flash=${encodeURIComponent(message)}`);
}

/** The action rows a macro form posts, as the parser wants them. */
function columns(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => String(value ?? ""));
}

/**
 * Write a macro from the console form.
 *
 * One action serves both create and edit: a hidden `macroId` means the form was
 * opened from an existing macro, so the same rows that wrote it can change it —
 * the service decides which, and audits either way.
 */
export async function saveMacroAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const macroId = String(formData.get("macroId") ?? "").trim();
  const input = {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    actions: parseActions(columns(formData, "actionKind"), columns(formData, "actionValue")),
  };

  const result = macroId
    ? await macroServicesFor().update(actor, macroId, input)
    : await macroServicesFor().create(actor, input);

  if (!result.ok) fail(result.error);
  done(`Macro “${result.value.name}” saved`);
}

/** Switch a macro on or off, without losing anything about it. */
export async function setMacroEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const macroId = String(formData.get("macroId") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!macroId) fail("Choose a macro first.");

  const result = await macroServicesFor().setEnabled(actor, macroId, enabled);
  if (!result.ok) fail(result.error);
  done(`${enabled ? "Macro switched on" : "Macro switched off"}: ${result.value.name}`);
}

/** Remove a macro. What one click did stays on the audit chain. */
export async function removeMacroAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const macroId = String(formData.get("macroId") ?? "");
  if (!macroId) fail("Choose a macro first.");

  const result = await macroServicesFor().remove(actor, macroId);
  if (!result.ok) fail(result.error);
  done("Macro removed");
}
