"use server";

/**
 * Custom field and form server actions (M6).
 *
 * Every action starts from `requireActor()` and hands the work to `FormService`, which owns
 * the permission (`tenant:manage`), the validation and the audit event. Nothing is decided
 * here — this file reads a form and turns a refusal into a sentence on the page.
 *
 * The layout is read as numbered sections rather than as a blob of text: `section.0.title`,
 * `section.0.field` (repeated, one per checked field) and `section.0.required` (only sent for
 * the boxes that are ticked). A section with neither a title nor any fields is an unused
 * slot and is dropped, so the page can always render the same number of blank sections
 * without them meaning "and also an empty section, thanks".
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { formServicesFor } from "../../lib/db";
import { MAX_SECTIONS, type FormSection } from "../../lib/form-rules";

const FORMS_PATH = "/admin/forms";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath(to.split("?")[0] || FORMS_PATH);
  const joiner = to.includes("?") ? "&" : "?";
  redirect(`${to}${joiner}${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

function options(formData: FormData): string[] {
  return text(formData, "options")
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

/** Define a field, or edit one. The key is only sent when creating. */
export async function saveFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const fieldId = text(formData, "fieldId");
  const input = {
    key: text(formData, "key"),
    label: text(formData, "label"),
    type: text(formData, "type").toUpperCase(),
    options: options(formData),
    requiredByDefault: formData.get("requiredByDefault") === "on",
    placeholder: text(formData, "placeholder"),
    helpText: text(formData, "helpText"),
  };

  const result = fieldId
    ? await formServicesFor().updateField(actor, fieldId, input)
    : await formServicesFor().createField(actor, input);
  if (!result.ok) back(`${FORMS_PATH}?edit=${fieldId}`, result.error, "error");

  back(
    FORMS_PATH,
    fieldId
      ? `Updated “${result.value.label}”. Every ticket that already answered it keeps its answer.`
      : `Added “${result.value.label}” as “${result.value.key}”. Put it on a form below — it is not shown until you do.`,
  );
}

/** Take a field off new forms, or put it back. Values already recorded are untouched. */
export async function archiveFieldAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const archived = text(formData, "archived") === "true";
  const result = await formServicesFor().archiveField(actor, text(formData, "fieldId"), archived);
  if (!result.ok) back(FORMS_PATH, result.error, "error");

  back(
    FORMS_PATH,
    archived
      ? `“${result.value.label}” is off new forms. Every ticket that answered it still reads, and it can be restored.`
      : `“${result.value.label}” is on forms again wherever a layout names it.`,
  );
}

/** Save the form for one queue, or the tenant's default form when no queue is chosen. */
export async function saveLayoutAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const queueId = text(formData, "queueId") || null;

  const sections: FormSection[] = [];
  for (let index = 0; index < MAX_SECTIONS; index += 1) {
    const title = text(formData, `section.${index}.title`);
    const fieldKeys = formData.getAll(`section.${index}.field`).map((value) => String(value));
    // A required box is only sent when it is ticked, so the filter keeps the requirement
    // pointed at a field that is actually on the section.
    const requiredKeys = formData
      .getAll(`section.${index}.required`)
      .map((value) => String(value))
      .filter((key) => fieldKeys.includes(key));
    if (!title && fieldKeys.length === 0) continue;
    sections.push({ title: title || `Section ${index + 1}`, fieldKeys, ...(requiredKeys.length > 0 ? { requiredKeys } : {}) });
  }

  const result = await formServicesFor().setLayout(actor, { queueId, sections });
  if (!result.ok) back(`${FORMS_PATH}?queue=${queueId ?? ""}`, result.error, "error");

  const fields = result.value.sections.reduce((total, section) => total + section.fieldKeys.length, 0);
  back(
    `${FORMS_PATH}?queue=${queueId ?? ""}`,
    queueId
      ? `Saved that queue's form: ${fields} field${fields === 1 ? "" : "s"}. Every ticket raised into it is checked against it.`
      : `Saved the default form: ${fields} field${fields === 1 ? "" : "s"}. Queues without a form of their own use it, and so does a ticket with no queue.`,
  );
}

/** Forget a queue's form, so it goes back to inheriting the default. */
export async function removeLayoutAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const queueId = text(formData, "queueId");
  const result = await formServicesFor().removeLayout(actor, queueId || null);
  if (!result.ok) back(`${FORMS_PATH}?queue=${queueId}`, result.error, "error");
  back(FORMS_PATH, "That queue has no form of its own again; it uses the default one.");
}
