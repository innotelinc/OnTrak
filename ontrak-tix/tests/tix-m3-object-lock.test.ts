/**
 * OnTrak Tix M3 tests: object-lock (WORM) storage for evidence artifacts.
 *
 * Covers the pure retention rules, the write-once filesystem store, the service
 * that stores bytes and records them as evidence, the manifest that carries the
 * lock, and what the console actually shows.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-object-lock.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { IncidentDocsService, MemoryIncidentDocsStore, type EvidenceArtifactRecord } from "../src/lib/incident-docs-service";
import { IncidentService, MemoryIncidentStore } from "../src/lib/incident-service";
import { EVIDENCE_RETENTION_DAYS } from "../src/lib/evidence-rules";
import { FileEvidenceObjectStore, sha256Bytes } from "../src/lib/object-lock-file";
import {
  DEFAULT_RETENTION_MODE,
  EVIDENCE_ARTIFACT_MAX_BYTES,
  MemoryEvidenceObjectStore,
  artifactHeld,
  artifactKeyFor,
  describeLock,
  isRetentionMode,
  objectLockFor,
  objectLockHeaders,
  objectPutDecision,
  objectPurgeDecision,
  retentionModeFromEnv,
  sameBytes,
} from "../src/lib/object-lock-rules";
import { IncidentList } from "../src/components/IncidentList";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const OUTSIDER = { id: "admin-2", tenantId: "tenant-b", role: "ADMIN" as const };

/* ------------------------------------------------------------------ rules */

test("a lock states the same ten-year window evidence already has, in both modes", () => {
  const base = { collectedAt: "2026-09-20T09:05:00.000Z", now: "2026-09-20T09:05:00.000Z" };
  const lock = objectLockFor(base);
  assert.equal(lock.mode, DEFAULT_RETENTION_MODE);
  assert.equal(lock.mode, "COMPLIANCE");
  assert.equal(lock.lockedAt, base.now);
  // Stated as a date a third party can read, not as "our default".
  const expected = new Date("2026-09-20T09:05:00.000Z").getTime() + EVIDENCE_RETENTION_DAYS * 86_400_000;
  assert.equal(lock.retainUntil, new Date(expected).toISOString());
  assert.equal(describeLock(lock), `COMPLIANCE until ${lock.retainUntil}`);

  // A policy can shorten the window and pick the softer mode.
  const softer = objectLockFor({ ...base, mode: "GOVERNANCE", retentionDays: 30 });
  assert.equal(softer.mode, "GOVERNANCE");
  assert.equal(softer.retainUntil, "2026-10-20T09:05:00.000Z");
});

test("the deployment's default mode comes from the environment, and junk falls back", () => {
  assert.equal(retentionModeFromEnv({}), "COMPLIANCE");
  assert.equal(retentionModeFromEnv({ ONTRAK_TIX_EVIDENCE_LOCK_MODE: " governance " }), "GOVERNANCE");
  assert.equal(retentionModeFromEnv({ ONTRAK_TIX_EVIDENCE_LOCK_MODE: "nonsense" }), "COMPLIANCE");
  assert.equal(isRetentionMode("COMPLIANCE"), true);
  assert.equal(isRetentionMode("NONE"), false);
});

test("a key is derived from the content, so it cannot drift from its bytes", () => {
  const digest = "AB".repeat(32);
  assert.equal(artifactKeyFor("tenant-a", "inc-1", digest), `evidence/tenant-a/inc-1/${"ab".repeat(32)}`);
  assert.match(sha256Bytes(new Uint8Array([1, 2, 3])), /^[a-f0-9]{64}$/);
  // The digest is of the bytes, not of anything the caller said about them.
  assert.equal(sha256Bytes(new Uint8Array([1, 2, 3])), sha256Bytes(new Uint8Array([1, 2, 3])));
  assert.notEqual(sha256Bytes(new Uint8Array([1, 2, 3])), sha256Bytes(new Uint8Array([1, 2, 4])));
  assert.equal(sameBytes(new Uint8Array([1]), new Uint8Array([1])), true);
  assert.equal(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});

test("storing the same bytes twice is a no-op, and different bytes are a conflict", () => {
  const digest = "a".repeat(64);
  assert.equal(objectPutDecision(null, digest).action, "create");
  assert.equal(objectPutDecision({ sha256: digest.toUpperCase() }, digest).action, "unchanged");
  const conflict = objectPutDecision({ sha256: "b".repeat(64) }, digest);
  assert.equal(conflict.action, "conflict");
  assert.match(conflict.reason, /never overwritten/);
  // A purge is a recorded act; re-storing under the key would quietly undo it.
  const purged = objectPutDecision({ sha256: digest, purgedAt: "2026-09-21T00:00:00.000Z" }, digest);
  assert.equal(purged.action, "conflict");
  assert.match(purged.reason, /purged/);
});

test("COMPLIANCE never yields early, GOVERNANCE only when asked and recorded", () => {
  const lock = objectLockFor({ collectedAt: "2026-09-20T09:05:00.000Z", now: "2026-09-20T09:05:00.000Z" });
  const during = "2026-10-01T00:00:00.000Z";

  // The clock has not run out, and no caller can shorten it — not even a bypass.
  const compliance = objectPurgeDecision({ lock, holdActive: false }, during, { bypassGovernance: true });
  assert.equal(compliance.allowed, false);
  assert.equal(compliance.requiresBypass, false);
  assert.match(compliance.reason, /COMPLIANCE/);

  // GOVERNANCE says no by default, but names the move that would work.
  const softLock = { ...lock, mode: "GOVERNANCE" as const };
  const refused = objectPurgeDecision({ lock: softLock, holdActive: false }, during);
  assert.equal(refused.allowed, false);
  assert.equal(refused.requiresBypass, true);
  const bypassed = objectPurgeDecision({ lock: softLock, holdActive: false }, during, { bypassGovernance: true });
  assert.equal(bypassed.allowed, true);
  assert.equal(bypassed.requiresBypass, true);
  assert.match(bypassed.reason, /on the record/);

  // Once the window closes, both modes are removable without ceremony.
  const after = "2037-01-01T00:00:00.000Z";
  assert.equal(objectPurgeDecision({ lock, holdActive: false }, after).allowed, true);
  assert.equal(objectPurgeDecision({ lock: softLock, holdActive: false }, after).requiresBypass, false);

  // Already gone stays gone.
  assert.equal(objectPurgeDecision({ lock: softLock, holdActive: false, purgedAt: during }, after).allowed, false);
});

test("a legal hold outranks the clock in both directions", () => {
  const lock = objectLockFor({ collectedAt: "2026-09-20T09:05:00.000Z", now: "2026-09-20T09:05:00.000Z" });
  const after = "2037-01-01T00:00:00.000Z";

  // It blocks an artifact that is still inside its window, bypass or not…
  const blocked = objectPurgeDecision({ lock, holdActive: true }, "2026-10-01T00:00:00.000Z", { bypassGovernance: true });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.requiresBypass, false);

  // …and one whose window has already closed, which is the case that matters:
  // "the clock ran out" is not the same answer as "you may destroy it".
  const held = objectPurgeDecision({ lock, holdActive: true }, after);
  assert.equal(held.allowed, false);
  assert.match(held.reason, /legal hold/);
});

test("the object store headers are the ones a real backend enforces", () => {
  const headers = objectLockHeaders({ mode: "GOVERNANCE", retainUntil: "2036-09-20T09:05:00.000Z", lockedAt: "2026-09-20T09:05:00.000Z" });
  assert.deepEqual(headers, {
    "x-amz-object-lock-mode": "GOVERNANCE",
    "x-amz-object-lock-retain-until-date": "2036-09-20T09:05:00.000Z",
  });
  assert.equal(artifactHeld({ purgedAt: null }), true);
  assert.equal(artifactHeld({ purgedAt: "2026-09-21T00:00:00.000Z" }), false);
});

/* ----------------------------------------------------------- object stores */

test("the in-memory store refuses to replace locked bytes", async () => {
  const store = new MemoryEvidenceObjectStore();
  const bytes = new TextEncoder().encode("evidence");
  assert.equal(await store.put("k", bytes, "text/plain"), "created");
  // The same bytes are the same object; a retry is not a collision.
  assert.equal(await store.put("k", new TextEncoder().encode("evidence"), "text/plain"), "unchanged");
  await assert.rejects(() => store.put("k", new TextEncoder().encode("other"), "text/plain"), /Refusing to overwrite/);
  assert.deepEqual(await store.get("k"), bytes);
  assert.equal(await store.get("missing"), null);
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});

test("the filesystem store is write-once by the kernel, not by a check-then-write", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontrak-evidence-"));
  try {
    const store = new FileEvidenceObjectStore(root);
    const bytes = new TextEncoder().encode("triage bundle");
    assert.equal(await store.put("evidence/tenant-a/inc-1/abc", bytes, "application/gzip"), "created");
    assert.equal(await store.put("evidence/tenant-a/inc-1/abc", bytes, "application/gzip"), "unchanged");
    await assert.rejects(
      () => store.put("evidence/tenant-a/inc-1/abc", new TextEncoder().encode("tampered"), "application/gzip"),
      /Refusing to overwrite/,
    );

    // The intent is visible on disk: the file is read-only.
    const stat = await readFile(join(root, "evidence/tenant-a/inc-1/abc"));
    assert.deepEqual(new Uint8Array(stat), bytes);

    // Removal after the retention window is the point of having a window, so
    // delete lifts the read-only bit rather than failing on it.
    await store.delete("evidence/tenant-a/inc-1/abc");
    assert.equal(await store.get("evidence/tenant-a/inc-1/abc"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the filesystem store refuses a key that would climb out of its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontrak-evidence-"));
  try {
    const store = new FileEvidenceObjectStore(root);
    for (const key of ["../escape", "/tmp/absolute", "evidence//empty", "evidence/../../up"]) {
      await assert.rejects(() => store.put(key, new Uint8Array([1]), "application/octet-stream"), /unsafe evidence key/);
    }
    assert.equal(await store.get("../escape"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- service */

function harness(options: { mode?: "COMPLIANCE" | "GOVERNANCE"; retentionDays?: number; storage?: boolean } = {}) {
  const audit = new AuditLog(sha256);
  const incidentStore = new MemoryIncidentStore();
  const objects = new MemoryEvidenceObjectStore();
  let n = 0;
  let clock = "2026-09-20T09:00:00.000Z";
  const ids = { id: () => `id-${++n}`, now: () => clock };
  const incidents = new IncidentService(incidentStore, audit, ids);
  const docs = new IncidentDocsService(
    new MemoryIncidentDocsStore(),
    incidentStore,
    audit,
    ids,
    sha256,
    options.storage === false ? null : { objects, mode: options.mode ?? "COMPLIANCE", retentionDays: options.retentionDays },
  );
  return {
    audit,
    objects,
    incidents,
    docs,
    tick: (at: string) => {
      clock = at;
    },
  };
}

async function declareIncident(h: ReturnType<typeof harness>) {
  const result = await h.incidents.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("declare failed");
  return result.value;
}

test("storing bytes records the evidence item whose reference is the object key", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  h.tick("2026-09-20T09:05:00.000Z");
  const bytes = new TextEncoder().encode("exchange transport log");

  const stored = await h.docs.recordArtifact(AGENT, incident.id, {
    kind: "LOG",
    label: "Exchange transport log",
    contentType: "text/plain",
    bytes,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const digest = sha256Bytes(bytes);
  assert.equal(stored.value.stored, "created");
  assert.equal(stored.value.artifact.key, artifactKeyFor("tenant-a", incident.id, digest));
  assert.equal(stored.value.artifact.sha256, digest);
  assert.equal(stored.value.artifact.bytes, bytes.byteLength);
  assert.equal(stored.value.artifact.mode, "COMPLIANCE");
  assert.equal(stored.value.artifact.purgedAt, null);
  assert.equal(stored.value.artifact.createdBy, AGENT.id);
  // The two halves cannot disagree about which bytes they mean.
  assert.equal(stored.value.item.reference, stored.value.artifact.key);
  assert.equal(stored.value.item.sha256, digest);
  assert.deepEqual(await h.objects.get(stored.value.artifact.key), bytes);

  // Re-uploading identical bytes is another collection of the same artifact,
  // not a second object and not an error.
  const again = await h.docs.recordArtifact(AGENT, incident.id, { kind: "LOG", label: "Re-collected", bytes });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.stored, "unchanged");
  assert.equal(again.value.artifact.id, stored.value.artifact.id);
  assert.equal((await h.docs.listArtifacts("tenant-a", incident.id)).length, 1);
  assert.equal((await h.docs.listEvidence("tenant-a", incident.id)).length, 2);

  // Both acts are on the timeline and the audit chain, not only in the table.
  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.ok(timeline.some((event) => /Artifact locked/.test(event.summary)));
  assert.equal(h.audit.snapshot().events.filter((entry) => entry.action === "incident.evidence.store").length, 2);

  // The lock is inside the manifest digest, so an auditor reading the record
  // sees the retention that applied — and a change to it changes the digest.
  const manifest = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.value.artifacts.length, 1);
  assert.equal(manifest.value.artifacts[0].key, stored.value.artifact.key);
  assert.equal(manifest.value.artifacts[0].mode, "COMPLIANCE");
});

test("an upload has to be a real file, and the deployment has to have storage", async () => {
  const h = harness();
  const incident = await declareIncident(h);

  assert.equal(h.docs.artifactStorageEnabled, true);
  assert.equal((await h.docs.recordArtifact(AGENT, incident.id, { kind: "LOG", label: "Empty", bytes: new Uint8Array() })).ok, false);
  assert.equal(
    (await h.docs.recordArtifact(AGENT, incident.id, { kind: "VIDEO" as never, label: "Video", bytes: new Uint8Array([1]) })).ok,
    false,
  );
  assert.equal(
    (await h.docs.recordArtifact(AGENT, incident.id, { kind: "LOG", label: " ", bytes: new Uint8Array([1]) })).ok,
    false,
  );
  assert.equal((await h.docs.recordArtifact(AGENT, "missing-incident", { kind: "LOG", label: "Log", bytes: new Uint8Array([1]) })).ok, false);

  // A read-only role cannot write evidence at all.
  const requester = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
  assert.equal((await h.docs.recordArtifact(requester, incident.id, { kind: "LOG", label: "Log", bytes: new Uint8Array([1]) })).ok, false);

  // Nothing large enough to be a mistake gets stored.
  const oversized = new Uint8Array(EVIDENCE_ARTIFACT_MAX_BYTES + 1);
  const tooBig = await h.docs.recordArtifact(AGENT, incident.id, { kind: "LOG", label: "Bundle", bytes: oversized });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.match(tooBig.error, /at most 64 MB/);

  // Nothing was written for any of the refusals: validation runs first.
  assert.deepEqual(await h.docs.listArtifacts("tenant-a", incident.id), []);

  const noStorage = harness({ storage: false });
  const bare = await declareIncident(noStorage);
  assert.equal(noStorage.docs.artifactStorageEnabled, false);
  const refused = await noStorage.docs.recordArtifact(AGENT, bare.id, { kind: "LOG", label: "Log", bytes: new Uint8Array([1]) });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /storage is not configured/);
});

test("removing bytes needs an administrator, a reason, and a lock that allows it", async () => {
  const h = harness();
  const incident = await declareIncident(h);
  const stored = await h.docs.recordArtifact(AGENT, incident.id, { kind: "LOG", label: "Log", bytes: new Uint8Array([9]) });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const { artifact } = stored.value;
  h.tick("2026-10-01T00:00:00.000Z");

  // Recording evidence is a normal act; destroying it is not.
  const asAgent = await h.docs.purgeArtifact(AGENT, incident.id, artifact.id, { reason: "cleanup" });
  assert.equal(asAgent.ok, false);
  if (!asAgent.ok) assert.match(asAgent.error, /administrator/);

  // A removal with no reason is not a recorded act, so it is refused.
  const noReason = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "  " });
  assert.equal(noReason.ok, false);
  if (!noReason.ok) assert.match(noReason.error, /reason/);

  // Inside the COMPLIANCE window nothing yields — bypass or not.
  const tooEarly = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "disk pressure", bypassGovernance: true });
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.match(tooEarly.error, /COMPLIANCE/);
  assert.deepEqual(await h.objects.get(artifact.key), new Uint8Array([9]));

  // An artifact from another incident is not reachable through this one.
  const other = await declareIncident(h);
  const wrongIncident = await h.docs.purgeArtifact(ADMIN, other.id, artifact.id, { reason: "ops" });
  assert.equal(wrongIncident.ok, false);
  if (!wrongIncident.ok) assert.match(wrongIncident.error, /not on this incident/);
});

test("GOVERNANCE can be removed early on the record, and a legal hold stops even that", async () => {
  const h = harness({ mode: "GOVERNANCE" });
  const incident = await declareIncident(h);
  const stored = await h.docs.recordArtifact(AGENT, incident.id, { kind: "SNAPSHOT", label: "Volume", bytes: new Uint8Array([7, 7]) });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const { artifact } = stored.value;
  assert.equal(artifact.mode, "GOVERNANCE");
  h.tick("2026-10-01T00:00:00.000Z");

  const hold = await h.docs.placeLegalHold(AGENT, incident.id, "Insurer requested preservation");
  assert.equal(hold.ok, true);

  // The hold blocks the window that has not closed…
  const held = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "ops", bypassGovernance: true });
  assert.equal(held.ok, false);
  if (!held.ok) assert.match(held.error, /legal hold/);

  // …and the bypass refusal names the move that would work.
  const released = await h.docs.releaseLegalHold(AGENT, incident.id, "Insurer withdrew the request");
  assert.equal(released.ok, true);
  const refused = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "ops" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /GOVERNANCE/);

  const purged = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "superseded by the new bundle", bypassGovernance: true });
  assert.equal(purged.ok, true);
  if (!purged.ok) return;
  assert.notEqual(purged.value.purgedAt, null);

  // The bytes are actually gone from the store, and the row says so.
  assert.equal(await h.objects.get(artifact.key), null);
  assert.equal((await h.docs.listArtifacts("tenant-a", incident.id))[0].purgedAt, purged.value.purgedAt);

  // A second removal has nothing to do, and says that rather than pretending.
  const again = await h.docs.purgeArtifact(ADMIN, incident.id, artifact.id, { reason: "again", bypassGovernance: true });
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /already been purged/);

  // Both the bypass and the refusal-to-remove-later are on the record.
  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.ok(timeline.some((event) => /Artifact purged/.test(event.summary)));
  const audit = h.audit.snapshot().events.filter((entry) => entry.action === "incident.evidence.purge");
  assert.equal(audit.length, 1);
  assert.equal((audit[0].detail as { bypassedGovernance: boolean }).bypassedGovernance, true);
});

test("artifacts are tenant-scoped, and the manifest carries a purged artifact's tombstone", async () => {
  // A short window, so this artifact ages out on its own rather than needing a bypass.
  const h = harness({ mode: "GOVERNANCE", retentionDays: 30 });
  const incident = await declareIncident(h);
  const stored = await h.docs.recordArtifact(AGENT, incident.id, { kind: "FILE", label: "Config", bytes: new Uint8Array([3, 1, 4]) });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  // Another tenant sees none of it, and cannot reach it by id.
  assert.deepEqual(await h.docs.listArtifacts("tenant-b", incident.id), []);
  const foreign = await h.docs.purgeArtifact(OUTSIDER, incident.id, stored.value.artifact.id, { reason: "ops" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && /not found/i.test(foreign.error), true);

  // The bytes outlive nothing: after a purge the manifest still lists the
  // artifact, with the purge time — the record is the point, not the file.
  h.tick("2027-01-01T00:00:00.000Z");
  assert.equal(stored.value.artifact.retainUntil, "2026-10-20T09:00:00.000Z");
  const purged = await h.docs.purgeArtifact(ADMIN, incident.id, stored.value.artifact.id, { reason: "aged out" });
  assert.equal(purged.ok, true);
  const manifest = await h.docs.manifest("tenant-a", incident.id);
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.equal(manifest.value.artifacts[0].purgedAt, "2027-01-01T00:00:00.000Z");
});

/* ----------------------------------------------------------------- console */

const artifact: EvidenceArtifactRecord = {
  id: "art-1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  key: `evidence/tenant-a/inc-1/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
  bytes: 4096,
  contentType: "application/gzip",
  mode: "COMPLIANCE" as const,
  retainUntil: "2036-09-20T09:05:00.000Z",
  lockedAt: "2026-09-20T09:05:00.000Z",
  createdBy: "agent-1",
  purgedAt: null,
};

function view(artifacts: EvidenceArtifactRecord[]) {
  return {
    incident: {
      id: "inc-1",
      tenantId: "tenant-a",
      ref: "INC-000001",
      title: "Mail outage",
      summary: "Exchange is down.",
      severity: "SEV1" as const,
      phase: "CONTAINED" as const,
      impact: "EXTENSIVE" as const,
      urgency: "CRITICAL" as const,
      ticketId: null,
      alertId: null,
      commanderId: "agent-1",
      commsLeadId: null,
      scribeId: null,
      liaisonId: null,
      detectedAt: "2026-09-20T08:55:00.000Z",
      declaredAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:10:00.000Z",
      resolvedAt: null,
      reviewedAt: null,
    },
    steps: [],
    evidence: [],
    custody: [],
    holds: [],
    artifacts,
    timeline: [],
  };
}

const noop = async () => {};

test("the console shows the lock, offers removal only when allowed, and shows a purge", () => {
  const html = renderToStaticMarkup(
    createElement(IncidentList, {
      incidents: [view([artifact])],
      staff: [],
      actions: { advance: noop, assignRole: noop, addNote: noop, startPlaybook: noop, step: noop, recordEvidence: noop, uploadArtifact: noop, purgeArtifact: noop },
    }),
  );
  assert.match(html, /Artifacts under lock/);
  assert.match(html, /locked/);
  assert.match(html, /COMPLIANCE until 2036-09-20T09:05:00.000Z/);
  assert.match(html, /Remove the bytes/);
  // The consequence is stated where the button is, not only in the docs.
  assert.match(html, /not even an administrator/);

  // A purged artifact keeps its place in the record and offers no removal.
  const purged = renderToStaticMarkup(
    createElement(IncidentList, {
      incidents: [view([{ ...artifact, purgedAt: "2027-01-01T00:00:00.000Z" }])],
      staff: [],
      actions: { advance: noop, assignRole: noop, addNote: noop, startPlaybook: noop, step: noop, recordEvidence: noop, purgeArtifact: noop },
    }),
  );
  assert.match(purged, /purged/);
  assert.match(purged, /Bytes removed 2027-01-01T00:00:00.000Z/);
  assert.doesNotMatch(purged, /Remove the bytes/);
});

test("the console says plainly when no bytes are stored, and stores none read-only", () => {
  const html = renderToStaticMarkup(
    createElement(IncidentList, {
      incidents: [view([])],
      staff: [],
      actions: { advance: noop, assignRole: noop, addNote: noop, startPlaybook: noop, step: noop, recordEvidence: noop },
    }),
  );
  assert.match(html, /No bytes stored/);
  assert.doesNotMatch(html, /Store artifact/);
  assert.doesNotMatch(html, /Remove the bytes/);
});

test("a stored file is readable back unchanged, and marked read-only on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontrak-evidence-"));
  try {
    const store = new FileEvidenceObjectStore(root);
    const bytes = new TextEncoder().encode("keep me exactly");
    await store.put("evidence/tenant-a/inc-1/deadbeef", bytes, "text/plain");
    // Reading is available to whoever can read the row; the write-once rule
    // governs writers, not readers.
    assert.deepEqual(await store.get("evidence/tenant-a/inc-1/deadbeef"), bytes);
    const path = join(root, "evidence/tenant-a/inc-1/deadbeef");
    // The intent is visible to anyone looking at the directory, not only to a
    // caller that goes through this class.
    assert.equal((await stat(path)).mode & 0o222, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
