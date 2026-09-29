/**
 * OnTrak Sentinel S0 tests: the spine, persisted.
 *
 * The service tests (`sentinel-identity.test.ts`) prove the rules; these prove
 * that the rules survive a database — that an identity comes back with its
 * organization and its MFA state, that a session's clocks survive the round trip
 * between epoch milliseconds and `DateTime`, that each organization's evidence
 * chain numbers from 1 on its own, and that a tampered chain is refused rather
 * than extended.
 *
 * The Prisma client is faked, deliberately: the adapter is declared structurally
 * (`IdentityPrismaClient`), so these run without a database or a generated
 * client, and the migration that creates the real tables is verified by applying
 * it (`npm run db:deploy`).
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { DEFAULT_IDENTITY_POLICY } from "../src/lib/identity-rules";
import { createIdentityServices, type IdentityServices } from "../src/lib/identity-server";
import {
  organizationOf,
  PrismaIdentityStore,
  PrismaOrganizationAuditTrail,
  toAuditRow,
  type AuditEventRow,
  type IdentityPrismaClient,
  type IdentityRow,
  type OrganizationRow,
  type PolicyRow,
  type SessionRow,
} from "../src/lib/identity-store-prisma";
import type { IdentityActor } from "../src/lib/identity-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");

type Where = Record<string, unknown>;

/** Equality the way Prisma means it, including the `{ equals, mode }` form. */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected !== null && typeof expected === "object" && "equals" in (expected as object)) {
      const wanted = String((expected as { equals: unknown }).equals).trim().toLowerCase();
      return String(actual).trim().toLowerCase() === wanted;
    }
    return actual === expected;
  });
}

/**
 * A throwaway stand-in for the delegates the adapter uses, over plain arrays.
 * It holds real rows (dates, not ISO strings), so the mappers are exercised
 * rather than short-circuited.
 */
function fakePrisma(): IdentityPrismaClient & {
  rows: {
    organization: OrganizationRow[];
    identity: IdentityRow[];
    identityPolicy: PolicyRow[];
    session: SessionRow[];
    auditEvent: AuditEventRow[];
  };
} {
  const organization: OrganizationRow[] = [];
  const identity: IdentityRow[] = [];
  const identityPolicy: PolicyRow[] = [];
  const session: SessionRow[] = [];
  const auditEvent: AuditEventRow[] = [];

  const asRecord = (row: object): Record<string, unknown> => row as unknown as Record<string, unknown>;

  return {
    rows: { organization, identity, identityPolicy, session, auditEvent },
    organization: {
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return organization.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async create(args: { data: unknown }) {
        organization.push({ ...(args.data as OrganizationRow) });
        return args.data;
      },
    },
    identity: {
      async findMany(args: unknown) {
        const where = (args as { where: Where }).where;
        return identity.filter((row) => matches(asRecord(row), where));
      },
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return identity.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async create(args: { data: unknown }) {
        identity.push({ ...(args.data as IdentityRow) });
        return args.data;
      },
      async update(args: { where: unknown; data: unknown }) {
        const id = (args.where as { id: string }).id;
        const row = identity.find((entry) => entry.id === id);
        if (row) Object.assign(row, args.data as Partial<IdentityRow>);
        return row ?? null;
      },
    },
    identityPolicy: {
      async findMany(args: unknown) {
        const where = (args as { where: Where }).where;
        return identityPolicy.filter((row) => matches(asRecord(row), where));
      },
      async upsert(args: { where: unknown; create: unknown; update: unknown }) {
        const key = args.where as { organizationId_scope: { organizationId: string; scope: string } };
        const found = identityPolicy.find(
          (row) => row.organizationId === key.organizationId_scope.organizationId && row.scope === key.organizationId_scope.scope,
        );
        if (found) {
          Object.assign(found, args.update as Partial<PolicyRow>);
          return found;
        }
        identityPolicy.push({ ...(args.create as PolicyRow) });
        return args.create;
      },
    },
    session: {
      async findMany(args: unknown) {
        const where = (args as { where: Where }).where;
        return session.filter((row) => matches(asRecord(row), where));
      },
      async findFirst(args: unknown) {
        const where = (args as { where: Where }).where;
        return session.find((row) => matches(asRecord(row), where)) ?? null;
      },
      async create(args: { data: unknown }) {
        session.push({ ...(args.data as SessionRow) });
        return args.data;
      },
      async update(args: { where: unknown; data: unknown }) {
        const id = (args.where as { id: string }).id;
        const row = session.find((entry) => entry.id === id);
        if (row) Object.assign(row, args.data as Partial<SessionRow>);
        return row ?? null;
      },
    },
    auditEvent: {
      async findMany(args: unknown) {
        const where = (args as { where: Where }).where;
        return auditEvent.filter((row) => matches(asRecord(row), where)).sort((a, b) => a.seq - b.seq);
      },
      async create(args: { data: unknown }) {
        auditEvent.push({ ...(args.data as AuditEventRow) });
        return args.data;
      },
    },
  };
}

let harnessSeq = 0;

/** A full stack over the fake client, with a clock the tests move by hand. */
function harness() {
  const db = fakePrisma();
  let clock = Date.parse("2026-09-28T09:00:00.000Z");
  let n = 0;
  const scope = `p${++harnessSeq}`;
  const services: IdentityServices = createIdentityServices(
    db,
    { id: () => `${scope}-id-${++n}`, now: () => new Date(clock).toISOString(), nowMs: () => clock },
    sha256,
  );
  return {
    ...services,
    db,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

/** Bootstrap one more organization inside an existing stack (one database). */
async function bootstrap(h: ReturnType<typeof harness>, slug: string) {
  const created = await h.service.bootstrapOrganization("founder-1", { name: `${slug} MSP`, slug }, {
    identifier: `admin@${slug}.test`,
    displayName: `Ada ${slug}`,
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const admin: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };
  return { org: created.value.organization, admin };
}

/** A bootstrapped organization with an admin, which most tests start from. */
async function withOrg(slug = "acme") {
  const h = harness();
  const { org, admin } = await bootstrap(h, slug);
  return { ...h, org, admin };
}

/* -------------------------------------------------------------------------- */
/*  The rows                                                                  */
/* -------------------------------------------------------------------------- */

test("bootstrapping writes the organization, its admin and both evidence rows", async () => {
  const { db, org } = await withOrg();

  assert.equal(db.rows.organization.length, 1);
  assert.equal(db.rows.identity.length, 1);
  assert.equal(db.rows.organization[0].slug, "acme");
  // The audit rows are real rows, not a log in the process.
  assert.deepEqual(
    db.rows.auditEvent.map((row) => row.action),
    ["organization.create", "identity.create"],
  );
  assert.ok(db.rows.auditEvent.every((row) => row.organizationId === org.id));
});

test("an identity round-trips through the columns, including its MFA state", async () => {
  const h = await withOrg();
  await h.service.setMfaEnrolled(h.admin, h.admin.id, true);

  const back = await h.store.findIdentity(h.org.id, h.admin.id);

  assert.equal(back?.mfaEnrolled, true, "the column is read, not recomputed from the factors");
  assert.equal(back?.kind, "HUMAN");
  assert.equal(back?.role, "ADMIN");
  assert.equal(back?.active, true);
  assert.equal(back?.createdAt, "2026-09-28T09:00:00.000Z", "timestamps come back as ISO strings");
});

test("a session's clocks survive the trip through DateTime", async () => {
  const h = await withOrg();
  await h.service.setMfaEnrolled(h.admin, h.admin.id, true);
  const granted = await h.service.issueSession(h.org.id, h.admin.id, { ipAddress: "203.0.113.9" });
  assert.equal(granted.ok, true);
  if (!granted.ok) return;

  const row = h.db.rows.session[0];
  assert.equal(row.expiresAt.getTime() - row.issuedAt.getTime(), DEFAULT_IDENTITY_POLICY.maxSessionSeconds * 1000);
  assert.equal(row.ipAddress, "203.0.113.9");

  const back = await h.store.findSession(h.org.id, granted.value.id);
  assert.equal(back?.issuedAt, Date.parse("2026-09-28T09:00:00.000Z"));
  assert.equal(back?.expiresAt, back!.issuedAt + DEFAULT_IDENTITY_POLICY.maxSessionSeconds * 1000);
  assert.equal(back?.revokedAt, null);

  // Revoking stores a moment, and it comes back as one.
  await h.service.revokeSession(h.admin, granted.value.id, "user signed out");
  h.advance(60);
  const revoked = await h.store.findSession(h.org.id, granted.value.id);
  assert.equal(typeof revoked?.revokedAt, "number");
});

test("an identifier search is case-insensitive inside one organization only", async () => {
  // Both organizations live in one database — which is the point: isolation is
  // a property of the queries, not of two stores that cannot see each other.
  const h = harness();
  const acme = await bootstrap(h, "acme");
  const beacon = await bootstrap(h, "beacon");

  assert.equal((await h.store.findIdentityByIdentifier(acme.org.id, "ADMIN@acme.test"))?.id, acme.admin.id);
  // Beacon has its own admin, and acme's address is not in its directory.
  assert.equal(await h.store.findIdentityByIdentifier(beacon.org.id, "admin@acme.test"), null);
});

test("another organization's identity is absent, not forbidden", async () => {
  const h = harness();
  const acme = await bootstrap(h, "acme");
  const beacon = await bootstrap(h, "beacon");

  assert.equal(await h.store.findIdentity(acme.org.id, beacon.admin.id), null);
  assert.equal((await h.store.findIdentity(beacon.org.id, beacon.admin.id))?.id, beacon.admin.id);
  assert.deepEqual(
    (await h.store.listIdentities(acme.org.id)).map((entry) => entry.organizationId),
    [acme.org.id],
  );
});

/* -------------------------------------------------------------------------- */
/*  The evidence chain                                                        */
/* -------------------------------------------------------------------------- */

test("each organization's chain numbers from 1, because (organizationId, seq) is the key", async () => {
  const h = harness();
  const acme = await bootstrap(h, "acme");
  const beacon = await bootstrap(h, "beacon");

  const acmeSeq = h.db.rows.auditEvent.filter((row) => row.organizationId === acme.org.id).map((row) => row.seq);
  const beaconSeq = h.db.rows.auditEvent.filter((row) => row.organizationId === beacon.org.id).map((row) => row.seq);

  assert.deepEqual(acmeSeq, [1, 2]);
  assert.deepEqual(beaconSeq, [1, 2], "a second tenant's chain is its own, not a slice of a global counter");
  // Which is also why the uniqueness is on the pair: `seq` alone would collide.
  assert.equal(h.db.rows.auditEvent.filter((row) => row.seq === 1).length, 2);
});

test("the trail reads back what is stored, and verifies", async () => {
  const h = await withOrg();
  await h.service.createIdentity(h.admin, { identifier: "agent@acme.test", displayName: "Agent", role: "AGENT" });

  const events = await h.audit.trail(h.org.id);

  assert.deepEqual(events.map((event) => event.action), ["organization.create", "identity.create", "identity.create"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(await h.audit.verify(h.org.id), { ok: true, length: 3 });
  assert.deepEqual(await h.audit.verify("org-never-seen"), { ok: true, length: 0 });
});

test("history cannot be rewritten by mutating what the trail handed out", async () => {
  const h = await withOrg();

  const handed = (await h.audit.trail(h.org.id)) as unknown as { actor: string }[];
  handed[0].actor = "somebody-else";

  assert.equal((await h.audit.trail(h.org.id))[0].actor, "founder-1");
  assert.equal(h.db.rows.auditEvent[0].actor, "founder-1");
});

test("a tampered row is reported broken, and a fresh process refuses to extend it", async () => {
  const h = await withOrg();
  // Somebody with database access edits yesterday's evidence.
  h.db.rows.auditEvent[0].recordHash = sha256("not-the-real-hash");

  assert.deepEqual(await h.audit.verify(h.org.id), {
    ok: false,
    brokenAt: 1,
    reason: "record hash does not match its contents (tampered)",
  });

  // `verify` re-reads the rows, so the tampering is caught even in the process
  // that cached the chain. Appending is the other half: a chain is loaded and
  // verified on first use, so a restarted process refuses to build on damage
  // rather than entrenching it.
  const cold = new PrismaOrganizationAuditTrail(h.db, sha256);
  await assert.rejects(
    () =>
      cold.append({
        id: "e-x",
        at: "2026-09-28T10:00:00.000Z",
        actor: "founder-1",
        action: "identity.create",
        detail: { organizationId: h.org.id },
      }) as Promise<unknown>,
    /failed verification/,
  );

  // And the tampered row is still what is stored: a refusal does not "fix" it.
  assert.equal(h.db.rows.auditEvent[0].recordHash, sha256("not-the-real-hash"));
});

test("an event with no organization cannot be appended or turned into a row", async () => {
  const audit = new PrismaOrganizationAuditTrail(fakePrisma(), sha256);
  const event = { id: "e-1", at: "2026-09-28T09:00:00.000Z", actor: "founder-1", action: "identity.create" };

  assert.throws(() => organizationOf(event), /must name the organization/);
  await assert.rejects(() => audit.append(event) as Promise<unknown>, /must name the organization/);
});

test("a chain is appended to from where it stopped, not from the start", async () => {
  const h = await withOrg();
  const trail = new PrismaOrganizationAuditTrail(h.db, sha256);

  await trail.append({
    id: "e-1",
    at: "2026-09-28T10:00:00.000Z",
    actor: "founder-1",
    action: "session.grant",
    detail: { organizationId: h.org.id },
  });
  await trail.append({
    id: "e-2",
    at: "2026-09-28T10:01:00.000Z",
    actor: "founder-1",
    action: "session.revoke",
    detail: { organizationId: h.org.id },
  });

  const rows = h.db.rows.auditEvent.filter((row) => row.organizationId === h.org.id);
  assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4]);
  assert.equal(rows[3].prevHash, rows[2].recordHash, "each record commits to the one before it");
  assert.deepEqual(await trail.verify(h.org.id), { ok: true, length: 4 });
});

/* -------------------------------------------------------------------------- */
/*  The mappers on their own                                                  */
/* -------------------------------------------------------------------------- */

test("a null target is written as null and read back as absent", () => {
  const row = toAuditRow({
    id: "e-1",
    seq: 1,
    at: "2026-09-28T09:00:00.000Z",
    actor: "founder-1",
    action: "organization.create",
    detail: { organizationId: "org-1" },
    prevHash: "0".repeat(64),
    recordHash: "abc",
  });

  assert.equal(row.targetType, null);
  assert.equal(row.targetId, null);
  assert.ok(row.at instanceof Date);
});

test("the store is usable against a client that has only what it asks for", async () => {
  // `PrismaIdentityStore` is the same object the service gets; constructing it
  // by hand is what a later repository layer or a test double would do.
  const store = new PrismaIdentityStore(fakePrisma());
  assert.equal(await store.findOrganization("nobody"), null);
  assert.deepEqual(await store.listIdentities("nobody"), []);
  assert.deepEqual(await store.listSessions("nobody"), []);
});
