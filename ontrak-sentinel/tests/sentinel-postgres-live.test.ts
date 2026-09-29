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

import { sha256Hex } from "../src/lib/hash";
import { createIdentityServices } from "../src/lib/identity-server";
import type { IdentityPrismaClient } from "../src/lib/identity-store-prisma";

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
