/**
 * OnTrak Sentinel S2 tests: reading a directory (AD, Entra, Google).
 *
 * S2's first half made Sentinel a SCIM *server* — a connector pushes people in. This
 * suite is about the other direction, and about the ways a sync that reads a roster goes
 * wrong. Each test follows one of them:
 *
 *  - **A rename becomes a second person.** The directory's own id is what makes it a
 *    *move*; matching on the user name alone orphans the first identity, with its
 *    sessions, its factors and its history.
 *  - **Two people, one address.** The id and the name resolving to different identities is
 *    the conflict this product never resolves by guessing, because merging identities
 *    means deleting evidence.
 *  - **A local edit is silently overwritten** (or silently ignored, both wrong) instead of
 *    being a policy the organization chose and a divergence on the record.
 *  - **A partial answer offboards a company.** A person who is simply *absent* from the
 *    directory's answer must not be deactivated; a leaver says `active: false`.
 *  - **A pull that failed is remembered as one that did nothing.** A failed run that
 *    advanced the sync clock would stop protecting local edits without saying so.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import {
  createHttpDirectoryReader,
  staticDirectoryReader,
  type FetchLike,
} from "../src/lib/directory-client";
import {
  DirectoryService,
  MemoryDirectoryStore,
  type DirectoryReader,
} from "../src/lib/directory-service";
import {
  parseDirectoryPage,
  planDirectorySync,
  toDirectoryPerson,
  type DirectoryConnectionRecord,
  type DirectoryPerson,
} from "../src/lib/directory-rules";
import { MemoryMfaStore, MfaService, type MfaIds } from "../src/lib/mfa-service";
import { MemoryScimStore, ScimService, type ScimIds } from "../src/lib/scim-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import type { IdentityRecord } from "../src/lib/identity-rules";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;

/* -------------------------------------------------------------------------- */
/*  The pure rules                                                            */
/* -------------------------------------------------------------------------- */

function person(over: Partial<DirectoryPerson> = {}): DirectoryPerson {
  return { externalId: "dir-1", userName: "ada@corp.test", displayName: "Ada Lovelace", active: true, role: null, groups: [], ...over };
}

function identity(over: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    id: over.id ?? "id-1",
    organizationId: "org",
    identifier: over.identifier ?? "ada@corp.test",
    displayName: over.displayName ?? "Ada Lovelace",
    externalId: over.externalId ?? null,
    kind: "HUMAN",
    role: over.role ?? "AGENT",
    active: over.active ?? true,
    mfaEnrolled: false,
    createdAt: over.createdAt ?? "2026-10-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-10-01T00:00:00.000Z",
  };
}

const OPTIONS = { conflictPolicy: "preferDirectory" as const, defaultRole: "AGENT" as const, lastSyncedAt: "2026-10-20T00:00:00.000Z" };

test("directory: a vendor record is read through its aliases, and a nameless one is skipped", () => {
  // Graph.
  const graph = toDirectoryPerson("ENTRA", {
    id: "abc-123",
    userPrincipalName: "Ada@Corp.test",
    displayName: "Ada Lovelace",
    accountEnabled: false,
    memberOf: ["Engineering"],
  });
  assert.ok(graph.person);
  assert.equal(graph.person.externalId, "abc-123");
  assert.equal(graph.person.active, false);
  assert.deepEqual(graph.person.groups, ["Engineering"]);

  // Google, with an object-shaped name and group and a string "true".
  const google = toDirectoryPerson("GOOGLE", {
    id: "1031",
    primaryEmail: "grace@corp.test",
    name: { displayName: "Grace Hopper" },
    enabled: "true",
    groups: [{ email: "compilers@corp.test", name: "Compilers" }],
  });
  assert.ok(google.person);
  assert.equal(google.person.displayName, "Grace Hopper", "Google nests the name, so a flat read would miss it");
  assert.equal(google.person.active, true);
  assert.deepEqual(google.person.groups, ["Compilers"]);

  // A record with no id cannot be matched next time.
  const nameless = toDirectoryPerson("GENERIC", { displayName: "Nobody" });
  assert.equal(nameless.person, undefined);
  assert.match(nameless.issues.join(" "), /no id/);

  // And a page arrives in whichever wrapper the vendor uses.
  assert.equal(parseDirectoryPage("ENTRA", { value: [{ id: "1", userPrincipalName: "a@corp.test" }] }).people.length, 1);
  assert.equal(parseDirectoryPage("GOOGLE", { users: [{ id: "2", primaryEmail: "b@corp.test" }] }).people.length, 1);
  assert.equal(parseDirectoryPage("GENERIC", [{ id: "3", userName: "c@corp.test" }]).people.length, 1);
  assert.equal(parseDirectoryPage("GENERIC", { unexpected: true }).people.length, 0);
});

test("directory: the directory's id makes a rename a move, not a second identity", () => {
  const existing = identity({ externalId: "dir-1", identifier: "ada.lovelace@corp.test" });
  const plan = planDirectorySync([existing], [person({ userName: "ada@corp.test" })], OPTIONS);

  const update = plan.changes.find((change) => change.action === "update");
  assert.ok(update, "the renamed person is an update");
  assert.equal(update.identityId, existing.id);
  assert.ok(update.changes.includes("identifier"));
  assert.equal(plan.counts.created, 0, "a rename must never create a second identity");
});

test("directory: a hand-made identity is adopted by name, once", () => {
  const handMade = identity({ externalId: null });
  const plan = planDirectorySync([handMade], [person()], OPTIONS);

  const update = plan.changes.find((change) => change.action === "update");
  assert.ok(update);
  assert.ok(update.changes.includes("externalId"), "adoption is the point: next time the id matches");
  assert.equal(plan.counts.created, 0);
});

test("directory: an id and a name pointing at different people is a conflict, never a merge", () => {
  const byId = identity({ id: "id-a", externalId: "dir-1", identifier: "ada.lovelace@corp.test" });
  const byName = identity({ id: "id-b", externalId: "dir-9", identifier: "ada@corp.test" });

  const plan = planDirectorySync([byId, byName], [person()], OPTIONS);
  assert.equal(plan.counts.conflicts, 1);
  assert.equal(plan.counts.created + plan.counts.updated + plan.counts.deactivated, 0);
  assert.match(plan.changes[0].detail, /refusing to merge/);

  // Two identities sharing one address is the same refusal, for the same reason.
  const ambiguous = planDirectorySync(
    [identity({ id: "id-a", identifier: "ada@corp.test" }), identity({ id: "id-b", identifier: "ada@corp.test" })],
    [person()],
    OPTIONS,
  );
  assert.equal(ambiguous.counts.conflicts, 1);
  assert.match(ambiguous.changes[0].detail, /refusing to guess/);
});

test("directory: a partial answer never deactivates anybody, and a leaver does", () => {
  const ada = identity({ id: "id-a", externalId: "dir-1", identifier: "ada@corp.test" });
  const grace = identity({ id: "id-b", externalId: "dir-2", identifier: "grace@corp.test" });

  // Grace is simply absent from this answer — the directory answered about Ada only.
  const partial = planDirectorySync([ada, grace], [person()], OPTIONS);
  assert.equal(partial.counts.deactivated, 0, "absence is not a leaver");
  assert.equal(partial.counts.unchanged, 1);

  // A leaver says so.
  const leaver = planDirectorySync([ada], [person({ active: false })], OPTIONS);
  assert.equal(leaver.counts.deactivated, 1);
  assert.equal(leaver.changes.find((change) => change.action === "deactivate")?.identityId, "id-a");

  // And somebody who comes back is switched back on, not created again.
  const returning = planDirectorySync([identity({ ...ada, active: false })], [person()], OPTIONS);
  assert.equal(returning.counts.reactivated, 1);
  assert.equal(returning.counts.created, 0);
});

test("directory: whose edit wins is a policy, and either way it is recorded", () => {
  // The identity was edited here *after* the last sync, so it is protected under
  // `preferLocal` and overwritten under `preferDirectory`.
  const editedLocally = identity({ externalId: "dir-1", displayName: "Ada (on the desk)", updatedAt: "2026-10-24T00:00:00.000Z" });
  const incoming = [person({ displayName: "Ada Lovelace" })];

  const keep = planDirectorySync([editedLocally], incoming, { ...OPTIONS, conflictPolicy: "preferLocal" });
  assert.equal(keep.counts.updated, 0);
  assert.equal(keep.counts.conflicts, 1, "keeping the local value is still a divergence somebody should see");
  assert.match(keep.changes.find((change) => change.action === "conflict")!.detail, /keeping the local/);
  assert.equal(keep.writes, false);

  const overwrite = planDirectorySync([editedLocally], incoming, { ...OPTIONS, conflictPolicy: "preferDirectory" });
  assert.equal(overwrite.counts.updated, 1);
  assert.ok(overwrite.changes.find((change) => change.action === "update")!.changes.includes("displayName"));

  // A directory that states no role does not get to overwrite one set here.
  const silent = planDirectorySync([identity({ externalId: "dir-1", role: "ADMIN" })], [person({ role: null })], OPTIONS);
  const roleChange = (silent.changes.find((change) => change.action === "update")?.changes ?? []).includes("role");
  assert.equal(roleChange, false);
});

test("directory: groups are planned complete, so a removal is visible", () => {
  const plan = planDirectorySync(
    [],
    [person({ externalId: "a", groups: ["Compilers", "Ops"] }), person({ externalId: "b", userName: "b@corp.test", groups: ["Ops"] })],
    OPTIONS,
  );
  assert.deepEqual(plan.groups, [
    { displayName: "Compilers", memberExternalIds: ["a"] },
    { displayName: "Ops", memberExternalIds: ["a", "b"] },
  ]);
});

/* -------------------------------------------------------------------------- */
/*  The service, over the real spine                                          */
/* -------------------------------------------------------------------------- */

let seq = 0;

function harness(reader: DirectoryReader) {
  const audit = new OrganizationAuditLog(sha256);
  const store = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-26T09:00:00.000Z");
  let n = 0;
  const tag = `d${++seq}`;
  const spine = new IdentityService(store, audit, {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const mfaIds: MfaIds = { id: () => `${tag}-f-${++n}`, secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", now: () => new Date(clock).toISOString(), nowMs: () => clock };
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit, mfaIds);
  const scimIds: ScimIds = { id: () => `${tag}-s-${++n}`, now: () => new Date(clock).toISOString(), nowMs: () => clock, token: () => `sc1_${"x".repeat(32)}` };
  const scim = new ScimService(new MemoryScimStore(), spine, { baseUrl: "https://id.sentinel.test/scim/v2" }, audit, null, scimIds);
  const directoryStore = new MemoryDirectoryStore();
  const directories = new DirectoryService(directoryStore, spine, scim, { ENTRA: reader, GENERIC: reader }, audit);
  // No console login in this harness: the directory reader is the last parameter, and the
  // two sign-in slots before it are the optional ones this deployment leaves unset.
  const console_ = new ConsoleService(spine, mfa, null, null, scim, null, null, directories);

  return {
    spine,
    mfa,
    scim,
    audit,
    directories,
    directoryStore,
    service: console_,
    entities: store,
    advance: (ms: number) => {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
      assert.ok((await spine.setMfaEnrolled(actor, actor.id, true)).ok);
      const session = await spine.issueSession(actor.organizationId, actor.id);
      assert.ok(session.ok, session.ok ? "" : session.error);
      return { actor, sessionId: session.value.id, organizationId: actor.organizationId };
    },
  };
}

function connectionRecord(over: Partial<DirectoryConnectionRecord> = {}): DirectoryConnectionRecord {
  return {
    id: "conn-1",
    organizationId: "org",
    name: "Entra ID",
    source: "ENTRA",
    settings: { url: "https://graph.microsoft.com/v1.0/users" },
    conflictPolicy: "preferDirectory",
    defaultRole: "AGENT",
    lastSyncedAt: null,
    hasSecret: false,
    createdBy: "root",
    createdAt: "2026-10-26T09:00:00.000Z",
    updatedAt: "2026-10-26T09:00:00.000Z",
    ...over,
  };
}

test("directory: a sync creates people, records the run, and moves the clock", async () => {
  const h = harness(staticDirectoryReader([person(), person({ externalId: "dir-2", userName: "grace@corp.test", displayName: "Grace" })]));
  const { actor, organizationId } = await h.organization("sync");

  const created = await h.directories.createConnection(actor, { name: "Entra ID", source: "ENTRA", settings: { url: "https://graph.microsoft.com/v1.0/users" } });
  assert.ok(created.ok, created.ok ? "" : created.error);
  assert.equal(created.value.lastSyncedAt, null);

  const run = await h.directories.sync(actor, created.value.id);
  assert.ok(run.ok, run.ok ? "" : run.error);
  assert.equal(run.value.applied.created, 2);
  assert.equal(run.value.dryRun, false);

  const listed = await h.spine.listIdentities(actor);
  assert.ok(listed.ok);
  const ada = listed.value.find((entry) => entry.identifier === "ada@corp.test");
  assert.ok(ada, "the person the directory named now exists here");
  assert.equal(ada.externalId, "dir-1");

  const runs = await h.directories.runs(actor, created.value.id);
  assert.ok(runs.ok);
  assert.equal(runs.value.length, 1);
  assert.equal(runs.value[0].status, "COMPLETED");
  assert.match(runs.value[0].detail ?? "", /2 created/);

  // The connection's clock moved, so a local edit from here on is protected.
  const connections = await h.directories.connections(actor);
  assert.ok(connections.ok);
  assert.ok(connections.value[0].lastSyncedAt, "a completed run advances the sync clock");

  // A second sync of the same roster changes nothing.
  const again = await h.directories.sync(actor, created.value.id);
  assert.ok(again.ok);
  assert.equal(again.value.applied.created + again.value.applied.updated, 0);
  assert.equal(again.value.plan.counts.unchanged, 2);

  const trail = h.audit.trail(organizationId).filter((event) => event.action === "directory.sync");
  assert.equal(trail.length, 2);
});

test("directory: a dry run writes nothing at all — not an identity, not a clock", async () => {
  const h = harness(staticDirectoryReader([person()]));
  const { actor } = await h.organization("preview");
  const created = await h.directories.createConnection(actor, { name: "Entra", source: "ENTRA", settings: { url: "https://graph.microsoft.com/v1.0/users" } });
  assert.ok(created.ok, created.ok ? "" : created.error);

  const preview = await h.directories.sync(actor, created.value.id, { dryRun: true });
  assert.ok(preview.ok, preview.ok ? "" : preview.error);
  assert.equal(preview.value.plan.counts.created, 1, "the plan is real");
  assert.equal(preview.value.applied.created, 0, "the write is not");

  const listed = await h.spine.listIdentities(actor);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1, "only the administrator exists");
  const runs = await h.directories.runs(actor);
  assert.ok(runs.ok);
  assert.equal(runs.value.length, 0, "a preview is not a run");
  const connections = await h.directories.connections(actor);
  assert.ok(connections.ok);
  assert.equal(connections.value[0].lastSyncedAt, null);
});

test("directory: a leaver is switched off through the SCIM path, sessions and all", async () => {
  const h = harness(staticDirectoryReader([person({ active: false, externalId: "dir-9", userName: "leaver@corp.test" })]));
  const { actor, organizationId } = await h.organization("leaver");
  const created = await h.directories.createConnection(actor, { name: "Entra", source: "ENTRA", settings: { url: "x" } });
  assert.ok(created.ok, created.ok ? "" : created.error);

  // The person exists here and holds a live session.
  const made = await h.spine.createIdentity(actor, { identifier: "leaver@corp.test", displayName: "Leaver", externalId: "dir-9" });
  assert.ok(made.ok, made.ok ? "" : made.error);
  // The enrolled flag stands in for a real factor: this test is about the leaver path,
  // and under the default policy a session cannot exist without one.
  assert.ok((await h.spine.setMfaEnrolled(actor, made.value.id, true)).ok);
  const session = await h.spine.issueSession(organizationId, made.value.id);
  assert.ok(session.ok, session.ok ? "" : session.error);

  const run = await h.directories.sync(actor, created.value.id);
  assert.ok(run.ok, run.ok ? "" : run.error);
  assert.equal(run.value.applied.deactivated, 1);

  const after = await h.spine.listIdentities(actor);
  assert.ok(after.ok);
  assert.equal(after.value.find((entry) => entry.id === made.value.id)?.active, false);

  // The session is ended, which is the whole reason this goes through SCIM.
  const check = await h.spine.checkSession(organizationId, session.value.id);
  assert.equal(check.active, false);

  const trail = h.audit.trail(organizationId);
  assert.ok(trail.some((event) => event.action === "scim.deprovision"), "the leaver path is the SCIM one, not a second implementation");
});

test("directory: groups are written complete, so a removal from a group is heard", async () => {
  const h = harness(staticDirectoryReader([person({ externalId: "dir-1", groups: ["Compilers"] })]));
  const { actor } = await h.organization("groups");
  const created = await h.directories.createConnection(actor, { name: "Entra", source: "ENTRA", settings: { url: "x" } });
  assert.ok(created.ok, created.ok ? "" : created.error);

  const first = await h.directories.sync(actor, created.value.id);
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.equal(first.value.applied.groups, 1);

  const groups = await h.scim.listGroupsForActor(actor);
  assert.ok(groups.ok, groups.ok ? "" : groups.error);
  assert.equal(groups.value[0].displayName, "Compilers");
  assert.equal(groups.value[0].memberCount, 1);
});

test("directory: a failed pull is recorded as failed, and the clock does not move", async () => {
  const failing: DirectoryReader = { async pull() { return { ok: false, error: "the directory answered 503 while listing people" }; } };
  const h = harness(failing);
  const { actor, organizationId } = await h.organization("failed");
  const created = await h.directories.createConnection(actor, { name: "Entra", source: "ENTRA", settings: { url: "x" } });
  assert.ok(created.ok, created.ok ? "" : created.error);

  const run = await h.directories.sync(actor, created.value.id);
  assert.equal(run.ok, false);
  if (!run.ok) assert.match(run.error, /503/);

  const runs = await h.directories.runs(actor, created.value.id);
  assert.ok(runs.ok);
  assert.equal(runs.value[0].status, "FAILED");
  assert.match(runs.value[0].detail ?? "", /503/);

  const connections = await h.directories.connections(actor);
  assert.ok(connections.ok);
  assert.equal(connections.value[0].lastSyncedAt, null, "a failed sync must not stop protecting local edits");
  assert.ok(h.audit.trail(organizationId).some((event) => event.action === "directory.sync.failed"));
});

test("directory: a source with no reader is refused at connection time, not at 02:00", async () => {
  const h = harness(staticDirectoryReader([person()]));
  const { actor } = await h.organization("nosource");

  const ldap = await h.directories.createConnection(actor, { name: "AD", source: "LDAP", settings: { host: "dc01" } });
  assert.equal(ldap.ok, false);
  if (!ldap.ok) assert.match(ldap.error, /no reader for LDAP/);

  assert.deepEqual(h.directories.sources().sort(), ["ENTRA", "GENERIC"]);

  const bad = await h.directories.createConnection(actor, { name: "", source: "ENTRA" });
  assert.equal(bad.ok, false);
});

test("directory: only an administrator may read or run a connection", async () => {
  const h = harness(staticDirectoryReader([person()]));
  const { actor, organizationId } = await h.organization("guard");
  const agent = await h.spine.createIdentity(actor, { identifier: "agent@guard.test", displayName: "Agent" });
  assert.ok(agent.ok, agent.ok ? "" : agent.error);
  const agentActor: IdentityActor = { id: agent.value.id, organizationId, role: "AGENT" };

  const refused = await h.directories.connections(agentActor);
  assert.equal(refused.ok, false);
  const created = await h.directories.createConnection(actor, { name: "Entra", source: "ENTRA", settings: { url: "x" } });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const run = await h.directories.sync(agentActor, created.value.id);
  assert.equal(run.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The HTTP reader                                                           */
/* -------------------------------------------------------------------------- */

/** A fake fetch that answers each URL from a table and remembers what it was asked. */
function fakeFetch(routes: Record<string, { status?: number; body: string }>): { fetch: FetchLike; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body });
      const route = routes[url];
      if (!route) return { ok: false, status: 404, text: async () => "not found" };
      const status = route.status ?? 200;
      return { ok: status < 400, status, text: async () => route.body };
    },
  };
}

test("reader: pages are followed through the provider's own next-link", async () => {
  const { fetch, calls } = fakeFetch({
    "https://graph.microsoft.com/v1.0/users": {
      body: JSON.stringify({
        value: [{ id: "1", userPrincipalName: "a@corp.test" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=2",
      }),
    },
    "https://graph.microsoft.com/v1.0/users?$skiptoken=2": {
      body: JSON.stringify({ value: [{ id: "2", userPrincipalName: "b@corp.test" }, { displayName: "no id" }] }),
    },
  });

  const reader = createHttpDirectoryReader({ fetch });
  const pull = await reader.pull(connectionRecord(), "token-123");
  assert.ok(pull.ok, pull.ok ? "" : pull.error);
  assert.deepEqual(pull.people.map((entry) => entry.externalId), ["1", "2"]);
  assert.equal(pull.skipped.length, 1, "the record with no id is reported rather than guessed at");
  assert.equal(calls.length, 2);
});

test("reader: a client-credentials secret is exchanged for a token, not sent as one", async () => {
  const { fetch, calls } = fakeFetch({
    "https://login.microsoftonline.com/tenant/oauth2/v2.0/token": {
      body: JSON.stringify({ access_token: "minted-token" }),
    },
    "https://graph.microsoft.com/v1.0/users": { body: JSON.stringify({ value: [{ id: "1", userPrincipalName: "a@corp.test" }] }) },
  });

  const reader = createHttpDirectoryReader({ fetch });
  const pull = await reader.pull(
    connectionRecord({
      settings: {
        url: "https://graph.microsoft.com/v1.0/users",
        auth: "clientCredentials",
        clientId: "app-1",
        tokenUrl: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        scope: "https://graph.microsoft.com/.default",
      },
      hasSecret: true,
    }),
    "shh",
  );
  assert.ok(pull.ok, pull.ok ? "" : pull.error);
  assert.equal(pull.people.length, 1);
  assert.match(calls[0].body ?? "", /grant_type=client_credentials/);
  assert.ok(calls[0].body?.includes("client_secret=shh"));
});

test("reader: a page that is not JSON is an error, not an empty roster", async () => {
  const { fetch } = fakeFetch({ "https://x.test/users": { body: "<html>sign in</html>" } });
  const reader = createHttpDirectoryReader({ fetch });
  const pull = await reader.pull(connectionRecord({ settings: { url: "https://x.test/users", auth: "none" } }), null);
  assert.equal(pull.ok, false);
  if (!pull.ok) assert.match(pull.error, /not JSON/);

  // An HTTP failure names the status rather than reporting nobody.
  const down = createHttpDirectoryReader({ fetch: fakeFetch({ "https://x.test/users": { status: 503, body: "{}" } }).fetch });
  const refused = await down.pull(connectionRecord({ settings: { url: "https://x.test/users", auth: "none" } }), null);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /503/);

  // And a missing setting is refused by name.
  const incomplete = await createHttpDirectoryReader({ fetch: fakeFetch({}).fetch }).pull(
    connectionRecord({ settings: { auth: "none" } }),
    null,
  );
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.match(incomplete.error, /no “url” setting/);
});

test("reader: a credential is required unless the connection says it needs none", async () => {
  const reader = createHttpDirectoryReader({ fetch: fakeFetch({}).fetch });
  const refused = await reader.pull(connectionRecord({ settings: { url: "https://x.test/users" }, hasSecret: false }), null);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /needs a credential/);

  const unknown = await reader.pull(connectionRecord({ settings: { url: "https://x.test/users", auth: "kerberos" } }), "s");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /not an authentication mode/);
});

/* -------------------------------------------------------------------------- */
/*  The console page                                                          */
/* -------------------------------------------------------------------------- */

function get(path: string, cookie?: string): HttpRequest {
  return { method: "GET", url: `https://id.sentinel.test${path}`, headers: {}, cookies: cookie ? { [CONSOLE_SESSION_COOKIE]: cookie } : {} };
}

function post(path: string, body: string, cookie?: string): HttpRequest {
  return {
    method: "POST",
    url: `https://id.sentinel.test${path}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: cookie ? { [CONSOLE_SESSION_COOKIE]: cookie } : {},
    body,
  };
}

test("console: a directory is connected, previewed in place and synced with a redirect", async () => {
  const h = harness(staticDirectoryReader([person()]));
  const { sessionId } = await h.organization("page");

  const page = await routeConsole(get(CONSOLE_PATHS.directory, sessionId), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /Read a directory/);
  assert.match(page.body, /Entra/);
  assert.doesNotMatch(page.body, /value="LDAP"/, "only the sources this deployment can read are offered");

  const connected = await routeConsole(
    post(
      CONSOLE_PATHS.directoryConnect,
      "name=Entra+ID&source=ENTRA&url=https%3A%2F%2Fgraph.microsoft.com%2Fv1.0%2Fusers&auth=bearer&conflictPolicy=preferLocal&defaultRole=AGENT&secret=shh",
      sessionId,
    ),
    h.service,
  );
  assert.equal(connected.status, 303);
  assert.match(decodeURIComponent(connected.headers.location), /Connected Entra ID/);

  const after = await routeConsole(get(CONSOLE_PATHS.directory, sessionId), h.service);
  assert.match(after.body, /Entra ID/);
  assert.match(after.body, /preferLocal/);

  // The connection id the page holds is the one the store holds.
  const page2 = await h.service.directory(sessionId);
  assert.ok(page2.ok, page2.ok ? "" : page2.error);
  const connectionId = page2.value.connections[0].id;

  // A preview answers with a body, so it can be repeated safely.
  const preview = await routeConsole(post(CONSOLE_PATHS.directorySync, `connectionId=${connectionId}&dryRun=1`, sessionId), h.service);
  assert.equal(preview.status, 200);
  assert.match(preview.body, /Preview — nothing was written/);
  assert.match(preview.body, /Create ada@corp.test/);

  // A real sync redirects, because answering with a body would sync again on refresh.
  const synced = await routeConsole(post(CONSOLE_PATHS.directorySync, `connectionId=${connectionId}`, sessionId), h.service);
  assert.equal(synced.status, 303);
  assert.match(decodeURIComponent(synced.headers.location), /1 created/);

  const runsPage = await routeConsole(get(CONSOLE_PATHS.directory, sessionId), h.service);
  assert.match(runsPage.body, /COMPLETED/);

  const removed = await routeConsole(post(CONSOLE_PATHS.directoryRemove, `connectionId=${connectionId}`, sessionId), h.service);
  assert.equal(removed.status, 303);
  assert.match(decodeURIComponent(removed.headers.location), /Removed Entra ID/);

  const anonymous = await routeConsole(get(CONSOLE_PATHS.directory), h.service);
  assert.equal(anonymous.status, 401);
});
