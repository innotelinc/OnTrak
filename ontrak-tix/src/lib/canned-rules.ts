/**
 * Canned response rules (M1): the reusable agent replies a desk keeps so the
 * common questions are answered the same way every time.
 *
 * A canned response is a title, a body and an optional shortcut. The body may
 * reference `{{ref}}`, `{{subject}}`, `{{requester}}` and `{{agent}}`, which are
 * substituted when the response is inserted into a reply. Substitution is pure
 * and tested, so what an agent sees in the composer is exactly what the
 * requester would receive.
 */

export interface CannedResponse {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  /** A short trigger, e.g. `reset`. Unique per tenant when set. */
  shortcut: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TEMPLATE_VARS = ["ref", "subject", "requester", "agent"] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export type TemplateValues = Partial<Record<TemplateVar, string>>;

export const CANNED_TITLE_MAX = 120;
export const CANNED_BODY_MAX = 5_000;

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders are left untouched
 * (rather than blanked) so an agent notices a typo instead of silently sending
 * an empty greeting.
 */
export function applyCannedTemplate(body: string, values: TemplateValues = {}): string {
  return body.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (match, name: string) => {
    const key = name.toLowerCase() as TemplateVar;
    const value = values[key];
    return value === undefined ? match : value;
  });
}

export interface CannedIssue {
  field: string;
  message: string;
}

/** Validate a canned response before it is stored. Returns every problem. */
export function validateCannedResponse(input: Partial<CannedResponse>): CannedIssue[] {
  const issues: CannedIssue[] = [];

  const title = input.title?.trim() ?? "";
  if (!title) issues.push({ field: "title", message: "A title is required." });
  else if (title.length > CANNED_TITLE_MAX) {
    issues.push({ field: "title", message: `The title may be at most ${CANNED_TITLE_MAX} characters.` });
  }

  const body = input.body?.trim() ?? "";
  if (!body) issues.push({ field: "body", message: "A body is required." });
  else if (body.length > CANNED_BODY_MAX) {
    issues.push({ field: "body", message: `The body may be at most ${CANNED_BODY_MAX} characters.` });
  }

  const shortcut = input.shortcut?.trim();
  if (shortcut && !/^[a-z0-9_-]{2,24}$/i.test(shortcut)) {
    issues.push({ field: "shortcut", message: "A shortcut is 2–24 letters, digits, dashes or underscores." });
  }

  return issues;
}

/**
 * The responses a new desk starts with. Shipped as defaults rather than empty,
 * because an empty canned-response list never gets filled in.
 */
export const DEFAULT_CANNED_RESPONSES: readonly { title: string; body: string; shortcut: string | null }[] = [
  {
    title: "Acknowledge and triage",
    shortcut: "ack",
    body:
      "Hi {{requester}},\n\nThanks for reaching out — I've logged this as {{ref}} and I'm taking a look now. " +
      "I'll follow up here as soon as I have an update.\n\n— {{agent}}",
  },
  {
    title: "Need more information",
    shortcut: "info",
    body:
      "Hi {{requester}},\n\nTo move {{ref}} along I need a little more detail: when the problem started, " +
      "what changed just before, and the exact wording of any error message. A screenshot helps too.\n\n— {{agent}}",
  },
  {
    title: "Resolved",
    shortcut: "resolved",
    body:
      "Hi {{requester}},\n\nGood news — this is resolved. I'm marking {{ref}} as resolved, but reply here if it " +
      "comes back and I'll reopen it.\n\n— {{agent}}",
  },
];
