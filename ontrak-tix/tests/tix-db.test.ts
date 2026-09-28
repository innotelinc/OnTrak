/**
 * OnTrak Tix Postgres integration test (M0).
 *
 *   cd ontrak-tix && npm run setup     # generate, push, seed
 *   npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-db.test.ts
 *
 * Everything else in the suite runs against fakes, so the app is proven without
 * a database. This one closes the loop the roadmap called out: the *real*
 * Prisma-backed store and audit sink, against a *real* Postgres. It is skipped
 * (not failed) when no database is reachable, so `npm test` stays green on a
 * machine without one.
 *
 * It provisions its own throwaway tenant and deletes it afterwards, so it never
 * touches the demo seed.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { Actor } from "../src/lib/access-rules";
import { createTicketServices } from "../src/lib/ticket-server";
import { PrismaAuditSink, type TicketPrismaClient } from "../src/lib/ticket-store-prisma";
import { IncidentDocsService } from "../src/lib/incident-docs-service";
import {
  PrismaIncidentDocsStore,
  type IncidentDocsPrismaClient,
} from "../src/lib/incident-docs-store-prisma";
import { IncidentService } from "../src/lib/incident-service";
import { PrismaIncidentStore, type IncidentPrismaClient } from "../src/lib/incident-store-prisma";
import { FileEvidenceObjectStore } from "../src/lib/object-lock-file";

/** Connect, or return null so the test can skip cleanly. */
async function connect(): Promise<PrismaClient | null> {
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
}

test("postgres: a ticket flows create → reply → resolve with a verifiable chain", async (t) => {
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const slug = `itest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const tenant = await db.tenant.create({ data: { name: "Integration Test", slug } });
    const requester = await db.user.create({
      data: { tenantId: tenant.id, email: `req-${slug}@test`, displayName: "Rita Requester", role: "REQUESTER" },
    });
    const agent = await db.user.create({
      data: { tenantId: tenant.id, email: `agent-${slug}@test`, displayName: "Sam Agent", role: "AGENT" },
    });

    const client = db as unknown as TicketPrismaClient;
    const { service, store } = createTicketServices(client);
    const actor: Actor = { id: agent.id, tenantId: tenant.id, role: "AGENT" };

    const created = await service.createTicket(actor, {
      subject: "Printer offline on the second floor",
      description: "Nobody can print since the queue was cleared.",
      type: "INCIDENT",
      priority: "HIGH",
      requesterId: requester.id,
    });
    assert.equal(created.ok, true, "the ticket is created");
    if (!created.ok) return;
    assert.equal(created.value.ref, "TIX-000001");

    const replied = await service.reply(actor, created.value.id, "Recreated the spooler and re-added the queue.", "INTERNAL_NOTE");
    assert.equal(replied.ok, true, "the reply is appended");
    // The lifecycle is a state machine, not a free-form field: NEW → OPEN → RESOLVED.
    const opened = await service.setStatus(actor, created.value.id, "OPEN");
    assert.equal(opened.ok, true, "the ticket opens");
    const resolved = await service.setStatus(actor, created.value.id, "RESOLVED");
    assert.equal(resolved.ok, true, "the ticket resolves");

    // Read it back from Postgres, not from anything held in memory.
    const stored = await db.ticket.findUnique({
      where: { id: created.value.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(stored?.status, "RESOLVED");
    assert.equal(stored?.messages.length, 1);
    assert.equal(stored?.messages[0].kind, "INTERNAL_NOTE");

    // The ticket is visible to its own tenant and invisible to any other.
    assert.equal((await store.findTicket(tenant.id, created.value.id))?.subject, "Printer offline on the second floor");
    assert.equal(await store.findTicket(`${slug}-other`, created.value.id), null, "tenant isolation holds at the query");

    // One audit event per mutation, persisted and verifiable from the rows.
    const events = await db.auditEvent.count({ where: { tenantId: tenant.id } });
    assert.equal(events, 4, "create, reply and both status changes each emitted an event");
    // A fresh sink re-reads the chain from the database — exactly what an
    // auditor's tamper check does.
    assert.deepEqual(await new PrismaAuditSink(client).verify(tenant.id), { ok: true, length: 4 });
  } finally {
    // Cascade removes the tenant's users, tickets, messages and audit rows.
    await db.tenant.delete({ where: { slug } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});

test("postgres: the retention sweep purges a closed window and leaves a held artifact alone", async (t) => {
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const slug = `itest-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Real bytes on a real filesystem: the point of this test is that the sweep
  // removes files and rows together, so neither can drift from the other.
  const evidenceDir = await mkdtemp(join(tmpdir(), "ontrak-sweep-"));
  t.after(async () => {
    await rm(evidenceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  try {
    const tenant = await db.tenant.create({ data: { name: "Sweep Test", slug } });
    const agent = await db.user.create({
      data: { tenantId: tenant.id, email: `agent-${slug}@test`, displayName: "Sam Agent", role: "AGENT" },
    });
    const actor: Actor = { id: agent.id, tenantId: tenant.id, role: "AGENT" };

    const client = db as unknown as TicketPrismaClient;
    const audit = new PrismaAuditSink(client);
    const incidentStore = new PrismaIncidentStore(db as unknown as IncidentPrismaClient);
    // The clock is injected, so "thirty days later" is a variable, not a wait.
    let clock = "2026-09-20T09:00:00.000Z";
    const ids = { id: () => randomUUID(), now: () => clock };
    const objects = new FileEvidenceObjectStore(evidenceDir);
    const docs = new IncidentDocsService(
      new PrismaIncidentDocsStore(db as unknown as IncidentDocsPrismaClient),
      incidentStore,
      audit,
      ids,
      undefined,
      { objects, retentionDays: 1 },
    );

    const incidents = new IncidentService(incidentStore, audit, ids);
    const declare = async (title: string) => {
      const declared = await incidents.declare(actor, {
        title,
        summary: "A key was used from an unfamiliar address.",
        impact: "EXTENSIVE",
        urgency: "CRITICAL",
      });
      assert.equal(declared.ok, true, `${title} is declared`);
      if (!declared.ok) throw new Error("declare failed");
      return declared.value;
    };

    const stored = async (incidentId: string, label: string) => {
      clock = new Date(Date.parse(clock) + 60_000).toISOString();
      const result = await docs.recordArtifact(actor, incidentId, {
        kind: "LOG",
        label,
        contentType: "text/plain",
        bytes: new TextEncoder().encode(`${label} — bastion host kerberos log`),
      });
      assert.equal(result.ok, true, `${label} is stored`);
      if (!result.ok) throw new Error("recordArtifact failed");
      return result.value.artifact;
    };

    // A legal hold covers the incident, so the two artifacts are on two
    // incidents: one the clock may act on, one somebody has said to preserve.
    const ordinary = await declare("Compromised bastion host");
    const expiry = await stored(ordinary.id, "expiry");
    const held = await declare("Compromised bastion host (under claim)");
    const hold = await docs.placeLegalHold(actor, held.id, "Preserve pending the adjuster");
    assert.equal(hold.ok, true);
    const preserved = await stored(held.id, "preserved");

    // Nobody has to ask: the window closes and the sweep acts on it.
    clock = "2026-09-23T09:00:00.000Z";
    const sweep = await docs.sweepRetention(tenant.id);
    assert.equal(sweep.ok, true, "the sweep runs against real Postgres");
    if (!sweep.ok) return;
    assert.equal(sweep.value.considered, 2);
    assert.equal(sweep.value.purged, 1);
    assert.equal(sweep.value.held, 1);

    // The file went with the row, and the held artifact's bytes are still there.
    assert.equal(await objects.get(expiry.key), null, "the purged artifact's bytes are gone from disk");
    assert.notEqual(await objects.get(preserved.key), null, "a legal hold keeps the bytes");
    const rows = await db.evidenceArtifact.findMany({ where: { tenantId: tenant.id }, orderBy: { lockedAt: "asc" } });
    assert.deepEqual(
      rows.map((row) => (row.key === expiry.key ? row.purgedAt !== null : row.purgedAt)),
      [true, null],
    );
    assert.equal(sweep.value.skipped[0].key, preserved.key);

    // Release the hold and the same sweep takes the rest.
    const released = await docs.releaseLegalHold(actor, held.id, "Claim settled");
    assert.equal(released.ok, true);
    clock = "2026-09-23T09:05:00.000Z";
    const second = await docs.sweepRetention(tenant.id);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.purged, 1);
    assert.equal(await objects.get(preserved.key), null);

    // Both runs are on the chain, and the chain still verifies.
    const sweeps = await db.auditEvent.count({ where: { tenantId: tenant.id, action: "incident.retention.sweep" } });
    const purges = await db.auditEvent.count({ where: { tenantId: tenant.id, action: "incident.evidence.purge" } });
    assert.equal(sweeps, 2);
    assert.equal(purges, 2);
    const verified = await new PrismaAuditSink(client).verify(tenant.id);
    assert.equal(verified.ok, true, "the audit chain verifies after the sweep");

    // A sweep with nothing left to do purges nothing — safe to schedule hourly.
    const idle = await docs.sweepRetention(tenant.id);
    assert.equal(idle.ok, true);
    if (idle.ok) assert.equal(idle.value.purged, 0);
  } finally {
    await db.tenant.delete({ where: { slug } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
