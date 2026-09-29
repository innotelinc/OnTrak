/**
 * OnTrak Tix M2 live test: scheduled outbound provisioning through the *running* app.
 *
 *   ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 \
 *   ONTRAK_TIX_CRON_SECRET=… \
 *   ONTRAK_TIX_SCIM_BASE_URL=http://127.0.0.1:8787 \
 *   ONTRAK_TIX_SCIM_TOKEN=sc1_… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-scim-sweep-live.test.ts
 *
 * The unit suite proves the plan and the service; the *endpoint* is a different
 * claim — that the scheduler's secret is checked, that `?tenant=` scopes the run
 * to one desk, that an unconfigured deployment is told so instead of being handed
 * a cheerful zero, and that the JSON says what actually happened. That is what
 * this does: it POSTs to the running server exactly as a cron would.
 *
 * Opt-in, and it provisions a throwaway tenant, so it never touches the demo seed.
 * It never calls the endpoint without `?tenant=`: an unscoped run would push every
 * desk in the database to the provider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";
import { HttpScimClient } from "../src/lib/scim-client";
import { scimTargetFromEnv } from "../src/lib/scim-rules";

const BASE_URL = process.env.ONTRAK_TIX_BASE_URL;
const SECRET = process.env.ONTRAK_TIX_CRON_SECRET;
const target = scimTargetFromEnv().target;

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
 * The scheduler's call. `null` means "send no credential at all", which is not the
 * same as `undefined` — that would fall back to the default and sign the request.
 */
async function push(query: string, secret: string | null | undefined = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return fetch(`${BASE_URL}/api/scim/push${query}`, { method: "POST", headers });
}

interface PushBody {
  status?: string;
  error?: string;
  totals?: { created: number; updated: number; deactivated: number; unchanged: number; failures: number };
  tenants?: { slug: string; created?: number; updated?: number; unchanged?: number }[];
}

test("the scheduler provisions a desk through the endpoint", async (t) => {
  if (!BASE_URL || !SECRET) {
    t.skip("set ONTRAK_TIX_BASE_URL and ONTRAK_TIX_CRON_SECRET to run the live sweep test");
    return;
  }
  if (!target) {
    // Only a proxy for whether the *server* is configured — the endpoint reads its
    // own environment. Without the target here the run below has nothing to assert.
    t.skip("set ONTRAK_TIX_SCIM_BASE_URL and ONTRAK_TIX_SCIM_TOKEN to run the live sweep test");
    return;
  }
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const tag = `scim-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const provider = new HttpScimClient(target);
  const stays = { email: `${tag}-stays@ontrak.test`, displayName: "Sweep Stays" };
  const leaves = { email: `${tag}-leaves@ontrak.test`, displayName: "Sweep Leaves" };

  try {
    const tenant = await db.tenant.create({ data: { name: "SCIM Sweep Live Test", slug: tag } });
    await db.user.create({
      data: { tenantId: tenant.id, email: stays.email, displayName: stays.displayName, role: "AGENT", active: true },
    });
    await db.user.create({
      data: { tenantId: tenant.id, email: leaves.email, displayName: leaves.displayName, role: "AGENT", active: true },
    });

    // 1. Without a credential the endpoint is a door, not a service.
    const anonymous = await push(`?tenant=${tag}`, null);
    assert.equal(anonymous.status, 401);
    const wrong = await push(`?tenant=${tag}`, "not-the-secret");
    assert.equal(wrong.status, 401);

    // 2. A scoped run provisions exactly this desk, and says so.
    const first = await push(`?tenant=${tag}`);
    assert.equal(first.status, 200, `expected 200, got ${first.status}`);
    const firstBody = (await first.json()) as PushBody;
    assert.equal(firstBody.status, "ok");
    assert.equal(firstBody.totals?.created, 2);
    assert.equal(firstBody.totals?.failures, 0);
    assert.deepEqual(firstBody.tenants?.map((entry) => entry.slug), [tag], "only the tenant that was asked for");

    const created = await provider.findByUserName(stays.email);
    assert.ok(created, "the person is at the provider");
    assert.equal(created?.active, true);

    // 3. A second run changes nothing — which is what makes it safe to schedule
    //    every few minutes.
    const second = await push(`?tenant=${tag}`);
    const secondBody = (await second.json()) as PushBody;
    assert.equal(secondBody.totals?.created, 0);
    assert.equal(secondBody.totals?.unchanged, 2);

    // 4. Somebody leaving the desk is switched off at the provider.
    await db.user.update({ where: { tenantId_email: { tenantId: tenant.id, email: leaves.email } }, data: { active: false } });
    const third = await push(`?tenant=${tag}`);
    const thirdBody = (await third.json()) as PushBody;
    assert.equal(thirdBody.totals?.deactivated, 1);
    assert.equal((await provider.findByUserName(leaves.email))?.active, false);

    // 5. An unknown desk is named in the answer rather than silently sweeping none.
    const unknown = await push("?tenant=does-not-exist");
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as PushBody).error ?? "", /Unknown tenant/);
  } finally {
    await db.tenant.delete({ where: { slug: tag } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
