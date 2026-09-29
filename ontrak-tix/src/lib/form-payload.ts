/**
 * How a desk's field answers travel in a ticket form.
 *
 * The encoding is one line of convention and it is worth its own file, because it is the
 * contract between the page that renders the inputs and the action that reads them: the
 * answers are posted as `custom:<key>`. Prefixing rather than using the bare key is what
 * keeps a field a desk calls `subject` or `priority` from colliding with the ticket's own
 * columns — and a desk is allowed to call a field anything.
 *
 * Pure, so the round trip can be tested without a browser, a server or a database.
 */
import type { CustomValues } from "./form-rules";

export const CUSTOM_FIELD_PREFIX = "custom:";

/** The input name one field's answer is posted under. */
export function customFieldName(key: string): string {
  return `${CUSTOM_FIELD_PREFIX}${key}`;
}

/** The key an input name carries, or `null` when it is not a custom field's. */
export function customFieldKey(name: string): string | null {
  return name.startsWith(CUSTOM_FIELD_PREFIX) ? name.slice(CUSTOM_FIELD_PREFIX.length) || null : null;
}

/**
 * The answers in a submitted form.
 *
 * Only the last value of a repeated name is kept: a custom field is a single answer, and a
 * form that posted two would be a form whose second one is what the person last typed.
 * Anything not carrying the prefix is ignored rather than guessed at.
 */
export function readCustomValues(formData: FormData): CustomValues {
  const values: CustomValues = {};
  for (const [name, value] of formData.entries()) {
    const key = customFieldKey(name);
    if (key) values[key] = String(value);
  }
  return values;
}
