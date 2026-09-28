/**
 * OnTrak Tix M2 tests: the identity/IdP slice.
 *
 * Covers the pure rules — connection validation, domain and MFA enforcement,
 * claim→role mapping and the SCIM provisioning plan — the service's sign-in and
 * SCIM flows (including their audit trail), and the Prisma adapter's narrowing.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-identity.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  assertedMfa,
  authorizeSignIn,
  emailDomain,
  isDomainAllowed,
  mapRole,
  planScimProvision,
  scimRole,
  validateIdentityConnection,
  type IdentityClaims,
  type IdentityConnection,
} from "../src/lib/identity-rules";
import {
  IdentityService,
  MemoryIdentityStore,
  type IdentityStore,
} from "../src/lib/identity-service";
import {
  PrismaIdentityStore,
  toConnectionData,
  toConnectionRecord,
  toIdentityUserData,
  toIdentityUserRecord,
  toRoleMappings,
  type IdentityConnectionRow,
  type IdentityPrismaClient,
  type IdentityUserRow,
} from "../src/lib/identity-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };

function connection(overrides: Partial<IdentityConnection> = {}): IdentityConnection {
  return {
    id: "conn-1",
    tenantId: "tenant-a",
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "ontrak-tix",
    scopes: ["openid", "email", "profile", "groups"],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [
      { value: "helpdesk", role: "AGENT" },
      { claim: "roles", value: "it-leads", role: "DISPATCHER" },
    ],
    mfaRequired: false,
    scimEnabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function claims(overrides: Partial<IdentityClaims> = {}): IdentityClaims {
  return {
    issuer: "https://idp.acme.test",
    subject: "idp-user-1",
    email: "sam@acme.test",
    name: "Sam Patel",
    groups: ["helpdesk"],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ config */

test("a connection is validated before it is stored", () => {
  assert.deepEqual(validateIdentityConnection({ protocol: "OIDC", issuer: "https://idp.acme.test", clientId: "x", defaultRole: "AGENT" }), []);
  assert.match(validateIdentityConnection({ protocol: "LDAP" as never, issuer: "x", clientId: "y" }).join(" "), /Unknown identity protocol/);
  assert.match(validateIdentityConnection({ issuer: "not a url", clientId: "y" }).join(" "), /absolute http/);
  assert.match(validateIdentityConnection({ issuer: "https://x.test" }).join(" "), /client id/);
  assert.match(validateIdentityConnection({ issuer: "https://x.test", clientId: "y", allowedDomains: ["nope"] }).join(" "), /not a valid email domain/);
  assert.match(
    validateIdentityConnection({ issuer: "https://x.test", clientId: "y", roleMappings: [{ value: "", role: "AGENT" }] }).join(" "),
    /needs a claim value/,
  );
});

/* -------------------------------------------------------------- enforcement */

test("domain and MFA are enforced on the claims", () => {
  assert.equal(emailDomain("Sam@Acme.Test"), "acme.test");
  assert.equal(isDomainAllowed(connection(), "sam@acme.test"), true);
  assert.equal(isDomainAllowed(connection(), "sam@evil.test"), false);
  assert.equal(isDomainAllowed(connection({ allowedDomains: [] }), "sam@anything.test"), true);

  assert.equal(assertedMfa({ issuer: "", subject: "", email: "", amr: ["pwd", "otp"] }), true);
  assert.equal(assertedMfa({ issuer: "", subject: "", email: "", amr: ["pwd"] }), false);
  assert.equal(assertedMfa({ issuer: "", subject: "", email: "", amr: ["pwd"], mfa: true }), true);
});

test("sign-in is refused for the wrong issuer, domain or a missing factor", () => {
  const wrongIssuer = authorizeSignIn(connection(), claims({ issuer: "https://other.test" }));
  assert.equal(wrongIssuer.ok, false);
  if (!wrongIssuer.ok) assert.match(wrongIssuer.reason, /not issued by this tenant/);

  const noEmail = authorizeSignIn(connection(), claims({ email: "" }));
  assert.equal(noEmail.ok, false);

  const badDomain = authorizeSignIn(connection(), claims({ email: "sam@evil.test" }));
  assert.equal(badDomain.ok, false);
  if (!badDomain.ok) assert.match(badDomain.reason, /not an allowed sign-in domain/);

  const needsMfa = authorizeSignIn(connection({ mfaRequired: true }), claims({ amr: ["pwd"] }));
  assert.equal(needsMfa.ok, false);
  if (!needsMfa.ok) assert.match(needsMfa.reason, /multi-factor/);

  assert.equal(authorizeSignIn(connection({ mfaRequired: true }), claims({ amr: ["pwd", "webauthn"] })).ok, true);
});

/* ------------------------------------------------------------- role mapping */

test("group claims map to roles, with a default fallback", () => {
  assert.equal(mapRole(connection(), claims({ groups: ["helpdesk"] })), "AGENT");
  assert.equal(mapRole(connection(), claims({ groups: ["HELPDESK"] })), "AGENT"); // case-insensitive
  assert.equal(mapRole(connection(), claims({ groups: ["it-leads"] })), "REQUESTER"); // wrong claim name
  assert.equal(mapRole(connection(), claims({ groups: [], claims: { roles: ["it-leads"] } })), "DISPATCHER");
  assert.equal(mapRole(connection(), claims({ groups: ["unmapped"] })), "REQUESTER");

  const authorized = authorizeSignIn(connection(), claims({ groups: ["helpdesk"] }));
  assert.equal(authorized.ok, true);
  if (authorized.ok) {
    assert.equal(authorized.role, "AGENT");
    assert.equal(authorized.mapped, true);
    assert.equal(authorized.email, "sam@acme.test");
  }
});

/* -------------------------------------------------------------------- SCIM */

test("a SCIM push plans one create, update, deactivate or no-op", () => {
  // SCIM supplies groups, so the connections it drives map on the group claim.
  const conn = connection({
    roleMappings: [
      { value: "helpdesk", role: "AGENT" },
      { value: "it-leads", role: "DISPATCHER" },
    ],
  });
  const created = planScimProvision(conn, { externalId: "idp-9", userName: "Jo@Acme.Test", displayName: "Jo", active: true, groups: ["helpdesk"] }, null);
  assert.equal(created.action, "CREATE");
  assert.equal(created.email, "jo@acme.test");
  assert.equal(created.role, "AGENT");

  const target = { id: "u1", externalId: "idp-9", email: "jo@acme.test", displayName: "Jo", role: "AGENT" as const, active: true };
  assert.equal(
    planScimProvision(conn, { externalId: "idp-9", userName: "jo@acme.test", displayName: "Jo", active: true, groups: ["helpdesk"] }, target).action,
    "NOOP",
  );
  // A push that names no groups falls back to the default role, so it is a change.
  assert.equal(planScimProvision(conn, { externalId: "idp-9", userName: "jo@acme.test", displayName: "Jo", active: true }, target).role, "REQUESTER");

  const promoted = planScimProvision(conn, { externalId: "idp-9", userName: "jo@acme.test", displayName: "Jo", active: true, groups: ["it-leads"] }, target);
  assert.equal(promoted.action, "UPDATE");
  assert.equal(promoted.role, "DISPATCHER");

  // A deactivation wins over everything, and repeating it is a no-op.
  const off = planScimProvision(conn, { externalId: "idp-9", userName: "jo@acme.test", active: false }, target);
  assert.equal(off.action, "DEACTIVATE");
  assert.equal(planScimProvision(conn, { externalId: "idp-9", userName: "jo@acme.test", active: false }, { ...target, active: false }).action, "NOOP");

  assert.equal(scimRole(conn, ["helpdesk"]), "AGENT");
  assert.equal(scimRole(conn, undefined), "REQUESTER");
});

/* ----------------------------------------------------------------- service */

function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryIdentityStore();
  const service = new IdentityService(store, audit);
  return { audit, store, service };
}

function actions(audit: AuditLog): string[] {
  return audit.snapshot().events.map((entry) => entry.action);
}

test("an administrator configures the connection, and it is audited", async () => {
  const h = harness();
  const result = await h.service.configure(ADMIN, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "ontrak-tix",
    scopes: ["openid", "groups"],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [{ value: "helpdesk", role: "AGENT" }],
    mfaRequired: true,
    scimEnabled: true,
  });
  assert.equal(result.ok, true);
  assert.equal((await h.service.connectionFor("tenant-a"))?.issuer, "https://idp.acme.test");
  assert.deepEqual(actions(h.audit), ["identity.connection.configure"]);

  // A requester cannot configure identity.
  const denied = await h.service.configure({ id: "r1", tenantId: "tenant-a", role: "REQUESTER" }, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "x",
    scopes: [],
    allowedDomains: [],
    defaultRole: "REQUESTER",
    roleMappings: [],
    mfaRequired: false,
    scimEnabled: false,
  });
  assert.equal(denied.ok, false);
});

test("a first sign-in provisions the user and maps the role", async () => {
  const h = harness();
  await h.service.configure(ADMIN, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "ontrak-tix",
    scopes: [],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [
      { value: "helpdesk", role: "AGENT" },
      { claim: "roles", value: "it-leads", role: "DISPATCHER" },
    ],
    mfaRequired: false,
    scimEnabled: false,
  });

  const first = await h.service.signIn("tenant-a", claims({ groups: ["helpdesk"] }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.provisioned, true);
  assert.equal(first.value.actor.role, "AGENT");
  assert.equal(first.value.user.externalId, "idp-user-1");
  assert.equal(first.value.user.email, "sam@acme.test");

  // A second sign-in finds the same user, and a group change moves the role.
  const second = await h.service.signIn("tenant-a", claims({ groups: ["it-leads"], claims: { roles: ["it-leads"] } }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.provisioned, false);
  assert.equal(second.value.user.id, first.value.user.id);
  assert.equal(second.value.actor.role, "DISPATCHER");

  assert.equal(h.store.all("tenant-a").length, 1);
  assert.equal(actions(h.audit).filter((action) => action === "identity.signin").length, 2);
  assert.equal(actions(h.audit).filter((action) => action === "identity.role.change").length, 1);
});

test("a refused sign-in is audited and returns no user", async () => {
  const h = harness();
  await h.service.configure(ADMIN, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "ontrak-tix",
    scopes: [],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [],
    mfaRequired: true,
    scimEnabled: false,
  });

  const refused = await h.service.signIn("tenant-a", claims({ email: "sam@evil.test" }));
  assert.equal(refused.ok, false);
  assert.equal(h.store.all("tenant-a").length, 0);
  assert.deepEqual(actions(h.audit).slice(-1), ["identity.signin.denied"]);

  const noConnection = await h.service.signIn("tenant-z", claims());
  assert.equal(noConnection.ok, false);
});

test("SCIM provisions, updates and deprovisions through the same user record", async () => {
  const h = harness();
  await h.service.configure(ADMIN, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "ontrak-tix",
    scopes: [],
    allowedDomains: ["acme.test"],
    defaultRole: "REQUESTER",
    roleMappings: [{ value: "helpdesk", role: "AGENT" }],
    mfaRequired: false,
    scimEnabled: true,
  });

  const created = await h.service.provision("tenant-a", { externalId: "idp-9", userName: "jo@acme.test", displayName: "Jo", active: true, groups: ["helpdesk"] });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.plan.action, "CREATE");
  assert.equal(created.value.user?.role, "AGENT");

  const updated = await h.service.provision("tenant-a", { externalId: "idp-9", userName: "jo@acme.test", displayName: "Jo Quinn", active: true, groups: ["helpdesk"] });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.value.plan.action, "UPDATE");
  assert.equal(updated.value.user?.displayName, "Jo Quinn");

  const off = await h.service.provision("tenant-a", { externalId: "idp-9", userName: "jo@acme.test", active: false });
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.equal(off.value.plan.action, "DEACTIVATE");
  assert.equal(off.value.user?.active, false);

  const audited = actions(h.audit);
  assert.equal(audited.filter((action) => action === "identity.scim.provision").length, 2);
  assert.equal(audited.filter((action) => action === "identity.scim.deprovision").length, 1);
});

test("SCIM is refused when the connection has it disabled or absent", async () => {
  const h = harness();
  assert.equal((await h.service.provision("tenant-a", { externalId: "x", userName: "x@acme.test", active: true })).ok, false);

  await h.service.configure(ADMIN, {
    protocol: "OIDC",
    issuer: "https://idp.acme.test",
    clientId: "x",
    scopes: [],
    allowedDomains: [],
    defaultRole: "REQUESTER",
    roleMappings: [],
    mfaRequired: false,
    scimEnabled: false,
  });
  const disabled = await h.service.provision("tenant-a", { externalId: "x", userName: "x@acme.test", active: true });
  assert.equal(disabled.ok, false);
});

/* --------------------------------------------------------- prisma adapter */

const connectionRow: IdentityConnectionRow = {
  id: "conn-1",
  tenantId: "tenant-a",
  protocol: "OIDC",
  issuer: "https://idp.acme.test",
  clientId: "ontrak-tix",
  scopes: ["openid"],
  allowedDomains: ["acme.test"],
  defaultRole: "REQUESTER",
  roleMappings: [
    { value: "helpdesk", role: "AGENT" },
    { value: "junk", role: "NOT_A_ROLE" },
    { value: "", role: "AGENT" },
    "nonsense",
    { value: "leads", role: "DISPATCHER", claim: "roles" },
  ],
  mfaRequired: true,
  scimEnabled: true,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-02T00:00:00Z"),
};

const userRow: IdentityUserRow = {
  id: "u1",
  tenantId: "tenant-a",
  email: "sam@acme.test",
  displayName: "Sam",
  role: "AGENT",
  active: true,
  externalId: "idp-1",
};

test("the connection mapper narrows JSON and enum-like columns", () => {
  const record = toConnectionRecord(connectionRow);
  assert.equal(record.protocol, "OIDC");
  assert.deepEqual(record.roleMappings, [
    { value: "helpdesk", role: "AGENT" },
    { value: "leads", role: "DISPATCHER", claim: "roles" },
  ]);
  assert.equal(record.updatedAt, "2026-09-02T00:00:00.000Z");

  assert.deepEqual(toRoleMappings("not an array"), []);
  assert.equal(toConnectionRecord({ ...connectionRow, protocol: "WAT", defaultRole: "???" }).protocol, "OIDC");
  assert.equal(toConnectionRecord({ ...connectionRow, protocol: "WAT", defaultRole: "???" }).defaultRole, "REQUESTER");
  assert.ok(toConnectionData(record).roleMappings instanceof Array);
});

test("the user mapper narrows the role and round-trips", () => {
  const user = toIdentityUserRecord(userRow);
  assert.equal(user.role, "AGENT");
  assert.equal(user.externalId, "idp-1");
  assert.equal(toIdentityUserRecord({ ...userRow, role: "WAT" }).role, "REQUESTER");
  assert.equal((toIdentityUserData(user) as Record<string, unknown>).externalId, "idp-1");
});

test("the Prisma identity store reads, upserts and looks users up", async () => {
  const created: unknown[] = [];
  let upserted: unknown = null;
  const client: IdentityPrismaClient = {
    identityConnection: {
      findUnique: async (args) => ((args as { where: { tenantId: string } }).where.tenantId === "tenant-a" ? connectionRow : null),
      upsert: async (args) => {
        upserted = args;
        return {};
      },
    },
    user: {
      findFirst: async (args) => {
        const where = (args as { where: Record<string, unknown> }).where;
        return where.externalId === "idp-1" || where.email === "sam@acme.test" ? userRow : null;
      },
      create: async (args) => {
        created.push(args.data);
        return {};
      },
      update: async () => undefined,
    },
  };
  const store: IdentityStore = new PrismaIdentityStore(client);

  assert.equal((await store.findConnection("tenant-a"))?.issuer, "https://idp.acme.test");
  assert.equal(await store.findConnection("tenant-z"), null);
  await store.saveConnection(toConnectionRecord(connectionRow));
  assert.ok(upserted);

  assert.equal((await store.findUserByExternalId("tenant-a", "idp-1"))?.id, "u1");
  assert.equal((await store.findUserByEmail("tenant-a", "SAM@acme.test"))?.id, "u1");
  await store.createUser(toIdentityUserRecord(userRow));
  assert.equal(created.length, 1);
});
