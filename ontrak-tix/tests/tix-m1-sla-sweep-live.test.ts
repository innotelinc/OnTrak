/**
 * OnTrak Tix M1 live test: the SLA sweep through the *running* app.
 *
 *   ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 ONTRAK_TIX_CRON_SECRET=… \
 *     npx tsx --tsconfig tests/tsconfig.json --test ontrak-tix/tests/tix-m1-sla-sweep-live.test.ts
 *
 * The unit suite proves the escalation rules and the service's idempotency, and
 * the Postgres test proves the ticket store against a real database. Neither of
 * them proves the *endpoint*: that the cron secret is checked, that `?tenant=`
 * scopes the run to one desk, that the scheduler's JSON says what was raised,
 * and that a real `SlaEscalation` row and its audit event exist afterwards.
 * That is what this does — it POSTs to the running server exactly as a cron would.
 *
 * Opt-in twice over (`ONTRAK_TIX_BASE_URL` and `ONTRAK_TIX_CRON_SECRET`), and it
 * provisions two throwaway tenants, so it never touches the demo seed. It never
 * calls the endpoint without `?tenant=`: an unscoped run would sweep every tenant
 * in the database, including the demo one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

const BASE_URL = process.env.ONTRAK_TIX_BASE_URL;
const SECRET = process.env.ONTRAK_TIX_CRON_SECRET;

/** A 24×7 calendar, so the arithmetic below is whole minutes and no business hours. */
const ALWAYS_OPEN = {
  name: "24x7",
  utcOffsetMinutes: 0,
  week: Array.from({ length: 7 }, () => [{ startMinute: 0, endMinute: 24 * 60 }]),
};

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

/**
 * POST the scheduler's endpoint the way a cron would. `null` means "send no
 * credential at all" — which is not the same as passing `undefined`, since an
 * explicit `undefined` would fall back to the default and sign the request.
 */
async function sweep(query: string, secret: string | null | undefined = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return fetch(`${BASE_URL}/api/sla/sweep${query}`, { method: "POST", headers });
}

interface SweepBody {
  status: string;
  raised: number;
  tenants: { tenant: string; tickets: number; raised: number }[];
}

/**
 * A throwaway desk with one ticket whose response and resolution clocks have both
 * burned through their whole window — so the sweep raises the top rung (level 3,
 * the manager's) on each clock, and nothing else.
 */
async function seedBreachedDesk(db: PrismaClient, slug: string): Promise<{ tenantId: string; ticketId: string }> {
  const tenant = await db.tenant.create({ data: { name: `SLA Sweep ${slug}`, slug } });
  const requester = await db.user.create({
    data: { tenantId: tenant.id, email: `requester-${slug}@test`, displayName: "Rae Requester", role: "REQUESTER" },
  });
  await db.slaPolicy.create({
    data: {
      tenantId: tenant.id,
      name: "24x7 one-hour response",
      priority: null,
      responseMinutes: 60,
      resolutionMinutes: 240,
      calendar: ALWAYS_OPEN,
      warningFraction: 0.2,
    },
  });
  const ticket = await db.ticket.create({
    data: {
      tenantId: tenant.id,
      ref: "TIX-000001",
      subject: "The whole site is down",
      description: "Nothing answers, from anywhere.",
      type: "INCIDENT",
      status: "OPEN",
      priority: "URGENT",
      requesterId: requester.id,
      // A month old: the one-hour response promise and the four-hour resolution
      // one have both passed, so each clock is at its top rung.
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
    },
  });
  return { tenantId: tenant.id, ticketId: ticket.id };
}

test("a cron run of the SLA sweep endpoint raises a real rung through the app", async (t) => {
  if (!BASE_URL) {
    t.skip("set ONTRAK_TIX_BASE_URL to run the live SLA sweep test");
    return;
  }
  if (!SECRET) {
    t.skip("set ONTRAK_TIX_CRON_SECRET (the app's `ONTRAK_TIX_CRON_SECRET`) to authorise the sweep");
    return;
  }
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `sla-live-a-${stamp}`;
  const slugB = `sla-live-b-${stamp}`;

  try {
    const a = await seedBreachedDesk(db, slugA);
    const b = await seedBreachedDesk(db, slugB);

    // Unauthenticated and unknown-tenant calls are refused before anything runs.
    assert.equal((await sweep(`?tenant=${slugA}`, null)).status, 401);
    assert.equal((await sweep("?tenant=nope")).status, 404);

    // The run: two clocks, both long past their window, so both raise level 3.
    const run = await sweep(`?tenant=${slugA}`);
    assert.equal(run.status, 200);
    const body = (await run.json()) as SweepBody;
    assert.equal(body.status, "ok");
    assert.equal(body.raised, 2);
    assert.deepEqual(body.tenants, [{ tenant: slugA, tickets: 1, raised: 2 }]);

    // `?tenant=` scopes the run: the other throwaway desk is untouched, and so is
    // every desk the sweep was not asked about.
    assert.equal(await db.slaEscalation.count({ where: { tenantId: b.tenantId } }), 0);
    assert.equal(await db.auditEvent.count({ where: { tenantId: b.tenantId } }), 0);

    const raised = await db.slaEscalation.findMany({ where: { tenantId: a.tenantId }, orderBy: { kind: "asc" } });
    assert.deepEqual(
      raised.map((row) => ({ kind: row.kind, level: row.level, audience: row.audience, dedupeKey: row.dedupeKey })),
      [
        { kind: "resolution", level: 3, audience: "MANAGER", dedupeKey: `${a.ticketId}:resolution:3` },
        { kind: "response", level: 3, audience: "MANAGER", dedupeKey: `${a.ticketId}:response:3` },
      ],
    );
    assert.equal(raised.every((row) => row.acknowledgedAt === null), true, "a new rung is unacknowledged");

    // The notice is on the tenant's hash-chained audit log, written by the
    // scheduler rather than a person.
    const audited = await db.auditEvent.findMany({ where: { tenantId: a.tenantId, action: "sla.escalate" } });
    assert.equal(audited.length, 2);
    assert.equal(audited.every((event) => event.actor === "system:sla-sweep"), true);

    // Safe to schedule as often as you like: the rungs are already raised.
    const again = await sweep(`?tenant=${slugA}`);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as SweepBody).raised, 0);
    assert.equal(await db.slaEscalation.count({ where: { tenantId: a.tenantId } }), 2);

    // The desk the first run was not asked about sweeps on its own turn.
    const other = await sweep(`?tenant=${slugB}`);
    assert.equal(((await other.json()) as SweepBody).raised, 2);
    assert.equal(await db.slaEscalation.count({ where: { tenantId: b.tenantId } }), 2);
  } finally {
    await db.tenant.delete({ where: { slug: slugA } }).catch(() => undefined);
    await db.tenant.delete({ where: { slug: slugB } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
