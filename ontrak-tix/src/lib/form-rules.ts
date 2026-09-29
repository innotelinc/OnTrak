/**
 * Custom fields and ticket forms (M6): the pure half.
 *
 * Every desk eventually asks for the same two things, and they are the same feature seen
 * from opposite ends: *"our tickets need a location and a change window"* (a custom field)
 * and *"the network queue should not show those, and the facilities queue needs a room"*
 * (a per-queue layout). This module decides what a field may be, which fields a given
 * queue's form has, and whether the values somebody typed are values this desk accepts.
 *
 * Four decisions worth stating out loud:
 *
 *  - **A value is stored as a string, whatever the field's type.** A number is a number
 *    when it is validated, not when it is stored, so the record stays readable by anything
 *    that can read JSON and a change of type is a validation change rather than a
 *    migration. The invoice CSV, the API and the console all see the same thing.
 *  - **Unknown keys are refused, not ignored.** A form that silently dropped a field
 *    somebody filled in is a form that loses work; refusing it with the key named is how
 *    the person finds out their browser was posting to an older layout.
 *  - **A required field is required by the layout, not by the field.** The same field can
 *    be optional on one queue's form and required on another's, which is what "per-queue
 *    layout" has to mean to be worth having — and the rule lives in `validateValues`, so
 *    the answer is the same wherever a ticket is raised from.
 *  - **Archiving beats deleting.** A field that has ever held a value is part of a ticket's
 *    history; `archived` takes it off new forms and leaves every old one readable. There is
 *    no `removeField`.
 */

import type { Role } from "./access-rules";

/* -------------------------------------------------------------------------- */
/*  Fields                                                                    */
/* -------------------------------------------------------------------------- */

export const FIELD_TYPES = ["TEXT", "TEXTAREA", "NUMBER", "SELECT", "CHECKBOX", "DATE"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface CustomFieldRecord {
  id: string;
  tenantId: string;
  /**
   * The stable key a value is stored under. Separate from the label because a label gets
   * renamed ("Room" → "Location") and renaming it must not orphan the values already
   * recorded under it.
   */
  key: string;
  label: string;
  type: FieldType;
  /** The choices, for a `SELECT`. Empty for every other type. */
  options: readonly string[];
  /** Read by the layout's own required list — see the note above. */
  requiredByDefault: boolean;
  placeholder: string;
  helpText: string;
  /** Off new forms, still readable on every ticket that holds a value. */
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const FIELD_LABEL_MAX = 80;
export const FIELD_KEY_MAX = 40;
export const FIELD_VALUE_MAX = 2000;
export const FIELD_OPTION_MAX = 60;
export const MAX_FIELD_OPTIONS = 50;
export const MAX_FIELDS = 40;
export const MAX_SECTIONS = 10;
export const SECTION_TITLE_MAX = 60;
export const MAX_CUSTOM_VALUES = MAX_FIELDS;

export interface FormIssue {
  field: string;
  message: string;
}

/** The types that carry a list of choices, and therefore need at least two. */
export function needsOptions(type: FieldType): boolean {
  return type === "SELECT";
}

/** The types whose value is a number, so a rule or a report can add them up. */
export function isNumeric(type: FieldType): boolean {
  return type === "NUMBER";
}

export function validateField(input: {
  key?: string;
  label?: string;
  type?: string;
  options?: readonly string[];
  placeholder?: string;
  helpText?: string;
}): FormIssue[] {
  const issues: FormIssue[] = [];

  const label = input.label?.trim() ?? "";
  if (!label) issues.push({ field: "label", message: "A label is required — it is what the person filling the form reads." });
  else if (label.length > FIELD_LABEL_MAX) issues.push({ field: "label", message: `The label may be at most ${FIELD_LABEL_MAX} characters.` });

  const key = input.key?.trim() ?? "";
  if (!key) issues.push({ field: "key", message: "A key is required — it is how the value is stored." });
  else if (key.length > FIELD_KEY_MAX) issues.push({ field: "key", message: `The key may be at most ${FIELD_KEY_MAX} characters.` });
  else if (!FIELD_KEY_PATTERN.test(key)) {
    issues.push({
      field: "key",
      message: "A key is lower-case letters, digits and underscores, and starts with a letter — it ends up in stored JSON.",
    });
  }

  const type = (input.type ?? "").toUpperCase();
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    issues.push({ field: "type", message: "Choose what kind of value this field holds." });
  }

  const options = (input.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0);
  if (needsOptions(type as FieldType)) {
    if (options.length < 2) issues.push({ field: "options", message: "A choice field needs at least two options." });
    else if (options.length > MAX_FIELD_OPTIONS) {
      issues.push({ field: "options", message: `A choice field may have at most ${MAX_FIELD_OPTIONS} options.` });
    }
    const tooLong = options.find((option) => option.length > FIELD_OPTION_MAX);
    if (tooLong) issues.push({ field: "options", message: `An option may be at most ${FIELD_OPTION_MAX} characters.` });
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
      issues.push({ field: "options", message: "Two options read the same; a person cannot choose between them." });
    }
  } else if (options.length > 0) {
    issues.push({ field: "options", message: "Only a choice field carries options." });
  }

  if ((input.placeholder ?? "").length > FIELD_LABEL_MAX) {
    issues.push({ field: "placeholder", message: `The placeholder may be at most ${FIELD_LABEL_MAX} characters.` });
  }
  if ((input.helpText ?? "").length > 300) {
    issues.push({ field: "helpText", message: "The help text may be at most 300 characters." });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Layouts                                                                   */
/* -------------------------------------------------------------------------- */

export interface FormSection {
  title: string;
  /** Field keys, in the order they appear. The pair with `title` is the whole layout. */
  fieldKeys: readonly string[];
  /**
   * The keys this *section's* form requires, when that is more than the field's own
   * default. Kept per layout rather than per field because the same field is very often
   * optional on one queue's form and required on another's — which is the whole point of
   * a per-queue layout.
   */
  requiredKeys?: readonly string[];
}

export interface QueueFormRecord {
  id: string;
  tenantId: string;
  /** The queue this layout is for, or `null` for the tenant's default form. */
  queueId: string | null;
  sections: readonly FormSection[];
  updatedBy: string;
  updatedAt: string;
}

export interface ResolvedField extends CustomFieldRecord {
  /** Whether *this layout* requires it, which may differ from the field's default. */
  required: boolean;
}

export interface ResolvedSection {
  title: string;
  fields: ResolvedField[];
}

export interface FormLayout {
  /** The queue this layout was resolved for, or `null` for the default form. */
  queueId: string | null;
  /** True when no layout row named this queue and the default was used. */
  inherited: boolean;
  sections: ResolvedSection[];
  /** Every field on the form, for a quick lookup. */
  fields: ResolvedField[];
}

/**
 * Refuse a layout that references a field the tenant does not have, or one twice.
 *
 * A key that does not exist is the mistake worth catching: it renders as an empty gap
 * nobody notices, and the field it was supposed to show is silently missing from every
 * ticket in that queue.
 */
export function validateLayout(sections: readonly FormSection[], fields: readonly CustomFieldRecord[]): FormIssue[] {
  const issues: FormIssue[] = [];
  const known = new Map(fields.filter((field) => !field.archived).map((field) => [field.key, field]));

  if (sections.length === 0) issues.push({ field: "sections", message: "A form needs at least one section." });
  else if (sections.length > MAX_SECTIONS) {
    issues.push({ field: "sections", message: `A form may have at most ${MAX_SECTIONS} sections.` });
  }

  const seen = new Set<string>();
  let total = 0;
  for (const [index, section] of sections.entries()) {
    const title = section.title.trim();
    if (!title) issues.push({ field: `sections.${index}.title`, message: "Every section needs a title." });
    else if (title.length > SECTION_TITLE_MAX) {
      issues.push({ field: `sections.${index}.title`, message: `A section title may be at most ${SECTION_TITLE_MAX} characters.` });
    }

    for (const key of section.fieldKeys) {
      total += 1;
      if (!known.has(key)) {
        issues.push({ field: `sections.${index}`, message: `“${key}” is not an active custom field.` });
        continue;
      }
      if (seen.has(key)) {
        issues.push({ field: `sections.${index}`, message: `“${key}” appears twice; a form shows a field once.` });
        continue;
      }
      seen.add(key);
    }

    // A required key that is not on the form could never be satisfied, which would make
    // every ticket in the queue unraisable rather than merely unvalidated.
    for (const key of section.requiredKeys ?? []) {
      if (!section.fieldKeys.includes(key)) {
        issues.push({ field: `sections.${index}`, message: `“${key}” is required but is not on this form.` });
      }
    }
  }

  if (total > MAX_FIELDS) issues.push({ field: "sections", message: `A form may show at most ${MAX_FIELDS} fields.` });

  return issues;
}

/**
 * The form a queue actually has.
 *
 * The queue's own layout when it has one, the tenant's default when it does not, and —
 * when neither exists — every active field in the order it was created, which is what a
 * desk that has only ever added fields expects to see. `inherited` says which of those
 * happened, because "why is this queue's form different from what I set?" is answered by
 * that one word.
 */
export function resolveLayout(
  fields: readonly CustomFieldRecord[],
  layouts: readonly QueueFormRecord[],
  queueId: string | null,
): FormLayout {
  const active = fields.filter((field) => !field.archived);
  const byKey = new Map(active.map((field) => [field.key, field]));
  const explicit = queueId === null ? null : (layouts.find((layout) => layout.queueId === queueId) ?? null);
  const fallback = layouts.find((layout) => layout.queueId === null) ?? null;
  const chosen = explicit ?? fallback;

  if (!chosen) {
    return {
      queueId,
      inherited: queueId !== null,
      sections: active.length > 0 ? [{ title: "Details", fields: active.map((field) => ({ ...field, required: field.requiredByDefault })) }] : [],
      fields: active.map((field) => ({ ...field, required: field.requiredByDefault })),
    };
  }

  const sections: ResolvedSection[] = [];
  const resolved: ResolvedField[] = [];
  for (const section of chosen.sections) {
    const sectionFields: ResolvedField[] = [];
    for (const key of section.fieldKeys) {
      const field = byKey.get(key);
      // A field archived after the layout was written is skipped rather than rendered
      // from a stale row: archiving is how a desk takes a field off the form.
      if (!field) continue;
      const entry: ResolvedField = {
        ...field,
        required: field.requiredByDefault || (section.requiredKeys ?? []).includes(key),
      };
      sectionFields.push(entry);
      resolved.push(entry);
    }
    sections.push({ title: section.title, fields: sectionFields });
  }

  return { queueId, inherited: explicit === null, sections, fields: resolved };
}

/* -------------------------------------------------------------------------- */
/*  Values                                                                    */
/* -------------------------------------------------------------------------- */

export type CustomValues = Record<string, string>;

function canonicalNumber(raw: string): string | null {
  // A plain decimal, and nothing JavaScript would parse into something surprising:
  // `Number("0x10")` is 16 and `Number("")` is 0, and neither is what a person typed.
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? String(value) : null;
}

function canonicalDate(raw: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : null;
}

/**
 * One value as this field's type, or the reason it is not one.
 *
 * Returns the canonical string rather than a typed value, so what is stored is what was
 * validated — a number normalised to `String(Number(...))` and a checkbox to `"true"` or
 * `"false"` rather than to whatever a browser sent.
 */
export function coerceValue(field: Pick<CustomFieldRecord, "type" | "options" | "label">, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : raw === true ? "true" : raw === false ? "false" : "";

  if (field.type === "CHECKBOX") {
    if (["true", "on", "yes", "1"].includes(text.toLowerCase())) return { ok: true, value: "true" };
    if (["false", "off", "no", "0", ""].includes(text.toLowerCase())) return { ok: true, value: "false" };
    return { ok: false, error: `“${field.label}” is either ticked or not.` };
  }

  if (!text) return { ok: true, value: "" };

  if (text.length > FIELD_VALUE_MAX) {
    return { ok: false, error: `“${field.label}” may be at most ${FIELD_VALUE_MAX} characters.` };
  }

  if (isNumeric(field.type)) {
    const number = canonicalNumber(text);
    return number === null
      ? { ok: false, error: `“${field.label}” must be a number.` }
      : { ok: true, value: number };
  }

  if (field.type === "DATE") {
    const date = canonicalDate(text);
    return date === null ? { ok: false, error: `“${field.label}” must be a date, as YYYY-MM-DD.` } : { ok: true, value: date };
  }

  if (field.type === "SELECT") {
    const match = field.options.find((option) => option.toLowerCase() === text.toLowerCase());
    return match === undefined
      ? { ok: false, error: `“${text}” is not one of the choices for “${field.label}”.` }
      : { ok: true, value: match };
  }

  return { ok: true, value: text };
}

/**
 * Whether a whole form's answers are answers this desk accepts.
 *
 * Two refusals that matter beyond "required": a key the layout does not carry (a stale
 * browser, or a caller posting to the API with a field somebody archived), and a required
 * field left blank. Both name the field, because the person who has to fix it is the person
 * filling the form.
 */
export function validateValues(
  layout: FormLayout,
  values: unknown,
): { ok: true; value: CustomValues } | { ok: false; issues: FormIssue[] } {
  if (values === undefined || values === null) values = {};
  if (typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, issues: [{ field: "customFields", message: "Custom field values must be an object keyed by field." }] };
  }

  const input = values as Record<string, unknown>;
  const issues: FormIssue[] = [];
  const out: CustomValues = {};
  const byKey = new Map(layout.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) {
      issues.push({ field: key, message: `“${key}” is not on this form; it may have been archived since the page was rendered.` });
    }
  }
  if (Object.keys(input).length > MAX_CUSTOM_VALUES) {
    issues.push({ field: "customFields", message: `A ticket may hold at most ${MAX_CUSTOM_VALUES} custom values.` });
  }

  for (const field of layout.fields) {
    const raw = input[field.key];
    const coerced = coerceValue(field, raw);
    if (!coerced.ok) {
      issues.push({ field: field.key, message: coerced.error });
      continue;
    }
    // An unticked checkbox is empty, and a *required* checkbox is one somebody had to
    // tick — "I have read the change policy" is a real field and a blank one is not an
    // answer to it.
    const empty = field.type === "CHECKBOX" ? coerced.value === "false" : coerced.value === "";
    if (field.required && empty) {
      issues.push({ field: field.key, message: `“${field.label}” is required on this form.` });
      continue;
    }
    if (!empty) out[field.key] = coerced.value;
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

/** The values as a ticket view shows them: labelled, ordered, and empty ones left out. */
export function summarizeValues(
  fields: readonly CustomFieldRecord[],
  values: CustomValues | undefined,
): { key: string; label: string; value: string }[] {
  if (!values) return [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return Object.entries(values)
    .map(([key, value]) => ({ key, label: byKey.get(key)?.label ?? key, value }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The shape check a stored ticket can be given without knowing any field definitions. */
export function validateStoredValues(values: unknown): FormIssue[] {
  if (values === undefined || values === null) return [];
  if (typeof values !== "object" || Array.isArray(values)) {
    return [{ field: "customFields", message: "Custom field values must be an object keyed by field." }];
  }
  const issues: FormIssue[] = [];
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_VALUES) {
    issues.push({ field: "customFields", message: `A ticket may hold at most ${MAX_CUSTOM_VALUES} custom values.` });
  }
  for (const [key, value] of entries) {
    if (!FIELD_KEY_PATTERN.test(key)) issues.push({ field: key, message: `“${key}” is not a field key.` });
    if (typeof value !== "string") issues.push({ field: key, message: `“${key}” must be stored as text.` });
    else if (value.length > FIELD_VALUE_MAX) {
      issues.push({ field: key, message: `“${key}” may be at most ${FIELD_VALUE_MAX} characters.` });
    }
  }
  return issues;
}

/** Who may reshape the forms. The same line every other tenant-wide setting draws. */
export function canManageForms(role: Role): boolean {
  return role === "ADMIN";
}
