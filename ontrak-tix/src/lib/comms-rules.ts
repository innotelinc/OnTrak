/**
 * Incident communications rules (M3): the message a duty actually sends.
 *
 * M3 tracks the duty, its clock and its acknowledgement — but until now the
 * notice itself was typed from scratch every time, at the worst possible moment,
 * under a 24-hour clock. The failure that produces is not a missing
 * notification; it is a notification that says nothing an authority can act on.
 *
 * So a regime comes with a draft. A template is data — a subject, a body and a
 * line of guidance on what a message of that kind must not forget — and the
 * incident's own facts are substituted in by the same `{{name}}` engine the M1
 * canned responses use. `COMMS_PLACEHOLDERS` is a *superset* of the M1 set, so a
 * canned response can be offered as an incident draft unchanged
 * (`cannedAsCommsTemplate`). Nothing here sends anything: a template proposes
 * the words, a person records them as sent, and the text that went out is kept
 * on the obligation.
 */

import { TEMPLATE_VARS } from "./canned-rules";

/* -------------------------------------------------------------------------- */
/*  Who the notice goes to                                                    */
/* -------------------------------------------------------------------------- */

export type CommsAudience = "REGULATOR" | "CLIENT" | "AFFECTED" | "STAFF";

export const COMMS_AUDIENCES: readonly CommsAudience[] = ["REGULATOR", "CLIENT", "AFFECTED", "STAFF"];

export function audienceLabel(audience: CommsAudience): string {
  switch (audience) {
    case "REGULATOR":
      return "regulator";
    case "CLIENT":
      return "client";
    case "AFFECTED":
      return "affected people";
    case "STAFF":
      return "staff";
  }
}

/* -------------------------------------------------------------------------- */
/*  Placeholders                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The names a draft may use, all of which the incident supplies. Deliberately a
 * superset of the M1 canned-response variables (`ref`, `subject`, `requester`,
 * `agent`) so that a body written for a canned response renders here unchanged.
 */
export const COMMS_VALUE_PLACEHOLDERS = [
  "ref",
  "title",
  "severity",
  "phase",
  "impact",
  "regime",
  "authority",
  "dueAt",
  "detectedAt",
  "declaredAt",
  "tenant",
  "author",
  // The M1 names, kept so a canned response works as an incident draft.
  "subject",
  "requester",
  "agent",
] as const;

/**
 * Names no incident can supply, because only a person can: the categories of
 * data involved, how many people are affected, the material impact. A template
 * is allowed to leave them unresolved on purpose — `commsIssues` then reports
 * the draft as unfinished and the service refuses to record it as sent, which is
 * the point: a breach notice with the affected classes left blank is not a
 * notice, and the rule should say so rather than let it through.
 */
export const COMMS_FILL_IN = [
  "dataCategories",
  "subjectCount",
  "consequences",
  "servicesAffected",
  "scope",
  "materialImpact",
  "informationInvolved",
  "whatYouCanDo",
] as const;

export type CommsFillIn = (typeof COMMS_FILL_IN)[number];

export const COMMS_PLACEHOLDERS = [...COMMS_VALUE_PLACEHOLDERS, ...COMMS_FILL_IN] as const;

export type CommsPlaceholder = (typeof COMMS_PLACEHOLDERS)[number];
export type CommsValues = Partial<Record<CommsPlaceholder, string>>;

export type CommsValueName = (typeof COMMS_VALUE_PLACEHOLDERS)[number];

/**
 * Names are matched case-insensitively but resolved to their canonical spelling,
 * because several of them are camel-cased (`{{detectedAt}}`) and lower-casing the
 * match would look up a key that does not exist — which is how `{{detectedAt}}`
 * once survived into a notice that claimed to be ready.
 */
const PLACEHOLDER_BY_LOWER = new Map<string, CommsPlaceholder>(
  COMMS_PLACEHOLDERS.map((name) => [name.toLowerCase(), name]),
);

/** The canonical name behind a placeholder, or null when the name is unknown. */
export function canonicalPlaceholder(name: string): CommsPlaceholder | null {
  return PLACEHOLDER_BY_LOWER.get(name.toLowerCase()) ?? null;
}

export function isCommsValueName(name: string): name is CommsValueName {
  return (COMMS_VALUE_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * Substitute `{{name}}` placeholders. Unknown names are left untouched — a
 * notice that says `{{authority}}` is obviously unfinished, whereas one that
 * silently says "Dear ," looks finished and is not.
 */
export function renderCommsText(text: string, values: CommsValues = {}): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (match, name: string) => {
    const key = canonicalPlaceholder(name);
    // A fill-in name never has a value, so it survives rendering on purpose.
    const value = key !== null && isCommsValueName(key) ? values[key] : undefined;
    return value === undefined ? match : value;
  });
}

/**
 * Every placeholder named in a piece of text, de-duplicated and in its canonical
 * spelling where the name is known (so a notice reports `{{dataCategories}}`
 * rather than the way it happened to be typed).
 */
export function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([a-z]+)\s*\}\}/gi)) {
    found.add(canonicalPlaceholder(match[1]) ?? match[1].toLowerCase());
  }
  return [...found];
}

/** Placeholders named in the text that this rule set does not know at all. */
export function unknownPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter((name) => !(COMMS_PLACEHOLDERS as readonly string[]).includes(name));
}

/**
 * The fields in a draft that only a person can fill in, so the console can say
 * "three fields to complete" instead of showing a half-sentence.
 */
export function commsFillInFields(text: string): string[] {
  return placeholdersIn(text).filter((name) => (COMMS_FILL_IN as readonly string[]).includes(name));
}

/** Placeholders still unresolved after rendering — i.e. values that were missing. */
export function unresolvedPlaceholders(rendered: string): string[] {
  return placeholdersIn(rendered);
}

/* -------------------------------------------------------------------------- */
/*  The incident's facts, as values                                           */
/* -------------------------------------------------------------------------- */

/** The obligation fields a draft needs. Kept structural so a page can pass rows. */
export interface CommsObligationFacts {
  regime: string;
  label: string;
  authority: string;
  dueAt: string;
  clock: "detected" | "declared";
}

export interface CommsIncidentFacts {
  ref: string;
  title: string;
  severity: string;
  phase: string;
  impact: string;
  detectedAt: string;
  declaredAt: string;
}

/**
 * The facts a page has once and reuses for every duty it renders: the incident
 * itself, the desk's name, and who is recording the notice.
 */
export interface CommsFacts {
  incident: CommsIncidentFacts;
  /** The desk's own name, so the notice can say who is speaking. */
  tenant: string;
  /** Who is recording the notice — the name against it on the record. */
  author: string;
}

export interface CommsContext extends CommsFacts {
  obligation: CommsObligationFacts;
  /**
   * Who is being written to, when that is a person rather than an authority.
   * Falls back to the authority, which is where a regulatory notice goes.
   */
  recipient?: string | null;
}

export function commsValues(context: CommsContext): CommsValues {
  const { incident, obligation } = context;
  const recipient = context.recipient?.trim() || obligation.authority;
  return {
    ref: incident.ref,
    title: incident.title,
    severity: incident.severity,
    phase: incident.phase,
    impact: incident.impact,
    regime: obligation.label,
    authority: obligation.authority,
    dueAt: obligation.dueAt,
    detectedAt: incident.detectedAt,
    declaredAt: incident.declaredAt,
    tenant: context.tenant,
    author: context.author,
    // The M1 names, so a canned body reads correctly here too.
    subject: incident.title,
    requester: recipient,
    agent: context.author,
  };
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

export interface IncidentCommsTemplate {
  key: string;
  label: string;
  audience: CommsAudience;
  /** Regime keys this drafts. Empty means it fits any regime (a generic one). */
  regimes: readonly string[];
  subject: string;
  body: string;
  /** What a message of this kind must not forget. */
  guidance: string;
}

/**
 * The drafts a desk starts with. Shipped rather than empty, for the same reason
 * the M1 defaults are: an empty template library never gets filled in, and this
 * one is most needed at 03:00 on the first hour of somebody's 24-hour clock.
 */
export const INCIDENT_COMMS_TEMPLATES: readonly IncidentCommsTemplate[] = [
  {
    key: "regulator-early-warning",
    label: "Early warning to the authority",
    audience: "REGULATOR",
    regimes: ["nis2-early-warning"],
    subject: "Early warning — {{ref}}: {{title}} ({{severity}})",
    body:
      "To: {{authority}}\nFrom: {{tenant}}\nReference: {{ref}}\n\n" +
      "We are giving early warning of a significant incident under the reporting duty for " +
      "{{regime}}.\n\n" +
      "- Incident: {{ref}} — {{title}}\n" +
      "- Severity: {{severity}} (impact {{impact}})\n" +
      "- Detected: {{detectedAt}}\n" +
      "- Declared: {{declaredAt}}\n" +
      "- Suspected cause: under investigation\n" +
      "- Cross-border impact: under assessment\n\n" +
      "This warning is given without prejudice to the assessment still under way. A fuller " +
      "notification will follow inside the 72-hour window, and we will answer questions " +
      "through {{author}} until then. " +
      "{{author}}, {{tenant}}.",
    guidance:
      "An early warning only has to say that something happened and whether it looks unlawful or malicious. Do not wait for the root cause.",
  },
  {
    key: "regulator-incident-notification",
    label: "Incident notification to the authority",
    audience: "REGULATOR",
    regimes: ["nis2-incident", "nis2-final-report"],
    subject: "Incident notification — {{ref}}: {{title}} ({{severity}})",
    body:
      "To: {{authority}}\nFrom: {{tenant}}\nReference: {{ref}}\n\n" +
      "Incident notification under {{regime}}.\n\n" +
      "1. Nature of the incident: {{title}}.\n" +
      "2. Severity and impact: assessed {{severity}}; impact {{impact}}.\n" +
      "3. Timeline: detected {{detectedAt}}, declared {{declaredAt}}.\n" +
      "4. Indicators of compromise: attached.\n" +
      "5. Measures taken so far: containment under way; the response is running to our " +
      "incident playbook with a named commander and a contemporaneous timeline.\n" +
      "6. Cross-border impact: under assessment.\n\n" +
      "Questions to {{author}}, {{tenant}}.",
    guidance:
      "This is the fuller notification. For a final report, keep the same shape and add the root cause, the mitigation applied in full and the cross-border impact.",
  },
  {
    key: "supervisory-authority-breach",
    label: "Personal-data breach notification",
    audience: "REGULATOR",
    regimes: ["gdpr-breach"],
    subject: "Personal-data breach notification — {{ref}}: {{title}}",
    body:
      "To: {{authority}}\nFrom: {{tenant}}\nReference: {{ref}}\n\n" +
      "Notification of a personal-data breach under {{regime}}.\n\n" +
      "- Nature of the breach: {{title}}.\n" +
      "- Categories of personal data affected: {{dataCategories}}\n" +
      "- Approximate number of data subjects affected: {{subjectCount}}\n" +
      "- Likely consequences: {{consequences}}\n" +
      "- Measures taken: containment under way; the response runs on our incident playbook.\n" +
      "- Contact for the authority: {{author}}, {{tenant}}.\n\n" +
      "This notice is being sent without undue delay from awareness at {{declaredAt}}. " +
      "We will supplement it as the assessment completes.",
    guidance:
      "The categories, the number of data subjects and the likely consequences are questions only a person can answer — fill them in before sending, or say plainly why they are unknown.",
  },
  {
    key: "client-breach-notice",
    label: "Client breach notice",
    audience: "CLIENT",
    regimes: ["contract-24h"],
    subject: "Service incident notice — {{ref}} ({{severity}})",
    body:
      "Dear {{requester}},\n\n" +
      "This is the notice our agreement requires inside its 24-hour window. We are " +
      "responding to an incident that affects the services we provide to you.\n\n" +
      "- What happened: {{title}}\n" +
      "- Severity: {{severity}}\n" +
      "- When we became aware: {{detectedAt}}\n" +
      "- Services affected: {{servicesAffected}}\n" +
      "- What we are doing: containment and recovery are under way, with a named incident " +
      "commander and a contemporaneous record.\n\n" +
      "Your liaison contact is {{author}} ({{tenant}}). We will keep you updated at agreed " +
      "intervals until the incident is closed.",
    guidance:
      "Clients can act on a plain statement of scope and impact. Do not trade certainty you do not have for reassurance — scope is often the one field to leave provisional.",
  },
  {
    key: "securities-material-incident",
    label: "Material incident disclosure",
    audience: "REGULATOR",
    regimes: ["sec-8k"],
    subject: "Material cybersecurity incident — {{ref}} ({{severity}})",
    body:
      "To: {{authority}}\nFrom: {{tenant}}\nReference: {{ref}}\n\n" +
      "Disclosure of a cybersecurity incident we have determined to be material.\n\n" +
      "- Nature of the incident: {{title}}\n" +
      "- Scope: {{scope}}\n" +
      "- Timing: detected {{detectedAt}}, declared {{declaredAt}}\n" +
      "- Material impact or reasonably likely material impact: {{materialImpact}}\n\n" +
      "The determination of materiality was made by the incident commander and recorded in " +
      "the incident's timeline. Contact: {{author}}, {{tenant}}.",
    guidance:
      "Four business days is not four days. Escalate the materiality determination to whoever is accountable for it, and record that decision on the incident.",
  },
  {
    key: "health-breach-notice",
    label: "Breach notice to affected individuals",
    audience: "AFFECTED",
    regimes: ["hipaa-breach"],
    subject: "Notice of a breach of your information — {{ref}}",
    body:
      "Dear {{requester}},\n\n" +
      "We are writing to tell you about an incident that may have involved your protected " +
      "health information, as {{regime}} requires.\n\n" +
      "- What happened: {{title}}\n" +
      "- When: we became aware on {{detectedAt}}\n" +
      "- What information: {{informationInvolved}}\n" +
      "- What we are doing: containment is under way and the affected system has been " +
      "secured; the response runs on our incident playbook.\n" +
      "- What you can do: {{whatYouCanDo}}\n\n" +
      "If you have questions, contact {{author}} at {{tenant}}. We are sorry this happened.",
    guidance:
      "Write this one to be read by a worried person, not by a regulator: plain words, no severity codes, and the practical steps first.",
  },
  {
    key: "incident-holding-statement",
    label: "Holding statement",
    audience: "CLIENT",
    regimes: [],
    subject: "We are responding to an incident — {{ref}}",
    body:
      "We are currently responding to an incident that may affect services. Our team is " +
      "engaged and we are working to contain and restore normal service.\n\n" +
      "We will publish a fuller statement once the scope is confirmed. Questions can go to " +
      "{{author}}.\n\n— {{tenant}}",
    guidance:
      "The generic statement: use it only to say that you are awake and working. Say nothing about scope, cause or data that nobody has verified yet.",
  },
  {
    key: "staff-internal-update",
    label: "Internal update",
    audience: "STAFF",
    regimes: [],
    subject: "Internal update — {{ref}}: {{title}} ({{severity}})",
    body:
      "Team,\n\n" +
      "Status on {{ref}} — {{title}}.\n\n" +
      "- Severity: {{severity}} · phase: {{phase}}\n" +
      "- Declared: {{declaredAt}} · detected: {{detectedAt}}\n" +
      "- Your part: keep working from the playbook and log anything you touch on the " +
      "incident's timeline as it happens.\n" +
      "- Say nothing externally beyond the approved notices; the comms lead owns those.\n\n" +
      "— {{author}}",
    guidance:
      "Internal updates keep people off the phone to each other. Say what you know, say what you do not, and point everyone at the one record.",
  },
];

export function commsTemplateByKey(key: string): IncidentCommsTemplate | null {
  return INCIDENT_COMMS_TEMPLATES.find((template) => template.key === key) ?? null;
}

/**
 * The drafts that fit a regime: the ones that name it, or — when none does — the
 * generic ones, flagged as such so the console can say it is offering a fallback
 * rather than pretending to have a template for that duty.
 */
export function templatesForRegime(regimeKey: string): { template: IncidentCommsTemplate; fallback: boolean }[] {
  const exact = INCIDENT_COMMS_TEMPLATES.filter((template) => template.regimes.includes(regimeKey));
  if (exact.length > 0) return exact.map((template) => ({ template, fallback: false }));
  return INCIDENT_COMMS_TEMPLATES.filter((template) => template.regimes.length === 0).map((template) => ({
    template,
    fallback: true,
  }));
}

/* -------------------------------------------------------------------------- */
/*  The M1 bridge                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A tenant's own canned response, offered as an incident draft. The body is used
 * verbatim: `COMMS_PLACEHOLDERS` contains every M1 variable, so a canned body
 * resolves here without an edit — which is what makes the desk's existing
 * wording usable from an incident rather than only from a ticket.
 */
export function cannedAsCommsTemplate(canned: { id: string; title: string; body: string }): IncidentCommsTemplate {
  return {
    key: `canned:${canned.id}`,
    label: canned.title,
    audience: "AFFECTED",
    regimes: [],
    subject: "{{ref}} — {{title}}",
    body: canned.body,
    guidance:
      "One of the desk's canned responses, sent as an incident notice. It keeps its own wording; the incident's facts arrive through the same placeholders.",
  };
}

/* -------------------------------------------------------------------------- */
/*  Drafts and readiness                                                      */
/* -------------------------------------------------------------------------- */

export const COMMS_MESSAGE_MAX = 20_000;

export interface CommsDraft {
  template: IncidentCommsTemplate;
  /** The rendered subject, as a person would send it. */
  subject: string;
  /** The rendered body. */
  body: string;
  /** Subject and body together — what gets stored as the notice text. */
  message: string;
  /** True when nothing is blank, over-long or left unresolved. */
  ready: boolean;
  /** Why it is not ready, in words the console can show. */
  issues: string[];
  /** The fields only a person can supply, still blank in this draft. */
  fillIn: string[];
  /** True when no template names this regime and a generic one was offered. */
  fallback: boolean;
}

/** What is wrong with a notice text, if anything. Empty means it is sendable. */
export function commsIssues(message: string): string[] {
  const issues: string[] = [];
  const text = message.trim();
  if (!text) issues.push("The notice text is empty.");
  else if (text.length > COMMS_MESSAGE_MAX) {
    issues.push(`The notice may be at most ${COMMS_MESSAGE_MAX} characters.`);
  }
  const unresolved = unresolvedPlaceholders(text);
  if (unresolved.length > 0) {
    issues.push(`Still to fill in: ${unresolved.map((name) => `{{${name}}}`).join(", ")}.`);
  }
  return issues;
}

/**
 * The drafts for one tracked duty, rendered from the incident's facts. A draft
 * is offered whether or not it is "ready": a notice that still has fields to
 * fill in is exactly the thing a person needs to see, with the gaps named.
 */
export function commsDrafts(context: CommsContext): CommsDraft[] {
  const values = commsValues(context);
  return templatesForRegime(context.obligation.regime).map(({ template, fallback }) => {
    const subject = renderCommsText(template.subject, values).trim();
    const body = renderCommsText(template.body, values).trim();
    const message = `${subject}\n\n${body}`;
    const issues = commsIssues(message);
    return {
      template,
      subject,
      body,
      message,
      ready: issues.length === 0,
      issues,
      fillIn: commsFillInFields(message),
      fallback,
    };
  });
}

/** One draft by key, for a caller that knows which template it wants. */
export function commsDraft(context: CommsContext, templateKey: string): CommsDraft | null {
  return commsDrafts(context).find((draft) => draft.template.key === templateKey) ?? null;
}
