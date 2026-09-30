/**
 * OnTrak Sentinel S1 tests: the OIDC grants, persisted.
 *
 * The engine tests (`sentinel-oidc.test.ts`) prove the flow; these prove it
 * survives a database — that a client, a code and a token come back out of the
 * rows they were written to, that a code's lifetime crosses the
 * epoch-milliseconds/`DateTime` boundary intact, and that `markCodeUsed` is a
 * conditional write rather than a read-then-write (so two exchanges racing on one
 * code cannot both win). The last two tests matter most: they run the *whole*
 * flow over the Prisma-backed store and then resolve an already-issued token
 * through a *second* service instance, which is the difference between
 * persisting grants and merely caching them.
 *
 * The Prisma client is faked, deliberately: the adapter is declared structurally
 * (`OidcPrismaClient`), so these run without a database or a generated client.
 * The second migration that creates the real tables is checked in CI by
 * validating the schema and generating the client.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { generateSigningKey, oneKey, type SigningKey } from "../src/lib/oidc-keys";
import { codeChallengeFor, type OidcClientRecord } from "../src/lib/oidc-rules";
import {
  PrismaOidcStore,
  toClientCreate,
  toClientRecord,
  toCodeCreate,
  toCodeRecord,
  toTokenCreate,
  toTokenRecord,
  type AccessTokenRow,
  type AuthorizationCodeRow,
  type OidcClientRow,
  type OidcPrismaClient,
} from "../src/lib/oidc-store-prisma";
import {
  MemoryOidcStore,
  OidcService,
  type AccessTokenRecord,
  type AuthorizationCodeRecord,
  type OidcIds,
} from "../src/lib/oidc-service";
import { configureOidc, createOidcServices, oidcServices } from "../src/lib/oidc-server";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ISSUER = "https://identity.acme.test";
const KEYS: SigningKey = generateSigningKey();
const VERIFIER = "3lR6kQz1vB9wS2pJ8nH4tY7cM0xG5dF1aK9eU2rT6bN8sW";
const REDIRECT = "https://tix.acme.test/api/sso/callback";

/* -------------------------------------------------------------------------- */
/*  A fake client over plain arrays                                           */
/* -------------------------------------------------------------------------- */

type Where = Record<string, unknown>;

/** Equality the way Prisma means it, including a `null` match on `usedAt`. */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => row[key] === expected);
}

function fakePrisma(): OidcPrismaClient & {
  rows: { oidcClient: OidcClientRow[]; authorizationCode: AuthorizationCodeRow[]; accessToken: AccessTokenRow[] };
} {
  const oidcClient: OidcClientRow[] = [];
  const authorizationCode: AuthorizationCodeRow[] = [];
  const accessToken: AccessTokenRow[] = [];

  const asRecord = (row: object): Record<string, unknown> => row as unknown as Record<string, unknown>;

  return {
    rows: { oidcClient, authorizationCode, accessToken },
    oidcClient: {
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return oidcClient.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async findMany(args: unknown) {
        const where = (args as { where: Where }).where;
        return oidcClient.filter((row) => matches(asRecord(row), where));
      },
      async create(args: { data: unknown }) {
        oidcClient.push({ ...(args.data as OidcClientRow) });
        return args.data;
      },
    },
    authorizationCode: {
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return authorizationCode.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async create(args: { data: unknown }) {
        authorizationCode.push({ ...(args.data as AuthorizationCodeRow) });
        return args.data;
      },
      async updateMany(args: { where: unknown; data: unknown }) {
        const where = (args as { where: Where }).where;
        const data = (args as { data: Partial<AuthorizationCodeRow> }).data;
        let count = 0;
        authorizationCode.forEach((row, index) => {
          if (!matches(asRecord(row), where)) return;
          authorizationCode[index] = { ...row, ...data };
          count += 1;
        });
        return { count };
      },
    },
    accessToken: {
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return accessToken.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async create(args: { data: unknown }) {
        accessToken.push({ ...(args.data as AccessTokenRow) });
        return args.data;
      },
      async updateMany(args: { where: unknown; data: unknown }) {
        const where = (args as { where: Where }).where;
        const data = (args as { data: Partial<AccessTokenRow> }).data;
        let count = 0;
        accessToken.forEach((row, index) => {
          if (!matches(asRecord(row), where)) return;
          accessToken[index] = { ...row, ...data };
          count += 1;
        });
        return { count };
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Deterministic ids and a small harness                                     */
/* -------------------------------------------------------------------------- */

let seq = 0;

function idsFor(scope: string, clock: { at: number }): OidcIds {
  let n = 0;
  return {
    id: () => `${scope}-ev-${++n}`,
    clientId: () => `${scope}-client-${++n}`,
    code: () => `${scope}-code-${++n}`,
    token: () => `${scope}-token-${++n}`,
    now: () => new Date(clock.at).toISOString(),
    nowMs: () => clock.at,
  };
}

/**
 * A full stack over the fake database, plus the spine it shares.
 *
 * `reuse` stands in for the durable S0 spine of a real deployment: a second
 * process would open the same identity tables, so passing one in lets a test
 * isolate the thing under test — that the *grant* rows, not a service's memory,
 * are what a later instance reads.
 */
function stack(
  db: OidcPrismaClient,
  clock: { at: number } = { at: Date.parse("2026-09-29T09:00:00.000Z") },
  reuse?: { spine: IdentityService; identities: MemoryIdentityStore },
) {
  const scope = `s${++seq}`;
  const audit = new OrganizationAuditLog(sha256);
  const identities = reuse?.identities ?? new MemoryIdentityStore();
  const spine = reuse?.spine ?? new IdentityService(identities, audit);
  const ids = idsFor(scope, clock);
  const { store, service: oidc } = createOidcServices(
    new PrismaOidcStore(db),
    identities,
    spine,
    { issuer: ISSUER, keys: oneKey(KEYS) },
    audit,
    ids,
    sha256,
  );
  return { store, oidc, spine, identities, audit, clock, advance: (seconds: number) => (clock.at += seconds * 1000) };
}

/** A bootstrapped organization, its admin, a live session and one registered client. */
async function signedIn(h = stack(fakePrisma())) {
  const created = await h.spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${seq}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");

  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const client = await h.oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: [REDIRECT],
    scopes: ["openid", "profile", "email", "roles"],
  });
  assert.equal(client.ok, true, client.ok ? "" : client.error);
  if (!client.ok) throw new Error("unreachable");

  return { ...h, actor, session: session.value, client: client.value };
}

/** Take a code all the way to a token, the way a client would. */
async function exchanged(s: Awaited<ReturnType<typeof signedIn>>) {
  const authorize = await s.oidc.authorize({
    clientId: s.client.clientId,
    redirectUri: REDIRECT,
    responseType: "code",
    scope: "openid profile email",
    state: "state-1",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: s.session.id,
  });
  assert.equal(authorize.ok, true, authorize.ok ? "" : authorize.error);
  if (!authorize.ok) throw new Error("unreachable");

  const token = await s.oidc.token({
    grantType: "authorization_code",
    clientId: s.client.clientId,
    code: authorize.code,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
  });
  assert.equal(token.ok, true, token.ok ? "" : token.error);
  if (!token.ok) throw new Error("unreachable");
  return { code: authorize.code, token };
}

/* -------------------------------------------------------------------------- */
/*  The mappers                                                               */
/* -------------------------------------------------------------------------- */

test("a client survives the round trip from record to row and back", () => {
  const record: OidcClientRecord = {
    clientId: "client-1",
    organizationId: "org-1",
    name: "OnTrak Tix",
    redirectUris: [REDIRECT],
    scopes: ["openid", "email"],
    kind: "confidential",
    createdBy: "admin-1",
    createdAt: "2026-09-29T09:00:00.000Z",
  };

  assert.deepEqual(toClientRecord(toClientCreate(record)), record);
});

test("a code's instants cross the DateTime boundary intact", () => {
  const record: AuthorizationCodeRecord = {
    code: "code-1",
    organizationId: "org-1",
    clientId: "client-1",
    redirectUri: REDIRECT,
    scopes: ["openid"],
    identityId: "identity-1",
    sessionId: "session-1",
    nonce: null,
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    issuedAt: Date.parse("2026-09-29T09:00:00.000Z"),
    expiresAt: Date.parse("2026-09-29T09:01:00.000Z"),
    usedAt: null,
  };

  const back = toCodeRecord(toCodeCreate(record) as AuthorizationCodeRow);
  assert.deepEqual(back, record);
  // Sixty seconds, not sixty thousand: the unit is the one the engine reads.
  assert.equal(back.expiresAt - back.issuedAt, 60_000);
});

test("an access token is keyed by its hash, never by the token", () => {
  const record: AccessTokenRecord = {
    tokenHash: sha256("the-token"),
    organizationId: "org-1",
    clientId: "client-1",
    identityId: "identity-1",
    sessionId: "session-1",
    scopes: ["openid"],
    issuedAt: Date.parse("2026-09-29T09:00:00.000Z"),
    expiresAt: Date.parse("2026-09-29T09:30:00.000Z"),
    revokedAt: null,
  };

  assert.deepEqual(toTokenRecord(toTokenCreate(record) as AccessTokenRow), record);

  // Revocation is a timestamp, and it survives the round trip: a token that was
  // killed must read back as killed, not as "never revoked".
  const revoked = { ...record, revokedAt: Date.parse("2026-09-29T09:05:00.000Z") };
  assert.deepEqual(toTokenRecord(toTokenCreate(revoked) as AccessTokenRow), revoked);
});

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

test("clients are resolved globally by id, but listed only within their organization", async () => {
  const db = fakePrisma();
  const store = new PrismaOidcStore(db);
  const client: OidcClientRecord = {
    clientId: "client-1",
    organizationId: "org-1",
    name: "OnTrak Tix",
    redirectUris: [REDIRECT],
    scopes: ["openid"],
    kind: "public",
    createdBy: "admin-1",
    createdAt: "2026-09-29T09:00:00.000Z",
  };
  await store.insertClient(client);
  await store.insertClient({ ...client, clientId: "client-2", organizationId: "org-2" });

  // The token endpoint is reached with the id alone, so the read is unscoped.
  assert.equal((await store.findClient("client-1"))?.organizationId, "org-1");
  assert.equal(await store.findClient("missing"), null);
  assert.deepEqual(
    (await store.listClients("org-1")).map((entry) => entry.clientId),
    ["client-1"],
  );
});

test("markCodeUsed is one conditional write, so only one exchange can win", async () => {
  const db = fakePrisma();
  const store = new PrismaOidcStore(db);
  const record: AuthorizationCodeRecord = {
    code: "code-1",
    organizationId: "org-1",
    clientId: "client-1",
    redirectUri: REDIRECT,
    scopes: ["openid"],
    identityId: "identity-1",
    sessionId: "session-1",
    nonce: null,
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    issuedAt: 1_000,
    expiresAt: 61_000,
    usedAt: null,
  };
  await store.insertCode(record);

  assert.equal(await store.markCodeUsed("code-1", 5_000), true);
  // The second caller gets `false` — the code is spent, not rewritten.
  assert.equal(await store.markCodeUsed("code-1", 6_000), false);
  assert.equal((await store.findCode("code-1"))?.usedAt, 5_000);
  // A code nobody issued cannot be spent either.
  assert.equal(await store.markCodeUsed("code-404", 5_000), false);
});

test("tokens are looked up by hash", async () => {
  const db = fakePrisma();
  const store = new PrismaOidcStore(db);
  const hash = sha256("token-1");
  await store.insertToken({
    tokenHash: hash,
    organizationId: "org-1",
    clientId: "client-1",
    identityId: "identity-1",
    sessionId: "session-1",
    scopes: ["openid"],
    issuedAt: 1_000,
    expiresAt: 2_000,
    revokedAt: null,
  });

  assert.equal((await store.findToken(hash))?.identityId, "identity-1");
  assert.equal(await store.findToken(sha256("token-2")), null);
});

test("revoking a session's tokens is one conditional write, and it is idempotent", async () => {
  const db = fakePrisma();
  const store = new PrismaOidcStore(db);
  const token = (name: string, sessionId = "session-1"): AccessTokenRecord => ({
    tokenHash: sha256(name),
    organizationId: "org-1",
    clientId: "client-1",
    identityId: "identity-1",
    sessionId,
    scopes: ["openid"],
    issuedAt: 1_000,
    expiresAt: 2_000,
    revokedAt: null,
  });

  await store.insertToken(token("token-1"));
  await store.insertToken(token("token-2"));
  // Another session's token must be untouched by a sign-out it has nothing to do with.
  await store.insertToken(token("token-3", "session-2"));

  assert.equal(await store.revokeTokensForSession("org-1", "session-1", 1_500), 2);
  assert.equal((await store.findToken(sha256("token-1")))?.revokedAt, 1_500);
  assert.equal((await store.findToken(sha256("token-2")))?.revokedAt, 1_500);
  assert.equal((await store.findToken(sha256("token-3")))?.revokedAt, null);

  // Running it again revokes nothing: the `where` only matches unrevoked rows.
  assert.equal(await store.revokeTokensForSession("org-1", "session-1", 1_600), 0);
  assert.equal((await store.findToken(sha256("token-1")))?.revokedAt, 1_500);

  // And a single-token revoke is the same conditional write.
  assert.equal(await store.revokeToken(sha256("token-3"), 1_700), true);
  assert.equal(await store.revokeToken(sha256("token-3"), 1_800), false);
  assert.equal(await store.revokeToken(sha256("token-404"), 1_800), false);
});

/* -------------------------------------------------------------------------- */
/*  The whole flow, over Postgres-shaped rows                                 */
/* -------------------------------------------------------------------------- */

test("the flow completes over the persisted store, and the token lands as a hash", async () => {
  const db = fakePrisma();
  const store = new PrismaOidcStore(db);
  const s = await signedIn(stack(db));
  const { token } = await exchanged(s);

  assert.equal(db.rows.oidcClient.length, 1);
  assert.equal(db.rows.accessToken.length, 1);
  // The plaintext token is handed out once and never stored.
  assert.equal(db.rows.accessToken[0].tokenHash, sha256(token.accessToken));
  assert.notEqual(db.rows.accessToken[0].tokenHash, token.accessToken);

  const claims = await s.oidc.userinfo(token.accessToken);
  assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
  assert.equal(store instanceof PrismaOidcStore, true);
});

test("a code already spent is refused, over the persisted store too", async () => {
  const s = await signedIn();
  const { code } = await exchanged(s);

  const replay = await s.oidc.token({
    grantType: "authorization_code",
    clientId: s.client.clientId,
    code,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
  });
  assert.equal(replay.ok, false);
  if (replay.ok) throw new Error("unreachable");
  assert.equal(replay.code, "invalid_grant");
});

test("tokens persist across service instances, which is the point of the migration", async () => {
  const db = fakePrisma();
  const first = await signedIn(stack(db));
  const { token } = await exchanged(first);

  // A second process would build its own stack over the same rows. It knows
  // nothing of the first one's grants, only of what was written down (the S0
  // spine is durable too, so it is shared here rather than re-bootstrapped).
  const second = stack(db, { at: first.clock.at }, { spine: first.spine, identities: first.identities });
  const claims = await second.oidc.userinfo(token.accessToken);
  assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
  if (!claims.ok) throw new Error("unreachable");
  assert.equal(claims.value.sub, first.actor.id);
});

/* -------------------------------------------------------------------------- */
/*  The assembly                                                              */
/* -------------------------------------------------------------------------- */

test("configureOidc binds one stack for the process, and refuses before it is called", () => {
  assert.throws(() => oidcServices(), /not configured/);

  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const spine = new IdentityService(identities, audit);
  const bound = configureOidc(
    new MemoryOidcStore(),
    identities,
    spine,
    { issuer: ISSUER, keys: oneKey(KEYS) },
    audit,
  );
  assert.equal(oidcServices().service, bound.service);
  assert.equal(bound.store instanceof MemoryOidcStore, true);
});

test("the memory store and the Prisma store honour the same port", async () => {
  // The engine cannot tell them apart, which is what makes the dev provider and
  // a deployment run the identical code path.
  for (const store of [new MemoryOidcStore(), new PrismaOidcStore(fakePrisma())]) {
    const record: OidcClientRecord = {
      clientId: `client-${Math.random()}`,
      organizationId: "org-1",
      name: "Client",
      redirectUris: [REDIRECT],
      scopes: ["openid"],
      kind: "public",
      createdBy: "admin-1",
      createdAt: "2026-09-29T09:00:00.000Z",
    };
    await store.insertClient(record);
    assert.equal((await store.findClient(record.clientId))?.name, "Client");
  }
});
