/**
 * OnTrak Tix M3 tests: incident communications templates.
 *
 * The duty, its clock and its acknowledgement were already tracked; these tests
 * cover the message itself — that a regime comes with words, that the incident's
 * own facts are substituted in by the same engine the M1 canned responses use,
 * that a field only a person can fill in is reported rather than glossed over,
 * and that the text that went out is kept on the record.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-comms.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { DEFAULT_CANNED_RESPONSES, TEMPLATE_VARS } from "../src/lib/canned-rules";
import {
  COMMS_FILL_IN,
  COMMS_MESSAGE_MAX,
  COMMS_PLACEHOLDERS,
  INCIDENT_COMMS_TEMPLATES,
  audienceLabel,
  cannedAsCommsTemplate,
  commsDraft,
  commsDrafts,
  commsFillInFields,
  commsIssues,
  commsTemplateByKey,
  commsValues,
  placeholdersIn,
  renderCommsText,
  templatesForRegime,
  unknownPlaceholders,
  type CommsContext,
} from "../src/lib/comms-rules";
import { IncidentComplianceService, MemoryComplianceStore } from "../src/lib/compliance-service";
import { IncidentService, MemoryIncidentStore, type IncidentRecord } from "../src/lib/incident-service";
import { NOTIFICATION_REGIMES, type NotificationObligation } from "../src/lib/regulatory-rules";
import { NotificationPanel } from "../src/components/IncidentCompliance";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };

/* --------------------------------------------------------------- vocabulary */

test("the draft vocabulary covers the M1 canned variables, so a canned response drafts a notice", () => {
  for (const name of TEMPLATE_VARS) {
    assert.ok((COMMS_PLACEHOLDERS as readonly string[]).includes(name), `${name} is missing from the comms placeholders`);
  }
  // Every name a template uses is either supplied by the incident or is one of
  // the fields a person fills in — never a typo.
  for (const template of INCIDENT_COMMS_TEMPLATES) {
    assert.deepEqual(unknownPlaceholders(`${template.subject}\n${template.body}`), [], `${template.key} names an unknown placeholder`);
  }
  // Fill-ins are known names, so they are reported as unfinished rather than
  // flagged as typos.
  assert.deepEqual(unknownPlaceholders("{{dataCategories}}"), []);
  assert.deepEqual(unknownPlaceholders("{{nope}}"), ["nope"]);
  assert.equal(COMMS_FILL_IN.includes("dataCategories"), true);
  assert.equal((COMMS_FILL_IN as readonly string[]).includes("authority"), false);
});

test("substitution is pure: values land, unmatched names survive, and names ignore case and spacing", () => {
  const values = { ref: "INC-000042", authority: "National CSIRT", author: "Ada" };
  assert.equal(renderCommsText("{{ref}} → {{authority}} ({{author}})", values), "INC-000042 → National CSIRT (Ada)");
  assert.equal(renderCommsText("{{ REF }} and {{ref}}", values), "INC-000042 and INC-000042");
  // A missing value is left visible on purpose: a notice that says {{dueAt}} is
  // obviously unfinished, where "due " looks finished and is not.
  assert.equal(renderCommsText("{{dueAt}} {{nope}}", values), "{{dueAt}} {{nope}}");
  assert.deepEqual(placeholdersIn("{{ref}} {{ref}} {{title}}"), ["ref", "title"]);
  assert.deepEqual(commsFillInFields("scope: {{scope}}, ref: {{ref}}"), ["scope"]);
  assert.equal(renderCommsText("nothing to do"), "nothing to do");
});

test("every M1 canned response renders as an incident notice with nothing left half-said", () => {
  const context = contextFor(
    obligation({ regime: "contract-24h", label: "Client contract breach notice", authority: "Affected client(s)" }),
  );
  const values = commsValues(context);
  // A canned response says "Hi {{requester}}": for a notice that is the authority
  // it is addressed to, unless the caller names a person instead.
  assert.equal(values.requester, "Affected client(s)");
  assert.equal(commsValues({ ...context, recipient: "Dana at Acme" }).requester, "Dana at Acme");
  assert.equal(values.agent, "Ada Lovelace");

  for (const canned of DEFAULT_CANNED_RESPONSES) {
    const rendered = renderCommsText(canned.body, values);
    assert.deepEqual(placeholdersIn(rendered), [], `${canned.title} still names a placeholder after rendering`);
    assert.ok(rendered.includes("INC-000042"), canned.title);
  }

  // And one can be adopted wholesale, keeping the desk's own wording.
  const template = cannedAsCommsTemplate({ id: "c1", title: "Client holding note", body: DEFAULT_CANNED_RESPONSES[0].body });
  assert.equal(template.key, "canned:c1");
  assert.equal(template.label, "Client holding note");
  assert.equal(template.audience, "AFFECTED");
  assert.deepEqual(template.regimes, []);
  assert.deepEqual(placeholdersIn(renderCommsText(template.body, values)), []);
});

/* ---------------------------------------------------------------- selection */

test("every tracked regime gets a draft, and a regime nobody wrote for gets a generic one flagged as such", () => {
  for (const regime of NOTIFICATION_REGIMES) {
    const drafts = templatesForRegime(regime.key);
    assert.ok(drafts.length > 0, `${regime.key} has no draft`);
    assert.ok(
      drafts.every((entry) => entry.fallback === false),
      `${regime.key} fell back to a generic draft`,
    );
  }

  const early = templatesForRegime("nis2-early-warning");
  assert.equal(early.length, 1);
  assert.equal(early[0].template.key, "regulator-early-warning");
  assert.equal(early[0].template.audience, "REGULATOR");

  // An unknown regime is not left without words: the generic drafts are offered,
  // and they say they are generic.
  const unknown = templatesForRegime("made-up-regime");
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every((entry) => entry.fallback === true));
  assert.ok(unknown.every((entry) => entry.template.regimes.length === 0));

  assert.equal(commsTemplateByKey("client-breach-notice")?.audience, "CLIENT");
  assert.equal(commsTemplateByKey("nope"), null);
  assert.equal(audienceLabel("AFFECTED"), "affected people");
});

/* ------------------------------------------------------------------- drafts */

test("a draft carries the incident's own facts, and its subject heads the notice", () => {
  const draft = commsDrafts(contextFor(obligation({ regime: "nis2-early-warning" })))[0];
  assert.equal(draft.fallback, false);
  assert.equal(draft.ready, true);
  assert.deepEqual(draft.issues, []);
  assert.equal(draft.message.startsWith(draft.subject), true);
  assert.equal(draft.subject, "Early warning — INC-000042: Bastion host compromised (SEV1)");
  assert.ok(draft.message.includes("National CSIRT"));
  assert.ok(draft.message.includes("Ada Lovelace"));
  assert.ok(draft.message.includes("Acme MSP"));
  assert.ok(draft.message.includes("2026-09-20T08:30:00.000Z"));
  assert.ok(draft.message.includes("2026-09-20T09:00:00.000Z"));
  // The duty's own deadline is available to a template even where this one does
  // not quote it, since some regimes require the notice to name its window.
  assert.equal(renderCommsText("{{dueAt}}", commsValues(contextFor(obligation()))), "2026-09-21T09:30:00.000Z");

  // One draft can be asked for by key; an unknown key is nothing rather than a guess.
  assert.equal(commsDraft(contextFor(obligation({ regime: "nis2-incident" })), "made-up"), null);
  assert.equal(
    commsDraft(contextFor(obligation({ regime: "nis2-incident" })), "regulator-incident-notification")?.template.key,
    "regulator-incident-notification",
  );
});

test("a draft that needs a field only a person can fill says so, and is not ready", () => {
  const draft = commsDrafts(contextFor(obligation({ regime: "gdpr-breach", label: "GDPR personal-data breach" })))[0];
  assert.equal(draft.ready, false);
  assert.deepEqual(draft.fillIn, ["dataCategories", "subjectCount", "consequences"]);
  assert.match(draft.issues[0], /Still to fill in: \{\{dataCategories\}\}, \{\{subjectCount\}\}, \{\{consequences\}\}\./);
  // The rest of the notice is still written, so the person has something to edit.
  assert.ok(draft.message.includes("INC-000042"));

  // Filling them in is what makes it sendable.
  const filled = draft.message
    .replace("{{dataCategories}}", "Names and work email addresses")
    .replace("{{subjectCount}}", "about 240 client contacts")
    .replace("{{consequences}}", "phishing risk; no evidence of misuse so far");
  assert.deepEqual(commsIssues(filled), []);
});

test("what is wrong with a notice text is a rule, not a judgement", () => {
  assert.match(commsIssues("")[0], /empty/);
  assert.match(commsIssues("   ")[0], /empty/);
  assert.match(commsIssues("x".repeat(COMMS_MESSAGE_MAX + 1))[0], /at most 20000 characters/);
  assert.deepEqual(commsIssues("x".repeat(COMMS_MESSAGE_MAX)), []);
  assert.deepEqual(commsIssues("Everything the authority needs."), []);
  assert.match(commsIssues("{{scope}}").join(" "), /Still to fill in: \{\{scope\}\}/);
});

/* ------------------------------------------------------------------ service */

async function sendableHarness(
  regime: string,
): Promise<{ service: IncidentComplianceService; incident: IncidentRecord; obligation: NotificationObligation; incidents: MemoryIncidentStore }> {
  const audit = new AuditLog(sha256);
  const incidents = new MemoryIncidentStore();
  const store = new MemoryComplianceStore();
  const incidentsService = new IncidentService(incidents, audit, {
    id: (() => {
      let n = 0;
      return () => `incident-id-${++n}`;
    })(),
    now: () => "2026-09-20T09:00:00.000Z",
  });
  const service = new IncidentComplianceService(store, incidents, audit, {
    id: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    now: (() => {
      let n = 0;
      return () => new Date(Date.parse("2026-09-20T09:00:00.000Z") + ++n * 60_000).toISOString();
    })(),
  });

  const declared = await incidentsService.declare(AGENT, {
    title: "Bastion host compromised",
    summary: "A key was used from an unfamiliar address.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
    detectedAt: "2026-09-20T08:30:00.000Z",
  });
  assert.equal(declared.ok, true);
  if (!declared.ok) throw new Error("declare failed");

  const tracked = await service.track(AGENT, declared.value.id, regime);
  assert.equal(tracked.ok, true);
  if (!tracked.ok) throw new Error("track failed");
  return { service, incident: declared.value, obligation: tracked.value, incidents };
}

test("the notice that went out is stored on the duty, from the incident's own facts", async () => {
  const { service, incident, obligation: tracked, incidents } = await sendableHarness("nis2-early-warning");
  const draft = commsDrafts(contextFor(tracked, incident))[0];
  assert.equal(draft.ready, true);
  assert.ok(draft.message.includes(incident.ref));

  const sent = await service.markSent(AGENT, incident.id, tracked.id, {
    reference: "CSIRT-2026-0042",
    message: draft.message,
    templateKey: draft.template.key,
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(sent.value.message, draft.message);
  assert.equal(sent.value.status, "SENT");

  // Reading it back keeps it: the record of what was said is not regenerated.
  const stored = (await service.listNotifications("tenant-a", incident.id))[0];
  assert.equal(stored.message, draft.message);
  const overview = await service.overview("tenant-a", incident.id);
  assert.equal(overview.notifications[0].message, draft.message);

  // The timeline says which draft it came from, so the wording is traceable.
  const events = await incidents.listEvents("tenant-a", incident.id);
  assert.ok(events.some((event) => event.kind === "notification" && /from the "Early warning to the authority" draft/.test(event.summary)));
});

test("an unfinished notice is refused rather than recorded as sent", async () => {
  const { service, incident, obligation: tracked } = await sendableHarness("gdpr-breach");
  const draft = commsDrafts(contextFor(tracked, incident))[0];

  const refused = await service.markSent(AGENT, incident.id, tracked.id, { message: draft.message });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /Still to fill in/);
  // The duty is still pending, so nobody can claim it was notified.
  assert.equal((await service.listNotifications("tenant-a", incident.id))[0].status, "PENDING");

  const tooLong = await service.markSent(AGENT, incident.id, tracked.id, { message: "x".repeat(COMMS_MESSAGE_MAX + 1) });
  assert.equal(tooLong.ok, false);

  // A blank message is simply no message; the duty is still tracked as sent.
  const blank = await service.markSent(AGENT, incident.id, tracked.id, { message: "   " });
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.value.message, null);

  // And a requester cannot record a notice at all.
  const other = await sendableHarness("nis2-incident");
  const denied = await other.service.markSent(REQUESTER, other.incident.id, other.obligation.id, { message: "hello" });
  assert.equal(denied.ok, false);
});

/* ----------------------------------------------------------------- renderer */

function obligation(overrides: Partial<NotificationObligation> = {}): NotificationObligation {
  return {
    id: "n1",
    tenantId: "tenant-a",
    incidentId: "inc-1",
    regime: "nis2-early-warning",
    label: "NIS2 early warning",
    authority: "National CSIRT",
    requirement: "An early warning that a significant incident has occurred.",
    clock: "declared",
    dueAt: "2026-09-21T09:30:00.000Z",
    status: "PENDING",
    sentAt: null,
    sentBy: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    reference: null,
    note: null,
    message: null,
    waivedAt: null,
    waivedBy: null,
    waiverReason: null,
    createdAt: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

const COMMS_FACTS = {
  incident: {
    ref: "INC-000042",
    title: "Bastion host compromised",
    severity: "SEV1",
    phase: "CONTAINED",
    impact: "EXTENSIVE",
    detectedAt: "2026-09-20T08:30:00.000Z",
    declaredAt: "2026-09-20T09:00:00.000Z",
  },
  tenant: "Acme MSP",
  author: "Ada Lovelace",
};

/** The panel's context: the page's facts, plus the duty being drafted for. */
function contextFor(row: NotificationObligation, incident: IncidentRecord | null = null): CommsContext {
  return {
    incident: incident
      ? {
          ref: incident.ref,
          title: incident.title,
          severity: incident.severity,
          phase: incident.phase,
          impact: incident.impact,
          detectedAt: incident.detectedAt,
          declaredAt: incident.declaredAt,
        }
      : COMMS_FACTS.incident,
    obligation: { regime: row.regime, label: row.label, authority: row.authority, dueAt: row.dueAt, clock: row.clock },
    tenant: COMMS_FACTS.tenant,
    author: COMMS_FACTS.author,
  };
}

const NO_ACTIONS = {
  track: async () => {},
  send: async () => {},
  acknowledge: async () => {},
  waive: async () => {},
};

test("the panel offers a draft on an open duty, and shows what was sent once it is", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationPanel, {
      incidentId: "inc-1",
      obligations: [obligation()],
      suggestions: [],
      comms: COMMS_FACTS,
      now: "2026-09-20T10:00:00.000Z",
      actions: NO_ACTIONS,
    }),
  );
  assert.match(html, /Draft this notice/);
  assert.match(html, /Early warning to the authority/);
  assert.match(html, /regulator/);
  assert.match(html, /ready/);
  assert.match(html, /INC-000042/);
  assert.match(html, /Record this notice as sent/);

  // A duty that wants a field filled in says how many, and names them.
  const gdpr = renderToStaticMarkup(
    createElement(NotificationPanel, {
      incidentId: "inc-1",
      obligations: [
        obligation({ regime: "gdpr-breach", label: "GDPR personal-data breach", authority: "Supervisory authority (Art. 33)" }),
      ],
      suggestions: [],
      comms: COMMS_FACTS,
      now: "2026-09-20T10:00:00.000Z",
      actions: NO_ACTIONS,
    }),
  );
  assert.match(gdpr, /3 fields to complete/);
  assert.match(gdpr, /Still to fill in/);

  // Nothing to draft once it is sent — the text is on the record instead.
  const sent = renderToStaticMarkup(
    createElement(NotificationPanel, {
      incidentId: "inc-1",
      obligations: [
        obligation({
          status: "SENT",
          sentAt: "2026-09-20T10:30:00.000Z",
          sentBy: "agent-1",
          message: "To: National CSIRT\n\nWe are giving early warning.",
        }),
      ],
      suggestions: [],
      comms: COMMS_FACTS,
      now: "2026-09-20T11:00:00.000Z",
      actions: NO_ACTIONS,
    }),
  );
  assert.doesNotMatch(sent, /Draft this notice/);
  assert.match(sent, /Notice text as sent/);
  assert.match(sent, /We are giving early warning\./);
});
