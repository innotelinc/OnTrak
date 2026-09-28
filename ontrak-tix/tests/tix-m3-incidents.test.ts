/**
 * OnTrak Tix M3 tests: the incident lifecycle.
 *
 * Covers the pure decisions (the severity matrix, the phase ladder, roles and
 * validation), the service's declare/advance/staff flows with their append-only
 * timeline and audit trail, and the Prisma adapter's narrowing.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-incidents.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  INCIDENT_PHASES,
  advancePhase,
  assignedRoles,
  atLeastAsSevere,
  incidentRef,
  isIncidentClosed,
  isIncidentRole,
  isResponseActive,
  phaseProgress,
  requiredRolesFor,
  roleField,
  roleLabel,
  severityFor,
  severityRank,
  targetAcknowledgeMinutes,
  unfilledRequiredRoles,
  validateIncident,
} from "../src/lib/incident-rules";
import { IncidentService, incidentIsOpen, MemoryIncidentStore, type IncidentStore } from "../src/lib/incident-service";
import {
  PrismaIncidentStore,
  toImpact,
  toIncidentData,
  toIncidentEventData,
  toIncidentEventRecord,
  toIncidentRecord,
  toPhase,
  toSeverity,
  toUrgency,
  type IncidentEventRow,
  type IncidentPrismaClient,
  type IncidentRow,
} from "../src/lib/incident-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };

/* ------------------------------------------------------------ severity matrix */

test("severity comes from the impact × urgency matrix", () => {
  assert.equal(severityFor("EXTENSIVE", "CRITICAL"), "SEV1");
  assert.equal(severityFor("EXTENSIVE", "LOW"), "SEV2");
  assert.equal(severityFor("SIGNIFICANT", "HIGH"), "SEV2");
  assert.equal(severityFor("MODERATE", "MEDIUM"), "SEV3");
  assert.equal(severityFor("MINOR", "LOW"), "SEV4");

  assert.ok(severityRank("SEV1") < severityRank("SEV4"));
  assert.equal(atLeastAsSevere("SEV2", "SEV2"), true);
  assert.equal(atLeastAsSevere("SEV3", "SEV2"), false);

  assert.equal(targetAcknowledgeMinutes("SEV1"), 15);
  assert.equal(targetAcknowledgeMinutes("SEV4"), 480);
});

/* --------------------------------------------------------------- lifecycle */

test("the phase ladder refuses jumps and allows a re-open", () => {
  assert.deepEqual(advancePhase("DETECTED", "TRIAGED"), { ok: true, phase: "TRIAGED" });
  assert.equal(advancePhase("DETECTED", "CONTAINED").ok, true);
  assert.equal(advancePhase("DETECTED", "REVIEWED").ok, false);
  assert.equal(advancePhase("TRIAGED", "TRIAGED").ok, false);
  const jump = advancePhase("DETECTED", "REVIEWED");
  if (!jump.ok) assert.match(jump.reason, /cannot move straight to reviewed/);

  // A regression is real work: something eradicated that comes back is contained.
  assert.equal(advancePhase("ERADICATED", "CONTAINED").ok, true);
  assert.equal(advancePhase("REVIEWED", "CONTAINED").ok, true);

  assert.equal(phaseProgress("DETECTED"), 0);
  assert.equal(phaseProgress("REVIEWED"), 1);
  assert.equal(isIncidentClosed("REVIEWED"), true);
  assert.equal(isResponseActive("CONTAINED"), true);
  assert.equal(isResponseActive("RECOVERED"), false);
  assert.equal(INCIDENT_PHASES.length, 6);
});

test("roles have fields and labels, and SEV1/SEV2 need a commander and a scribe", () => {
  assert.equal(roleField("COMMANDER"), "commanderId");
  assert.equal(roleField("COMMS_LEAD"), "commsLeadId");
  assert.equal(roleLabel("SCRIBE"), "Scribe");
  assert.equal(isIncidentRole("LIAISON"), true);
  assert.equal(isIncidentRole("nope"), false);

  assert.deepEqual(requiredRolesFor("SEV1"), ["COMMANDER", "SCRIBE"]);
  assert.deepEqual(requiredRolesFor("SEV3"), ["COMMANDER"]);

  const empty = { commanderId: null, commsLeadId: null, scribeId: null, liaisonId: null };
  assert.deepEqual(unfilledRequiredRoles("SEV1", empty), ["COMMANDER", "SCRIBE"]);
  assert.deepEqual(
    unfilledRequiredRoles("SEV2", { ...empty, commanderId: "u1" }),
    ["SCRIBE"],
  );
  assert.deepEqual(assignedRoles({ ...empty, commanderId: "u1" }).find((entry) => entry.role === "COMMANDER"), {
    role: "COMMANDER",
    userId: "u1",
  });
});

test("an incident declaration is validated", () => {
  const base = { title: "Mail outage", summary: "Exchange is down", impact: "EXTENSIVE" as const, urgency: "CRITICAL" as const };
  assert.deepEqual(validateIncident(base), []);
  assert.match(validateIncident({ ...base, title: "  " }).join(" "), /title is required/);
  assert.match(validateIncident({ ...base, summary: "" }).join(" "), /summary is required/);
  assert.match(validateIncident({ ...base, impact: "HUGE" as never }).join(" "), /Unknown impact/);
  assert.match(validateIncident({ ...base, urgency: "SOON" as never }).join(" "), /Unknown urgency/);
  assert.match(validateIncident({ ...base, severity: "SEV9" as never }).join(" "), /Unknown severity/);
  assert.match(validateIncident({ ...base, detectedAt: "not a date" }).join(" "), /not a valid date/);
  assert.equal(incidentRef(7), "INC-000007");
});

/* ----------------------------------------------------------------- service */

function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryIncidentStore();
  let n = 0;
  let clock = "2026-09-20T09:00:00.000Z";
  const service = new IncidentService(store, audit, {
    id: () => `inc-${++n}`,
    now: () => clock,
  });
  return { audit, store, service, tick: (at: string) => { clock = at; } };
}

function actions(audit: AuditLog): string[] {
  return audit.snapshot().events.map((entry) => entry.action);
}

test("declaring an incident derives the severity and opens a timeline", async () => {
  const h = harness();
  const result = await h.service.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is unavailable for all staff.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
    detectedAt: "2026-09-20T08:55:00.000Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.severity, "SEV1");
  assert.equal(result.value.phase, "DETECTED");
  assert.equal(result.value.ref, "INC-000001");
  assert.equal(result.value.detectedAt, "2026-09-20T08:55:00.000Z");

  const timeline = await h.service.timeline("tenant-a", result.value.id);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "declared");
  assert.deepEqual(timeline[0].detail?.requiredRoles, ["COMMANDER", "SCRIBE"]);
  assert.deepEqual(actions(h.audit), ["incident.declare"]);
});

test("an explicit severity overrides the matrix, and a requester cannot declare", async () => {
  const h = harness();
  const overridden = await h.service.declare(AGENT, {
    title: "Suspicious login",
    summary: "One failed login from an unknown region.",
    impact: "MINOR",
    urgency: "LOW",
    severity: "SEV2",
  });
  assert.equal(overridden.ok, true);
  if (overridden.ok) assert.equal(overridden.value.severity, "SEV2");

  const denied = await h.service.declare(REQUESTER, {
    title: "x",
    summary: "y",
    impact: "MINOR",
    urgency: "LOW",
  });
  assert.equal(denied.ok, false);
  assert.equal((await h.service.list("tenant-a")).length, 1);
});

test("a SEV1 cannot be triaged until it is staffed", async () => {
  const h = harness();
  const declared = await h.service.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
  });
  assert.equal(declared.ok, true);
  if (!declared.ok) return;

  const blocked = await h.service.advance(AGENT, declared.value.id, "TRIAGED");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.error, /^Assign incident commander and scribe before triaging\.$/);

  await h.service.assignRole(AGENT, declared.value.id, "COMMANDER", "user-1");
  await h.service.assignRole(AGENT, declared.value.id, "SCRIBE", "user-2");

  const triaged = await h.service.advance(AGENT, declared.value.id, "TRIAGED");
  assert.equal(triaged.ok, true);
  if (!triaged.ok) return;
  assert.equal(triaged.value.phase, "TRIAGED");

  const timeline = await h.service.timeline("tenant-a", declared.value.id);
  assert.deepEqual(timeline.map((event) => event.kind), ["declared", "role", "role", "phase"]);
  assert.deepEqual(actions(h.audit), ["incident.declare", "incident.role", "incident.role", "incident.phase"]);
});

test("phase changes stamp resolution and review times, and a bad move is refused", async () => {
  const h = harness();
  const declared = await h.service.declare(AGENT, {
    title: "Disk full",
    summary: "The primary database volume is full.",
    impact: "SIGNIFICANT",
    urgency: "HIGH",
  });
  assert.equal(declared.ok, true);
  if (!declared.ok) return;
  const id = declared.value.id;

  const illegal = await h.service.advance(AGENT, id, "REVIEWED");
  assert.equal(illegal.ok, false);

  h.tick("2026-09-20T09:30:00.000Z");
  await h.service.advance(AGENT, id, "CONTAINED");
  h.tick("2026-09-20T10:00:00.000Z");
  await h.service.advance(AGENT, id, "ERADICATED");
  h.tick("2026-09-20T11:00:00.000Z");
  const recovered = await h.service.advance(AGENT, id, "RECOVERED");
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.value.resolvedAt, "2026-09-20T11:00:00.000Z");

  h.tick("2026-09-21T09:00:00.000Z");
  const reviewed = await h.service.advance(AGENT, id, "REVIEWED");
  assert.equal(reviewed.ok, true);
  if (reviewed.ok) {
    assert.equal(reviewed.value.reviewedAt, "2026-09-21T09:00:00.000Z");
    assert.equal(incidentIsOpen(reviewed.value), false);
  }
});

test("roles can be filled and cleared, and notes append without moving the phase", async () => {
  const h = harness();
  const declared = await h.service.declare(AGENT, {
    title: "Phishing wave",
    summary: "Several staff received a credential-harvesting mail.",
    impact: "MODERATE",
    urgency: "HIGH",
  });
  if (!declared.ok) return;
  const id = declared.value.id;

  const assigned = await h.service.assignRole(AGENT, id, "COMMS_LEAD", "user-9");
  assert.equal(assigned.ok, true);
  if (assigned.ok) assert.equal(assigned.value.commsLeadId, "user-9");

  const cleared = await h.service.assignRole(AGENT, id, "COMMS_LEAD", null);
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.value.commsLeadId, null);

  const badRole = await h.service.assignRole(AGENT, id, "CAPTAIN" as never, "u");
  assert.equal(badRole.ok, false);

  const noted = await h.service.addNote(AGENT, id, "Blocked the sender domain.");
  assert.equal(noted.ok, true);
  if (noted.ok) assert.equal(noted.value.phase, "DETECTED");
  assert.equal((await h.service.addNote(AGENT, id, "   ")).ok, false);

  const timeline = await h.service.timeline("tenant-a", id);
  assert.deepEqual(timeline.map((event) => event.kind), ["declared", "role", "role", "note"]);
  assert.equal(timeline[3].summary, "Blocked the sender domain.");
});

test("incidents are tenant-scoped", async () => {
  const h = harness();
  const declared = await h.service.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
  });
  if (!declared.ok) return;

  const other = { ...AGENT, tenantId: "tenant-b" };
  assert.equal((await h.service.advance(other, declared.value.id, "CONTAINED")).ok, false);
  assert.equal((await h.service.assignRole(other, declared.value.id, "COMMANDER", "u")).ok, false);
  assert.equal(await h.service.get("tenant-b", declared.value.id), null);
  assert.deepEqual(await h.service.timeline("tenant-b", declared.value.id), []);
});

/* ---------------------------------------------------------- prisma adapter */

const incidentRow: IncidentRow = {
  id: "inc-1",
  tenantId: "tenant-a",
  ref: "INC-000001",
  title: "Mail outage",
  summary: "Exchange is down",
  severity: "SEV1",
  phase: "CONTAINED",
  impact: "EXTENSIVE",
  urgency: "CRITICAL",
  ticketId: "tkt-1",
  alertId: null,
  commanderId: "user-1",
  commsLeadId: null,
  scribeId: "user-2",
  liaisonId: null,
  detectedAt: new Date("2026-09-20T08:55:00Z"),
  declaredAt: new Date("2026-09-20T09:00:00Z"),
  updatedAt: new Date("2026-09-20T09:30:00Z"),
  resolvedAt: null,
  reviewedAt: null,
};

const eventRow: IncidentEventRow = {
  id: "ev-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  at: new Date("2026-09-20T09:00:00Z"),
  kind: "declared",
  actor: "agent-1",
  summary: "Declared SEV1",
  detail: { severity: "SEV1" },
};

test("the incident mappers narrow enums and round-trip", () => {
  const record = toIncidentRecord(incidentRow);
  assert.equal(record.severity, "SEV1");
  assert.equal(record.phase, "CONTAINED");
  assert.equal(record.impact, "EXTENSIVE");
  assert.equal(record.detectedAt, "2026-09-20T08:55:00.000Z");
  assert.ok(toIncidentData(record).detectedAt instanceof Date);

  assert.equal(toSeverity("nonsense"), "SEV4");
  assert.equal(toPhase("nonsense"), "DETECTED");
  assert.equal(toImpact("nonsense"), "MINOR");
  assert.equal(toUrgency("nonsense"), "LOW");
  // A round-trip never changes a valid value.
  assert.equal(toSeverity(toIncidentRecord(incidentRow).severity), "SEV1");
});

test("the event mapper narrows the kind and keeps the detail", () => {
  const event = toIncidentEventRecord(eventRow);
  assert.equal(event.kind, "declared");
  assert.deepEqual(event.detail, { severity: "SEV1" });
  assert.equal(event.at, "2026-09-20T09:00:00.000Z");
  assert.equal(toIncidentEventRecord({ ...eventRow, kind: "wat" }).kind, "note");
  assert.equal((toIncidentEventData(event) as Record<string, unknown>).kind, "declared");
});

test("the Prisma incident store reads, writes and lists its timeline", async () => {
  const created: unknown[] = [];
  const events: unknown[] = [];
  let updated: unknown = null;
  const client: IncidentPrismaClient = {
    incident: {
      count: async () => 6,
      findFirst: async (args) => ((args as { where: { id: string } }).where.id === "inc-1" ? incidentRow : null),
      findMany: async () => [incidentRow],
      create: async (args) => {
        created.push(args.data);
        return {};
      },
      update: async (args) => {
        updated = args.data;
        return {};
      },
    },
    incidentEvent: {
      findMany: async () => [eventRow],
      create: async (args) => {
        events.push(args.data);
        return {};
      },
    },
  };
  const store: IncidentStore = new PrismaIncidentStore(client);

  assert.equal(await store.nextIncidentSeq("tenant-a"), 7);
  assert.equal((await store.findIncident("tenant-a", "inc-1"))?.ref, "INC-000001");
  assert.equal(await store.findIncident("tenant-a", "nope"), null);
  assert.equal((await store.listIncidents("tenant-a")).length, 1);

  await store.insertIncident(toIncidentRecord(incidentRow));
  await store.updateIncident({ ...toIncidentRecord(incidentRow), phase: "ERADICATED" });
  assert.equal(created.length, 1);
  assert.equal((updated as { phase: string }).phase, "ERADICATED");

  const timeline = await store.listEvents("tenant-a", "inc-1");
  assert.equal(timeline[0].kind, "declared");
  await store.appendEvent(timeline[0]);
  assert.equal(events.length, 1);
});
