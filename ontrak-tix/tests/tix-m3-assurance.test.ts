/**
 * OnTrak Tix M3 tests: the Assurance Packet — assembling it, digesting it,
 * signing it, verifying it, and the export that is itself recorded.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-assurance.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, createAuditChain, appendAuditEvent, type HashFn } from "../src/lib/audit-chain";
import { assuranceSecret, hmacSigner } from "../src/lib/assurance-sign";
import {
  ASSURANCE_ALGORITHM,
  ASSURANCE_PACKET_VERSION,
  buildAssurancePacket,
  packetCompleteness,
  packetContent,
  verifyAssurancePacket,
  type AssurancePacket,
  type AssurancePacketInput,
} from "../src/lib/assurance-rules";
import { AssuranceService, MemoryAssuranceAuditReader } from "../src/lib/assurance-service";
import { IncidentDocsService, MemoryIncidentDocsStore } from "../src/lib/incident-docs-service";
import { IncidentService, MemoryIncidentStore } from "../src/lib/incident-service";
import { buildEvidenceManifest } from "../src/lib/evidence-rules";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const sign = hmacSigner("test-assurance-key-that-is-long-enough");
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };

/* ---------------------------------------------------------------- fixtures */

type ManifestInput = Parameters<typeof buildEvidenceManifest>[0];

const COLLECTED_ENTRY = {
  id: "c1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  evidenceId: "ev-1",
  at: "2026-09-20T09:05:00.000Z",
  action: "COLLECTED" as const,
  fromActor: "user-1",
  toActor: "user-1",
  reason: null,
};

const AUDIT: AssurancePacketInput["audit"] = {
  head: "a".repeat(64),
  length: 7,
  verified: true,
  exportSeq: 8,
  excerpt: [{ seq: 3, at: "2026-09-20T09:00:00.000Z", actor: "agent-1", action: "incident.declare", recordHash: "b".repeat(64) }],
};

function manifestInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    incident: {
      ref: "INC-000001",
      title: "Mail outage",
      severity: "SEV2",
      phase: "REVIEWED",
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
    custody: [COLLECTED_ENTRY],
    legalHold: null,
    timeline: [{ at: "2026-09-20T09:00:00.000Z", kind: "declared", actor: "user-1", summary: "Declared SEV2" }],
    generatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

/** The packet input for a manifest built from the default fixture. */
function packetInput(overrides: Partial<AssurancePacketInput> = {}): AssurancePacketInput {
  return {
    manifest: buildEvidenceManifest(manifestInput(), sha256),
    audit: AUDIT,
    generatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

/** A packet input over a *modified* manifest, which is what an edit looks like. */
function packetOverManifest(overrides: Partial<ManifestInput>, packet: Partial<AssurancePacketInput> = {}): AssurancePacketInput {
  return packetInput({ manifest: buildEvidenceManifest(manifestInput(overrides), sha256), ...packet });
}

/* ------------------------------------------------------------------- rules */

test("a packet digests its whole content, and the same record always digests the same", () => {
  const first = buildAssurancePacket(packetInput(), sha256, sign);
  const second = buildAssurancePacket(packetInput({ generatedAt: "2027-01-01T00:00:00.000Z" }), sha256, sign);

  assert.equal(first.version, ASSURANCE_PACKET_VERSION);
  assert.equal(first.algorithm, ASSURANCE_ALGORITHM);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.match(first.recordHash, /^[a-f0-9]{64}$/);
  assert.match(first.signature, /^[a-f0-9]{64}$/);
  // The digests and signature are about the record, not about when it was pulled.
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.recordHash, first.recordHash);
  assert.equal(second.signature, first.signature);
  assert.notEqual(second.generatedAt, first.generatedAt);
  // The packet carries the manifest it was built from, digest included.
  assert.equal(first.evidenceManifestHash, packetInput().manifest.manifestHash);
  assert.equal(first.evidence.length, 1);
  assert.equal(first.custody.length, 1);
});

test("a packet verifies, and an edit anywhere in it is caught", () => {
  const packet = buildAssurancePacket(packetInput(), sha256, sign);
  assert.deepEqual(verifyAssurancePacket(packet, sha256, sign), { ok: true, contentHash: packet.contentHash });

  const edited: AssurancePacket = { ...packet, incident: { ...packet.incident, title: "Something else" } };
  const caught = verifyAssurancePacket(edited, sha256, sign);
  assert.equal(caught.ok, false);
  if (!caught.ok) assert.match(caught.reason, /content hash/);

  // A re-written signature fails the second check, even over intact content.
  const resigned: AssurancePacket = { ...packet, signature: "f".repeat(64) };
  const badSignature = verifyAssurancePacket(resigned, sha256, sign);
  assert.equal(badSignature.ok, false);
  if (!badSignature.ok) assert.match(badSignature.reason, /signature/);

  // An unknown algorithm is refused rather than waved through.
  const unknown = verifyAssurancePacket({ ...packet, algorithm: "MD5" }, sha256, sign);
  assert.equal(unknown.ok, false);

  // A different deployment's key does not verify someone else's packet.
  assert.equal(
    verifyAssurancePacket(packet, sha256, hmacSigner("some-other-deployments-key")).ok,
    false,
  );
});

test("the record digest is stable while the record is, and the content digest tracks the anchor", () => {
  const base = buildAssurancePacket(packetInput(), sha256, sign);

  // Same record, a different point in the chain: the *packet* differs (it says
  // where in history it was cut) but the record's fingerprint does not — which is
  // what makes an archived packet comparable to a fresh one.
  const laterAnchor = buildAssurancePacket(
    packetInput({ audit: { ...AUDIT, head: "e".repeat(64), length: 31, exportSeq: 32 } }),
    sha256,
    sign,
  );
  assert.equal(laterAnchor.recordHash, base.recordHash);
  assert.notEqual(laterAnchor.contentHash, base.contentHash);

  // Change anything in the record and both move.
  const edited = buildAssurancePacket(packetOverManifest({ timeline: [] }), sha256, sign);
  assert.notEqual(edited.recordHash, base.recordHash);
  assert.notEqual(edited.contentHash, base.contentHash);

  // A policy change is part of the record: two packets measured against
  // different policies are not the same evidence.
  const repolicied = buildAssurancePacket(
    packetInput({ policies: [{ key: "evidence-retention", version: "2.0", effectiveAt: "2027-01-01T00:00:00.000Z" }] }),
    sha256,
    sign,
  );
  assert.notEqual(repolicied.recordHash, base.recordHash);
});

test("the digest covers the custody trail, the hold, the audit anchor and the policies", () => {
  const base = buildAssurancePacket(packetInput(), sha256, sign).contentHash;

  // A hand-off appended to the item's trail.
  const movedCustody = packetOverManifest({
    custody: [
      COLLECTED_ENTRY,
      {
        id: "c2",
        tenantId: "tenant-a",
        incidentId: "inc-1",
        evidenceId: "ev-1",
        at: "2026-09-20T10:30:00.000Z",
        action: "TRANSFERRED" as const,
        fromActor: "user-1",
        toActor: "forensics",
        reason: "handed over",
      },
    ],
  });
  assert.notEqual(buildAssurancePacket(movedCustody, sha256, sign).contentHash, base);

  const held = packetOverManifest({
    legalHold: {
      id: "hold-1",
      tenantId: "tenant-a",
      incidentId: "inc-1",
      reason: "Insurer asked",
      placedBy: "user-1",
      placedAt: "2026-09-20T11:00:00.000Z",
      releasedBy: null,
      releasedAt: null,
    },
  });
  assert.notEqual(buildAssurancePacket(held, sha256, sign).contentHash, base);

  // Re-anchoring to a different chain state changes the digest too.
  const reanchored = packetInput({ audit: { ...AUDIT, head: "c".repeat(64), length: 8, exportSeq: 9 } });
  assert.notEqual(buildAssurancePacket(reanchored, sha256, sign).contentHash, base);

  const repolicy = packetInput({
    policies: [{ key: "incident-response", version: "2.0", effectiveAt: "2027-01-01T00:00:00.000Z" }],
  });
  assert.notEqual(buildAssurancePacket(repolicy, sha256, sign).contentHash, base);
});

test("packetContent is the one shape both the digest and the verifier read", () => {
  const input = packetInput();
  const content = packetContent(input);
  assert.equal(content.evidenceManifestHash, input.manifest.manifestHash);
  assert.equal(content.custody.length, 1);
  assert.deepEqual(content.playbook, input.manifest.steps);
  assert.deepEqual(content.incident, input.manifest.incident);
  // Nothing about the export moment leaks into the content.
  assert.equal("generatedAt" in content, false);
  assert.equal("signature" in content, false);
});

test("completeness names what a reviewer would still be missing", () => {
  const complete = buildAssurancePacket(packetInput(), sha256, sign);
  assert.deepEqual(packetCompleteness(complete), { complete: true, missing: [] });

  const thinManifest = buildEvidenceManifest(
    manifestInput({
      incident: { ...manifestInput().incident, phase: "DETECTED" },
      steps: [{ key: "declare", title: "Declare", status: "PENDING", completedAt: null, completedBy: null }],
      evidence: [],
      custody: [],
      timeline: [],
    }),
    sha256,
  );
  const thin = buildAssurancePacket(
    packetInput({
      manifest: thinManifest,
      audit: { head: "a".repeat(64), length: 1, verified: false, exportSeq: 2, excerpt: [] },
    }),
    sha256,
    sign,
  );
  const report = packetCompleteness(thin);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missing, [
    "the incident has not been reviewed",
    "the playbook still has open steps",
    "no evidence was collected",
    "the evidence has no chain of custody",
    "the timeline is empty",
    "the audit chain did not verify",
  ]);
});

/* ------------------------------------------------------------------ signer */

test("the signing key comes from the environment and refuses a weak one", () => {
  assert.equal(assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "x".repeat(24) }), "x".repeat(24));
  // Falls back to the session secret so a fresh checkout can still export.
  assert.equal(assuranceSecret({ TIX_AUTH_SECRET: "y".repeat(24) }), "y".repeat(24));
  assert.throws(() => assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "short" }), /missing or too short/);
  assert.throws(() => assuranceSecret({}), /missing or too short/);

  // Blank is absent, as `.env.example` documents: it ships the variable empty and
  // promises the session secret signs instead. The browser sweep found the difference
  // the hard way — a deployment configured exactly as the example says answered 500 on
  // every packet export, while the error named a variable that deployment had left blank.
  assert.equal(
    assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "", TIX_AUTH_SECRET: "y".repeat(24) }),
    "y".repeat(24),
  );
  assert.equal(
    assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "   ", AUTH_SECRET: "z".repeat(24) }),
    "z".repeat(24),
  );
  assert.throws(() => assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "" }), /missing or too short/);
  // Set but weak is still refused, rather than quietly falling through to another key.
  assert.throws(
    () => assuranceSecret({ ONTRAK_TIX_ASSURANCE_SECRET: "short", TIX_AUTH_SECRET: "y".repeat(24) }),
    /missing or too short/,
  );

  // The signer is deterministic: the same digest always signs the same way.
  const signer = hmacSigner("a-long-enough-test-key");
  assert.equal(signer("abc"), signer("abc"));
  assert.notEqual(signer("abc"), signer("abd"));
  assert.match(signer("abc"), /^[a-f0-9]{64}$/);
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
  const assurance = new AssuranceService({
    incidents: incidentStore,
    docs,
    // The same chain the sink writes, read fresh — as the Prisma reader does.
    auditReader: { read: async () => audit.snapshot() },
    sign,
    audit,
    hash: sha256,
    now: () => clock,
  });
  return { audit, incidentStore, incidents, docs, assurance, tick: (at: string) => { clock = at; } };
}

/** A reviewed, evidenced, playbook-complete incident. */
async function fullyDocumented(h: ReturnType<typeof harness>) {
  const declared = await h.incidents.declare(AGENT, {
    title: "Mail outage",
    summary: "Exchange is down.",
    impact: "MODERATE",
    urgency: "MEDIUM",
  });
  assert.equal(declared.ok, true);
  if (!declared.ok) throw new Error("declare failed");
  const incident = declared.value;

  await h.docs.startPlaybook(AGENT, incident.id);
  for (const step of await h.docs.listSteps("tenant-a", incident.id)) {
    await h.docs.completeStep(AGENT, incident.id, step.key);
  }
  await h.docs.recordEvidence(AGENT, incident.id, {
    kind: "LOG",
    label: "Transport log",
    reference: "s3://evidence/inc-1/transport.log",
    sha256: "d".repeat(64),
  });
  await h.docs.transferEvidence(AGENT, incident.id, (await h.docs.listEvidence("tenant-a", incident.id))[0].id, {
    toActor: "forensics@acme.test",
    reason: "Handed to the forensics vendor",
  });

  await h.incidents.assignRole(AGENT, incident.id, "COMMANDER", "user-1");
  for (const phase of ["TRIAGED", "CONTAINED", "ERADICATED", "RECOVERED", "REVIEWED"] as const) {
    const moved = await h.incidents.advance(AGENT, incident.id, phase);
    assert.equal(moved.ok, true, `could not move to ${phase}`);
  }
  return incident;
}

test("a packet bundles the record, cites the chain it was cut from, and records its own export", async () => {
  const h = harness();
  const incident = await fullyDocumented(h);

  const result = await h.assurance.packet(AGENT, incident.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const packet = result.value;

  assert.equal(packet.incident.ref, incident.ref);
  assert.equal(packet.incident.phase, "REVIEWED");
  assert.ok(packet.playbook.length > 0);
  assert.ok(packet.playbook.every((step) => step.status === "DONE"));
  assert.equal(packet.evidence.length, 1);
  assert.match(packet.evidence[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(packet.evidenceManifestHash, packet.evidenceManifestHash);
  assert.equal(packet.custody.length, 2);
  assert.ok(packet.timeline.some((event) => event.kind === "custody"));

  // The packet commits to the chain head it was read at, not to a subset: the
  // export event is the newest record, and the cited head is the one before it.
  const chain = h.audit.snapshot();
  assert.equal(packet.audit.exportSeq, chain.events.length);
  assert.equal(packet.audit.length, chain.events.length - 1);
  assert.equal(packet.audit.head, chain.events[chain.events.length - 2].recordHash);
  assert.equal(packet.audit.verified, true);
  // The excerpt is this incident's decisions, with chain positions.
  assert.ok(packet.audit.excerpt.every((entry) => entry.recordHash.length === 64));
  assert.ok(packet.audit.excerpt.some((entry) => entry.action === "incident.manifest"));

  // It stands on its own: complete, and verifiable without the database.
  assert.deepEqual(packetCompleteness(packet), { complete: true, missing: [] });
  assert.equal(verifyAssurancePacket(packet, sha256, sign).ok, true);
  assert.match(packet.recordHash, /^[a-f0-9]{64}$/);

  // The export landed on the chain at the seq the packet said it would, and it
  // carries the digest — so the packet can be cited from the record itself.
  const after = h.audit.snapshot().events;
  const exportEvent = after.find((event) => event.action === "incident.packet.export");
  assert.ok(exportEvent);
  assert.equal(exportEvent?.seq, packet.audit.exportSeq);
  assert.equal((exportEvent?.detail as { contentHash: string }).contentHash, packet.contentHash);
  assert.equal((exportEvent?.detail as { ref: string }).ref, incident.ref);
});

test("a broken audit chain is reported in the packet, not thrown over", async () => {
  const h = harness();
  const incident = await fullyDocumented(h);

  // Forge a chain whose second record was edited after it was written: the
  // stored hash no longer matches the record's canonical payload.
  const chain = h.audit.snapshot();
  const tampered = {
    ...chain,
    events: chain.events.map((event, index) => (index === 1 ? { ...event, actor: "someone-else" } : event)),
  };
  const reader = new MemoryAssuranceAuditReader();
  reader.set("tenant-a", tampered);

  const service = new AssuranceService({
    incidents: h.incidentStore,
    docs: h.docs,
    auditReader: reader,
    sign,
    hash: sha256,
    now: () => "2026-09-20T14:00:00.000Z",
  });

  const result = await service.packet(AGENT, incident.id);
  assert.equal(result.ok, true, "a damaged chain does not stop the export");
  if (!result.ok) return;
  assert.equal(result.value.audit.verified, false);
  assert.ok(packetCompleteness(result.value).missing.includes("the audit chain did not verify"));
});

test("a packet ties to exactly one incident, and only staff may export it", async () => {
  const h = harness();
  const incident = await fullyDocumented(h);

  const requester = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
  assert.equal((await h.assurance.packet(requester, incident.id)).ok, false);
  assert.equal((await h.assurance.packet({ ...AGENT, tenantId: "tenant-b" }, incident.id)).ok, false);
  assert.equal((await h.assurance.packet(AGENT, "nope")).ok, false);

  // Each export re-reads the chain, so the second packet cites a longer one.
  const first = await h.assurance.packet(AGENT, incident.id);
  const second = await h.assurance.packet(AGENT, incident.id);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.audit.length > first.value.audit.length, true);
  assert.equal(second.value.audit.exportSeq, second.value.audit.length + 1);
  // Two packets, cut at different points in the same unchanged record: the
  // packets differ, the record does not.
  assert.notEqual(second.value.contentHash, first.value.contentHash);
  assert.equal(second.value.recordHash, first.value.recordHash);
});

test("the audit anchor is part of what the packet commits to", () => {
  // A chain that grew between two exports yields two different packets, which is
  // correct: the packet says where in history it was cut.
  const first = buildAssurancePacket(packetInput(), sha256, sign);
  const later = buildAssurancePacket(
    packetInput({ audit: { head: "d".repeat(64), length: 12, verified: true, exportSeq: 13, excerpt: AUDIT.excerpt } }),
    sha256,
    sign,
  );
  assert.notEqual(first.contentHash, later.contentHash);
  assert.equal(first.recordHash, later.recordHash, "the record itself did not change");
  assert.equal(verifyAssurancePacket(later, sha256, sign).ok, true);

  // A chain with no records at all still anchors to genesis rather than nothing.
  const genesis = appendAuditEvent(createAuditChain(), { id: "e1", tenantId: "tenant-a", at: "2026-09-20T09:00:00.000Z", actor: "agent-1", action: "incident.declare" }, sha256);
  assert.equal(genesis.head, genesis.events[0].recordHash);
});
