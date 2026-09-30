/**
 * OnTrak Tix M6 tests: the tenant-wide audit-evidence export.
 *
 * M3's packet answers "what happened to this incident"; M6's exit criterion asks for
 * "audit evidence exports on demand", which is the trail itself. These tests follow the
 * four things that make the difference between an export and a JSON dump:
 *
 *  - **It is the same envelope as M3's packet**, checked by M3's verifier. One format,
 *    one implementation of "is this signature ours" — asserted as literals here so a
 *    drift in either product's format breaks a test rather than an auditor's day.
 *  - **It carries the record and not the payloads.** Every entry's seq, time, actor,
 *    action and record hash; none of the free-form `detail` each handler happened to
 *    attach. That is the difference between a document about what happened and a
 *    document that leaks whatever was in the bag at the time.
 *  - **A trail that did not verify still exports, and says so** — inside the signed
 *    anchor, so a break cannot be presented as sound. Verified and intact are two
 *    different questions and the report answers both.
 *  - **Exporting is itself an audited act**, carrying the digest, so who took a copy is
 *    on the chain the copy describes.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-audit-export.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  AUDIT_EXPORT_KIND,
  auditExportReport,
  buildAuditChainPacket,
  verifyAuditChainPacket,
} from "../src/lib/audit-export-rules";
import { ASSURANCE_ALGORITHM, ASSURANCE_PACKET_VERSION } from "../src/lib/assurance-rules";
import { hmacSigner } from "../src/lib/assurance-sign";
import { AssuranceService, MemoryAssuranceAuditReader } from "../src/lib/assurance-service";
import { AuditLog, type AuditEventInput, type HashFn } from "../src/lib/audit-chain";
import { IncidentDocsService, MemoryIncidentDocsStore } from "../src/lib/incident-docs-service";
import { IncidentService, MemoryIncidentStore } from "../src/lib/incident-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const sign = hmacSigner("test-audit-export-key-long-enough");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };

const T0 = "2026-09-20T09:00:00.000Z";
const T1 = "2026-09-20T09:05:00.000Z";
const T2 = "2026-09-20T09:10:00.000Z";

/** Three events, two of which carry a `detail` that must not reach the document. */
const EVENTS: AuditEventInput[] = [
  {
    id: "e1",
    tenantId: "tenant-a",
    at: T0,
    actor: "agent-1",
    action: "ticket.created",
    targetType: "ticket",
    targetId: "t1",
    detail: { subject: "Mail is down", reset_token: "should-not-leave-the-building" },
  },
  {
    id: "e2",
    tenantId: "tenant-a",
    at: T1,
    actor: "agent-1",
    action: "ticket.updated",
    targetType: "ticket",
    targetId: "t1",
    detail: { note: "internal only" },
  },
  {
    id: "e3",
    tenantId: "tenant-a",
    at: T2,
    actor: "admin-1",
    action: "client.created",
    targetType: "client",
    targetId: "c1",
  },
];

let seq = 0;

function harness(reader?: MemoryAssuranceAuditReader) {
  const audit = new AuditLog(sha256);
  for (const event of EVENTS) audit.append(event);

  const incidentStore = new MemoryIncidentStore();
  const ids = { id: () => `id-${++seq}`, now: () => T2 };
  const incidents = new IncidentService(incidentStore, audit, ids);
  const docs = new IncidentDocsService(new MemoryIncidentDocsStore(), incidentStore, audit, ids, sha256);

  const service = new AssuranceService({
    incidents: incidentStore,
    docs,
    // The same chain the sink writes, read fresh — as the Prisma reader does.
    auditReader: reader ?? { read: async () => audit.snapshot() },
    sign,
    audit,
    hash: sha256,
    now: () => T2,
  });
  return { audit, service };
}

/* -------------------------------------------------------------------------- */
/*  It is the family's envelope                                                */
/* -------------------------------------------------------------------------- */

test("the audit export is the same envelope as the incident packet", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Literals on purpose: this is the agreement with M3's packet format.
  assert.equal(result.value.kind, AUDIT_EXPORT_KIND);
  assert.equal(result.value.version, "1.0");
  assert.equal(result.value.algorithm, "HMAC-SHA256");
  assert.equal(ASSURANCE_PACKET_VERSION, "1.0");
  assert.equal(ASSURANCE_ALGORITHM, "HMAC-SHA256");
  // And its own kind, so a reader can tell the two documents apart.
  assert.notEqual(result.value.kind, "incident");
});

test("a tenant-wide export verifies with the incident packet's verifier", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const checked = verifyAuditChainPacket(result.value, sha256, sign);
  assert.equal(checked.ok, true);
  assert.match(auditExportReport(result.value, checked).headline, /trail verified/);
});

/* -------------------------------------------------------------------------- */
/*  The record, and not the payloads                                           */
/* -------------------------------------------------------------------------- */

test("every entry is carried, oldest first, with no payload detail", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const packet = result.value;
  assert.equal(packet.entries.length, EVENTS.length);
  assert.deepEqual(packet.entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.deepEqual(packet.entries.map((entry) => entry.action), ["ticket.created", "ticket.updated", "client.created"]);
  assert.deepEqual(packet.entries.map((entry) => entry.actor), ["agent-1", "agent-1", "admin-1"]);
  // Each entry carries the digest that ties it to the chain.
  assert.ok(packet.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.recordHash)));

  // The one assertion that matters most: what a handler happened to attach is not in
  // the document that leaves the building.
  const serialised = JSON.stringify(packet);
  assert.ok(!serialised.includes("should-not-leave-the-building"), "a payload value reached the export");
  assert.ok(!serialised.includes("internal only"), "a payload value reached the export");
  assert.ok(!("detail" in packet.entries[0]), "the entry kept its detail bag");
});

test("the export is anchored at the head it read, and cites where its own event lands", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const packet = result.value;
  assert.equal(packet.audit.length, EVENTS.length);
  assert.equal(packet.audit.verified, true);
  assert.equal(packet.audit.exportSeq, EVENTS.length + 1, "the export event lands one past the head it cites");
  assert.equal(packet.audit.head, packet.entries[packet.entries.length - 1].recordHash, "the anchor is the last entry's hash");
});

/* -------------------------------------------------------------------------- */
/*  Digests do their separate jobs                                             */
/* -------------------------------------------------------------------------- */

test("the record fingerprint ignores the clock, the anchor does not", () => {
  const input = {
    tenantId: "tenant-a",
    entries: EVENTS.map((event, index) => ({
      seq: index + 1,
      at: event.at,
      actor: event.actor,
      action: event.action,
      recordHash: sha256(`entry-${index}`),
    })),
    audit: { head: "h".repeat(64), length: 3, verified: true, exportSeq: 4 },
  };

  const a = buildAuditChainPacket({ ...input, generatedAt: T2 }, sha256, sign);
  const b = buildAuditChainPacket(
    { ...input, generatedAt: "2027-01-01T00:00:00.000Z", audit: { ...input.audit, length: 40 } },
    sha256,
    sign,
  );

  assert.equal(a.recordHash, b.recordHash, "an unchanged trail exports the same fingerprint");
  assert.notEqual(a.contentHash, b.contentHash, "a longer trail and a later export move the content digest");
});

test("an edited entry fails verification", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const packet = result.value;
  const edited = { ...packet, entries: [{ ...packet.entries[0], action: "ticket.deleted" }, ...packet.entries.slice(1)] };
  const checked = verifyAuditChainPacket(edited, sha256, sign);
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.match(checked.reason, /content hash|record hash/);
});

test("a dropped entry fails verification", async () => {
  const { service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // The tempting edit: remove the embarrassing line and keep the document.
  const trimmed = { ...result.value, entries: result.value.entries.slice(1) };
  assert.equal(verifyAuditChainPacket(trimmed, sha256, sign).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  A broken trail is still evidence                                           */
/* -------------------------------------------------------------------------- */

test("a trail that does not verify still exports, and says so", async () => {
  const audit = new AuditLog(sha256);
  for (const event of EVENTS) audit.append(event);
  const tampered = audit.snapshot();
  // Somebody edited history: the second entry's action no longer matches its digest.
  tampered.events[1] = { ...tampered.events[1], action: "ticket.deleted" };

  const reader = new MemoryAssuranceAuditReader();
  reader.set("tenant-a", tampered);
  const { service } = harness(reader);

  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true, "a damaged chain does not stop the export");
  if (!result.ok) return;

  assert.equal(result.value.audit.verified, false);
  const checked = verifyAuditChainPacket(result.value, sha256, sign);
  // The packet is intact — it is a faithful copy of a broken trail — and it says the
  // trail was broken. Both statements are true and the report makes both.
  assert.equal(checked.ok, true);
  assert.match(auditExportReport(result.value, checked).headline, /did NOT verify/);
});

/* -------------------------------------------------------------------------- */
/*  Who may take a copy, and the copy being audited                            */
/* -------------------------------------------------------------------------- */

test("only a role that may read the audit trail can export it", async () => {
  const { service } = harness();
  const refused = await service.auditExport(AGENT);
  assert.equal(refused.ok, false, "an agent may not take away the tenant's audit trail");
  if (!refused.ok) assert.match(refused.error, /audit trail/i);

  // ADMIN holds `audit:read`, so the same call succeeds.
  assert.equal((await service.auditExport(ADMIN)).ok, true);
});

test("the export is written to the chain it exports", async () => {
  const { audit, service } = harness();
  const result = await service.auditExport(ADMIN);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const events = audit.snapshot().events;
  const last = events[events.length - 1];
  assert.equal(last.action, "audit.chain.export");
  assert.equal(last.actor, ADMIN.id);
  assert.equal(last.tenantId, "tenant-a");
  // It cites the digest, so the copy can be pointed at from the record of taking it —
  // and it is the seq the packet promised it would occupy.
  assert.equal((last.detail as { contentHash?: string } | undefined)?.contentHash, result.value.contentHash);
  assert.equal(last.seq, result.value.audit.exportSeq);
  assert.equal(audit.verify().ok, true, "the export leaves the chain verifiable");
});
