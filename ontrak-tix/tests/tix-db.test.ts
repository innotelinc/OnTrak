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
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { Actor } from "../src/lib/access-rules";
import { createTicketServices } from "../src/lib/ticket-server";
import { PrismaAuditSink, type TicketPrismaClient } from "../src/lib/ticket-store-prisma";

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
