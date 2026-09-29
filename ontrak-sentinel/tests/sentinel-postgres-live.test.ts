/**
 * OnTrak Sentinel S0/S1 live test: the spine, against a real Postgres.
 *
 * The adapter tests run against a fake client, which proves the *logic*; this
 * proves the SQL. Column names, the `DateTime`/epoch conversions and the
 * per-organization uniqueness of `(organizationId, seq)` are all things a fake
 * cannot disagree with, and all things a migration gets wrong quietly.
 *
 * It is opt-in: without `DATABASE_URL` (or without a database that has run
 * `npm run db:deploy`) every test here skips, so `npm test` stays a pure unit
 * suite on a machine with no database.
 *
 *   DATABASE_URL=postgresql://sentinel:sentinel@127.0.0.1:5434/sentinel npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import { PrismaAlertStore, type AlertPrismaClient } from "../src/lib/alert-store-prisma";
import type { AlertRecord } from "../src/lib/detection-service";
import { sha256Hex } from "../src/lib/hash";
import { createIdentityServices } from "../src/lib/identity-server";
import type { IdentityPrismaClient } from "../src/lib/identity-store-prisma";
import { toObservedEvent } from "../src/lib/telemetry-rules";
import { matchEvent, parseIndicator } from "../src/lib/threat-intel-rules";
import { ThreatIntelService } from "../src/lib/threat-intel-service";
import { PrismaIndicatorStore, type IndicatorPrismaClient } from "../src/lib/threat-intel-store-prisma";

/** The client, or `null` when there is no database to talk to. */
async function live(): Promise<{ prisma: PrismaClient; services: ReturnType<typeof createIdentityServices> } | null> {
  if (!process.env.DATABASE_URL) return null;
  const prisma = new PrismaClient();
  try {
    // A schema that has never been migrated is as good as no database here.
    await prisma.auditEvent.count();
  } catch {
    await prisma.$disconnect().catch(() => undefined);
    return null;
  }
  return { prisma, services: createIdentityServices(prisma as unknown as IdentityPrismaClient, undefined, sha256Hex) };
}

test("the spine persists: an organization, its identities, a session and a verified chain", async (t) => {
  const db = await live();
  if (!db) {
    t.skip("set DATABASE_URL to a migrated Sentinel database to run the live test");
    return;
  }
  const { prisma, services } = db;

  const slug = `live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const created = await services.service.bootstrapOrganization("live-test", { name: "Live MSP", slug }, {
    identifier: `admin@${slug}.test`,
    displayName: "Live Admin",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;
  const { organization, admin } = created.value;
  const actor = { id: admin.id, organizationId: organization.id, role: "ADMIN" as const };

  try {
    await services.service.setMfaEnrolled(actor, actor.id, true);
    const session = await services.service.issueSession(actor.organizationId, actor.id, { ipAddress: "203.0.113.9" });
    assert.equal(session.ok, true, session.ok ? "" : session.error);
    if (!session.ok) return;

    // The session survives as epoch milliseconds, which is the conversion a
    // faked client cannot catch.
    const resolved = await services.service.resolveSession(actor.organizationId, session.value.id);
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    if (!resolved.ok) return;
    assert.equal(resolved.value.session.expiresAt - resolved.value.session.issuedAt, 12 * 60 * 60 * 1000);

    const agent = await services.service.createIdentity(actor, {
      identifier: `agent@${slug}.test`,
      displayName: "Live Agent",
      role: "AGENT",
    });
    assert.equal(agent.ok, true, agent.ok ? "" : agent.error);

    // The chain is read back from the rows, not from the process.
    const trail = await services.service.auditTrail(actor);
    assert.equal(trail.ok, true);
    if (!trail.ok) return;
    assert.deepEqual(
      trail.value.events.map((event) => event.action),
      ["organization.create", "identity.create", "identity.mfa.enroll", "session.grant", "identity.create"],
    );
    assert.deepEqual(trail.value.verification, { ok: true, length: 5 });
    assert.deepEqual(
      trail.value.events.map((event) => event.seq),
      [1, 2, 3, 4, 5],
      "the chain numbers from 1 inside one organization",
    );

    // Every row was written under the organization it belongs to.
    const rows = await prisma.auditEvent.findMany({ where: { organizationId: organization.id }, orderBy: { seq: "asc" } });
    assert.equal(rows.length, 5);

    // A tampered column is reported, which is the whole point of the chain.
    await prisma.auditEvent.updateMany({
      where: { organizationId: organization.id, seq: 1 },
      data: { recordHash: sha256Hex("not-the-real-hash") },
    });
    const afterTamper = await services.service.auditTrail(actor);
    assert.equal(afterTamper.ok && afterTamper.value.verification.ok, false);
  } finally {
    // The tenant cascades: identities, sessions and the evidence rows go with it.
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

/**
 * The feed side of S3, against the same database.
 *
 * Everything a fake cannot disagree with lives here: the derived primary key is *text* and
 * not an integer a sequence could have produced, `labels` is a Postgres array rather than a
 * JSON column, `expiresAt` is nullable and null means "does not expire", and the matches on
 * an alert are JSONB that has to come back as the shape the mapper reads. A migration that
 * got any of those wrong would pass the unit suite and fail the moment a real deployment
 * ingested one feed.
 */
test("threat intelligence persists: a feed row is refreshed in place, and an alert keeps its matches", async (t) => {
  const db = await live();
  if (!db) {
    t.skip("set DATABASE_URL to a migrated Sentinel database to run the live test");
    return;
  }
  const { prisma, services } = db;

  const slug = `live-intel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const created = await services.service.bootstrapOrganization("live-test", { name: "Live Intel", slug }, {
    identifier: `admin@${slug}.test`,
    displayName: "Live Admin",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;
  const { organization, admin } = created.value;
  const actor = { id: admin.id, organizationId: organization.id, role: "ADMIN" as const };
  const at = Date.parse("2026-10-27T09:00:00.000Z");

  const store = new PrismaIndicatorStore(prisma as unknown as IndicatorPrismaClient);
  const intel = new ThreatIntelService(store, services.audit);

  try {
    await services.service.setMfaEnrolled(actor, actor.id, true);

    const first = await intel.ingest(actor, [
      { value: "203.0.113.9", source: "abuse-ch", confidence: 80, labels: ["c2", "scanner"], severity: "HIGH" },
      { value: "*.bad.example", source: "abuse-ch", expiresAt: at + 86_400_000 },
      { value: "not a value at all", source: "abuse-ch" },
    ]);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    if (!first.ok) return;
    assert.equal(first.value.accepted, 2);
    assert.equal(first.value.rejected.length, 1);

    // The array column, the nullable expiry and the derived id, read back out of the rows.
    const listed = await store.listIndicators(organization.id);
    assert.equal(listed.length, 2);
    const address = listed.find((row) => row.value === "203.0.113.9");
    assert.ok(address);
    assert.deepEqual(address.labels, ["c2", "scanner"]);
    assert.equal(address.expiresAt, null, "null survives as \"does not expire\"");
    assert.equal(address.severity, "HIGH");
    assert.equal(address.wildcard, false);
    // Stamped by ingestion's own clock rather than by the row's `at`, so what matters is
    // that the instant is a real one and that a poll does not move it.
    const firstSighting = address.firstSeenAt;
    assert.ok(Number.isFinite(firstSighting) && firstSighting > 0);
    const domain = listed.find((row) => row.value === "*.bad.example");
    assert.ok(domain);
    assert.equal(domain.wildcard, true, "the `*.` prefix is a column, not a substring of the value");
    assert.equal(domain.expiresAt, at + 86_400_000);

    // A poll of the same feed is an UPDATE: one row, a new opinion, the same first sighting.
    const again = await intel.ingest(actor, [
      { value: "203.0.113.9", source: "abuse-ch", confidence: 95, severity: "CRITICAL", labels: ["c2", "scanner"] },
    ]);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.value.accepted, 0);
    assert.equal(again.value.updated, 1);

    const refreshed = await store.listIndicators(organization.id);
    assert.equal(refreshed.length, 2, "the feed did not grow by its own size");
    const changed = refreshed.find((row) => row.value === "203.0.113.9");
    assert.ok(changed);
    assert.equal(changed.confidence, 95);
    assert.equal(changed.firstSeenAt, firstSighting, "how long we have watched it is not reset by a poll");

    // The alert side: the matches have to come back as the shape the mapper reads.
    const flow = toObservedEvent("NETFLOW", { src_ip: "203.0.113.9", dst_ip: "10.0.0.5", dst_port: 445 }, { sensor: "fw-1", at });
    assert.equal(flow.ok, true);
    if (!flow.ok) return;
    const match = matchEvent(flow.event, changed, at);
    assert.ok(match);
    const iso = new Date(at).toISOString();
    const record: AlertRecord = {
      id: `live-alert-${slug}`,
      organizationId: organization.id,
      ruleId: "SG-BEH-001",
      ruleVersion: 1,
      ruleName: "Repeated connections from one source to one port",
      severity: "CRITICAL",
      state: "NEW",
      dedupeKey: `SG-BEH-001@1|203.0.113.9|${slug}`,
      groupKey: "203.0.113.9",
      sourceAddress: "203.0.113.9",
      identityId: null,
      identityLabel: null,
      device: null,
      asset: null,
      firstSeenAt: iso,
      lastSeenAt: iso,
      occurrences: 20,
      evidence: [flow.event],
      threatIntel: [match],
      note: null,
      createdAt: iso,
      updatedAt: iso,
    };

    const alerts = new PrismaAlertStore(prisma as unknown as AlertPrismaClient);
    const written = await alerts.upsertAlert(record);
    assert.equal(written.created, true);

    const read = await alerts.findAlert(organization.id, record.id);
    assert.ok(read, "the alert reads back");
    assert.equal(read.threatIntel.length, 1);
    assert.equal(read.threatIntel[0].indicator.kind, "IPV4");
    assert.equal(read.threatIntel[0].indicator.source, "abuse-ch");
    assert.equal(read.threatIntel[0].indicator.confidence, 95);
    assert.equal(read.threatIntel[0].indicator.severity, "CRITICAL");
    assert.equal(read.threatIntel[0].indicator.expiresAt, null);
    assert.deepEqual(read.threatIntel[0].indicator.labels, ["c2", "scanner"]);
    assert.equal(read.threatIntel[0].field, "sourceAddress");
    assert.equal(read.threatIntel[0].observable, "203.0.113.9");
    assert.equal(read.threatIntel[0].escalates, true);
    assert.equal(read.evidence.length, 1, "and the evidence came back as events, not strings");

    // Withdrawing is a delete, and it is one tenant's row that goes.
    const withdrawn = await intel.withdraw(actor, changed.id);
    assert.equal(withdrawn.ok, true, withdrawn.ok ? "" : withdrawn.error);
    assert.equal((await store.listIndicators(organization.id)).length, 1);
    assert.equal((await intel.activeIndicators(organization.id, at + 2 * 86_400_000)).length, 0, "the expiry is enforced");
  } finally {
    // The tenant cascades: identities, indicators and the evidence rows go with it.
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
