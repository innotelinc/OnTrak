/**
 * SCIM 2.0 directory sync: the rules and the service.
 *
 * The interesting half of provisioning is the refusals, because a half-implemented
 * filter or a silent no-op on a PATCH is a directory that disagrees with this one
 * forever without anybody being told. So most of these cases assert that a body the
 * server does not understand is *named* as such — `invalidFilter`, `invalidPath`,
 * `uniqueness`, `mutability` — rather than quietly accepted.
 *
 * Everything runs against `MemoryScimStore`, so no Postgres, no network, no
 * directory.
 *
 *   ./node_modules/.bin/tsx --tsconfig tests/tsconfig.json --test tests/scim.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Role } from "@prisma/client";

import {
  SCIM_PAGE_MAX,
  SCIM_PATHS,
  SCIM_USER_SCHEMA,
  parseScimFilter,
  parseScimPatch,
  parseScimQuery,
  parseScimUserReplace,
  roleFromScim,
  scimPage,
  scimUserInput,
  serviceProviderConfig,
  toScimUser,
  type ScimError,
} from "../src/lib/scim-rules";
import {
  MemoryScimStore,
  ScimService,
  type ScimAuditEvent,
  type ScimOutcome,
  type ScimUserRecord,
} from "../src/lib/scim-service";

const BASE = "https://training.example/api/scim/v2";

/** A parsed value, or a failed assertion naming the refusal. */
function expectOk<T>(value: T | ScimError): T {
  if ("status" in (value as object)) {
    assert.fail(`expected a value, got a refusal: ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** A service result's value, or a failed assertion naming the error. */
function expectValue<T>(outcome: ScimOutcome<T>): T {
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error.detail);
  return (outcome as { ok: true; value: T }).value;
}

/** A service result's error, asserted to be one. */
function expectError<T>(outcome: ScimOutcome<T>): ScimError {
  assert.ok(!outcome.ok, "expected a refusal and got a value");
  return (outcome as { ok: false; error: ScimError }).error;
}

/** A rules result's error, asserted to be one. */
function expectRefusal<T>(value: T | ScimError): ScimError {
  assert.ok("status" in (value as object), `expected a refusal, got ${JSON.stringify(value)}`);
  return value as ScimError;
}

interface Seed {
  users?: Partial<ScimUserRecord>[];
  cohorts?: { id?: string; name?: string; createdAt?: string; updatedAt?: string }[];
}

function harness(seed: Seed = {}) {
  const audit: ScimAuditEvent[] = [];
  const store = new MemoryScimStore(
    seed,
    () => `id-${Math.random().toString(36).slice(2, 8)}`,
    () => "2026-10-06T00:00:00.000Z",
  );
  const service = new ScimService(store, BASE, async (event) => {
    audit.push(event);
  });
  return { store, service, audit };
}

function ada(overrides: Partial<ScimUserRecord> = {}): Partial<ScimUserRecord> {
  return {
    id: "u-ada",
    email: "ada@acme.test",
    name: "Ada Lovelace",
    role: "STUDENT" as Role,
    active: true,
    externalId: "dir-1",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Filters                                                                   */
/* -------------------------------------------------------------------------- */

test("scim: the filter subset is eq on a declared attribute, and the rest is refused by name", () => {
  const userName = expectOk(parseScimFilter('userName eq "ada@acme.test"'));
  assert.equal(userName.attribute, "userName");
  assert.equal(userName.value, "ada@acme.test");

  assert.equal(expectOk(parseScimFilter('externalId eq "dir-1"')).attribute, "externalId");

  // A compiler that dropped the second clause would answer a narrower question while
  // looking like a success.
  assert.equal(expectRefusal(parseScimFilter('userName eq "ada" and active eq "true"')).scimType, "invalidFilter");
  assert.equal(expectRefusal(parseScimFilter('userName co "ada"')).scimType, "invalidFilter");
  assert.equal(expectRefusal(parseScimFilter('nickName eq "ada"')).scimType, "invalidFilter");
  assert.equal(expectRefusal(parseScimFilter("")).status, 400);
});

test("scim: a filter is normalised past the schema prefix Entra sends", () => {
  const parsed = expectOk(
    parseScimFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "ada@acme.test"'),
  );
  assert.equal(parsed.attribute, "userName");
});

test("scim: pagination is 1-based and counts the whole match, not the page", () => {
  const records = Array.from({ length: 250 }, (_, index) => `u${index}`);
  const first = scimPage(records, { count: 3 });
  assert.equal(first.startIndex, 1);
  assert.equal(first.totalResults, 250);
  assert.deepEqual(first.Resources, ["u0", "u1", "u2"], "SCIM's startIndex counts from one");

  assert.deepEqual(scimPage(records, { startIndex: 4, count: 3 }).Resources, ["u3", "u4", "u5"]);

  // A `count` of zero is legal and means "the total, no rows".
  const none = scimPage(records, { count: 0 });
  assert.equal(none.Resources.length, 0);
  assert.equal(none.totalResults, 250);

  // The server's ceiling wins over an absurd ask.
  assert.equal(scimPage(records, { count: 10_000 }).Resources.length, SCIM_PAGE_MAX);
});

test("scim: a query with an unusable startIndex or count is refused, not clamped silently", () => {
  assert.equal(parseScimQuery(new URLSearchParams({ startIndex: "0" })).error?.scimType, "invalidValue");
  assert.equal(parseScimQuery(new URLSearchParams({ count: "-1" })).error?.scimType, "invalidValue");

  const ok = parseScimQuery(new URLSearchParams({ filter: 'userName eq "a@b.test"', startIndex: "2", count: "5" }));
  assert.equal(ok.error, null);
  assert.equal(ok.startIndex, 2);
  assert.equal(ok.count, 5);
});

/* -------------------------------------------------------------------------- */
/*  The projection                                                            */
/* -------------------------------------------------------------------------- */

test("scim: the user projection is an allowlist and leaks no credential", () => {
  const resource = toScimUser(
    {
      id: "u-ada",
      email: "ada@acme.test",
      name: "Ada Lovelace",
      role: "STUDENT",
      active: true,
      externalId: "dir-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    },
    BASE,
  );
  assert.deepEqual(resource.schemas, [SCIM_USER_SCHEMA]);
  assert.equal(resource.userName, "ada@acme.test");
  assert.equal(resource.active, true);
  assert.equal(resource.meta.location, `${BASE}/Users/u-ada`);
  // The row a projection reads carries a password hash and an accent; the allowlist
  // is what keeps them out.
  const emitted = JSON.stringify(resource);
  assert.equal(emitted.includes("password"), false);
  assert.equal(emitted.includes("accent"), false);
  assert.equal(emitted.includes("violet"), false);
});

/* -------------------------------------------------------------------------- */
/*  Reading a body                                                            */
/* -------------------------------------------------------------------------- */

test("scim: a created user defaults to STUDENT, active, and reads a role from either spelling", () => {
  const bare = expectOk(scimUserInput({ userName: "Ada@Acme.Test" }));
  assert.equal(bare.userName, "ada@acme.test", "the address is normalised the way ours are");
  assert.equal(bare.role, "STUDENT");
  assert.equal(bare.active, true);
  assert.equal(bare.displayName, "ada@acme.test");

  const named = expectOk(scimUserInput({ userName: "a@b.test", name: { formatted: "Ada" }, roles: [{ value: "INSTRUCTOR" }] }));
  assert.equal(named.role, "INSTRUCTOR");
  assert.equal(named.displayName, "Ada");

  assert.equal(expectOk(scimUserInput({ userName: "a@b.test", active: false })).active, false);
  assert.equal(expectRefusal(scimUserInput({ userName: "not-an-address" })).scimType, "invalidValue");
  assert.equal(expectRefusal(scimUserInput({ userName: "a@b.test", roles: [{ value: "WIZARD" }] })).scimType, "invalidValue");
});

test("scim: a PATCH is read in both shapes Entra and Okta send", () => {
  const entra = expectOk(
    parseScimPatch({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
  );
  assert.deepEqual(entra.changes, [{ name: "active", value: false }]);

  const okta = expectOk(
    parseScimPatch({ Operations: [{ op: "replace", value: { active: false, displayName: "Ada L" } }] }),
  );
  assert.deepEqual(okta.changes, [
    { name: "active", value: false },
    { name: "displayName", value: "Ada L" },
  ]);

  assert.equal(expectRefusal(parseScimPatch({ Operations: [{ op: "replace", path: "nickName", value: "ada" }] })).scimType, "invalidPath");
  // A user without a name is not a user; clearing it is not provisioning.
  assert.equal(expectRefusal(parseScimPatch({ Operations: [{ op: "remove", path: "userName" }] })).scimType, "mutability");
  assert.equal(expectRefusal(parseScimPatch({ Operations: [{ op: "replace", path: "active", value: "false" }] })).scimType, "invalidValue");
});

test("scim: a PUT replaces, so an omitted active means active", () => {
  const replaced = expectOk(parseScimUserReplace({ userName: "new@acme.test", name: { formatted: "New Name" } }));
  assert.equal(replaced.active, true, "PUT replacement semantics, stated rather than inferred");
  assert.equal(replaced.role, "STUDENT");

  assert.equal(expectRefusal(parseScimUserReplace({ name: { formatted: "New Name" } })).scimType, "invalidValue");
});

test("scim: a role is the roster's vocabulary and nothing else", () => {
  assert.equal(roleFromScim("instructor"), "INSTRUCTOR");
  assert.equal(roleFromScim("ADMIN"), "ADMIN");
  assert.equal(roleFromScim("WIZARD"), null);
  assert.equal(roleFromScim(null), null);
});

test("scim: the discovery document is honest about what is unsupported", () => {
  const config = serviceProviderConfig() as { bulk: { supported: boolean }; sort: { supported: boolean } };
  assert.equal(config.bulk.supported, false);
  assert.equal(config.sort.supported, false);
  assert.equal(SCIM_PATHS.serviceProviderConfig, "/api/scim/v2/ServiceProviderConfig");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("scim: a directory push provisions an account, and it holds no password", async () => {
  const h = harness();
  const created = expectValue(await h.service.createUser({ userName: "ada@acme.test", name: { formatted: "Ada Lovelace" } }));
  assert.equal(created.userName, "ada@acme.test");
  assert.equal(created.active, true);
  assert.equal(JSON.stringify(created).includes("password"), false);
  assert.equal(h.audit.at(-1)?.action, "scim.user.provision");

  // The same address again is a conflict a person resolves, not a retry that never
  // works.
  const again = expectError(await h.service.createUser({ userName: "ada@acme.test" }));
  assert.equal(again.scimType, "uniqueness");
  assert.equal(again.status, 409);
});

test("scim: a directory id that already belongs to somebody is a uniqueness, not a twin", async () => {
  const h = harness({ users: [ada()] });
  assert.equal(expectError(await h.service.createUser({ userName: "other@acme.test", externalId: "dir-1" })).scimType, "uniqueness");
});

test("scim: a rename moves the account rather than making a second one", async () => {
  const h = harness({ users: [ada()] });
  const moved = expectValue(
    await h.service.patchUser("u-ada", { Operations: [{ op: "replace", path: "userName", value: "ada.lovelace@acme.test" }] }),
  );
  assert.equal(moved.id, "u-ada", "the same account, moved");
  assert.equal(moved.userName, "ada.lovelace@acme.test");
  assert.equal(expectValue(await h.service.listUsers(new URLSearchParams())).totalResults, 1);
});

test("scim: a rename onto somebody else's address is refused", async () => {
  const h = harness({ users: [ada(), ada({ id: "u-bob", email: "bob@acme.test", externalId: "dir-2" })] });
  const refused = expectError(
    await h.service.patchUser("u-ada", { Operations: [{ op: "replace", path: "userName", value: "bob@acme.test" }] }),
  );
  assert.equal(refused.scimType, "uniqueness");
});

test("scim: active:false deprovisions and is written down as its own event", async () => {
  const h = harness({ users: [ada()] });
  const deactivated = expectValue(
    await h.service.patchUser("u-ada", { Operations: [{ op: "replace", path: "active", value: false }] }),
  );
  assert.equal(deactivated.active, false);
  const deprovisioned = h.audit.filter((event) => event.action === "scim.user.deprovision");
  assert.equal(deprovisioned.length, 1);
  assert.equal(JSON.stringify(deprovisioned[0]?.detail).includes("password"), false);
});

test("scim: DELETE deactivates rather than deleting training evidence", async () => {
  const h = harness({ users: [ada()] });
  assert.equal(expectValue(await h.service.deleteUser("u-ada")).deactivated, true);
  const still = expectValue(await h.service.getUser("u-ada"));
  assert.equal(still.active, false, "the account still exists, switched off");
});

test("scim: a listing filters by userName case-insensitively, the way a directory sends it", async () => {
  const h = harness({ users: [ada(), ada({ id: "u-bob", email: "bob@acme.test", externalId: "dir-2" })] });
  const result = expectValue(await h.service.listUsers(new URLSearchParams({ filter: 'userName eq "ADA@ACME.TEST"' })));
  assert.equal(result.totalResults, 1);
  assert.equal(result.Resources[0]?.id, "u-ada");
});

test("scim: a class is read with its members and its membership is replaced", async () => {
  const h = harness({
    users: [ada(), ada({ id: "u-bob", email: "bob@acme.test", externalId: "dir-2" })],
    cohorts: [{ id: "c-1", name: "Autumn intake", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  });

  const patched = expectValue(
    await h.service.patchGroup("c-1", { Operations: [{ op: "replace", path: "members", value: ["u-ada", "u-bob"] }] }),
  );
  assert.deepEqual(patched.members.map((member) => member.value).sort(), ["u-ada", "u-bob"]);
  assert.equal(h.audit.at(-1)?.action, "scim.group.members");

  const replaced = expectValue(await h.service.patchGroup("c-1", { Operations: [{ op: "replace", path: "members", value: ["u-bob"] }] }));
  assert.deepEqual(replaced.members.map((member) => member.value), ["u-bob"]);

  const unknown = expectError(await h.service.patchGroup("c-1", { Operations: [{ op: "replace", path: "members", value: ["nobody"] }] }));
  assert.equal(unknown.scimType, "invalidValue");
});

test("scim: a class is not invented, renamed or deleted through a group push", async () => {
  const h = harness({
    cohorts: [{ id: "c-1", name: "Autumn intake", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  });

  assert.equal(expectError(await h.service.createGroup({ displayName: "Invented class" })).scimType, "mutability");
  assert.equal(
    expectError(await h.service.patchGroup("c-1", { Operations: [{ op: "replace", path: "displayName", value: "Renamed" }] })).scimType,
    "mutability",
  );
  assert.equal(expectError(await h.service.deleteGroup("c-1")).scimType, "mutability");
});

test("scim: a write against a resource that does not exist is a 404, not a creation", async () => {
  const h = harness();
  const patched = expectError(await h.service.patchUser("missing", { Operations: [{ op: "replace", path: "active", value: false }] }));
  assert.equal(patched.status, 404);
  assert.equal(patched.scimType, "noTarget");

  assert.equal(expectError(await h.service.getGroup("missing")).status, 404);
});
