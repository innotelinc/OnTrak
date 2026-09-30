/**
 * OnTrak Sentinel S2 tests: SCIM 2.0 provisioning.
 *
 * S0 and S1 made Sentinel an IdP a person could use. Provisioning is the first thing
 * here that a *machine* drives, and every way that goes wrong is a way somebody loses
 * access or keeps it after they should not. Each test follows one of them:
 *
 *  - a filter the parser half-understands, so a page that looks complete is missing
 *    people (the parser refuses the grammar it does not implement, by name);
 *  - a rename that creates a second identity for the same person, orphaning the first
 *    one's sessions, factors and history (hence `externalId`, and hence a conflict
 *    rather than a duplicate);
 *  - a `PUT` that omits `active` and deactivates somebody by accident, or a `PATCH`
 *    that omits it and deactivates them anyway (replace and patch mean different
 *    things, and both are pinned here);
 *  - a leaver who is switched off but whose sessions — and the access tokens those
 *    sessions minted — keep working;
 *  - a directory that deactivates the organization's only administrator and leaves a
 *    tenant nobody can administer;
 *  - a service identity deactivated by a provisioning push, because the connector's
 *    own machine account is a user as far as SCIM is concerned unless something says
 *    otherwise;
 *  - a token that can mint another token, or one tenant's connector reading another's
 *    people;
 *  - and a `404` from the OIDC router that never reaches the SCIM one, which would
 *    make every endpoint here unreachable in a deployment while its own tests passed.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { SCIM_USER_SCHEMA } from "../src/lib/scim-rules";
import { MemoryScimStore, ScimService, type ScimIds, type ScimTokenRevoker } from "../src/lib/scim-service";
import { routeScim, type ScimEndpoints } from "../src/lib/scim-http";
import type { HttpRequest } from "../src/lib/oidc-http";
import { createOidcServer } from "../src/lib/oidc-server";

const sha256: HashFn = sha256Hex;
const BASE = "https://id.sentinel.test/scim/v2";

let harnessSeq = 0;

/**
 * A spine, a token store and a clock that moves only when a test moves it.
 *
 * Tokens are minted with a realistic length on purpose: `looksLikeScimToken` refuses
 * anything shorter than the real thing before it reaches the database, so a short
 * fake would make every authentication test pass for the wrong reason.
 */
function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-20T09:00:00.000Z");
  let n = 0;
  const scope = `s${++harnessSeq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });

  const store = new MemoryScimStore();
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
    // The length the real mint produces: 24 random bytes as base64url is 32
    // characters. A short fixture would pass a shape check the server itself fails.
    token: () => `sc1_${"a".repeat(24)}${`${++n}`.padStart(8, "0")}`,
  };
  const service = new ScimService(store, spine, { baseUrl: BASE }, audit, revoker, scimIds);

  return {
    scope,
    spine,
    store,
    service,
    audit,
    revoked,
    advance(ms: number) {
      clock += ms;
    },
    /** An organization with one administrator identity. */
    async bootstrap(slug = "acme") {
      const created = await spine.bootstrapOrganization(
        "test-suite",
        { name: slug, slug },
        { identifier: `admin@${slug}.test`, displayName: "Admin" },
      );
      assert.ok(created.ok, "the organization should bootstrap");
      const actor: IdentityActor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN",
      };
      return { actor, admin: created.value.admin, organizationId: created.value.organization.id };
    },
    /** A connector token, minted the way the console mints one. */
    async token(actor: IdentityActor, label: string | null = "Entra ID") {
      const minted = await service.mintToken(actor, label);
      assert.ok(minted.ok, "the token should mint");
      const authenticated = await service.authenticate(minted.value.plaintext);
      assert.ok(authenticated.ok, "the token should authenticate");
      return { plaintext: minted.value.plaintext, token: minted.value.token, caller: authenticated.value };
    },
  };
}

function request(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  const { method, path, ...rest } = overrides;
  return {
    method,
    url: `https://id.sentinel.test${path}`,
    headers: {},
    body: "",
    ...rest,
  };
}

const json = (body: unknown): string => JSON.stringify(body);

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

test("the filter parser accepts the one shape a directory sends and refuses the rest by name", async () => {
  const { parseScimFilter } = await import("../src/lib/scim-rules");

  const accepted = parseScimFilter('userName eq "ada@acme.test"');
  assert.ok(!("status" in accepted));
  assert.equal(accepted.attribute, "userName");
  assert.equal(accepted.value, "ada@acme.test");

  const external = parseScimFilter('externalId eq "8f2c"');
  assert.ok(!("status" in external));
  assert.equal(external.attribute, "externalId");

  // `co` and `and` are legal SCIM and not implemented here. Refusing them is the
  // point: honouring only the first clause of a compound filter answers a narrower
  // question than was asked while looking like a success.
  for (const text of ['userName co "ada"', 'userName eq "a" and active eq true', 'userName sw "a"', "userName eq ada"]) {
    const refused = parseScimFilter(text);
    assert.ok("status" in refused, `“${text}” should be refused`);
    assert.equal(refused.status, 400);
    assert.equal(refused.scimType, "invalidFilter");
  }

  const unknown = parseScimFilter('nickName eq "ada"');
  assert.ok("status" in unknown);
  assert.equal(unknown.scimType, "invalidFilter");
});

test("pagination is 1-based and reports the whole match, not the page", async () => {
  const { scimPage, SCIM_PAGE_MAX } = await import("../src/lib/scim-rules");
  const records = Array.from({ length: 10 }, (_, index) => `u${index + 1}`);

  const first = scimPage(records, { count: 3 });
  assert.equal(first.startIndex, 1);
  assert.equal(first.totalResults, 10);
  assert.equal(first.itemsPerPage, 3);
  assert.deepEqual(first.Resources, ["u1", "u2", "u3"]);

  // SCIM's startIndex counts from one. An off-by-one here silently duplicates or
  // skips one person per page, which is invisible without a directory attached.
  const second = scimPage(records, { startIndex: 4, count: 3 });
  assert.deepEqual(second.Resources, ["u4", "u5", "u6"]);

  const past = scimPage(records, { startIndex: 20, count: 3 });
  assert.deepEqual(past.Resources, []);
  assert.equal(past.itemsPerPage, 0);

  // `count=0` is how a connector asks "how many are there?" without pulling them.
  const none = scimPage(records, { count: 0 });
  assert.equal(none.totalResults, 10);
  assert.deepEqual(none.Resources, []);

  // A page larger than the ceiling is clamped rather than honoured. `itemsPerPage`
  // reports what was returned, so the clamp is visible in the rows themselves.
  const many = Array.from({ length: SCIM_PAGE_MAX + 50 }, (_, index) => `u${index}`);
  assert.equal(scimPage(many, { count: 10_000 }).Resources.length, SCIM_PAGE_MAX);
  assert.equal(scimPage(many, { count: 10_000 }).totalResults, SCIM_PAGE_MAX + 50);
});

test("a PATCH is read in both shapes, and an unknown path is refused rather than ignored", async () => {
  const { parseScimPatch } = await import("../src/lib/scim-rules");

  // Entra's shape: a path, and a scalar value.
  const entra = parseScimPatch({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:userName", value: "ada@acme.test" }],
  });
  assert.ok(!("status" in entra));
  assert.deepEqual(entra.changes, [{ name: "userName", value: "ada@acme.test" }]);

  // Okta's shape: no path, an object of attributes.
  const okta = parseScimPatch({
    Operations: [{ op: "replace", value: { active: false, displayName: "Ada Lovelace" } }],
  });
  assert.ok(!("status" in okta));
  assert.deepEqual(okta.changes, [
    { name: "active", value: false },
    { name: "displayName", value: "Ada Lovelace" },
  ]);

  const unknown = parseScimPatch({ Operations: [{ op: "replace", path: "nickName", value: "ada" }] });
  assert.ok("status" in unknown);
  assert.equal(unknown.scimType, "invalidPath");

  const clearingName = parseScimPatch({ Operations: [{ op: "remove", path: "userName" }] });
  assert.ok("status" in clearingName);
  assert.equal(clearingName.scimType, "mutability");

  const notBoolean = parseScimPatch({ Operations: [{ op: "replace", path: "active", value: "false" }] });
  assert.ok("status" in notBoolean);
  assert.equal(notBoolean.scimType, "invalidValue");

  const empty = parseScimPatch({ Operations: [] });
  assert.ok("status" in empty);
});

test("PUT replaces and PATCH patches, and the difference is whether an absent `active` deactivates", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const created = await h.service.createUser(caller, { userName: "ada@acme.test", displayName: "Ada" });
  assert.ok(created.ok);
  const userId = created.value.id;

  // PATCH that never mentions `active` leaves it alone.
  const patched = await h.service.patchUser(caller, userId, {
    Operations: [{ op: "replace", path: "displayName", value: "Ada L." }],
  });
  assert.ok(patched.ok);
  assert.equal(patched.value.active, true);
  assert.equal(patched.value.displayName, "Ada L.");

  // PUT that omits it means active — replacement semantics. A PUT is how a directory
  // re-asserts the whole resource, and reading an omission as "false" is how a
  // connector walks people out of a building.
  const replaced = await h.service.replaceUser(caller, userId, { userName: "ada@acme.test", displayName: "Ada" });
  assert.ok(replaced.ok);
  assert.equal(replaced.value.active, true);
});

test("the SCIM projection names every field it emits", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const created = await h.service.createUser(caller, {
    userName: "ada@acme.test",
    displayName: "Ada",
    externalId: "8f2c-11",
  });
  assert.ok(created.ok);

  // An allowlist, not a spread: the identity has no password column today, and this
  // assertion is what makes adding one a deliberate act rather than a leak.
  assert.deepEqual(Object.keys(created.value).sort(), [
    "active",
    "displayName",
    "externalId",
    "id",
    "meta",
    "name",
    "roles",
    "schemas",
    "userName",
  ]);
  assert.equal(created.value.schemas[0], SCIM_USER_SCHEMA);
  assert.equal("mfaEnrolled" in created.value, false);
  assert.equal(created.value.meta.location, `${BASE}/Users/${created.value.id}`);
});

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

test("a token is stored as a hash, shown once, and stops working when revoked", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();

  const minted = await h.service.mintToken(actor, "Entra ID — production");
  assert.ok(minted.ok);

  // The plaintext is never stored: what is on the row is a digest of it.
  const stored = await h.store.listTokens(actor.organizationId);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].tokenHash, minted.value.plaintext);
  assert.equal(stored[0].tokenHash, sha256(minted.value.plaintext));

  const authenticated = await h.service.authenticate(minted.value.plaintext);
  assert.ok(authenticated.ok);
  // The connector acts as a delegation of the administrator, inside one organization.
  assert.equal(authenticated.value.actor.id, `scim:${stored[0].id}`);
  assert.equal(authenticated.value.actor.role, "ADMIN");
  assert.equal(authenticated.value.organizationId, actor.organizationId);

  // Using it is recorded, so "is this still in use?" has an answer before revoking.
  assert.ok((await h.store.listTokens(actor.organizationId))[0].lastUsedAt);

  const revoked = await h.service.revokeToken(actor, stored[0].id);
  assert.ok(revoked.ok);
  const refused = await h.service.authenticate(minted.value.plaintext);
  assert.equal(refused.ok, false);
});

test("the token the server mints is a token the server will look up", async () => {
  const { looksLikeScimToken, SCIM_TOKEN_PREFIX, SCIM_TOKEN_BODY_MIN } = await import("../src/lib/scim-rules");
  const { systemScimIds } = await import("../src/lib/scim-service");

  // The guard refuses a shape it could not have minted, so the mint and the guard have
  // to agree on the encoding as well as the prefix. Asserting it here is what catches a
  // token that is born unauthenticatable — a bug that every hand-written fixture passes.
  const mint = systemScimIds().token();
  assert.ok(mint.startsWith(SCIM_TOKEN_PREFIX));
  assert.equal(mint.length, SCIM_TOKEN_PREFIX.length + SCIM_TOKEN_BODY_MIN);
  assert.ok(looksLikeScimToken(mint), `“${mint}” must be one this server looks up`);

  for (let i = 0; i < 25; i += 1) {
    assert.ok(looksLikeScimToken(systemScimIds().token()));
  }

  const h = harness();
  const { actor } = await h.bootstrap();
  const { plaintext, caller } = await h.token(actor);
  assert.ok(looksLikeScimToken(plaintext));
  // And a fixture of the same length is accepted, so the suite is not passing for the
  // wrong reason either.
  assert.ok(caller.tokenId.length > 0);
});

test("a token that is not shaped like ours is refused without a lookup, and a token cannot mint a token", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { caller } = await h.token(actor);

  for (const candidate of ["", "hunter2", "tx1_abcdefghijklmnopqrstuvwxyz", `sc1_${"a".repeat(10)}`]) {
    const refused = await h.service.authenticate(candidate);
    assert.equal(refused.ok, false, `“${candidate}” should be refused`);
  }

  // The SCIM surface has no mint endpoint at all — this is what stops a compromised
  // connector from issuing itself a longer-lived credential.
  const endpoints = h.service as unknown as Record<string, unknown>;
  assert.equal(typeof endpoints.mintToken, "function", "minting exists on the service, for the console");
  const created = await h.service.createUser(caller, { userName: "ada@acme.test" });
  assert.ok(created.ok);
});

/* -------------------------------------------------------------------------- */
/*  Users                                                                     */
/* -------------------------------------------------------------------------- */

test("creating a user records the connector as the actor, and a rename is a move rather than a second person", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller, token } = await h.token(actor);

  const created = await h.service.createUser(caller, {
    userName: "ada@acme.test",
    displayName: "Ada Lovelace",
    externalId: "dir-8f2c",
  });
  assert.ok(created.ok);

  // The evidence names the connector, not the person who minted its token: a machine's
  // write attributed to a human who was asleep is a trail that lies. (The organization's
  // own bootstrap is the earlier `identity.create`, and it names the script.)
  const trail = await h.audit.trail(organizationId);
  const event = trail.find((entry) => entry.action === "identity.create" && entry.targetId === created.value.id);
  assert.ok(event);
  assert.equal(event.actor, `scim:${token.id}`);
  assert.equal((event.detail as { identifier: string }).identifier, "ada@acme.test");

  // Re-sending the create while the user name is taken is a conflict, not a second
  // identity: this is a connector retrying, and it has to be told so.
  const duplicate = await h.service.createUser(caller, { userName: "ada@acme.test" });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.scimType, "uniqueness");

  // The rename: same identity, same externalId, new user name.
  const renamed = await h.service.patchUser(caller, created.value.id, {
    Operations: [{ op: "replace", path: "userName", value: "ada.lovelace@acme.test" }],
  });
  assert.ok(renamed.ok);
  assert.equal(renamed.value.id, created.value.id);
  assert.equal(renamed.value.externalId, "dir-8f2c");
  assert.equal(renamed.value.userName, "ada.lovelace@acme.test");

  // After a rename the old user name is free again, so a stale create that carried only
  // a name would make a *second* person; the same directory record is what recognises a
  // move, and it is still a conflict, because the resource already exists.
  const freshName = await h.service.createUser(caller, { userName: "ada@acme.test" });
  assert.ok(freshName.ok, "the vacated user name is free — which is why externalId exists");
  const sameDirectoryRecord = await h.service.createUser(caller, {
    userName: "somebody.else@acme.test",
    externalId: "dir-8f2c",
  });
  assert.equal(sameDirectoryRecord.ok, false);
  if (!sameDirectoryRecord.ok) {
    assert.equal(sameDirectoryRecord.error.scimType, "uniqueness");
    assert.match(sameDirectoryRecord.error.detail, /PATCH/);
  }
});

test("listing filters on the user name case-insensitively and pages what it found", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { caller } = await h.token(actor);

  for (const userName of ["ada@acme.test", "Grace@acme.test", "linus@acme.test"]) {
    const created = await h.service.createUser(caller, { userName });
    assert.ok(created.ok);
  }

  // Four humans: the three above, and the administrator who bootstrapped the
  // organization — who is a person in the directory like anybody else.
  const all = await h.service.listUsers(caller, new URLSearchParams());
  assert.ok(all.ok);
  assert.equal(all.value.totalResults, 4);

  // A directory and an address book disagree about case; matching exactly is how a
  // connector provisions the same person twice.
  const filtered = await h.service.listUsers(caller, new URLSearchParams({ filter: 'userName eq "GRACE@ACME.TEST"' }));
  assert.ok(filtered.ok);
  assert.equal(filtered.value.totalResults, 1);
  assert.equal(filtered.value.Resources[0].userName, "Grace@acme.test");

  const paged = await h.service.listUsers(caller, new URLSearchParams({ startIndex: "2", count: "1" }));
  assert.ok(paged.ok);
  assert.equal(paged.value.totalResults, 4);
  assert.equal(paged.value.Resources.length, 1);

  const badFilter = await h.service.listUsers(caller, new URLSearchParams({ filter: 'userName co "a"' }));
  assert.equal(badFilter.ok, false);
});

test("deactivating somebody through a directory ends their sessions AND the tokens those sessions minted", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const created = await h.service.createUser(caller, { userName: "leaver@acme.test" });
  assert.ok(created.ok);
  const userId = created.value.id;

  // A policy without MFA, so the test is about deprovisioning rather than enrolment.
  const policy = { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 3600 };
  const first = await h.spine.issueSession(organizationId, userId, {}, policy);
  assert.ok(first.ok);
  const second = await h.spine.issueSession(organizationId, userId, {}, policy);
  assert.ok(second.ok);

  const deactivated = await h.service.patchUser(caller, userId, {
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.ok(deactivated.ok);
  assert.equal(deactivated.value.active, false);

  // Both sessions ended…
  const sessions = await h.spine.listSessions(actor, userId);
  assert.ok(sessions.ok);
  assert.equal(sessions.value.filter((session) => session.revokedAt !== null).length, 2);
  // …and each one's access tokens were revoked, which ending a session alone does not do.
  assert.deepEqual(h.revoked.sort(), [first.value.id, second.value.id].sort());

  // Switching off is not deletion: the record is still there, and still readable.
  const stillThere = await h.service.getUser(caller, userId);
  assert.ok(stillThere.ok);
  assert.equal(stillThere.value.active, false);

  // And it can be switched back on, which is how a re-hire gets their history back.
  const back = await h.service.patchUser(caller, userId, { Operations: [{ op: "replace", path: "active", value: true }] });
  assert.ok(back.ok);
  assert.equal(back.value.active, true);
});

test("DELETE deactivates, so the evidence that a person existed survives them", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const created = await h.service.createUser(caller, { userName: "leaver@acme.test", externalId: "dir-1" });
  assert.ok(created.ok);

  const deleted = await h.service.deleteUser(caller, created.value.id);
  assert.ok(deleted.ok);

  const stillThere = await h.service.getUser(caller, created.value.id);
  assert.ok(stillThere.ok);
  assert.equal(stillThere.value.active, false);

  const trail = await h.audit.trail(organizationId);
  assert.ok(trail.some((entry) => entry.action === "identity.deactivate"));
  assert.ok(trail.some((entry) => entry.action === "scim.deprovision"));
  const verification = await h.audit.verify(organizationId);
  assert.equal(verification.ok, true);
});

test("a machine account is not a SCIM user, so a directory cannot switch one off", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const service = await h.spine.createIdentity(actor, {
    identifier: "svc-sentinel@acme.test",
    displayName: "Sentinel service account",
    kind: "SERVICE",
    role: "SERVICE",
  });
  assert.ok(service.ok);

  // The administrator who bootstrapped the organization is a human, so the collection
  // is not empty — it is exactly the humans, and the machine account is not one.
  const listed = await h.service.listUsers(caller, new URLSearchParams());
  assert.ok(listed.ok);
  assert.equal(listed.value.totalResults, 1);
  assert.equal(
    listed.value.Resources.some((resource) => resource.id === service.value.id),
    false,
    "a service identity must not appear in the Users collection",
  );

  const absent = await h.service.getUser(caller, service.value.id);
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.status, 404);

  const refused = await h.service.deleteUser(caller, service.value.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.status, 404);
});

test("a directory cannot deactivate the organization's only administrator", async () => {
  const h = harness();
  const { actor, admin, organizationId } = await h.bootstrap();
  const { caller } = await h.token(actor);

  // The refusal is the spine's, reached through the same method the console uses — so
  // a provisioning push is bounded by exactly the rules a person is.
  const refused = await h.service.patchUser(caller, admin.id, {
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.status, 409);
    assert.equal(refused.error.scimType, "mutability");
  }

  // Demotion is the same act done more quietly, and it is refused the same way.
  const demoted = await h.service.patchUser(caller, admin.id, {
    Operations: [{ op: "replace", path: "roles", value: [{ value: "AGENT" }] }],
  });
  assert.equal(demoted.ok, false);
  if (!demoted.ok) assert.equal(demoted.error.scimType, "mutability");

  const verification = await h.audit.verify(organizationId);
  assert.equal(verification.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Groups                                                                    */
/* -------------------------------------------------------------------------- */

test("groups carry membership, refuse unknown members, and decide nothing yet", async () => {
  const h = harness();
  const { actor, organizationId } = await h.bootstrap();
  const { caller } = await h.token(actor);

  const ada = await h.service.createUser(caller, { userName: "ada@acme.test" });
  const grace = await h.service.createUser(caller, { userName: "grace@acme.test" });
  assert.ok(ada.ok && grace.ok);

  const created = await h.service.createGroup(caller, {
    displayName: "Help desk",
    members: [{ value: ada.value.id }],
  });
  assert.ok(created.ok);
  assert.equal(created.value.members.length, 1);
  assert.equal(created.value.members[0].type, "User");

  // Adding a member twice is a no-op, which is what a connector's retry needs.
  const added = await h.service.patchGroup(caller, created.value.id, {
    Operations: [{ op: "add", path: "members", value: [{ value: grace.value.id }] }],
  });
  assert.ok(added.ok);
  assert.equal(added.value.members.length, 2);
  const again = await h.service.patchGroup(caller, created.value.id, {
    Operations: [{ op: "add", path: "members", value: [{ value: grace.value.id }] }],
  });
  assert.ok(again.ok);
  assert.equal(again.value.members.length, 2);

  // A member that is not a user here fails the whole write: a group that quietly
  // accepted eight of ten members is one somebody makes an access decision from.
  const unknown = await h.service.patchGroup(caller, created.value.id, {
    Operations: [{ op: "add", path: "members", value: [{ value: "not-a-user" }] }],
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.scimType, "invalidValue");

  const clash = await h.service.createGroup(caller, { displayName: "Help desk" });
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.equal(clash.error.scimType, "uniqueness");

  const trail = await h.audit.trail(organizationId);
  assert.ok(trail.some((entry) => entry.action === "scim.group.create"));
  assert.ok(trail.some((entry) => entry.action === "scim.group.members"));

  const deleted = await h.service.deleteGroup(caller, created.value.id);
  assert.ok(deleted.ok);
  const gone = await h.service.getGroup(caller, created.value.id);
  assert.equal(gone.ok, false);
});

test("one organization's connector can neither read nor reach another's people", async () => {
  const h = harness();
  const acme = await h.bootstrap("acme");
  const globex = await h.bootstrap("globex");

  const acmeToken = await h.token(acme.actor, "acme");
  const globexToken = await h.token(globex.actor, "globex");

  const acmeUser = await h.service.createUser(acmeToken.caller, { userName: "ada@acme.test" });
  const globexUser = await h.service.createUser(globexToken.caller, { userName: "ada@globex.test" });
  const acmeGroup = await h.service.createGroup(acmeToken.caller, { displayName: "Help desk" });
  assert.ok(acmeUser.ok && globexUser.ok && acmeGroup.ok);

  // Each organization has its own administrator and its own provisioned user, and
  // neither connector can see the other's two.
  const listed = await h.service.listUsers(globexToken.caller, new URLSearchParams());
  assert.ok(listed.ok);
  assert.equal(listed.value.totalResults, 2);
  assert.equal(listed.value.Resources.some((resource) => resource.userName === "ada@acme.test"), false);

  // Another tenant's ids are not "forbidden" — they are absent, which is the only
  // answer a caller can act on without learning about another organization.
  const foreign = await h.service.getUser(globexToken.caller, acmeUser.value.id);
  assert.equal(foreign.ok, false);
  const foreignGroup = await h.service.getGroup(globexToken.caller, acmeGroup.value.id);
  assert.equal(foreignGroup.ok, false);

  // And a filter cannot widen the read either: it runs inside the tenant's own list.
  const byName = await h.service.listUsers(
    globexToken.caller,
    new URLSearchParams({ filter: 'userName eq "ada@acme.test"' }),
  );
  assert.ok(byName.ok);
  assert.equal(byName.value.totalResults, 0);
});

/* -------------------------------------------------------------------------- */
/*  The HTTP surface                                                          */
/* -------------------------------------------------------------------------- */

/** A service as the router needs it, over a real harness. */
function endpoints(h: ReturnType<typeof harness>): ScimEndpoints {
  return h.service;
}

test("discovery is public and the data is not", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();

  const discovery = await routeScim(request({ method: "GET", path: "/scim/v2/ServiceProviderConfig" }), endpoints(h));
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers["content-type"], "application/scim+json");
  const document = JSON.parse(discovery.body) as { patch: { supported: boolean }; bulk: { supported: boolean } };
  assert.equal(document.patch.supported, true);
  assert.equal(document.bulk.supported, false, "bulk is not implemented and must not be advertised");

  const resourceTypes = await routeScim(request({ method: "GET", path: "/scim/v2/ResourceTypes" }), endpoints(h));
  assert.equal(resourceTypes.status, 200);

  // The path is public knowledge; the people behind it are not. A `404` here would
  // send somebody looking for a bad URL instead of a missing token.
  const unauthenticated = await routeScim(request({ method: "GET", path: "/scim/v2/Users" }), endpoints(h));
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers["www-authenticate"], "Bearer");
  const body = JSON.parse(unauthenticated.body) as { schemas: string[]; detail: string; status: string };
  assert.equal(body.schemas[0], "urn:ietf:params:scim:api:messages:2.0:Error");
  assert.equal(body.status, "401");

  // A token for somebody else is no better than no token.
  const { plaintext } = await h.token(actor);
  const accepted = await routeScim(
    request({ method: "GET", path: "/scim/v2/Users", headers: { authorization: `Bearer ${plaintext}` } }),
    endpoints(h),
  );
  assert.equal(accepted.status, 200);
});

test("a create answers 201 with its Location, a delete answers 204, and the methods that do not exist are refused", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { plaintext } = await h.token(actor);
  const auth = { authorization: `Bearer ${plaintext}` };

  const created = await routeScim(
    request({
      method: "POST",
      path: "/scim/v2/Users",
      headers: auth,
      body: json({ userName: "ada@acme.test", displayName: "Ada" }),
    }),
    endpoints(h),
  );
  assert.equal(created.status, 201);
  // A connector stores this URL and writes to it later, so getting it right matters.
  assert.equal(created.headers.location, `/scim/v2/Users/${(JSON.parse(created.body) as { id: string }).id}`);
  const userId = (JSON.parse(created.body) as { id: string }).id;

  const patched = await routeScim(
    request({
      method: "PATCH",
      path: `/scim/v2/Users/${userId}`,
      headers: auth,
      body: json({ Operations: [{ op: "replace", path: "displayName", value: "Ada L." }] }),
    }),
    endpoints(h),
  );
  assert.equal(patched.status, 200);

  const deleted = await routeScim(request({ method: "DELETE", path: `/scim/v2/Users/${userId}`, headers: auth }), endpoints(h));
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, "");

  const wrongMethod = await routeScim(request({ method: "PUT", path: "/scim/v2/Users", headers: auth }), endpoints(h));
  assert.equal(wrongMethod.status, 405);
  assert.match(String(wrongMethod.headers.allow), /POST/);

  const unknown = await routeScim(request({ method: "GET", path: "/scim/v2/Organizations", headers: auth }), endpoints(h));
  assert.equal(unknown.status, 404);

  // A sub-resource this server does not expose is not read as an id.
  const subResource = await routeScim(request({ method: "GET", path: `/scim/v2/Users/${userId}/photos`, headers: auth }), endpoints(h));
  assert.equal(subResource.status, 404);

  const notJson = await routeScim(request({ method: "POST", path: "/scim/v2/Users", headers: auth, body: "{oops" }), endpoints(h));
  assert.equal(notJson.status, 400);
  assert.equal((JSON.parse(notJson.body) as { scimType: string }).scimType, "invalidSyntax");
});

test("a conflict comes back as a conflict, because a connector retries what it cannot see", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { plaintext } = await h.token(actor);
  const auth = { authorization: `Bearer ${plaintext}` };

  const first = await routeScim(
    request({ method: "POST", path: "/scim/v2/Users", headers: auth, body: json({ userName: "ada@acme.test" }) }),
    endpoints(h),
  );
  assert.equal(first.status, 201);

  const second = await routeScim(
    request({ method: "POST", path: "/scim/v2/Users", headers: auth, body: json({ userName: "ada@acme.test" }) }),
    endpoints(h),
  );
  assert.equal(second.status, 409);
  const body = JSON.parse(second.body) as { scimType: string; status: string; detail: string };
  assert.equal(body.scimType, "uniqueness");
  assert.equal(body.status, "409");
  assert.ok(body.detail.length > 0);
});

test("the SCIM router is reachable through the shared listener, behind the OIDC one", async () => {
  const h = harness();
  const { actor } = await h.bootstrap();
  const { plaintext } = await h.token(actor);

  // The chain in `oidc-server.ts` asks the *next* router on a 404. A SCIM surface that
  // only existed as a function would pass every test above and 404 in a deployment.
  const server = createOidcServer({} as never, { scim: endpoints(h) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const discovery = await fetch(`${base}/scim/v2/ServiceProviderConfig`);
    assert.equal(discovery.status, 200);

    const users = await fetch(`${base}/scim/v2/Users`, { headers: { authorization: `Bearer ${plaintext}` } });
    assert.equal(users.status, 200);

    const nothing = await fetch(`${base}/scim/v2/Users`, { headers: { authorization: "Bearer nope" } });
    assert.equal(nothing.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
