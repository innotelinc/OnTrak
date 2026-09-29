/**
 * OnTrak Sentinel S2 tests: provisioning, persisted.
 *
 * `sentinel-scim.test.ts` proves what the service decides; these prove it survives a
 * database — that a token goes in as a digest and comes back out by that digest, that
 * revocation and use travel across the ISO-string/`DateTime` boundary intact, and that
 * membership is a delete-then-insert so a connector's retry cannot double a row.
 *
 * Two properties get their own test because nothing else would notice them:
 *
 *  - **An update cannot rewrite a token's hash.** `toScimTokenUpdate` names the three
 *    fields that move after a mint, so a call that marked a token used or revoked
 *    cannot also re-point it at a different secret — the fake client below fails a
 *    write that carries a `tokenHash`, which is the check a careless `update({ data })`
 *    would sail past.
 *  - **Every read is scoped by organization.** The fake's matcher *throws* on a `where`
 *    shape it does not understand rather than matching everything, so an adapter that
 *    forgot `organizationId` fails here instead of reading across tenants quietly.
 *
 * The Prisma client is faked, deliberately: the adapter is declared structurally
 * (`ScimPrismaClient`), so these run without a database or a generated client. The real
 * tables are created and applied in CI, which deploys every migration and diffs them
 * against the models.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { PrismaScimStore, toScimGroupCreate, toScimGroupUpdate, toScimTokenCreate, toScimTokenUpdate, type ScimGroupMemberRow, type ScimGroupRow, type ScimPrismaClient, type ScimTokenRow } from "../src/lib/scim-store-prisma";
import { ScimService, type ScimIds, type ScimTokenRevoker } from "../src/lib/scim-service";

const sha256: HashFn = sha256Hex;
const BASE = "https://identity.acme.test/scim/v2";

/* -------------------------------------------------------------------------- */
/*  A fake client over plain arrays                                           */
/* -------------------------------------------------------------------------- */

type Where = Record<string, unknown>;

/**
 * Does a row match this `where`?
 *
 * Deliberately strict: an operator it does not know throws. A fake that answered
 * "everything" to a clause it did not implement would let an adapter that forgot to
 * scope a query by organization pass every test in this file.
 */
function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const operators = Object.keys(condition as object);
      for (const operator of operators) {
        if (operator !== "in") {
          throw new Error(`the fake client does not understand “${operator}” on “${key}”`);
        }
        const allowed = (condition as { in: unknown[] }).in;
        if (!allowed.includes(row[key])) return false;
      }
      continue;
    }
    if (row[key] !== condition) return false;
  }
  return true;
}

function fakeDb() {
  const tokens: ScimTokenRow[] = [];
  const groups: ScimGroupRow[] = [];
  const members: ScimGroupMemberRow[] = [];
  const calls: { delegate: string; method: string; args: unknown }[] = [];

  const record = (delegate: string, method: string, args: unknown): void => {
    calls.push({ delegate, method, args });
  };

  const client: ScimPrismaClient = {
    scimToken: {
      async create({ data }) {
        record("scimToken", "create", data);
        // The database fills the nullable columns in, so the fake does too: a row with
        // an `undefined` in it is a shape Postgres never returns.
        const row = data as ScimTokenRow;
        tokens.push({ ...row, lastUsedAt: row.lastUsedAt ?? null, revokedAt: row.revokedAt ?? null });
        return data;
      },
      async findFirst(args) {
        record("scimToken", "findFirst", args);
        const where = ((args ?? {}) as { where?: Where }).where ?? {};
        return tokens.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null;
      },
      async findMany(args) {
        record("scimToken", "findMany", args);
        const where = ((args ?? {}) as { where?: Where }).where ?? {};
        return tokens.filter((row) => matches(row as unknown as Record<string, unknown>, where));
      },
      async update({ where, data }) {
        record("scimToken", "update", { where, data });
        const row = tokens.find((entry) => entry.id === where.id);
        if (!row) throw new Error("no such token");
        const patch = data as Record<string, unknown>;
        // The two fields that must never be written here: the digest and its owner.
        if ("tokenHash" in patch) throw new Error("an update must not rewrite a token's hash");
        if ("organizationId" in patch) throw new Error("an update must not move a token between organizations");
        if ("createdBy" in patch) throw new Error("an update must not change who minted a token");
        Object.assign(row, patch);
        return row;
      },
    },
    group: {
      async create({ data }) {
        record("group", "create", data);
        groups.push(data as ScimGroupRow);
        return data;
      },
      async findFirst(args) {
        record("group", "findFirst", args);
        const where = ((args ?? {}) as { where?: Where }).where ?? {};
        return groups.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null;
      },
      async findMany(args) {
        record("group", "findMany", args);
        const where = ((args ?? {}) as { where?: Where }).where ?? {};
        return groups.filter((row) => matches(row as unknown as Record<string, unknown>, where));
      },
      async update({ where, data }) {
        record("group", "update", { where, data });
        const row = groups.find((entry) => entry.id === where.id);
        if (!row) throw new Error("no such group");
        Object.assign(row, data as Record<string, unknown>);
        return row;
      },
      async delete({ where }) {
        record("group", "delete", where);
        const index = groups.findIndex((entry) => entry.id === where.id);
        if (index >= 0) groups.splice(index, 1);
        // The foreign key cascades in Postgres; the fake does the same so a deleted
        // group cannot leave membership rows behind in a test either.
        for (let i = members.length - 1; i >= 0; i -= 1) {
          if (members[i].groupId === where.id) members.splice(i, 1);
        }
        return { id: where.id };
      },
    },
    groupMember: {
      async findMany(args) {
        record("groupMember", "findMany", args);
        const where = ((args ?? {}) as { where?: Where }).where ?? {};
        return members.filter((row) => matches(row as unknown as Record<string, unknown>, where));
      },
      async createMany({ data }) {
        record("groupMember", "createMany", data);
        for (const row of data as ScimGroupMemberRow[]) {
          members.push({ createdAt: new Date(), ...row } as ScimGroupMemberRow);
        }
        return { count: data.length };
      },
      async deleteMany({ where }) {
        record("groupMember", "deleteMany", where);
        let count = 0;
        for (let i = members.length - 1; i >= 0; i -= 1) {
          if (matches(members[i] as unknown as Record<string, unknown>, where as Where)) {
            members.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      },
    },
  };

  return { client, tokens, groups, members, calls };
}

let seq = 0;

function harness() {
  const db = fakeDb();
  const store = new PrismaScimStore(db.client, sha256);
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-25T09:00:00.000Z");
  let n = 0;
  const scope = `p${++seq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const revoked: string[] = [];
  const revoker: ScimTokenRevoker = {
    revokeTokensForSession: async (_organizationId, sessionId) => {
      revoked.push(sessionId);
      return 1;
    },
  };
  const scimIds: ScimIds = {
    id: () => `${scope}-scim-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    // 24 bytes as base64url is 32 characters — the length the real mint produces.
    token: () => `sc1_${"b".repeat(24)}${`${++n}`.padStart(8, "0")}`,
  };
  const service = new ScimService(store, spine, { baseUrl: BASE }, audit, revoker, scimIds);

  return {
    db,
    store,
    service,
    spine,
    audit,
    revoked,
    advance(ms: number) {
      clock += ms;
    },
    async bootstrap(slug = "acme") {
      const created = await spine.bootstrapOrganization(
        "test-suite",
        { name: slug, slug },
        { identifier: `admin@${slug}.test`, displayName: "Admin" },
      );
      assert.ok(created.ok);
      const actor: IdentityActor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN",
      };
      return { actor, organizationId: created.value.organization.id, admin: created.value.admin };
    },
    async token(actor: IdentityActor) {
      const minted = await service.mintToken(actor, "prisma store");
      assert.ok(minted.ok);
      const authenticated = await service.authenticate(minted.value.plaintext);
      assert.ok(authenticated.ok);
      return { plaintext: minted.value.plaintext, record: minted.value.token, caller: authenticated.value };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

test("a minted token is found by its digest, and only the fields that move are ever written again", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const minted = await h.service.mintToken(actor, "Entra ID");
  assert.ok(minted.ok);

  // The row carries the digest, not the token.
  assert.equal(h.db.tokens.length, 1);
  assert.equal(h.db.tokens[0].tokenHash, sha256(minted.value.plaintext));
  assert.equal(JSON.stringify(h.db.tokens[0]).includes(minted.value.plaintext), false);

  const found = await h.store.findTokenByHash(sha256(minted.value.plaintext));
  assert.ok(found);
  assert.equal(found.id, minted.value.token.id);
  // A digest that matches nothing is `null`, not the first row.
  assert.equal(await h.store.findTokenByHash(sha256("something else")), null);

  // Using the token moves `lastUsedAt` across the ISO/DateTime boundary, and an update
  // that carries anything else the fake client refuses.
  h.advance(60_000);
  const authenticated = await h.service.authenticate(minted.value.plaintext);
  assert.ok(authenticated.ok);
  const used = (await h.store.listTokens(organizationId))[0];
  assert.equal(used.lastUsedAt, new Date(Date.parse("2026-10-25T09:01:00.000Z")).toISOString());
  assert.equal(used.revokedAt, null);

  const revoked = await h.service.revokeToken(actor, minted.value.token.id);
  assert.ok(revoked.ok);
  const after = (await h.store.listTokens(organizationId))[0];
  assert.equal(after.revokedAt, new Date(Date.parse("2026-10-25T09:01:00.000Z")).toISOString());
  assert.equal(after.tokenHash, sha256(minted.value.plaintext));

  // The update's shape, asserted directly: exactly the three fields that may move.
  const updates = h.db.calls.filter((call) => call.delegate === "scimToken" && call.method === "update");
  assert.deepEqual(Object.keys((updates.at(-1)!.args as { data: object }).data).sort(), [
    "label",
    "lastUsedAt",
    "revokedAt",
  ]);
});

test("tokens are listed for one organization only", async () => {
  const h = harness();
  const acme = await h.bootstrap("acme");
  const globex = await h.bootstrap("globex");

  const acmeToken = await h.service.mintToken(acme.actor, "acme");
  const globexToken = await h.service.mintToken(globex.actor, "globex");
  assert.ok(acmeToken.ok && globexToken.ok);

  const listed = await h.store.listTokens(acme.organizationId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, "acme");

  // Every read names its tenant, and the fake's matcher would throw on a `where`
  // shape it did not understand — so this cannot pass by matching everything.
  const call = h.db.calls.filter((entry) => entry.delegate === "scimToken" && entry.method === "findMany").at(-1);
  assert.deepEqual(call!.args, { where: { organizationId: acme.organizationId }, orderBy: { createdAt: "asc" } });
});

test("a persisted token outlives the service instance that minted it", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const minted = await h.service.mintToken(actor, "Entra ID");
  assert.ok(minted.ok);

  // A second stack over the same rows — the difference between persisting a token and
  // caching one. This is the whole reason the token store exists.
  const second = new ScimService(h.store, h.spine, { baseUrl: BASE }, h.audit);
  const authenticated = await second.authenticate(minted.value.plaintext);
  assert.ok(authenticated.ok);
  assert.equal(authenticated.value.organizationId, organizationId);
  assert.equal(authenticated.value.actor.id, `scim:${minted.value.token.id}`);
});

/* -------------------------------------------------------------------------- */
/*  Groups                                                                    */
/* -------------------------------------------------------------------------- */

test("groups round-trip, and membership is a delete-then-insert so a retry cannot double a row", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const ada = await h.service.createUser(caller, { userName: "ada@acme.test" });
  const grace = await h.service.createUser(caller, { userName: "grace@acme.test" });
  assert.ok(ada.ok && grace.ok);

  const created = await h.service.createGroup(caller, {
    displayName: "Help desk",
    members: [{ value: ada.value.id }, { value: grace.value.id }],
  });
  assert.ok(created.ok);
  assert.equal(created.value.members.length, 2);

  // The same add twice is one row per member: the pair is deleted before it is written.
  await h.store.addMembers(organizationId, created.value.id, [ada.value.id]);
  const rows = await h.store.listMembers(organizationId, created.value.id);
  assert.equal(rows.filter((row) => row.identityId === ada.value.id).length, 1);

  const byName = await h.store.findGroupByName(organizationId, "Help desk");
  assert.ok(byName);
  assert.equal(byName.id, created.value.id);

  // A rename goes through `toScimGroupUpdate`, which names the two fields that move.
  const renamed = await h.service.patchGroup(caller, created.value.id, {
    Operations: [{ op: "replace", path: "displayName", value: "Service desk" }],
  });
  assert.ok(renamed.ok);
  assert.equal(renamed.value.displayName, "Service desk");
  assert.deepEqual(Object.keys(toScimGroupUpdate({ ...byName, displayName: "x" }) as object).sort(), [
    "displayName",
    "updatedAt",
  ]);

  await h.store.removeMembers(organizationId, created.value.id, [grace.value.id]);
  const after = await h.store.listMembers(organizationId, created.value.id);
  assert.deepEqual(after.map((row) => row.identityId), [ada.value.id]);
});

test("a group is read inside its own organization, and deleting one takes its membership with it", async () => {
  const h = harness();
  const acme = await h.bootstrap("acme");
  const globex = await h.bootstrap("globex");
  const acmeToken = await h.token(acme.actor);
  const globexToken = await h.token(globex.actor);

  const acmeUser = await h.service.createUser(acmeToken.caller, { userName: "ada@acme.test" });
  assert.ok(acmeUser.ok);
  const group = await h.service.createGroup(acmeToken.caller, {
    displayName: "Help desk",
    members: [{ value: acmeUser.value.id }],
  });
  assert.ok(group.ok);

  // The same group id asked for from another organization is absent rather than shared.
  assert.equal(await h.store.findGroup(globex.organizationId, group.value.id), null);
  assert.equal((await h.store.listMembers(globex.organizationId, group.value.id)).length, 0);
  assert.equal((await globexToken.caller.organizationId) === acme.organizationId, false);

  // Memberships are per identity *and* per tenant.
  const acmeMemberships = await h.store.listMembershipsForIdentity(acme.organizationId, acmeUser.value.id);
  assert.equal(acmeMemberships.length, 1);
  assert.deepEqual(
    await h.store.listMembershipsForIdentity(globex.organizationId, acmeUser.value.id),
    [],
  );

  const deleted = await h.service.deleteGroup(acmeToken.caller, group.value.id);
  assert.ok(deleted.ok);
  assert.equal(await h.store.findGroup(acme.organizationId, group.value.id), null);
  assert.deepEqual(await h.store.listMembers(acme.organizationId, group.value.id), []);
  assert.deepEqual(await h.store.listMembershipsForIdentity(acme.organizationId, acmeUser.value.id), []);
});

test("the whole provisioning flow runs over the Prisma-shaped rows, deprovisioning included", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller, plaintext } = await h.token(actor);
  assert.ok(plaintext.startsWith("sc1_"));

  const created = await h.service.createUser(caller, {
    userName: "leaver@acme.test",
    displayName: "Lee Aver",
    externalId: "dir-77",
  });
  assert.ok(created.ok);
  assert.equal(created.value.externalId, "dir-77");

  const policy = { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 3600 };
  const session = await h.spine.issueSession(organizationId, created.value.id, {}, policy);
  assert.ok(session.ok);

  const deleted = await h.service.deleteUser(caller, created.value.id);
  assert.ok(deleted.ok);
  assert.equal(deleted.value.sessionsEnded, 1);
  assert.deepEqual(h.revoked, [session.value.id]);

  // Created rows survive the delete, on the chain and in the table.
  const row = h.db.tokens.length;
  assert.equal(row, 1);
  const verification = await h.audit.verify(organizationId);
  assert.equal(verification.ok, true);
  const trail = await h.audit.trail(organizationId);
  assert.ok(trail.some((entry) => entry.action === "scim.deprovision"));
  assert.ok(trail.some((entry) => entry.action === "scim.token.mint"));
});

test("the pure mappers are what the adapter writes", () => {
  const record = {
    id: "t1",
    organizationId: "o1",
    label: "Entra",
    tokenHash: "hash",
    createdBy: "i1",
    createdAt: "2026-10-25T09:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };

  // A create carries the hash and the newcomer's metadata…
  assert.deepEqual(toScimTokenCreate(record), {
    id: "t1",
    organizationId: "o1",
    label: "Entra",
    tokenHash: "hash",
    createdBy: "i1",
    createdAt: new Date("2026-10-25T09:00:00.000Z"),
  });
  // …and an update cannot: no `tokenHash`, no `createdBy`, no `organizationId`.
  assert.deepEqual(Object.keys(toScimTokenUpdate(record)).sort(), ["label", "lastUsedAt", "revokedAt"]);

  const group = {
    id: "g1",
    organizationId: "o1",
    displayName: "Help desk",
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
  };
  assert.deepEqual(toScimGroupCreate(group), {
    id: "g1",
    organizationId: "o1",
    displayName: "Help desk",
    createdAt: new Date("2026-10-25T09:00:00.000Z"),
    updatedAt: new Date("2026-10-25T09:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(toScimGroupUpdate(group)).sort(), ["displayName", "updatedAt"]);
});
