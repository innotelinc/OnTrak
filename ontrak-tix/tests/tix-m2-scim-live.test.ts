/**
 * OnTrak Tix M2 live test: outbound provisioning against a *running* provider.
 *
 *   ONTRAK_TIX_SCIM_BASE_URL=http://127.0.0.1:8787 \
 *   ONTRAK_TIX_SCIM_TOKEN=sc1_… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-scim-live.test.ts
 *
 * The unit suite proves the plan, the payloads and the client against a fake
 * server. None of that answers the question a deployment actually has: does the
 * person who joined this desk appear at the provider, and does the one who left
 * stop being able to sign in? Only a real connector token and a real SCIM server
 * can answer it — so this test needs both, and skips without them.
 *
 * It provisions its own throwaway tenant and its own addresses, so it never
 * touches the demo seed, and it asserts the *stateful* property that matters as
 * much as the happy path: a second run over unchanged people writes nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import type { AuditEventInput } from "../src/lib/audit-chain";
import { HttpScimClient } from "../src/lib/scim-client";
import { scimTargetFromEnv, type ScimTarget } from "../src/lib/scim-rules";
import { ScimSyncService } from "../src/lib/scim-sync-service";
import { createPrismaScimPeople, type ScimPeoplePrismaClient } from "../src/lib/scim-sync-store-prisma";
import { PrismaAuditSink, sha256Hex, type TicketPrismaClient } from "../src/lib/ticket-store-prisma";

const target: ScimTarget | null = scimTargetFromEnv().target;

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

test("the desk's people reach a real identity provider", async (t) => {
  if (!target) {
    t.skip("set ONTRAK_TIX_SCIM_BASE_URL and ONTRAK_TIX_SCIM_TOKEN to run the live provisioning test");
    return;
  }
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const tag = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const provider = new HttpScimClient(target);
  const sink = new PrismaAuditSink(db as unknown as TicketPrismaClient, sha256Hex);
  // The test's own client rather than the app's singleton, so this file needs no
  // part of the application graph to be bootable — only a database.
  const service = new ScimSyncService(
    createPrismaScimPeople(db as unknown as ScimPeoplePrismaClient),
    provider,
    sink,
  );

  const stays = { email: `${tag}-stays@ontrak.test`, displayName: "Stays Employed" };
  const leaves = { email: `${tag}-leaves@ontrak.test`, displayName: "Leaves Friday" };

  try {
    const tenant = await db.tenant.create({ data: { name: "SCIM Live Test", slug: tag } });
    const actor = { id: "system:test", tenantId: tenant.id, role: "ADMIN" as const };

    const staying = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: stays.email,
        displayName: stays.displayName,
        role: "AGENT",
        active: true,
      },
    });
    const leaving = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: leaves.email,
        displayName: leaves.displayName,
        role: "AGENT",
        active: true,
      },
    });

    // 1. The first run creates them at the provider.
    const first = await service.push(actor);
    assert.ok(first.ok);
    assert.equal(first.value.created, 2, `expected two creations, got ${JSON.stringify(first.value.failures)}`);
    assert.equal(first.value.failures.length, 0);

    const atProvider = await provider.findByUserName(stays.email);
    assert.ok(atProvider, "the person who joined is at the provider");
    assert.equal(atProvider?.active, true);
    // The provider keyed the identity on the desk's own account id, which is what
    // makes a later rename a move rather than a second person.
    assert.equal(atProvider?.externalId, staying.id);

    // 2. Re-running over people who have not changed writes nothing — the property
    //    that keeps a nightly sync from rewriting the provider's history.
    const second = await service.push(actor);
    assert.ok(second.ok);
    assert.equal(second.value.created, 0);
    assert.equal(second.value.updated, 0);
    assert.equal(second.value.deactivated, 0);
    assert.equal(second.value.unchanged, 2);

    const entriesAfterQuietRun = await db.auditEvent.count({
      where: { tenantId: tenant.id, action: "identity.scim.push" },
    });
    assert.equal(entriesAfterQuietRun, 2, "one audit entry per applied change, and none for a no-op run");

    // 3. Somebody leaving the desk is switched off at the provider.
    await db.user.update({ where: { id: leaving.id }, data: { active: false } });
    const third = await service.push(actor);
    assert.ok(third.ok);
    assert.equal(third.value.deactivated, 1);
    assert.equal(third.value.unchanged, 1);

    const switchedOff = await provider.findByUserName(leaves.email);
    assert.equal(switchedOff?.active, false, "the person who left can no longer sign in at the provider");

    // 4. Re-adding them switches them back on, because the desk is the system of
    //    record for its own people.
    await db.user.update({ where: { id: leaving.id }, data: { active: true } });
    const fourth = await service.push(actor);
    assert.ok(fourth.ok);
    assert.equal(fourth.value.updated, 1);
    const switchedOn = await provider.findByUserName(leaves.email);
    assert.equal(switchedOn?.active, true);
    assert.equal(switchedOn?.id, switchedOff?.id, "the same identity came back, not a second one");

    // 5. And every applied change is on the tenant's hash-chained evidence log,
    //    naming the person it was about. Not "the first entry is this person":
    //    the run is ordered by address, so which one comes first is not a fact
    //    worth asserting.
    const pushed = await db.auditEvent.findMany({
      where: { tenantId: tenant.id, action: "identity.scim.push" },
      select: { actor: true, targetId: true },
    });
    const audited = new Set(pushed.map((event) => event.targetId));
    assert.equal(pushed.length, 4, "two created, one switched off, one switched back on");
    assert.ok(audited.has(staying.id), "the person who stayed is on the chain");
    assert.ok(audited.has(leaving.id), "and so is the person who left");
    assert.ok(pushed.every((event) => event.actor === "system:scim-sync"));
  } finally {
    await db.tenant.delete({ where: { slug: tag } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});

test("the live provider refuses a token that is not a connector token", async (t) => {
  if (!target) {
    t.skip("set ONTRAK_TIX_SCIM_TOKEN to run the live provisioning test");
    return;
  }

  // A wrong-but-well-formed token must come back as a failure an operator can read,
  // not as an exception that abandons the run.
  const wrong = new HttpScimClient({ baseUrl: target.baseUrl, token: "sc1_not-a-real-connector-token" });
  const collected: AuditEventInput[] = [];
  const service = new ScimSyncService(
    { async listUsers() { return [{ id: "u1", tenantId: "t1", email: "nobody@ontrak.test", displayName: "Nobody", role: "AGENT", active: true, externalId: null }]; } },
    wrong,
    { append: (event) => { collected.push(event); } },
  );

  const result = await service.push({ id: "admin", tenantId: "t1", role: "ADMIN" });
  assert.ok(result.ok);
  assert.equal(result.value.created, 0);
  assert.equal(result.value.failures.length, 1);
  assert.match(result.value.failures[0].reason, /token|401|credential/i);
  assert.equal(collected.length, 0, "a refused push is not an applied change");
});
