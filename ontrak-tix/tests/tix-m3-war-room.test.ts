/**
 * OnTrak Tix M3 tests: the war-room timeline.
 *
 * Covers the pure merge (which events are the *same fact* seen from two systems,
 * and which are simply simultaneous), the source classification, the window and
 * relevance rules, and the service that assembles the whole thing over an
 * incident's log, the tenant's audit chain, the alert stream and the decisions
 * taken about it.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-war-room.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, appendAuditEvent, createAuditChain, type HashFn } from "../src/lib/audit-chain";
import { MemoryAssuranceAuditReader } from "../src/lib/assurance-service";
import type { AlertVerdict } from "../src/lib/alert-promotion-rules";
import type { PromotionRecord } from "../src/lib/alert-promotion-service";
import {
  IncidentService,
  incidentAudit,
  MemoryIncidentStore,
  type IncidentEvent,
  type IncidentStore,
} from "../src/lib/incident-service";
import {
  auditRecordToWarRoom,
  auditSource,
  clipWarRoom,
  incidentCorrelation,
  mergeWarRoomEvents,
  relevantAlerts,
  securityAlertToWarRoom,
  warRoomSummary,
  warRoomWindow,
  type AuditWarRoomFilter,
  type WarRoomEvent,
} from "../src/lib/war-room-rules";
import { WarRoomService } from "../src/lib/war-room-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };

/* ------------------------------------------------------------------- merge */

function event(overrides: Partial<WarRoomEvent> & Pick<WarRoomEvent, "id" | "at" | "source">): WarRoomEvent {
  return {
    kind: "kind",
    actor: "user-1",
    summary: "something happened",
    detail: null,
    correlation: null,
    ...overrides,
  };
}

test("the same fact seen by two systems is one entry, attested by both", () => {
  const at = "2026-09-20T09:00:00.000Z";
  // The two records are milliseconds apart in the running system, which is why
  // the correlation is per second and not per instant.
  const audit = event({
    id: "audit:a1",
    at: "2026-09-20T09:00:00.013Z",
    source: "audit",
    kind: "phase",
    summary: "Moved the incident on",
    detail: { action: "incident.phase" },
    correlation: incidentCorrelation("phase", "user-1", at),
  });
  const timeline = event({
    id: "incident:e1",
    at,
    source: "log",
    kind: "phase",
    summary: "Moved to triaged",
    correlation: incidentCorrelation("phase", "user-1", at),
  });

  const merged = mergeWarRoomEvents([audit, timeline]);
  assert.equal(merged.length, 1);
  // The operator's words win, but the entry says both systems saw it.
  assert.equal(merged[0].summary, "Moved to triaged");
  assert.deepEqual(merged[0].sources, ["log", "audit"]);
  assert.deepEqual(merged[0].ids, ["audit:a1", "incident:e1"]);
  assert.deepEqual(merged[0].detail, { action: "incident.phase" });
  assert.deepEqual(warRoomSummary(merged), { total: 1, bySource: { log: 1, alert: 0, decision: 0, login: 0, audit: 1 }, corroborated: 1 });
});

test("uncorrelated events stay separate, even a second apart in the same minute", () => {
  const at = "2026-09-20T09:00:00.000Z";
  const merged = mergeWarRoomEvents([
    event({ id: "a", at, source: "log", kind: "note", summary: "Called the ISP" }),
    event({ id: "b", at, source: "login", kind: "signin", summary: "Signed in" }),
    // Same event id shape, different instant: two facts, not one.
    event({ id: "c", at: "2026-09-20T09:00:01.000Z", source: "log", kind: "note", summary: "ISP confirmed the cut" }),
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((entry) => entry.summary), ["Called the ISP", "Signed in", "ISP confirmed the cut"]);
  assert.deepEqual(merged[1].sources, ["login"]);
  assert.equal(warRoomSummary(merged).corroborated, 0);
});

/* ------------------------------------------------------------ classification */

test("audit actions are classified by source, and unrelated ones are left out", () => {
  assert.equal(auditSource("identity.signin"), "login");
  assert.equal(auditSource("identity.signin.denied"), "login");
  assert.equal(auditSource("identity.role.change"), "login");
  assert.equal(auditSource("identity.connection.configure"), "decision");
  assert.equal(auditSource("security.alert.ingest"), "alert");
  assert.equal(auditSource("incident.packet.export"), "audit");
  assert.equal(auditSource("ticket.update"), null);
  assert.equal(auditSource("sla.sweep"), null);

  const chain = appendAuditEvent(
    createAuditChain(),
    { id: "a1", tenantId: "tenant-a", at: "2026-09-20T09:00:00.000Z", actor: "user-2", action: "identity.signin", targetType: "user", targetId: "u2" },
    sha256,
  );
  const anyIncident: AuditWarRoomFilter = { incidentId: "inc-1", alertIds: new Set() };
  const signedIn = auditRecordToWarRoom(chain.events[0], anyIncident);
  assert.ok(signedIn);
  assert.equal(signedIn.source, "login");
  assert.equal(signedIn.summary, "Signed in");
  // Nothing correlates a sign-in with an incident-log line, so it stands alone.
  assert.equal(signedIn.correlation, null);

  const ticket = appendAuditEvent(
    chain,
    { id: "a2", tenantId: "tenant-a", at: "2026-09-20T09:05:00.000Z", actor: "user-2", action: "ticket.update", targetType: "ticket", targetId: "t1" },
    sha256,
  );
  assert.equal(auditRecordToWarRoom(ticket.events[1], anyIncident), null);

  // An incident event about a *different* incident must not join this line, but
  // the same event for this one must.
  const other = appendAuditEvent(
    ticket,
    { id: "a3", tenantId: "tenant-a", at: "2026-09-20T09:06:00.000Z", actor: "user-2", action: "incident.phase", targetType: "incident", targetId: "inc-999" },
    sha256,
  );
  assert.equal(auditRecordToWarRoom(other.events[2], anyIncident), null);
  const mine = appendAuditEvent(
    other,
    { id: "a4", tenantId: "tenant-a", at: "2026-09-20T09:07:00.000Z", actor: "user-2", action: "incident.phase", targetType: "incident", targetId: "inc-1", detail: { from: "TRIAGED", to: "CONTAINED" } },
    sha256,
  );
  const kept = auditRecordToWarRoom(mine.events[3], anyIncident);
  assert.ok(kept);
  assert.equal(kept.source, "audit");

  // An alert ingest is kept only for an alert that belongs to the incident.
  const ingest = appendAuditEvent(
    mine,
    { id: "a5", tenantId: "tenant-a", at: "2026-09-20T09:08:00.000Z", actor: "system:alert-source", action: "security.alert.ingest", targetType: "security-alert", targetId: "alert-9" },
    sha256,
  );
  assert.equal(auditRecordToWarRoom(ingest.events[4], anyIncident), null);
  assert.ok(auditRecordToWarRoom(ingest.events[4], { incidentId: "inc-1", alertIds: new Set(["alert-9"]) }));
});

test("an alert ingest correlates with the alert row it created", () => {
  const chain = appendAuditEvent(
    createAuditChain(),
    {
      id: "a1",
      tenantId: "tenant-a",
      at: "2026-09-20T08:58:00.000Z",
      actor: "system:alert-source",
      action: "security.alert.ingest",
      targetType: "security-alert",
      targetId: "alert-9",
    },
    sha256,
  );
  const row = auditRecordToWarRoom(chain.events[0], { incidentId: null, alertIds: new Set(["alert-9"]) });
  const alert = securityAlertToWarRoom(
    { id: "alert-9", source: "IDS", occurredAt: "2026-09-20T08:58:00.000Z", signature: "ET SCAN", severity: "HIGH", description: "SSH scan" },
    "the alert this incident was declared from",
  );

  // The ingestion audit record and the alert row are the same fact — both are
  // the alert source, seen once by the sensor and once by the chain — so they
  // collapse into a single line carrying both ids.
  const merged = mergeWarRoomEvents([row!, alert]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ["alert"]);
  assert.deepEqual(merged[0].ids, ["audit:a1", "alert:alert-9"]);
  assert.match(merged[0].summary, /ET SCAN/);
});

/* ------------------------------------------------------------ window & relevance */

test("the window opens before detection and closes when the incident was recovered", () => {
  const open = warRoomWindow({ detectedAt: "2026-09-20T09:00:00.000Z", resolvedAt: null }, "2026-09-20T12:00:00.000Z");
  assert.equal(open.from, "2026-09-20T08:00:00.000Z");
  assert.equal(open.to, "2026-09-20T12:00:00.000Z");

  // A resolved incident stops there, so the hours after it are not on the line.
  const closed = warRoomWindow({ detectedAt: "2026-09-20T09:00:00.000Z", resolvedAt: "2026-09-20T10:30:00.000Z" }, "2026-09-20T12:00:00.000Z");
  assert.equal(closed.to, "2026-09-20T10:30:00.000Z");

  const entries = clipWarRoom(
    [
      { id: "1", at: "2026-09-20T07:00:00.000Z", kind: "k", actor: "a", summary: "too early", detail: null, sources: ["log"], ids: ["1"] },
      { id: "2", at: "2026-09-20T09:30:00.000Z", kind: "k", actor: "a", summary: "inside", detail: null, sources: ["log"], ids: ["2"] },
    ],
    open,
  );
  assert.deepEqual(entries.map((entry) => entry.summary), ["inside"]);
});

test("alerts belong to an incident for three checkable reasons, and no others", () => {
  const window = { from: "2026-09-20T08:00:00.000Z", to: "2026-09-20T12:00:00.000Z" };
  const alerts = [
    { id: "source", ticketId: null, asset: "srv-1", identity: "alice@acme.test", occurredAt: "2026-09-20T08:30:00.000Z" },
    { id: "same-ticket", ticketId: "tkt-1", asset: null, identity: null, occurredAt: "2026-09-20T09:10:00.000Z" },
    { id: "same-asset", ticketId: null, asset: "srv-1", identity: null, occurredAt: "2026-09-20T09:20:00.000Z" },
    { id: "same-identity", ticketId: null, asset: null, identity: "alice@acme.test", occurredAt: "2026-09-20T09:25:00.000Z" },
    { id: "unrelated", ticketId: null, asset: "srv-9", identity: "bob@acme.test", occurredAt: "2026-09-20T09:30:00.000Z" },
    { id: "too-late", ticketId: "tkt-1", asset: null, identity: null, occurredAt: "2026-09-20T14:00:00.000Z" },
  ];

  const relevant = relevantAlerts({ alertId: "source", ticketId: "tkt-1" }, alerts, window);
  assert.deepEqual(relevant.map(({ alert }) => alert.id), ["source", "same-ticket", "same-asset", "same-identity"]);
  assert.match(relevant[0].because, /declared from/);
  assert.match(relevant[1].because, /promoted to the incident's ticket/);
  assert.match(relevant[2].because, /same asset/);
  assert.match(relevant[3].because, /same identity/);
});

/* ---------------------------------------------------------------- the service */

interface Harness {
  incidents: IncidentStore;
  service: WarRoomService;
  audit: AuditLog;
  reader: MemoryAssuranceAuditReader;
  incidentsService: IncidentService;
}

function harness(
  alerts: { id: string; source: string; signature: string; severity: string; description: string; occurredAt: string; ticketId: string | null; asset: string | null; identity: string | null }[] = [],
  decisions: { promotions?: PromotionRecord[]; verdicts?: AlertVerdict[] } = {},
): Harness {
  const audit = new AuditLog(sha256);
  const incidents = new MemoryIncidentStore();
  const reader = new MemoryAssuranceAuditReader();
  // The incident service gets a fixed clock, so the events it writes land inside
  // the window the war-room service assembles (which is relative to detection).
  const incidentsService = new IncidentService(incidents, audit, {
    id: (() => {
      let n = 0;
      return () => `e${++n}`;
    })(),
    now: () => "2026-09-20T09:00:00.000Z",
  });
  const service = new WarRoomService({
    incidents,
    auditReader: reader,
    alerts: { list: async () => alerts },
    decisions: {
      listPromotions: async () => decisions.promotions ?? [],
      listVerdicts: async () => decisions.verdicts ?? [],
    },
    now: () => "2026-09-20T12:00:00.000Z",
  });
  return { incidents, service, audit, reader, incidentsService };
}

test("the assembled timeline carries the log, the chain, the alert and the decision", async () => {
  const alerts = [
    {
      id: "alert-9",
      source: "IDS",
      signature: "ET SCAN",
      severity: "HIGH",
      description: "SSH scan from 10.0.0.9",
      occurredAt: "2026-09-20T08:58:00.000Z",
      ticketId: "tkt-1",
      asset: "srv-1",
      identity: "alice@acme.test",
    },
    {
      id: "alert-other",
      source: "IDS",
      signature: "ET POLICY",
      severity: "LOW",
      description: "Something else entirely",
      occurredAt: "2026-09-20T09:12:00.000Z",
      ticketId: null,
      asset: "srv-9",
      identity: "bob@acme.test",
    },
  ];
  const h = harness(alerts, {
    promotions: [
      {
        id: "p1",
        tenantId: "tenant-a",
        alertId: "alert-9",
        decision: "PROMOTE",
        reason: "Looks like the start of it",
        ticketId: "tkt-1",
        ticketRef: "TIX-000042",
        at: "2026-09-20T09:05:00.000Z",
      },
      // About somebody else's alert, so it must not join this incident.
      {
        id: "p2",
        tenantId: "tenant-a",
        alertId: "alert-other",
        decision: "SUPPRESS",
        reason: "Known scanner",
        ticketId: null,
        ticketRef: null,
        at: "2026-09-20T09:15:00.000Z",
      },
    ],
    verdicts: [{ id: "v1", tenantId: "tenant-a", signature: "ET SCAN", verdict: "TRUE_POSITIVE", note: "Confirmed", by: "agent-2", at: "2026-09-20T09:06:00.000Z" }],
  });

  const incident = await h.incidentsService.declare(AGENT, {
    title: "Suspicious SSH activity",
    summary: "Repeated scans against the bastion host.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
    detectedAt: "2026-09-20T09:00:00.000Z",
    alertId: "alert-9",
    ticketId: "tkt-1",
  });
  assert.equal(incident.ok, true);
  const record = incident.ok ? incident.value : null;
  assert.ok(record);

  // The chain is what a real deployment would have written: the declare event,
  // plus activity that has nothing to do with this incident.
  const withSignIn = appendAuditEvent(
    h.audit.snapshot(),
    { id: "login-1", tenantId: "tenant-a", at: "2026-09-20T09:02:00.000Z", actor: "agent-2", action: "identity.signin", targetType: "user", targetId: "user-2" },
    sha256,
  );
  const noisy = appendAuditEvent(
    withSignIn,
    { id: "ticket-1", tenantId: "tenant-a", at: "2026-09-20T09:03:00.000Z", actor: "agent-2", action: "ticket.update", targetType: "ticket", targetId: "tkt-1" },
    sha256,
  );
  h.reader.set("tenant-a", noisy);

  const result = await h.service.timeline(AGENT, record!.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { entries, summary, window } = result.value;
  assert.equal(window.from, "2026-09-20T08:00:00.000Z");

  // The declaration is on the line twice over: the log wrote it, the chain recorded it.
  const declared = entries.find((entry) => entry.kind === "declared");
  assert.ok(declared);
  assert.deepEqual(declared.sources, ["log", "audit"]);

  // The sign-in is there, the ticket update is not.
  assert.ok(entries.some((entry) => entry.kind === "signin" && entry.sources.includes("login")));
  assert.ok(!entries.some((entry) => entry.summary === "ticket.update"));

  // The alert this incident came from, the decision to promote it, and the verdict.
  assert.ok(entries.some((entry) => entry.sources.includes("alert") && entry.summary.includes("ET SCAN")));
  assert.ok(entries.some((entry) => entry.sources.includes("decision") && /Promoted the alert to TIX-000042/.test(entry.summary)));
  assert.ok(entries.some((entry) => entry.kind === "verdict" && /true_positive/.test(entry.summary)));
  // …and nothing about the alert that belongs to somebody else.
  assert.ok(!entries.some((entry) => entry.summary.includes("Something else entirely")));
  assert.ok(!entries.some((entry) => /Known scanner/.test(entry.summary)));

  assert.ok(summary.corroborated >= 1);
  assert.equal(summary.total, entries.length);
});

test("a note the scribe typed stays a single-source line, and reading writes nothing", async () => {
  const h = harness();
  const incident = await h.incidentsService.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "MODERATE",
    urgency: "MEDIUM",
    detectedAt: "2026-09-20T09:00:00.000Z",
  });
  assert.equal(incident.ok, true);
  if (!incident.ok) return;

  await h.incidentsService.addNote(AGENT, incident.value.id, "Called the ISP; they see a fibre cut.");
  h.reader.set("tenant-a", h.audit.snapshot());

  const before = await h.incidents.listEvents("tenant-a", incident.value.id);
  const result = await h.service.timeline(AGENT, incident.value.id);
  const after = await h.incidents.listEvents("tenant-a", incident.value.id);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(after.length, before.length, "assembling the timeline is a read");

  const note = result.value.entries.find((entry) => entry.kind === "note");
  assert.ok(note);
  assert.deepEqual(note.sources, ["log"]);
  assert.equal(note.summary, "Called the ISP; they see a fibre cut.");
});

test("an audit-only fact is not lost: an export has no incident-log twin", async () => {
  const h = harness();
  const incident = await h.incidentsService.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "MODERATE",
    urgency: "MEDIUM",
    detectedAt: "2026-09-20T09:00:00.000Z",
  });
  assert.equal(incident.ok, true);
  if (!incident.ok) return;

  h.reader.set(
    "tenant-a",
    appendAuditEvent(
      h.audit.snapshot(),
      {
        id: "export-1",
        tenantId: "tenant-a",
        at: "2026-09-20T09:30:00.000Z",
        actor: "agent-1",
        action: "incident.packet.export",
        targetType: "incident",
        targetId: incident.value.id,
        detail: { ref: incident.value.ref, contentHash: "f".repeat(64) },
      },
      sha256,
    ),
  );

  const result = await h.service.timeline(AGENT, incident.value.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const exported = result.value.entries.find((entry) => entry.detail?.action === "incident.packet.export");
  assert.ok(exported);
  assert.deepEqual(exported.sources, ["audit"]);
  assert.equal(exported.summary, "Exported the assurance packet");
});

test("the war-room timeline is staff-only and tenant-scoped", async () => {
  const h = harness();
  const incident = await h.incidentsService.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "MODERATE",
    urgency: "MEDIUM",
    detectedAt: "2026-09-20T09:00:00.000Z",
  });
  assert.equal(incident.ok, true);
  if (!incident.ok) return;

  assert.equal((await h.service.timeline(REQUESTER, incident.value.id)).ok, false);
  assert.equal((await h.service.timeline({ ...AGENT, tenantId: "tenant-b" }, incident.value.id)).ok, false);
  assert.equal((await h.service.timeline(AGENT, "nope")).ok, false);
});

test("a timeline event is normalized with its instant and actor intact", () => {
  const event: IncidentEvent = {
    id: "e1",
    tenantId: "tenant-a",
    incidentId: "inc-1",
    at: "2026-09-20T09:00:00.000Z",
    kind: "hold",
    actor: "agent-1",
    summary: "Legal hold placed",
    detail: { reason: "Insurer asked" },
  };
  const audit = incidentAudit(
    {
      id: "inc-1",
      tenantId: "tenant-a",
      ref: "INC-000001",
      title: "t",
      summary: "s",
      severity: "SEV1",
      phase: "DETECTED",
      impact: "EXTENSIVE",
      urgency: "CRITICAL",
      ticketId: null,
      alertId: null,
      commanderId: null,
      commsLeadId: null,
      scribeId: null,
      liaisonId: null,
      detectedAt: "2026-09-20T09:00:00.000Z",
      declaredAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
      resolvedAt: null,
      reviewedAt: null,
    },
    "agent-1",
    "incident.hold.place",
    "2026-09-20T09:00:00.000Z",
    { reason: "Insurer asked" },
  );
  const chain = appendAuditEvent(createAuditChain(), audit, sha256);
  const row = auditRecordToWarRoom(chain.events[0], { incidentId: "inc-1", alertIds: new Set() });
  assert.ok(row);
  // Same second, same family, same actor, so the log line and the chain entry
  // are one fact — which is the merge the console reports as corroborated.
  assert.equal(row.correlation, incidentCorrelation("hold", "agent-1", event.at));
  assert.equal(row.at, event.at);
  assert.equal(row.actor, "agent-1");
});
