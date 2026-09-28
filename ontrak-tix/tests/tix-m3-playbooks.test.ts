/**
 * OnTrak Tix M3 tests: playbooks, evidence and the evidence manifest, plus the
 * incident console renderer.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-playbooks.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  DEFAULT_INCIDENT_PLAYBOOK,
  changeStepStatus,
  canChangeStep,
  isStepStatus,
  nextStep,
  planPlaybook,
  playbookProgress,
} from "../src/lib/playbook-rules";
import {
  buildEvidenceManifest,
  custodyIntegrity,
  custodyTrail,
  evidenceDigest,
  holdActive,
  retentionDecision,
  validateCustodyTransfer,
  validateEvidence,
  type CustodyEntry,
  type EvidenceInput,
  type LegalHold,
} from "../src/lib/evidence-rules";
import { IncidentService, MemoryIncidentStore, type IncidentStore } from "../src/lib/incident-service";
import { IncidentDocsService, MemoryIncidentDocsStore, type IncidentDocsStore } from "../src/lib/incident-docs-service";
import {
  PrismaIncidentDocsStore,
  toArtifactData,
  toArtifactRecord,
  toCustodyData,
  toCustodyRecord,
  toEvidenceData,
  toEvidenceRecord,
  toHoldRecord,
  toStepData,
  toStepRecord,
  type CustodyEntryRow,
  type EvidenceArtifactRow,
  type EvidenceItemRow,
  type IncidentDocsPrismaClient,
  type LegalHoldRow,
  type PlaybookStepRow,
} from "../src/lib/incident-docs-store-prisma";
import { IncidentList } from "../src/components/IncidentList";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };

/* ---------------------------------------------------------------- playbook */

test("a playbook is planned from severity", () => {
  const sev1 = planPlaybook("SEV1");
  const sev4 = planPlaybook("SEV4");
  // The stakeholder-comms step is for the severe incidents only.
  assert.ok(sev1.some((step) => step.key === "comms"));
  assert.ok(!sev4.some((step) => step.key === "comms"));
  assert.equal(sev1.length, DEFAULT_INCIDENT_PLAYBOOK.length);
  // Order is preserved, and every step names a phase.
  assert.equal(sev1[0].key, "declare");
  assert.ok(sev1.every((step) => typeof step.phase === "string" && step.phase.length > 0));
});

test("step statuses only move the legal way", () => {
  assert.equal(canChangeStep("PENDING", "DONE"), true);
  assert.equal(canChangeStep("PENDING", "SKIPPED"), true);
  assert.equal(canChangeStep("DONE", "PENDING"), true);
  assert.equal(canChangeStep("DONE", "SKIPPED"), false);
  assert.equal(canChangeStep("SKIPPED", "SKIPPED"), false);
  const blocked = changeStepStatus("DONE", "SKIPPED");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /reopen it first/);
  assert.equal(isStepStatus("SKIPPED"), true);
  assert.equal(isStepStatus("nope"), false);
});

test("progress and next-step read the plan", () => {
  const steps = [
    { key: "a", status: "DONE" as const },
    { key: "b", status: "SKIPPED" as const },
    { key: "c", status: "PENDING" as const },
  ];
  const progress = playbookProgress(steps);
  assert.deepEqual(progress, { total: 3, done: 1, skipped: 1, pending: 1, percent: 2 / 3, complete: false });
  assert.equal(nextStep(steps)?.key, "c");
  assert.equal(nextStep([{ key: "a", status: "DONE" as const }]), null);
  assert.equal(playbookProgress([]).complete, false);
});

/* ---------------------------------------------------------- evidence rules */

test("evidence is validated, including its checksum", () => {
  const base: EvidenceInput = { kind: "LOG", label: "Auth log", reference: "s3://evidence/1" };
  assert.deepEqual(validateEvidence(base), []);
  assert.match(validateEvidence({ ...base, label: " " }).join(" "), /label is required/);
  assert.match(validateEvidence({ ...base, reference: "" }).join(" "), /reference is required/);
  assert.match(validateEvidence({ ...base, kind: "VIDEO" as never }).join(" "), /Unknown evidence kind/);
  assert.match(validateEvidence({ ...base, sha256: "abc" }).join(" "), /SHA-256 hex digest/);
  assert.deepEqual(validateEvidence({ ...base, sha256: "a".repeat(64) }), []);
});

test("the manifest digests its content deterministically", () => {
  const input = {
    incident: {
      ref: "INC-000001",
      title: "Mail outage",
      severity: "SEV1",
      phase: "CONTAINED",
      detectedAt: "2026-09-20T08:55:00.000Z",
      declaredAt: "2026-09-20T09:00:00.000Z",
      roles: [{ role: "COMMANDER", userId: "user-1" }],
    },
    steps: [{ key: "declare", title: "Declare", status: "DONE" as const, completedAt: "2026-09-20T09:01:00.000Z", completedBy: "user-1" }],
    evidence: [
      {
        id: "ev-1",
        kind: "LOG",
        label: "Auth log",
        reference: "s3://evidence/1",
        sha256: "b".repeat(64),
        collectedBy: "user-1",
        collectedAt: "2026-09-20T09:05:00.000Z",
      },
    ],
    timeline: [{ at: "2026-09-20T09:00:00.000Z", kind: "declared", actor: "user-1", summary: "Declared SEV1" }],
    generatedAt: "2026-09-20T12:00:00.000Z",
  };

  const first = buildEvidenceManifest(input, sha256);
  const second = buildEvidenceManifest(input, sha256);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.match(first.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(first.evidence[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(first.evidence[0].digest, evidenceDigest(input.evidence[0], sha256));

  // Any edit changes the digest: a rewritten timeline, a swapped file, a step
  // quietly marked done.
  assert.notEqual(buildEvidenceManifest({ ...input, timeline: [{ ...input.timeline[0], summary: "edited" }] }, sha256).manifestHash, first.manifestHash);
  assert.notEqual(
    buildEvidenceManifest({ ...input, evidence: [{ ...input.evidence[0], sha256: "c".repeat(64) }] }, sha256).manifestHash,
    first.manifestHash,
  );
  assert.notEqual(
    buildEvidenceManifest({ ...input, steps: [{ ...input.steps[0], status: "SKIPPED" as const }] }, sha256).manifestHash,
    first.manifestHash,
  );
});

/* ------------------------------------------------------- chain of custody */

const COLLECTED: CustodyEntry = {
  id: "c1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  evidenceId: "ev-1",
  at: "2026-09-20T09:05:00.000Z",
  action: "COLLECTED",
  fromActor: "user-1",
  toActor: "user-1",
  reason: null,
};

function transfer(id: string, at: string, from: string, to: string): CustodyEntry {
  return { ...COLLECTED, id, at, action: "TRANSFERRED", fromActor: from, toActor: to, reason: "handed over" };
}

test("a hand-off needs a recipient and a reason", () => {
  assert.deepEqual(validateCustodyTransfer({ toActor: "user-2", reason: "to the security team" }), []);
  assert.match(validateCustodyTransfer({}).join(" "), /name who is taking custody/i);
  assert.match(validateCustodyTransfer({ toActor: "user-2" }).join(" "), /needs a reason/i);
  assert.match(validateCustodyTransfer({ toActor: "user-2", reason: "x".repeat(501) }).join(" "), /at most 500/);
});

test("a custody trail is walked in order and must be unbroken", () => {
  const trail = [transfer("c3", "2026-09-20T11:00:00.000Z", "user-2", "user-3"), COLLECTED, transfer("c2", "2026-09-20T10:00:00.000Z", "user-1", "user-2")];
  assert.deepEqual(
    custodyTrail(trail).map((entry) => entry.id),
    ["c1", "c2", "c3"],
  );

  const checked = custodyIntegrity(trail, "user-1");
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.holder, "user-3");
    assert.equal(checked.entries, 3);
  }

  // A missing entry leaves a gap: the next transfer starts from nobody.
  const gapped = custodyIntegrity([COLLECTED, transfer("c3", "2026-09-20T11:00:00.000Z", "user-2", "user-3")], "user-1");
  assert.equal(gapped.ok, false);
  if (!gapped.ok) assert.match(gapped.reason, /jumps from "user-1" to "user-2"/);

  // A collection entry that names someone else is refused too.
  assert.equal(custodyIntegrity([{ ...COLLECTED, toActor: "user-9" }], "user-1").ok, false);
  assert.equal(custodyIntegrity([], "user-1").ok, false);
  // Mixing items in one trail is refused rather than half-checked.
  assert.equal(custodyIntegrity([COLLECTED, { ...transfer("c2", "2026-09-20T10:00:00.000Z", "user-1", "user-2"), evidenceId: "ev-2" }], "user-1").ok, false);
});

/* ------------------------------------------------------------- legal hold */

const ACTIVE_HOLD: LegalHold = {
  id: "hold-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  reason: "Insurer requested preservation",
  placedBy: "user-1",
  placedAt: "2026-09-20T10:00:00.000Z",
  releasedBy: null,
  releasedAt: null,
};

test("a legal hold outranks the retention clock", () => {
  assert.equal(holdActive(ACTIVE_HOLD), true);
  assert.equal(holdActive({ ...ACTIVE_HOLD, releasedAt: "2026-09-21T10:00:00.000Z", releasedBy: "user-1" }), false);
  assert.equal(holdActive(null), false);

  const collectedAt = "2026-09-20T09:05:00.000Z";
  const held = retentionDecision({ hold: ACTIVE_HOLD, collectedAt, now: "2036-01-01T00:00:00.000Z" });
  assert.equal(held.action, "blocked");
  assert.match(held.reason, /legal hold/i);

  const withinWindow = retentionDecision({ hold: null, collectedAt, now: "2026-10-01T00:00:00.000Z" });
  assert.equal(withinWindow.action, "retain");

  const expired = retentionDecision({ hold: null, collectedAt, now: "2036-09-21T00:00:00.000Z" });
  assert.equal(expired.action, "eligible");
  assert.equal(expired.eligibleAt, "2036-09-17T09:05:00.000Z");

  // A shortened window is honoured, so a policy can age evidence out sooner.
  const short = retentionDecision({ hold: null, collectedAt, now: "2027-01-01T00:00:00.000Z", retentionDays: 30 });
  assert.equal(short.action, "eligible");
});

/* ----------------------------------------------------------------- service */

function harness() {
  const audit = new AuditLog(sha256);
  const incidentStore = new MemoryIncidentStore();
  let n = 0;
  let clock = "2026-09-20T09:00:00.000Z";
  const ids = { id: () => `id-${++n}`, now: () => clock };
  const incidents = new IncidentService(incidentStore, audit, ids);
  const docs = new IncidentDocsService(new MemoryIncidentDocsStore(), incidentStore, audit, ids, sha256);
  return { audit, incidentStore, incidents, docs, tick: (at: string) => { clock = at; } };
}

function actions(audit: AuditLog): string[] {
  return audit.snapshot().events.map((entry) => entry.action);
}

async function declareIncident(h: ReturnType<typeof harness>, overrides: Partial<{ impact: "EXTENSIVE"; urgency: "CRITICAL" }> = {}) {
  const result = await h.incidents.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
    ...overrides,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("declare failed");
  return result.value;
}

test("starting a playbook plans the steps once and is idempotent", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  const started = await h.docs.startPlaybook(AGENT, incident.id);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.length, DEFAULT_INCIDENT_PLAYBOOK.length);
  assert.equal(started.value[0].key, "declare");
  assert.ok(started.value.every((step) => step.status === "PENDING"));

  // Re-running keeps the existing plan (a severity revision must not wipe work).
  await h.docs.completeStep(AGENT, incident.id, "declare");
  const again = await h.docs.startPlaybook(AGENT, incident.id);
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.value.length, DEFAULT_INCIDENT_PLAYBOOK.length);
    assert.equal(again.value.find((step) => step.key === "declare")?.status, "DONE");
  }

  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.deepEqual(timeline.map((event) => event.kind), ["declared", "playbook", "playbook"]);
  assert.deepEqual(actions(h.audit), ["incident.declare", "incident.playbook.start", "incident.playbook.step"]);
});

test("a step records who and when, and can be reopened", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  await h.docs.startPlaybook(AGENT, incident.id);

  h.tick("2026-09-20T09:07:00.000Z");
  const done = await h.docs.completeStep(AGENT, incident.id, "notify", "Woke the on-call");
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.value.status, "DONE");
    assert.equal(done.value.completedAt, "2026-09-20T09:07:00.000Z");
    assert.equal(done.value.completedBy, "agent-1");
    assert.equal(done.value.note, "Woke the on-call");
  }

  // A done step cannot be skipped without being reopened first.
  const skipBlocked = await h.docs.skipStep(AGENT, incident.id, "notify", "no");
  assert.equal(skipBlocked.ok, false);

  const reopened = await h.docs.reopenStep(AGENT, incident.id, "notify");
  assert.equal(reopened.ok, true);
  if (reopened.ok) {
    assert.equal(reopened.value.status, "PENDING");
    assert.equal(reopened.value.completedAt, null);
    assert.equal(reopened.value.completedBy, null);
  }

  const skipped = await h.docs.skipStep(AGENT, incident.id, "notify", "No on-call rota yet");
  assert.equal(skipped.ok, true);
  if (skipped.ok) assert.equal(skipped.value.status, "SKIPPED");

  // A skip without a reason is refused.
  assert.equal((await h.docs.skipStep(AGENT, incident.id, "assess", "  ")).ok, false);
  // An unknown step is refused.
  assert.equal((await h.docs.completeStep(AGENT, incident.id, "nope")).ok, false);

  const progress = await h.docs.progress("tenant-a", incident.id);
  assert.equal(progress.total, DEFAULT_INCIDENT_PLAYBOOK.length);
  assert.equal(progress.skipped, 1);
});

test("evidence is recorded on the timeline and rolled into the manifest", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  await h.docs.startPlaybook(AGENT, incident.id);
  await h.docs.completeStep(AGENT, incident.id, "declare");

  const recorded = await h.docs.recordEvidence(AGENT, incident.id, {
    kind: "LOG",
    label: "Exchange transport log",
    reference: "s3://evidence/inc-1/transport.log",
    sha256: "d".repeat(64),
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.value.sha256, "d".repeat(64));

  assert.equal((await h.docs.recordEvidence(AGENT, incident.id, { kind: "LOG", label: "", reference: "x" })).ok, false);

  const manifest = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.value.incident.ref, incident.ref);
  assert.equal(manifest.value.evidence.length, 1);
  assert.match(manifest.value.manifestHash, /^[a-f0-9]{64}$/);
  // The timeline in the manifest includes the playbook and evidence events.
  assert.deepEqual(
    manifest.value.timeline.map((event) => event.kind),
    ["declared", "playbook", "playbook", "evidence"],
  );
  assert.equal(actions(h.audit).filter((action) => action === "incident.manifest").length, 1);

  // Generating again with nothing changed yields the same digest — the
  // generation time is reported but is not part of what is committed to.
  const before = manifest.value.manifestHash;
  h.tick("2026-09-20T13:00:00.000Z");
  const second = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.value.manifestHash, before);
    assert.notEqual(second.value.generatedAt, manifest.value.generatedAt);
  }
});

test("evidence opens its own custody trail, and hand-offs are appended and audited", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  const recorded = await h.docs.recordEvidence(AGENT, incident.id, {
    kind: "SNAPSHOT",
    label: "Disk image",
    reference: "s3://evidence/inc-1/disk.img",
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  // Collection is written with the item, so the trail never starts mid-way.
  let trail = await h.docs.listCustody("tenant-a", incident.id);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].action, "COLLECTED");
  assert.equal(trail[0].fromActor, AGENT.id);
  assert.equal(trail[0].toActor, AGENT.id);

  // A hand-off with no reason, or with nobody taking it, is refused.
  assert.equal((await h.docs.transferEvidence(AGENT, incident.id, recorded.value.id, { toActor: "user-2" })).ok, false);
  assert.equal((await h.docs.transferEvidence(AGENT, incident.id, recorded.value.id, { reason: "to forensics" })).ok, false);
  // Evidence from another incident is not found here.
  assert.equal(
    (await h.docs.transferEvidence(AGENT, incident.id, "ev-missing", { toActor: "user-2", reason: "x" })).ok,
    false,
  );

  h.tick("2026-09-20T10:30:00.000Z");
  const moved = await h.docs.transferEvidence(AGENT, incident.id, recorded.value.id, {
    toActor: "forensics@acme.test",
    reason: "Handed the image to the forensics vendor",
  });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    // The hand-off starts from the current holder, not from the requestor.
    assert.equal(moved.value.fromActor, AGENT.id);
    assert.equal(moved.value.toActor, "forensics@acme.test");
    assert.equal(moved.value.at, "2026-09-20T10:30:00.000Z");
  }

  trail = await h.docs.listCustody("tenant-a", incident.id);
  assert.equal(trail.length, 2);
  assert.equal(custodyIntegrity(trail, recorded.value.collectedBy).ok, true);

  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.equal(timeline.filter((event) => event.kind === "custody").length, 1);
  assert.ok(actions(h.audit).includes("incident.custody.transfer"));

  // Custody is part of the record, so moving it changes the manifest digest.
  h.tick("2026-09-20T11:00:00.000Z");
  const manifest = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(manifest.ok, true);
  if (manifest.ok) {
    assert.equal(manifest.value.custody.length, 2);
    assert.equal(manifest.value.custody[1].toActor, "forensics@acme.test");
  }
});

test("a legal hold is placed once, blocks retention, and is released with a reason", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  assert.equal(await h.docs.activeHold("tenant-a", incident.id), null);
  assert.equal((await h.docs.placeLegalHold(AGENT, incident.id, "  ")).ok, false);

  const placed = await h.docs.placeLegalHold(AGENT, incident.id, "Insurer requested preservation");
  assert.equal(placed.ok, true);
  if (!placed.ok) return;
  assert.equal(placed.value.placedBy, AGENT.id);
  assert.equal(placed.value.releasedAt, null);

  // Placing a second hold while one is in force is refused — one is enough.
  assert.equal((await h.docs.placeLegalHold(AGENT, incident.id, "again")).ok, false);
  assert.equal((await h.docs.activeHold("tenant-a", incident.id))?.id, placed.value.id);

  // The manifest carries the hold, so a reader does not have to go looking.
  const manifest = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(manifest.ok, true);
  if (manifest.ok) assert.equal(manifest.value.legalHold?.reason, "Insurer requested preservation");

  assert.equal((await h.docs.releaseLegalHold(AGENT, incident.id, " ")).ok, false);
  const released = await h.docs.releaseLegalHold(AGENT, incident.id, "Insurer withdrew the request");
  assert.equal(released.ok, true);
  if (released.ok) {
    assert.equal(released.value.releasedBy, AGENT.id);
    assert.notEqual(released.value.releasedAt, null);
  }
  assert.equal(await h.docs.activeHold("tenant-a", incident.id), null);
  // A released hold is kept, not deleted: the history is the point.
  assert.equal((await h.docs.listHolds("tenant-a", incident.id)).length, 1);

  assert.equal((await h.docs.releaseLegalHold(AGENT, incident.id, "nothing to release")).ok, false);

  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.deepEqual(
    timeline.filter((event) => event.kind === "hold").map((event) => event.summary),
    ["Legal hold placed", "Legal hold released"],
  );
  assert.ok(actions(h.audit).includes("incident.hold.place"));
  assert.ok(actions(h.audit).includes("incident.hold.release"));
});

test("documentation is tenant-scoped and permission-gated", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  const requester = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
  assert.equal((await h.docs.startPlaybook(requester, incident.id)).ok, false);
  assert.equal((await h.docs.completeStep(requester, incident.id, "declare")).ok, false);
  assert.equal((await h.docs.recordEvidence(requester, incident.id, { kind: "NOTE", label: "x", reference: "y" })).ok, false);
  assert.equal((await h.docs.transferEvidence(requester, incident.id, "ev-1", { toActor: "x", reason: "y" })).ok, false);
  assert.equal((await h.docs.placeLegalHold(requester, incident.id, "because")).ok, false);
  assert.equal((await h.docs.releaseLegalHold(requester, incident.id, "because")).ok, false);

  const otherTenant = { ...AGENT, tenantId: "tenant-b" };
  assert.equal((await h.docs.startPlaybook(otherTenant, incident.id)).ok, false);
  assert.equal((await h.docs.manifest("tenant-b", incident.id)).ok, false);
  assert.deepEqual(await h.docs.listSteps("tenant-b", incident.id), []);
  assert.deepEqual(await h.docs.listCustody("tenant-b", incident.id), []);
  assert.equal(await h.docs.activeHold("tenant-b", incident.id), null);
  // A hand-off raises against another tenant's incident rather than finding it.
  assert.equal((await h.docs.transferEvidence(otherTenant, incident.id, "ev-1", { toActor: "x", reason: "y" })).ok, false);
});

/* ---------------------------------------------------------- prisma adapter */

const stepRow: PlaybookStepRow = {
  id: "step-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  key: "declare",
  title: "Declare",
  description: "Declare it",
  phase: "DETECTED",
  order: 1,
  status: "DONE",
  completedAt: new Date("2026-09-20T09:01:00Z"),
  completedBy: "user-1",
  note: null,
};

const evidenceRow: EvidenceItemRow = {
  id: "ev-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  kind: "LOG",
  label: "Auth log",
  reference: "s3://evidence/1",
  sha256: "e".repeat(64),
  note: null,
  collectedBy: "user-1",
  collectedAt: new Date("2026-09-20T09:05:00Z"),
};

const custodyRow: CustodyEntryRow = {
  id: "cust-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  evidenceId: "ev-1",
  at: new Date("2026-09-20T09:05:00Z"),
  action: "COLLECTED",
  fromActor: "user-1",
  toActor: "user-1",
  reason: null,
};

const holdRow: LegalHoldRow = {
  id: "hold-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  reason: "Insurer asked us to preserve the record",
  placedBy: "user-2",
  placedAt: new Date("2026-09-20T10:00:00Z"),
  releasedBy: null,
  releasedAt: null,
};

const artifactRow: EvidenceArtifactRow = {
  id: "art-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  key: `evidence/tenant-a/inc-1/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
  bytes: 2048,
  contentType: "application/gzip",
  mode: "COMPLIANCE",
  retainUntil: new Date("2036-09-20T09:05:00Z"),
  lockedAt: new Date("2026-09-20T09:05:00Z"),
  createdBy: "user-1",
  purgedAt: null,
};

test("the docs mappers narrow status and kind and round-trip", () => {
  const step = toStepRecord(stepRow);
  assert.equal(step.status, "DONE");
  assert.equal(step.completedAt, "2026-09-20T09:01:00.000Z");
  assert.equal(toStepRecord({ ...stepRow, status: "nonsense" }).status, "PENDING");
  assert.ok(toStepData(step).completedAt instanceof Date);

  const item = toEvidenceRecord(evidenceRow);
  assert.equal(item.kind, "LOG");
  assert.equal(item.collectedAt, "2026-09-20T09:05:00.000Z");
  assert.equal(toEvidenceRecord({ ...evidenceRow, kind: "VIDEO" }).kind, "NOTE");
  assert.ok(toEvidenceData(item).collectedAt instanceof Date);

  const artifact = toArtifactRecord(artifactRow);
  assert.equal(artifact.mode, "COMPLIANCE");
  assert.equal(artifact.retainUntil, "2036-09-20T09:05:00.000Z");
  assert.equal(artifact.purgedAt, null);
  // A mode this version does not know degrades to the cautious one, not to "open".
  assert.equal(toArtifactRecord({ ...artifactRow, mode: "nonsense" }).mode, "COMPLIANCE");
  assert.ok(toArtifactData(artifact).retainUntil instanceof Date);
  assert.equal(toArtifactData({ ...artifact, purgedAt: "2026-09-21T00:00:00.000Z" }).purgedAt instanceof Date, true);
});

test("the Prisma docs store inserts, updates and lists", async () => {
  const createdSteps: unknown[] = [];
  const createdEvidence: unknown[] = [];
  const createdCustody: unknown[] = [];
  const createdHolds: unknown[] = [];
  const createdArtifacts: unknown[] = [];
  let updated: unknown = null;
  let updatedHold: unknown = null;
  let updatedArtifact: unknown = null;
  const client: IncidentDocsPrismaClient = {
    playbookStep: {
      findFirst: async (args) => ((args as { where: { key: string } }).where.key === "declare" ? stepRow : null),
      findMany: async () => [stepRow],
      createMany: async (args) => {
        createdSteps.push(...args.data);
        return {};
      },
      update: async (args) => {
        updated = args.data;
        return {};
      },
    },
    evidenceItem: {
      findFirst: async (args) => ((args as { where: { id: string } }).where.id === evidenceRow.id ? evidenceRow : null),
      findMany: async () => [evidenceRow],
      create: async (args) => {
        createdEvidence.push(args.data);
        return {};
      },
    },
    custodyEntry: {
      findMany: async () => [custodyRow],
      create: async (args) => {
        createdCustody.push(args.data);
        return {};
      },
    },
    legalHold: {
      findMany: async () => [holdRow],
      create: async (args) => {
        createdHolds.push(args.data);
        return {};
      },
      update: async (args) => {
        updatedHold = args.data;
        return {};
      },
    },
    evidenceArtifact: {
      findFirst: async (args) => {
        const where = (args as { where: { id?: string; key?: string } }).where;
        if (where.id) return where.id === artifactRow.id ? artifactRow : null;
        return where.key === artifactRow.key ? artifactRow : null;
      },
      findMany: async () => [artifactRow],
      create: async (args) => {
        createdArtifacts.push(args.data);
        return {};
      },
      update: async (args) => {
        updatedArtifact = args.data;
        return {};
      },
    },
  };
  const store: IncidentDocsStore = new PrismaIncidentDocsStore(client);

  await store.insertSteps([toStepRecord(stepRow)]);
  assert.equal(createdSteps.length, 1);
  assert.equal((await store.findStep("tenant-a", "inc-1", "declare"))?.status, "DONE");
  assert.equal(await store.findStep("tenant-a", "inc-1", "nope"), null);
  assert.equal((await store.listSteps("tenant-a", "inc-1"))[0].key, "declare");
  await store.updateStep({ ...toStepRecord(stepRow), status: "PENDING" });
  assert.equal((updated as { status: string }).status, "PENDING");

  await store.insertEvidence(toEvidenceRecord(evidenceRow));
  assert.equal(createdEvidence.length, 1);
  assert.equal((await store.findEvidence("tenant-a", "ev-1"))?.label, "Auth log");
  assert.equal(await store.findEvidence("tenant-a", "missing"), null);
  assert.equal((await store.listEvidence("tenant-a", "inc-1"))[0].label, "Auth log");

  await store.insertCustody(toCustodyRecord(custodyRow));
  assert.equal(createdCustody.length, 1);
  const trail = await store.listCustody("tenant-a", "inc-1");
  assert.equal(trail[0].action, "COLLECTED");
  assert.equal(trail[0].at, "2026-09-20T09:05:00.000Z");

  await store.insertHold(toHoldRecord(holdRow));
  assert.equal(createdHolds.length, 1);
  const holds = await store.listHolds("tenant-a", "inc-1");
  assert.equal(holds[0].reason, "Insurer asked us to preserve the record");
  assert.equal("releasedAt" in (createdHolds[0] as Record<string, unknown>), true);
  await store.updateHold({ ...toHoldRecord(holdRow), releasedBy: "user-1", releasedAt: "2026-09-21T09:00:00.000Z" });
  assert.equal((updatedHold as { releasedBy: string }).releasedBy, "user-1");
  assert.ok((updatedHold as { releasedAt: Date }).releasedAt instanceof Date);

  await store.insertArtifact(toArtifactRecord(artifactRow));
  assert.equal(createdArtifacts.length, 1);
  assert.ok((createdArtifacts[0] as { retainUntil: Date }).retainUntil instanceof Date);
  assert.equal((await store.findArtifact("tenant-a", "art-1"))?.sha256, "a".repeat(64));
  assert.equal(await store.findArtifact("tenant-a", "missing"), null);
  assert.equal((await store.findArtifactByKey("tenant-a", artifactRow.key))?.id, "art-1");
  assert.equal(await store.findArtifactByKey("tenant-a", "evidence/other"), null);
  assert.equal((await store.listArtifacts("tenant-a", "inc-1"))[0].contentType, "application/gzip");
  await store.markArtifactPurged("tenant-a", "art-1", "2026-09-21T00:00:00.000Z");
  assert.ok((updatedArtifact as { purgedAt: Date }).purgedAt instanceof Date);
});

test("the custody and hold mappers narrow and round-trip", () => {
  const entry = toCustodyRecord(custodyRow);
  assert.equal(entry.action, "COLLECTED");
  assert.equal(toCustodyRecord({ ...custodyRow, action: "nonsense" }).action, "TRANSFERRED");
  assert.ok(toCustodyData(entry).at instanceof Date);

  const hold = toHoldRecord(holdRow);
  assert.equal(hold.releasedAt, null);
  assert.equal(toHoldRecord({ ...holdRow, releasedAt: new Date("2026-09-21T09:00:00Z") }).releasedAt, "2026-09-21T09:00:00.000Z");
});

/* ------------------------------------------------------------- console UI */

test("the incident console renders severity, roles, playbook, evidence and timeline", () => {
  const html = renderToStaticMarkup(
    createElement(IncidentList, {
      incidents: [
        {
          incident: {
            id: "inc-1",
            tenantId: "tenant-a",
            ref: "INC-000001",
            title: "Mail outage",
            summary: "Exchange is down.",
            severity: "SEV1",
            phase: "TRIAGED",
            impact: "EXTENSIVE",
            urgency: "CRITICAL",
            ticketId: "tkt-1",
            alertId: null,
            commanderId: "user-1",
            commsLeadId: null,
            scribeId: "user-2",
            liaisonId: null,
            detectedAt: "2026-09-20T08:55:00.000Z",
            declaredAt: "2026-09-20T09:00:00.000Z",
            updatedAt: "2026-09-20T09:10:00.000Z",
            resolvedAt: null,
            reviewedAt: null,
          },
          steps: [
            {
              id: "s1",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              key: "declare",
              title: "Declare and set the severity",
              description: "Record the incident.",
              phase: "DETECTED",
              order: 1,
              status: "DONE",
              completedAt: "2026-09-20T09:01:00.000Z",
              completedBy: "user-1",
              note: null,
            },
            {
              id: "s2",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              key: "comms",
              title: "Send the first stakeholder communication",
              description: "Holding statement.",
              phase: "TRIAGED",
              order: 2,
              status: "SKIPPED",
              completedAt: "2026-09-20T09:08:00.000Z",
              completedBy: "user-2",
              note: "No external stakeholders affected",
            },
          ],
          evidence: [
            {
              id: "ev-1",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              kind: "LOG",
              label: "Exchange transport log",
              reference: "s3://evidence/1",
              sha256: "f".repeat(64),
              note: null,
              collectedBy: "user-1",
              collectedAt: "2026-09-20T09:05:00.000Z",
            },
          ],
          custody: [
            {
              id: "c1",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              evidenceId: "ev-1",
              at: "2026-09-20T09:05:00.000Z",
              action: "COLLECTED",
              fromActor: "user-1",
              toActor: "user-1",
              reason: null,
            },
            {
              id: "c2",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              evidenceId: "ev-1",
              at: "2026-09-20T10:30:00.000Z",
              action: "TRANSFERRED",
              fromActor: "user-1",
              toActor: "forensics@acme.test",
              reason: "Handed to the forensics vendor",
            },
          ],
          holds: [
            {
              id: "hold-1",
              tenantId: "tenant-a",
              incidentId: "inc-1",
              reason: "Insurer requested preservation",
              placedBy: "user-2",
              placedAt: "2026-09-20T11:00:00.000Z",
              releasedBy: null,
              releasedAt: null,
            },
          ],
          timeline: [
            { id: "t1", tenantId: "tenant-a", incidentId: "inc-1", at: "2026-09-20T09:00:00.000Z", kind: "declared", actor: "agent-1", summary: "Declared SEV1: Mail outage", detail: null },
          ],
        },
      ],
      staff: [{ id: "user-1", displayName: "Sam Agent", role: "AGENT" }],
      actions: {
        advance: async () => {},
        assignRole: async () => {},
        addNote: async () => {},
        startPlaybook: async () => {},
        step: async () => {},
        recordEvidence: async () => {},
        transfer: async () => {},
        placeHold: async () => {},
        releaseHold: async () => {},
      },
    }),
  );

  assert.match(html, /INC-000001/);
  assert.match(html, /SEV1/);
  assert.match(html, /TRIAGED/);
  assert.match(html, /Incident commander/);
  assert.match(html, /Sam Agent/);
  // Only the legal next moves are offered: from TRIAGED, containment.
  assert.match(html, /Move to contained/);
  assert.doesNotMatch(html, /Move to detected/);
  assert.doesNotMatch(html, /Move to triaged/);
  assert.doesNotMatch(html, /Move to reviewed/);
  // A skipped step stays visible, with its reason.
  assert.match(html, /skipped/);
  assert.match(html, /No external stakeholders affected/);
  assert.match(html, /1\/2 done/);
  assert.match(html, /Exchange transport log/);
  assert.match(html, /Download manifest/);
  assert.match(html, /Declared SEV1: Mail outage/);
  assert.match(html, /Add a timeline note/);
  assert.match(html, /Add note/);
  // The chain of custody and the hold are on the console, not hidden behind it.
  assert.match(html, /Custody: 2 entries, held by forensics@acme.test/);
  assert.match(html, /Handed to the forensics vendor/);
  assert.match(html, /Hand off/);
  assert.match(html, /legal hold/);
  assert.match(html, /Insurer requested preservation/);
  assert.match(html, /Release hold/);
  assert.match(html, /Download assurance packet/);
});

test("the incident console offers no actions to a read-only viewer, and starts an unplanned playbook", () => {
  const readOnly = renderToStaticMarkup(
    createElement(IncidentList, {
      incidents: [
        {
          incident: {
            id: "inc-2",
            tenantId: "tenant-a",
            ref: "INC-000002",
            title: "Disk full",
            summary: "Volume full.",
            severity: "SEV3",
            phase: "DETECTED",
            impact: "MODERATE",
            urgency: "MEDIUM",
            ticketId: null,
            alertId: null,
            commanderId: null,
            commsLeadId: null,
            scribeId: null,
            liaisonId: null,
            detectedAt: "2026-09-20T08:00:00.000Z",
            declaredAt: "2026-09-20T08:00:00.000Z",
            updatedAt: "2026-09-20T08:00:00.000Z",
            resolvedAt: null,
            reviewedAt: null,
          },            steps: [],
            evidence: [],
            custody: [],
            holds: [],
            timeline: [],
        },
      ],
      staff: [],
    }),
  );
  assert.doesNotMatch(readOnly, /Move to/);
  assert.doesNotMatch(readOnly, /Start playbook/);
  assert.match(readOnly, /not started/);

  const empty = renderToStaticMarkup(createElement(IncidentList, { incidents: [], staff: [] }));
  assert.match(empty, /No incidents/);
});
