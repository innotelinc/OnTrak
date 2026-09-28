/**
 * Ticket template rules (M1): the shapes a desk logs often enough to stop
 * retyping — "New starter", "Password reset", "Laptop replacement".
 *
 * A template is a *starting point*, not a rule: it prefills the subject,
 * description, type and priority of a new ticket, and the agent is free to edit
 * every field afterwards. Keeping it declarative (rather than a workflow) means
 * the same template can be reviewed as plain text.
 *
 * The text may use `{{requester}}`, `{{agent}}`, `{{date}}` and `{{tenant}}`,
 * which are substituted when the template is applied. Substitution is pure and
 * tested, so a template body renders identically wherever it is used.
 */

import { TICKET_PRIORITIES, TICKET_TYPES, type TicketPriority, type TicketType } from "./ticket-rules";

export interface TicketTemplate {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  /** An optional queue the ticket is routed into when the template is used. */
  queueId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TEMPLATE_PLACEHOLDERS = ["requester", "agent", "date", "tenant"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export type TemplateRenderValues = Partial<Record<TemplatePlaceholder, string>>;

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_SUBJECT_MAX = 200;
export const TEMPLATE_DESCRIPTION_MAX = 10_000;

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders are left untouched
 * (rather than blanked) so an author notices a typo instead of shipping a
 * ticket that says "Hello .".
 */
export function renderTemplateText(text: string, values: TemplateRenderValues = {}): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (match, name: string) => {
    const key = name.toLowerCase() as TemplatePlaceholder;
    const value = values[key];
    return value === undefined ? match : value;
  });
}

/** The fields a template contributes to a new ticket, with placeholders applied. */
export function applyTicketTemplate(
  template: TicketTemplate,
  values: TemplateRenderValues = {},
): { subject: string; description: string; type: TicketType; priority: TicketPriority; queueId: string | null } {
  return {
    subject: renderTemplateText(template.subject, values).trim(),
    description: renderTemplateText(template.description, values).trim(),
    type: template.type,
    priority: template.priority,
    queueId: template.queueId,
  };
}

export interface TemplateIssue {
  field: string;
  message: string;
}

/** Validate a template before it is stored. Returns every problem, not the first. */
export function validateTicketTemplate(input: Partial<TicketTemplate>): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A template name is required." });
  else if (name.length > TEMPLATE_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${TEMPLATE_NAME_MAX} characters.` });
  }

  const subject = input.subject?.trim() ?? "";
  if (!subject) issues.push({ field: "subject", message: "A subject is required." });
  else if (subject.length > TEMPLATE_SUBJECT_MAX) {
    issues.push({ field: "subject", message: `The subject may be at most ${TEMPLATE_SUBJECT_MAX} characters.` });
  }

  const description = input.description?.trim() ?? "";
  if (!description) issues.push({ field: "description", message: "A description is required." });
  else if (description.length > TEMPLATE_DESCRIPTION_MAX) {
    issues.push({ field: "description", message: `The description may be at most ${TEMPLATE_DESCRIPTION_MAX} characters.` });
  }

  if (input.type !== undefined && !TICKET_TYPES.includes(input.type)) {
    issues.push({ field: "type", message: "That is not a known ticket type." });
  }
  if (input.priority !== undefined && !TICKET_PRIORITIES.includes(input.priority)) {
    issues.push({ field: "priority", message: "That is not a known priority." });
  }

  return issues;
}

/**
 * The templates a new desk starts with. Shipped as defaults rather than empty,
 * because an empty template list never gets filled in.
 */
export const DEFAULT_TICKET_TEMPLATES: readonly {
  name: string;
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
}[] = [
  {
    name: "New starter",
    subject: "New starter setup — {{requester}} ({{date}})",
    type: "REQUEST",
    priority: "NORMAL",
    description:
      "Account and equipment for a new starter.\n\n" +
      "- Create the directory account and add the standard groups\n" +
      "- Issue a laptop and enrol it in device management\n" +
      "- Set up mail, chat and the shared drive\n" +
      "- Book the onboarding session with the team\n\n" +
      "Requested by: {{requester}}\nHandled by: {{agent}}",
  },
  {
    name: "Password reset",
    subject: "Password reset for {{requester}}",
    type: "REQUEST",
    priority: "HIGH",
    description:
      "The user cannot sign in and believes the password is wrong or expired.\n\n" +
      "Identity confirmed by: {{requester}}\n\n" +
      "Steps taken:\n" +
      "1. Confirm the identity of the caller\n" +
      "2. Reset the password and require a change at next sign-in\n" +
      "3. Check for a lockout or a stale cached credential on the device",
  },
  {
    name: "Broken hardware",
    subject: "Hardware fault — describe the device and the symptom",
    type: "INCIDENT",
    priority: "NORMAL",
    description:
      "Device:\n" +
      "Asset tag:\n" +
      "Symptom and when it started:\n" +
      "What changed just before:\n" +
      "Error message (exact wording):\n" +
      "Impact — one person, one team, or everyone?:\n\n" +
      "Logged by: {{requester}}",
  },
];
