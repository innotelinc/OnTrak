/**
 * OnTrak Tix M3 live test: the retention sweep through the *running* app.
 *
 *   ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 ONTRAK_TIX_CRON_SECRET=… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-retention-live.test.ts
 *
 * The unit suite proves the sweep's rules and the service's behaviour, and the
 * Postgres test proves it against a real database and real files. Neither of
 * them proves the *endpoint*: that the secret is checked, that `?tenant=` scopes
 * the run, that the scheduler's JSON says what happened, and that a real file on
 * the app's own evidence directory is gone afterwards. That is what this does —
 * it POSTs to the running server exactly as a cron would.
 *
 * Opt-in twice over (`ONTRAK_TIX_BASE_URL` and `ONTRAK_TIX_CRON_SECRET`), and it
 * provisions its own throwaway tenant, so it never touches the demo seed.
 *
 * Both the test and the app resolve evidence paths from the same working
 * directory (`ontrak-tix/`), which is what lets this assert on the actual file
 * the server removed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, mkdir, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

const BASE_URL = process.env.ONTRAK_TIX_BASE_URL;
const SECRET = process.env.ONTRAK_TIX_CRON_SECRET;

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

/** POST the scheduler's endpoint the way a cron would. */
async function sweep(query = "", secret: string | undefined = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return fetch(`${BASE_URL}/api/incidents/retention-sweep${query}`, { method: "POST", headers });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("a cron run of the sweep endpoint purges a real expired artifact through the app", async (t) => {
  if (!BASE_URL) {
    t.skip("set ONTRAK_TIX_BASE_URL to run the live retention sweep test");
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

  const evidenceRoot = resolve(process.env.ONTRAK_TIX_EVIDENCE_DIR ?? ".ontrak-tix-evidence");
  const slug = `sweep-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let tenantId = "";

  try {
    const tenant = await db.tenant.create({ data: { name: "Sweep Live Test", slug } });
    tenantId = tenant.id;
    const agent = await db.user.create({
      data: { tenantId: tenant.id, email: `agent-${slug}@test`, displayName: "Sam Agent", role: "AGENT" },
    });
    const incident = await db.incident.create({
      data: {
        tenantId: tenant.id,
        ref: "INC-000001",
        title: "Compromised bastion host",
        summary: "A key was used from an unfamiliar address.",
        severity: "SEV2",
        phase: "CONTAINED",
        impact: "EXTENSIVE",
        urgency: "CRITICAL",
        detectedAt: new Date("2026-09-20T08:00:00.000Z"),
        declaredAt: new Date("2026-09-20T09:00:00.000Z"),
      },
    });

    // An artifact whose window closed years ago, with its bytes written where the
    // app's own store looks for them (content-addressed, read-only, as if stored).
    const bytes = new TextEncoder().encode("bastion host kerberos log — sweep live test");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `evidence/${tenant.id}/${incident.id}/${sha256}`;
    const path = join(evidenceRoot, ...key.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o444 });

    const artifact = await db.evidenceArtifact.create({
      data: {
        tenantId: tenant.id,
        incidentId: incident.id,
        key,
        sha256,
        bytes: bytes.byteLength,
        contentType: "text/plain",
        mode: "COMPLIANCE",
        retainUntil: new Date("2026-09-19T00:00:00.000Z"),
        lockedAt: new Date("2016-09-19T00:00:00.000Z"),
        createdBy: agent.id,
      },
    });
    assert.equal(await exists(path), true, "the bytes are on disk before the sweep");

    // Unauthenticated and unknown-tenant calls are refused before anything runs.
    assert.equal((await sweep("", undefined)).status, 401);
    assert.equal((await sweep("?tenant=nope")).status, 404);

    // A dry run reports the purge and changes nothing at all.
    const dry = await sweep(`?tenant=${slug}&dryRun=1`);
    assert.equal(dry.status, 200);
    const dryBody = (await dry.json()) as { dryRun: boolean; purged: number; bytesFreed: number };
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.purged, 1);
    assert.equal(dryBody.bytesFreed, bytes.byteLength);
    assert.equal(await exists(path), true, "a dry run leaves the bytes alone");
    assert.equal((await db.evidenceArtifact.findUnique({ where: { id: artifact.id } }))?.purgedAt, null);

    // The real run: the app removes the file, stamps the tombstone and records it.
    const run = await sweep(`?tenant=${slug}`);
    assert.equal(run.status, 200);
    const body = (await run.json()) as {
      purged: number;
      bytesFreed: number;
      tenants: { tenant: string; considered: number; purged: number; held: number }[];
    };
    assert.equal(body.purged, 1);
    assert.equal(body.bytesFreed, bytes.byteLength);
    assert.deepEqual(body.tenants, [{ tenant: slug, considered: 1, purged: 1, retained: 0, held: 0 }]);
    assert.equal(await exists(path), false, "the server removed the bytes from its own evidence directory");
    assert.notEqual((await db.evidenceArtifact.findUnique({ where: { id: artifact.id } }))?.purgedAt, null);

    // The record explains the deletion, and the run itself is on the chain.
    const events = await db.incidentEvent.findMany({ where: { incidentId: incident.id }, orderBy: { at: "asc" } });
    assert.equal(events.filter((event) => event.summary.startsWith("Artifact purged:")).length, 1);
    const audited = await db.auditEvent.findMany({ where: { tenantId: tenant.id } });
    assert.equal(audited.filter((event) => event.action === "incident.evidence.purge").length, 1);
    assert.equal(audited.filter((event) => event.action === "incident.retention.sweep").length, 1);
    assert.equal(audited.find((event) => event.action === "incident.retention.sweep")?.actor, "system:retention-sweep");

    // Safe to schedule hourly: the second run has nothing left to do.
    const again = await sweep(`?tenant=${slug}`);
    const againBody = (await again.json()) as { purged: number };
    assert.equal(againBody.purged, 0);
  } finally {
    await db.tenant.delete({ where: { slug } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    // Only this throwaway tenant's subtree: the demo tenant keeps its evidence.
    if (tenantId) await rm(join(evidenceRoot, "evidence", tenantId), { recursive: true, force: true }).catch(() => undefined);
  }
});
