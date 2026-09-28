/**
 * OnTrak Sentinel S0 tests: the identity spine.
 *
 * S0 exists to get two things right before any feature depends on them, so this
 * covers exactly those: the **isolation boundary** (nothing crosses an
 * organization, including by id) and the **evidence log** (every privileged
 * action is recorded, the chain verifies, and one organization's history is not
 * another's).
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { DEFAULT_IDENTITY_POLICY } from "../src/lib/identity-rules";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");

/**
 * Identifiers are unique per harness, not per store. Two stores that both minted
 * `id-1` would let an isolation test pass by finding the *other* organization's
 * row — the opposite of what it is checking.
 */
let harnessSeq = 0;

/** A clock the tests move by hand, so session timeouts are not a matter of waiting. */
function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const store = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-21T09:00:00.000Z");
  let n = 0;
  const scope = `h${++harnessSeq}`;
  const ids = {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const service = new IdentityService(store, audit, ids);
  return {
    service,
    store,
    audit,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

/** A bootstrapped organization with an admin, which most tests start from. */
async function withOrg(slug = "acme") {
  const h = harness();
  const created = await h.service.bootstrapOrganization("founder-1", { name: "Acme MSP", slug }, {
    identifier: `admin@${slug}.test`,
    displayName: "Ada Admin",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const admin: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };
  return { ...h, org: created.value.organization, admin, adminRecord: created.value.admin };
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                 */
/* -------------------------------------------------------------------------- */

test("creating an organization also creates its first administrator, and records both", async () => {
  const { service, audit, admin } = await withOrg();
  const trail = await service.auditTrail(admin);
  assert.equal(trail.ok, true);
  if (!trail.ok) return;

  assert.deepEqual(
    trail.value.events.map((event) => event.action),
    ["organization.create", "identity.create"],
  );
  assert.equal(trail.value.verification.ok, true);
  assert.equal(trail.value.events[0].seq, 1, "the chain starts at 1 and does not skip");
});

test("a slug is trimmed, and has to be usable in a URL", async () => {
  const h = harness();
  const created = await h.service.bootstrapOrganization(
    "founder-1",
    { name: "Acme", slug: "  acme-msp  " },
    { identifier: "admin@acme.test", displayName: "Ada" },
  );
  assert.equal(created.ok && created.value.organization.slug, "acme-msp");

  for (const slug of ["Not A Slug", "Acme-MSP", "-leading"]) {
    const bad = await h.service.bootstrapOrganization("founder-1", { name: "Acme", slug }, { identifier: "a@b.test", displayName: "A" });
    assert.equal(bad.ok, false, `“${slug}” should be refused`);
    assert.match(bad.ok === false ? bad.error : "", /lower-case letters/);
  }
});

test("two organizations cannot share a slug", async () => {
  const { service } = await withOrg("acme");
  const clash = await service.bootstrapOrganization("founder-2", { name: "Other", slug: "acme" }, { identifier: "a@b.test", displayName: "A" });
  assert.equal(clash.ok, false);
  assert.match(clash.ok === false ? clash.error : "", /already exists/);
});

test("a human's identifier has to be an address mail could reach", async () => {
  const { service, admin } = await withOrg();
  const bad = await service.createIdentity(admin, { identifier: "not-an-address", displayName: "N" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.error : "", /not an address/);

  // A service is named, not emailed, so the same shape is fine for one.
  const serviceIdentity = await service.createIdentity(admin, {
    identifier: "guard-sensor-01",
    displayName: "Guard sensor 01",
    kind: "SERVICE",
    role: "SERVICE",
  });
  assert.equal(serviceIdentity.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Who may change the directory                                              */
/* -------------------------------------------------------------------------- */

test("only an administrator may create or switch off an identity", async () => {
  const { service, admin } = await withOrg();
  const agent = await service.createIdentity(admin, { identifier: "agent@acme.test", displayName: "Agent", role: "AGENT" });
  assert.equal(agent.ok, true);
  if (!agent.ok) return;

  const asAgent: IdentityActor = { id: agent.value.id, organizationId: admin.organizationId, role: "AGENT" };
  const attempted = await service.createIdentity(asAgent, { identifier: "x@acme.test", displayName: "X" });
  assert.equal(attempted.ok, false);
  assert.match(attempted.ok === false ? attempted.error : "", /do not administer/);

  assert.equal((await service.setActive(asAgent, admin.id, false)).ok, false);
  // An auditor may read the directory but not change it.
  const auditor: IdentityActor = { id: "auditor-1", organizationId: admin.organizationId, role: "AUDITOR" };
  assert.equal((await service.listIdentities(auditor)).ok, true);
  assert.equal((await service.createIdentity(auditor, { identifier: "y@acme.test", displayName: "Y" })).ok, false);
});

test("an organization may not be left without an active administrator", async () => {
  const { service, admin } = await withOrg();
  const refused = await service.setActive(admin, admin.id, false);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /only active administrator/);

  // With a second admin, the first one may stand down.
  const second = await service.createIdentity(admin, { identifier: "admin2@acme.test", displayName: "Second", role: "ADMIN" });
  assert.equal(second.ok, true);
  assert.equal((await service.setActive(admin, admin.id, false)).ok, true);
});

test("an identifier is unique within an organization, but not across them", async () => {
  const first = await withOrg("acme");
  const dup = await first.service.createIdentity(first.admin, { identifier: "Admin@ACME.test", displayName: "Dupe" });
  assert.equal(dup.ok, false, "the same address in different case is the same identity");
  assert.match(dup.ok === false ? dup.error : "", /already an identity/);

  // A different organization may absolutely have the same address.
  const other = harness();
  const made = await other.service.bootstrapOrganization("founder-2", { name: "Beacon", slug: "beacon" }, {
    identifier: "admin@acme.test",
    displayName: "Someone Else",
  });
  assert.equal(made.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Isolation                                                                 */
/* -------------------------------------------------------------------------- */

test("another organization's identity is not forbidden, it is absent", async () => {
  const acme = await withOrg("acme");
  const beacon = harness();
  const made = await beacon.service.bootstrapOrganization("founder-2", { name: "Beacon", slug: "beacon" }, {
    identifier: "admin@beacon.test",
    displayName: "Bea",
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const beaconAdmin: IdentityActor = { id: made.value.admin.id, organizationId: made.value.organization.id, role: "ADMIN" };

  assert.equal((await acme.service.identity(acme.admin, beaconAdmin.id)).ok, false);
  assert.equal((await beacon.service.identity(beaconAdmin, acme.admin.id)).ok, false);

  // And a mutation aimed across the boundary changes nothing.
  assert.equal((await acme.service.setActive(acme.admin, beaconAdmin.id, false)).ok, false);
  assert.equal((await beacon.service.identity(beaconAdmin, beaconAdmin.id)).ok, true);
});

test("one organization's history is not another's, and each chain verifies on its own", async () => {
  const acme = await withOrg("acme");

  const beacon = harness();
  const made = await beacon.service.bootstrapOrganization("founder-2", { name: "Beacon", slug: "beacon" }, {
    identifier: "admin@beacon.test",
    displayName: "Bea",
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;

  await acme.service.createIdentity(acme.admin, { identifier: "a2@acme.test", displayName: "Second" });

  const acmeTrail = await acme.service.auditTrail(acme.admin);
  assert.equal(acmeTrail.ok, true);
  if (!acmeTrail.ok) return;

  assert.equal(acmeTrail.value.events.length, 3, "org create, admin create, second identity");
  assert.ok(acmeTrail.value.events.every((event) => (event.detail as { organizationId: string }).organizationId === acme.org.id));
  assert.equal(acmeTrail.value.verification.ok, true);

  // Beacon's chain is a different object: it holds its own events and none of
  // acme's, so a logged-in tenant cannot read across the boundary at all.
  assert.equal(beacon.audit.trail(acme.org.id).length, 0);
  assert.equal(beacon.audit.trail(made.value.organization.id).length, 2);
  assert.equal(beacon.audit.verify(made.value.organization.id).ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Sessions and policy                                                       */
/* -------------------------------------------------------------------------- */

test("the policy decides whether a session is granted at all", async () => {
  const { service, admin, org } = await withOrg();

  // Default policy requires MFA, and a fresh identity has not enrolled.
  const refused = await service.issueSession(org.id, admin.id);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /MFA is required/);

  await service.setMfaEnrolled(admin, admin.id, true);
  const granted = await service.issueSession(org.id, admin.id, { ipAddress: "203.0.113.9" });
  assert.equal(granted.ok, true);
  if (!granted.ok) return;

  assert.equal(granted.value.expiresAt - granted.value.issuedAt, DEFAULT_IDENTITY_POLICY.maxSessionSeconds * 1000);
  const decision = await service.checkSession(org.id, granted.value.id);
  assert.deepEqual(decision, { active: true });
});

test("a deactivated identity loses its sessions without anyone revoking them", async () => {
  const { service, admin, org } = await withOrg();
  await service.setMfaEnrolled(admin, admin.id, true);
  const session = await service.issueSession(org.id, admin.id);
  assert.equal(session.ok, true);
  if (!session.ok) return;

  // A second admin so the first may stand down.
  await service.createIdentity(admin, { identifier: "admin2@acme.test", displayName: "Second", role: "ADMIN" });
  await service.setActive(admin, admin.id, false);

  const decision = await service.checkSession(org.id, session.value.id);
  assert.deepEqual(decision, { active: false, reason: "identity is deactivated" });
});

test("sessions expire on age and on idleness, and touching moves the idle clock", async () => {
  const { service, admin, org, advance } = await withOrg();
  await service.setMfaEnrolled(admin, admin.id, true);
  const session = await service.issueSession(org.id, admin.id);
  assert.equal(session.ok, true);
  if (!session.ok) return;

  // Idle past the timeout.
  advance(DEFAULT_IDENTITY_POLICY.idleTimeoutSeconds + 1);
  assert.equal((await service.checkSession(org.id, session.value.id)).active, false);

  // Touching it before the timeout keeps it alive.
  advance(-(DEFAULT_IDENTITY_POLICY.idleTimeoutSeconds + 1));
  advance(DEFAULT_IDENTITY_POLICY.idleTimeoutSeconds - 1);
  const touched = await service.touchSession(org.id, session.value.id);
  assert.equal(touched.ok, true);

  // But nothing outlives the absolute lifetime.
  advance(DEFAULT_IDENTITY_POLICY.maxSessionSeconds);
  const decision = await service.checkSession(org.id, session.value.id);
  assert.deepEqual(decision, { active: false, reason: "session exceeded its maximum lifetime" });
});

test("ending a session needs a reason, and says how many it ended", async () => {
  const { service, admin, org } = await withOrg();
  await service.setMfaEnrolled(admin, admin.id, true);
  await service.issueSession(org.id, admin.id, { userAgent: "one" });
  await service.issueSession(org.id, admin.id, { userAgent: "two" });

  const first = (await service.listSessions(admin, admin.id)).ok
    ? (await service.listSessions(admin, admin.id))
    : null;
  assert.equal(first?.ok, true);
  if (!first || !first.ok) return;

  assert.equal((await service.revokeSession(admin, first.value[0].id, "  ")).ok, false);

  const all = await service.revokeAllForIdentity(admin, admin.id, "leaver: left the company");
  assert.equal(all.ok, true);
  assert.equal(all.ok && all.value.revoked, 2);

  // Running it again ends nothing, and 0 is a real answer.
  const again = await service.revokeAllForIdentity(admin, admin.id, "leaver: left the company");
  assert.equal(again.ok && again.value.revoked, 0);
});

test("a session that does not exist is refused rather than treated as valid", async () => {
  const { service, org } = await withOrg();
  assert.deepEqual(await service.checkSession(org.id, "no-such-session"), {
    active: false,
    reason: "session does not exist",
  });
});

/* -------------------------------------------------------------------------- */
/*  The chain itself                                                          */
/* -------------------------------------------------------------------------- */

test("an event with no organization cannot be appended at all", () => {
  const audit = new OrganizationAuditLog(sha256);
  assert.throws(
    () => audit.append({ id: "e-1", at: "2026-09-21T09:00:00.000Z", actor: "someone", action: "identity.create" }),
    /must name the organization/,
  );
});

test("an appended pair verifies, and each organization's head is its own", () => {
  const audit = new OrganizationAuditLog(sha256);
  const event = (id: string, organizationId: string, action = "identity.create") => ({
    id,
    at: "2026-09-21T09:00:00.000Z",
    actor: "founder-1",
    action,
    detail: { organizationId },
  });

  audit.append(event("e-1", "org-1"));
  audit.append(event("e-2", "org-1", "session.grant"));
  audit.append(event("e-3", "org-2"));

  assert.deepEqual(audit.verify("org-1"), { ok: true, length: 2 });
  assert.deepEqual(audit.verify("org-2"), { ok: true, length: 1 });
  assert.notEqual(audit.head("org-1"), audit.head("org-2"), "one chain's head is not the other's");
  assert.deepEqual(
    audit.trail("org-1").map((entry) => entry.seq),
    [1, 2],
    "each chain numbers from 1, because it is a chain and not a slice",
  );
});

test("a caller cannot rewrite history by mutating what it was handed", () => {
  const audit = new OrganizationAuditLog(sha256);
  audit.append({
    id: "e-1",
    at: "2026-09-21T09:00:00.000Z",
    actor: "founder-1",
    action: "identity.create",
    detail: { organizationId: "org-1" },
  });

  // Someone holding a reference, not a write. `trail` hands out a copy, so this
  // is a no-op — which is the point: history is not editable by accident.
  const handed = audit.trail("org-1") as unknown as { actor: string }[];
  handed[0].actor = "somebody-else";

  assert.equal(audit.trail("org-1")[0].actor, "founder-1");
  assert.deepEqual(audit.verify("org-1"), { ok: true, length: 1 });
});

test("an organization with no history verifies as an empty chain, not an error", () => {
  const audit = new OrganizationAuditLog(sha256);
  assert.deepEqual(audit.verify("org-never-seen"), { ok: true, length: 0 });
});
