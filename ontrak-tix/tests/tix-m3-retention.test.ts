/**
 * OnTrak Tix M3 tests: the retention sweep.
 *
 * The lock rules could already decide whether an artifact may be removed; these
 * tests cover the thing that acts on the decision without being asked — the
 * plan (what the clock allows, and what a hold or a mode refuses), the service
 * that carries it out (bytes, tombstone, timeline, audit), and the report that
 * says what was left alone and why.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-retention.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { IncidentDocsService, MemoryIncidentDocsStore, SWEEP_ACTOR } from "../src/lib/incident-docs-service";
import {
  PrismaIncidentDocsStore,
  type IncidentDocsPrismaClient,
  type EvidenceArtifactRow,
} from "../src/lib/incident-docs-store-prisma";
import { IncidentService, MemoryIncidentStore } from "../src/lib/incident-service";
import { MemoryEvidenceObjectStore, planRetentionSweep, retentionSweepReason, type RetentionSweepCandidate } from "../src/lib/object-lock-rules";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const OUTSIDER = { id: "agent-2", tenantId: "tenant-b", role: "AGENT" as const };

const NOW = "2026-09-20T09:00:00.000Z";

/* ------------------------------------------------------------------ the plan */

function candidate(overrides: Partial<RetentionSweepCandidate> = {}): RetentionSweepCandidate {
  return {
    artifactId: "art-1",
    incidentId: "inc-1",
    key: "evidence/tenant-a/inc-1/abc",
    bytes: 1_024,
    lock: { mode: "COMPLIANCE", retainUntil: "2026-09-19T00:00:00.000Z", lockedAt: "2025-09-19T00:00:00.000Z" },
    holdActive: false,
    purgedAt: null,
    ...overrides,
  };
}

test("the sweep purges what the clock has closed and keeps what it has not", () => {
  const plan = planRetentionSweep(
    [
      candidate(),
      candidate({
        artifactId: "art-2",
        key: "evidence/tenant-a/inc-1/def",
        bytes: 2_048,
        lock: { mode: "COMPLIANCE", retainUntil: "2035-01-01T00:00:00.000Z", lockedAt: NOW },
      }),
    ],
    NOW,
  );

  assert.deepEqual(
    plan.decisions.map((entry) => entry.outcome),
    ["PURGE", "RETAIN"],
  );
  assert.equal(plan.purge.length, 1);
  assert.deepEqual(plan.summary, { considered: 2, purge: 1, retained: 1, held: 0, alreadyGone: 0, bytesFreed: 1_024 });
  // A retained artifact says when it may go, which is the answer to "why is this still here".
  assert.match(plan.decisions[1].reason, /Retained in COMPLIANCE mode until 2035-01-01/);
});

test("a legal hold outranks the clock in the sweep, in both directions", () => {
  const expiredHeld = planRetentionSweep([candidate({ holdActive: true })], NOW);
  assert.equal(expiredHeld.decisions[0].outcome, "HELD");
  assert.match(expiredHeld.decisions[0].reason, /legal hold is in force/);
  assert.equal(expiredHeld.summary.held, 1);
  assert.equal(expiredHeld.summary.purge, 0);

  // A held artifact is never purged, however long past its window it is.
  const ancient = planRetentionSweep(
    [candidate({ holdActive: true, lock: { mode: "GOVERNANCE", retainUntil: "2001-01-01T00:00:00.000Z", lockedAt: "2000-01-01T00:00:00.000Z" } })],
    NOW,
    { bypassGovernance: true },
  );
  assert.equal(ancient.decisions[0].outcome, "HELD");
});

test("the sweep does not shorten a lock, and never bypasses GOVERNANCE unless told to", () => {
  const governance = candidate({
    lock: { mode: "GOVERNANCE", retainUntil: "2035-01-01T00:00:00.000Z", lockedAt: NOW },
  });
  const compliance = candidate({
    artifactId: "art-2",
    lock: { mode: "COMPLIANCE", retainUntil: "2035-01-01T00:00:00.000Z", lockedAt: NOW },
  });

  const careful = planRetentionSweep([governance, compliance], NOW);
  assert.deepEqual(
    careful.decisions.map((entry) => entry.outcome),
    ["RETAIN", "RETAIN"],
  );
  assert.equal(careful.summary.purge, 0);
  // The governance one *could* go early, and the plan says so without doing it.
  assert.equal(careful.decisions[0].requiresBypass, true);
  assert.equal(careful.decisions[1].requiresBypass, false);

  const explicit = planRetentionSweep([governance, compliance], NOW, { bypassGovernance: true });
  assert.deepEqual(
    explicit.decisions.map((entry) => entry.outcome),
    ["PURGE", "RETAIN"],
  );
  // COMPLIANCE still does not yield, even to an explicit bypass.
  assert.equal(explicit.decisions[1].requiresBypass, false);
});

test("bytes already gone are not purged twice, and free nothing", () => {
  const plan = planRetentionSweep([candidate({ purgedAt: "2026-09-01T00:00:00.000Z" })], NOW);
  assert.equal(plan.decisions[0].outcome, "ALREADY_GONE");
  assert.deepEqual(plan.summary, { considered: 1, purge: 0, retained: 0, held: 0, alreadyGone: 1, bytesFreed: 0 });
  assert.equal(retentionSweepReason(candidate().lock), "Retention window closed at 2026-09-19T00:00:00.000Z; purged by the scheduled retention sweep.");
});

/* --------------------------------------------------------------- the service */

function harness(options: { retentionDays?: number; storage?: boolean } = {}) {
  const audit = new AuditLog(sha256);
  const incidentStore = new MemoryIncidentStore();
  const objects = new MemoryEvidenceObjectStore();
  const store = new MemoryIncidentDocsStore();
  let n = 0;
  let clock = NOW;
  const ids = { id: () => `id-${++n}`, now: () => clock };
  const incidents = new IncidentService(incidentStore, audit, ids);
  const docs = new IncidentDocsService(
    store,
    incidentStore,
    audit,
    ids,
    sha256,
    options.storage === false ? null : { objects, mode: "COMPLIANCE", retentionDays: options.retentionDays ?? 30 },
  );
  return {
    audit,
    objects,
    store,
    incidents,
    docs,
    tick: (at: string) => {
      clock = at;
    },
  };
}

async function declareIncident(h: ReturnType<typeof harness>, actor = AGENT) {
  const result = await h.incidents.declare(actor, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "EXTENSIVE",
    urgency: "CRITICAL",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("declare failed");
  return result.value;
}

async function storeArtifact(h: ReturnType<typeof harness>, incidentId: string, body: string, actor = AGENT) {
  const result = await h.docs.recordArtifact(actor, incidentId, {
    kind: "LOG",
    label: `log ${body}`,
    contentType: "text/plain",
    bytes: new TextEncoder().encode(body),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("recordArtifact failed");
  return result.value.artifact;
}

test("a sweep purges the artifacts whose window closed, and nothing else", async () => {
  const h = harness({ retentionDays: 30 });
  const incident = await declareIncident(h);
  const expired = await storeArtifact(h, incident.id, "exchange transport log");
  await storeArtifact(h, incident.id, "queue depth graph");

  // Nothing is due yet: the sweep runs, finds nothing and says so.
  const early = await h.docs.sweepRetention("tenant-a");
  assert.equal(early.ok, true);
  if (!early.ok) return;
  assert.equal(early.value.considered, 0);
  assert.equal(early.value.purged, 0);

  // The window is thirty days; a month later two of the three lock dates are past.
  h.tick("2026-10-25T09:00:00.000Z");
  const fresh = await storeArtifact(h, incident.id, "post-incident summary");

  const sweep = await h.docs.sweepRetention("tenant-a");
  assert.equal(sweep.ok, true);
  if (!sweep.ok) return;
  const report = sweep.value;
  assert.equal(report.considered, 2);
  assert.equal(report.purged, 2);
  assert.equal(report.retained, 0);
  const freed = "exchange transport log".length + "queue depth graph".length;
  assert.equal(report.bytesFreed, freed);
  assert.ok(report.purges.every((entry) => /Retention window closed/.test(entry.reason)));
  assert.equal(report.at, "2026-10-25T09:00:00.000Z");

  // The bytes are gone, the rows are tombstones, and the fresh artifact is untouched.
  assert.equal(await h.objects.get(expired.key), null);
  const artifacts = await h.docs.listArtifacts("tenant-a", incident.id);
  const purged = artifacts.filter((artifact) => artifact.purgedAt === null).map((artifact) => artifact.key);
  assert.deepEqual(purged, [fresh.key]);

  // The record explains itself: a timeline line and an audit event per artifact,
  // plus one event for the run.
  const timeline = await h.incidents.timeline("tenant-a", incident.id);
  assert.equal(timeline.filter((event) => /Artifact purged: /.test(event.summary)).length, 2);
  assert.ok(timeline.some((event) => event.actor === SWEEP_ACTOR && event.detail?.sweep === true));

  const audited = h.audit.snapshot().events;
  assert.equal(audited.filter((event) => event.action === "incident.evidence.purge").length, 2);
  // One run event per sweep — including the earlier one that found nothing, so
  // "the sweep ran and did nothing" is on the record too.
  const sweeps = audited.filter((event) => event.action === "incident.retention.sweep");
  assert.equal(sweeps.length, 2);
  assert.deepEqual(sweeps[0].detail, { considered: 0, purged: 0, retained: 0, held: 0, bytesFreed: 0 });
  assert.equal(sweeps[1].actor, SWEEP_ACTOR);
  assert.deepEqual(sweeps[1].detail, { considered: 2, purged: 2, retained: 0, held: 0, bytesFreed: freed });

  // Running it again purges nothing: a purged artifact is out of the worklist.
  const again = await h.docs.sweepRetention("tenant-a");
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.purged, 0);
});

test("a legal hold stops the sweep, and a released hold lets it through", async () => {
  const h = harness({ retentionDays: 30 });
  const incident = await declareIncident(h);
  const held = await storeArtifact(h, incident.id, "held bytes");
  const free = await storeArtifact(h, incident.id, "free bytes");

  const hold = await h.docs.placeLegalHold(AGENT, incident.id, "Preserve for the adjuster");
  assert.equal(hold.ok, true);

  h.tick("2026-10-25T09:00:00.000Z");
  const blocked = await h.docs.sweepRetention("tenant-a");
  assert.equal(blocked.ok, true);
  if (!blocked.ok) return;
  assert.equal(blocked.value.considered, 2);
  assert.equal(blocked.value.purged, 0);
  assert.equal(blocked.value.held, 2);
  assert.equal(blocked.value.skipped.length, 2);
  assert.match(blocked.value.skipped[0].reason, /legal hold is in force/);
  // Nothing was touched: the bytes are still there.
  assert.notEqual(await h.objects.get(held.key), null);
  assert.notEqual(await h.objects.get(free.key), null);

  const released = await h.docs.releaseLegalHold(AGENT, incident.id, "Claim settled");
  assert.equal(released.ok, true);
  const after = await h.docs.sweepRetention("tenant-a");
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.value.purged, 2);
  assert.equal(await h.objects.get(held.key), null);
  // A sweep writes nothing about a hold: the release is already on the record.
  assert.ok(!after.value.skipped.some((entry) => /legal hold/.test(entry.reason)));
});

test("a dry run reports the purges and touches nothing", async () => {
  const h = harness({ retentionDays: 30 });
  const incident = await declareIncident(h);
  const artifact = await storeArtifact(h, incident.id, "log bytes");
  h.tick("2026-10-25T09:00:00.000Z");

  const dry = await h.docs.sweepRetention("tenant-a", { dryRun: true });
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.purged, 1);
  assert.equal(dry.value.bytesFreed, "log bytes".length);
  assert.equal(dry.value.purges[0].incidentRef, incident.ref);
  assert.notEqual(await h.objects.get(artifact.key), null);
  assert.equal((await h.docs.listArtifacts("tenant-a", incident.id))[0].purgedAt, null);
  // A dry run writes no audit event either — it did not do anything to record.
  assert.ok(!h.audit.snapshot().events.some((event) => event.action === "incident.retention.sweep"));
});

test("one tenant's sweep cannot reach another tenant's artifacts, and storage must exist", async () => {
  const h = harness({ retentionDays: 30 });
  const mine = await declareIncident(h);
  const theirs = await declareIncident(h, OUTSIDER);
  const myArtifact = await storeArtifact(h, mine.id, "tenant a bytes");
  const theirArtifact = await storeArtifact(h, theirs.id, "tenant b bytes", OUTSIDER);

  h.tick("2026-10-25T09:00:00.000Z");
  const sweep = await h.docs.sweepRetention("tenant-a");
  assert.equal(sweep.ok, true);
  if (!sweep.ok) return;
  assert.equal(sweep.value.purged, 1);
  assert.equal(await h.objects.get(myArtifact.key), null);
  assert.notEqual(await h.objects.get(theirArtifact.key), null);

  const noStorage = harness({ storage: false });
  const refused = await noStorage.docs.sweepRetention("tenant-a");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /storage is not configured/);
});

/* ------------------------------------------------------------ the adapter */

test("the Prisma store asks the database for the tenant's expired, unpurged artifacts", async () => {
  const calls: unknown[] = [];
  const row: EvidenceArtifactRow = {
    id: "art-1",
    tenantId: "tenant-a",
    incidentId: "inc-1",
    key: "evidence/tenant-a/inc-1/abc",
    sha256: "a".repeat(64),
    bytes: 12,
    contentType: "text/plain",
    mode: "COMPLIANCE",
    retainUntil: new Date("2026-09-19T00:00:00.000Z"),
    lockedAt: new Date("2025-09-19T00:00:00.000Z"),
    createdBy: "agent-1",
    purgedAt: null,
  };
  const db = {
    evidenceArtifact: {
      findFirst: async () => row,
      findMany: async (args: unknown) => {
        calls.push(args);
        return [row];
      },
      create: async () => row,
      update: async () => row,
    },
  } as unknown as IncidentDocsPrismaClient;

  const store = new PrismaIncidentDocsStore(db);
  const found = await store.listExpiredArtifacts("tenant-a", "2026-10-01T00:00:00.000Z", 25);
  assert.equal(found.length, 1);
  // The row is narrowed on the way out like every other adapter result.
  assert.equal(found[0].mode, "COMPLIANCE");
  assert.equal(found[0].retainUntil, "2026-09-19T00:00:00.000Z");

  // A store that cannot answer tenant-wide still works: the service falls back
  // to walking the incidents, which is what the memory store exercises above.
  const prisma = calls[0] as { where: Record<string, unknown>; take: number };
  assert.equal(prisma.take, 25);
  assert.equal(prisma.where.tenantId, "tenant-a");
  assert.equal(prisma.where.purgedAt, null);
  assert.deepEqual(prisma.where.retainUntil, { lte: new Date("2026-10-01T00:00:00.000Z") });
});
