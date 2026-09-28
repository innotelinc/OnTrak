/**
 * OnTrak Tix M4 tests: one desk serving many clients.
 *
 * Covers the two things M4 actually changes: the promise a client is judged
 * against (a client's SLA policy outranking the queue's and the desk's, with the
 * winning rung named), and the scope that keeps two clients apart — including
 * the guardrails on the most dangerous convenience in an MSP helpdesk, looking
 * through a client's eyes.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-clients.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  ACT_AS_TTL_MINUTES,
  actAsActive,
  actAsClientDecision,
  actAsExpiry,
  canSeeClient,
  clientScopeFor,
  scopeByClient,
  validateClient,
  validateContact,
  type ClientAssignmentRecord,
} from "../src/lib/client-rules";
import { ClientService, MemoryClientStore, type ClientStore } from "../src/lib/client-service";
import { resolveSlaPolicy, weekdayCalendar, type SlaPolicy } from "../src/lib/sla-rules";
import { toClientRecord, toActAsRecord, toAssignmentRecord, type ClientRow } from "../src/lib/client-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const OTHER_AGENT = { id: "agent-2", tenantId: "tenant-a", role: "AGENT" as const };
const OTHER_ADMIN = { id: "admin-2", tenantId: "tenant-a", role: "ADMIN" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const NOW = "2026-09-20T12:00:00.000Z";

/* ------------------------------------------------------------------- the SLA */

function policy(overrides: Partial<SlaPolicy> = {}): SlaPolicy {
  return {
    id: "p-default",
    name: "Desk default",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    calendar: weekdayCalendar("default"),
    warningFraction: 0.2,
    ...overrides,
  };
}

test("a client's own policy outranks the queue's and the desk's, and says which rung won", () => {
  const policies: SlaPolicy[] = [
    policy({ id: "p-client-high", name: "Northwind HIGH", priority: "HIGH", responseMinutes: 60, resolutionMinutes: 480, clientId: "client-1" }),
    policy({ id: "p-client-any", name: "Northwind contract", responseMinutes: 120, resolutionMinutes: 960, clientId: "client-1" }),
    policy({ id: "p-queue-high", name: "Tier 2 HIGH", priority: "HIGH", responseMinutes: 90, resolutionMinutes: 600, queueId: "queue-1" }),
    policy({ id: "p-tenant-high", name: "Desk HIGH", priority: "HIGH", responseMinutes: 180, resolutionMinutes: 720 }),
    policy({ id: "p-tenant-any", name: "Desk default" }),
  ];

  // Most specific first: the client's priority policy.
  const clientHigh = resolveSlaPolicy({ policies, priority: "HIGH", clientId: "client-1", queueId: "queue-1" });
  assert.equal(clientHigh.policy?.id, "p-client-high");
  assert.equal(clientHigh.scope, "client");
  assert.equal(clientHigh.because, "the client's HIGH policy");

  // A priority the client has no policy for falls to their standing contract…
  const clientNormal = resolveSlaPolicy({ policies, priority: "NORMAL", clientId: "client-1", queueId: "queue-1" });
  assert.equal(clientNormal.policy?.id, "p-client-any");
  assert.equal(clientNormal.scope, "client");
  assert.equal(clientNormal.because, "the client's policy for any priority");

  // …and another client gets the queue's promise, then the desk's.
  const otherClient = resolveSlaPolicy({ policies, priority: "HIGH", clientId: "client-2", queueId: "queue-1" });
  assert.equal(otherClient.policy?.id, "p-queue-high");
  assert.equal(otherClient.scope, "queue");

  const noQueue = resolveSlaPolicy({ policies, priority: "HIGH", clientId: "client-2" });
  assert.equal(noQueue.policy?.id, "p-tenant-high");
  assert.equal(noQueue.scope, "tenant");

  // A ticket with no client and no queue resolves exactly as it did before M4.
  const plain = resolveSlaPolicy({ policies, priority: "HIGH" });
  assert.equal(plain.policy?.id, "p-tenant-high");
  assert.equal(resolveSlaPolicy({ policies, priority: "LOW" }).policy?.id, "p-tenant-any");

  // Nothing covers it, and the resolver says so rather than inventing a promise.
  const none = resolveSlaPolicy({ policies: [policy({ id: "p-client", clientId: "client-9" })], priority: "HIGH" });
  assert.equal(none.policy, null);
  assert.equal(none.scope, "none");
  assert.match(none.because, /no policy covers this ticket/);
});

/* ----------------------------------------------------------------- the scope */

function assignment(clientId: string, userId: string): ClientAssignmentRecord {
  return {
    id: `as-${clientId}-${userId}`,
    tenantId: "tenant-a",
    clientId,
    userId,
    assignedBy: "admin-1",
    assignedAt: NOW,
  };
}

test("an agent sees their clients, a dispatcher sees every client, and unassigned work stays visible", () => {
  const assignments = [assignment("client-1", "agent-1"), assignment("client-2", "agent-2")];

  const admin = clientScopeFor({ role: "ADMIN", userId: "admin-1", assignments });
  assert.equal(admin.kind, "all");
  assert.equal(canSeeClient(admin, "client-2"), true);
  assert.match(admin.because, /runs the desk/);

  const dispatcher = clientScopeFor({ role: "DISPATCHER", userId: "dispatcher-1", assignments });
  assert.equal(dispatcher.kind, "all");

  const agent = clientScopeFor({ role: "AGENT", userId: "agent-1", assignments });
  assert.equal(agent.kind, "assigned");
  assert.deepEqual(agent.clientIds, ["client-1"]);
  assert.equal(canSeeClient(agent, "client-1"), true);
  assert.equal(canSeeClient(agent, "client-2"), false);
  assert.match(agent.because, /assigned to 1 client/);

  // The desk's own work — a ticket with no client on it — is nobody's client's,
  // so hiding it would hide the desk's own backlog.
  assert.equal(canSeeClient(agent, null), true);
  assert.equal(canSeeClient(agent, undefined), true);

  const rows = [{ clientId: "client-1" }, { clientId: "client-2" }, { clientId: null }];
  assert.deepEqual(scopeByClient(agent, rows), [{ clientId: "client-1" }, { clientId: null }]);

  // An agent with no assignments sees only unassigned work, and is told so.
  const loner = clientScopeFor({ role: "AGENT", userId: "agent-9", assignments });
  assert.deepEqual(loner.clientIds, []);
  assert.match(loner.because, /only unassigned work/);
  // A requester is not given a desk scope at all; their tickets are scoped elsewhere.
  assert.equal(clientScopeFor({ role: "REQUESTER", userId: "req-1", assignments }).kind, "assigned");
});

test("acting as a client takes a permission, a visible client, a reason and a free slot", () => {
  const scope = clientScopeFor({ role: "DISPATCHER", userId: "dispatcher-1", assignments: [] });

  assert.equal(
    actAsClientDecision({ role: "AGENT", scope, clientId: "client-1", reason: "reproduce", active: null, now: NOW }).allowed,
    false,
  );
  assert.equal(
    actAsClientDecision({ role: "DISPATCHER", scope, clientId: "", reason: "reproduce", active: null, now: NOW }).allowed,
    false,
  );
  assert.equal(
    actAsClientDecision({ role: "DISPATCHER", scope, clientId: "client-1", reason: "  ", active: null, now: NOW }).allowed,
    false,
  );
  assert.match(
    actAsClientDecision({ role: "DISPATCHER", scope, clientId: "client-1", reason: "x", active: null, now: NOW }).reason,
    /needs a reason/,
  );

  // Act-as is not a way around the scope.
  const agentScope = clientScopeFor({ role: "AGENT", userId: "agent-1", assignments: [assignment("client-1", "agent-1")] });
  const outside = actAsClientDecision({ role: "DISPATCHER", scope: agentScope, clientId: "client-2", reason: "looking", active: null, now: NOW });
  assert.equal(outside.allowed, false);
  assert.match(outside.reason, /not a way around the client scope/);

  // …and only one window at a time.
  const busy = actAsClientDecision({
    role: "DISPATCHER",
    scope,
    clientId: "client-1",
    reason: "looking",
    active: { clientId: "client-2", expiresAt: "2026-09-20T12:10:00.000Z" },
    now: NOW,
  });
  assert.equal(busy.allowed, false);
  assert.match(busy.reason, /Already acting as a client/);

  // An expired window is not in the way.
  const expired = actAsClientDecision({
    role: "DISPATCHER",
    scope,
    clientId: "client-1",
    reason: "looking",
    active: { clientId: "client-2", expiresAt: "2026-09-20T11:00:00.000Z" },
    now: NOW,
  });
  assert.equal(expired.allowed, true);
  assert.equal(actAsExpiry(NOW), "2026-09-20T12:30:00.000Z");
  assert.equal(ACT_AS_TTL_MINUTES, 30);
});

/* ------------------------------------------------------------------ the data */

test("a client and a contact are validated before anyone is asked to reply to them", () => {
  assert.match(validateClient({})[0].message, /client name is required/);
  assert.match(validateClient({ name: " x".repeat(70) })[0].message, /at most 120 characters/);
  assert.deepEqual(validateClient({ name: "Northwind" }), []);

  assert.match(validateContact({ email: "a@b.test" })[0].message, /contact name is required/);
  assert.match(validateContact({ name: "Dana" })[0].message, /email address is required/);
  assert.match(validateContact({ name: "Dana", email: "dana@" })[0].message, /not an email address a reply can reach/);
  assert.match(validateContact({ name: "Dana", email: "dana@northwind" })[0].message, /not an email address a reply can reach/);
  assert.match(validateContact({ name: "Dana", email: "dana @northwind.test" })[0].message, /not an email address/);
  assert.deepEqual(validateContact({ name: "Dana", email: "dana@northwind.test" }), []);
});

/* --------------------------------------------------------------- the service */

async function harness() {
  const audit = new AuditLog(sha256);
  const store: ClientStore = new MemoryClientStore();
  let n = 0;
  let clock = NOW;
  const service = new ClientService(store, audit, {
    id: () => `id-${++n}`,
    now: () => clock,
  });
  return { service, store, audit, tick: (at: string) => (clock = at) };
}

test("the service scopes what it returns rather than trusting the caller to filter", async () => {
  const h = await harness();
  const northwind = await h.service.create(ADMIN, { name: "Northwind Logistics" });
  const contoso = await h.service.create(ADMIN, { name: "Contoso Retail" });
  assert.equal(northwind.ok, true);
  assert.equal(contoso.ok, true);
  if (!northwind.ok || !contoso.ok) return;

  await h.service.addContact(ADMIN, northwind.value.id, { name: "Dana Blythe", email: "Dana@Northwind.test" });
  await h.service.assign(ADMIN, northwind.value.id, "agent-1");

  // A dispatcher sees both; an agent sees the one they serve; a requester none.
  const adminList = await h.service.list(ADMIN);
  assert.equal(adminList.ok, true);
  if (adminList.ok) {
    assert.deepEqual(adminList.value.map((entry) => entry.client.name), ["Contoso Retail", "Northwind Logistics"]);
    assert.equal(adminList.value.find((entry) => entry.client.id === northwind.value.id)?.contacts[0].email, "Dana@Northwind.test");
    assert.equal(adminList.value.find((entry) => entry.client.id === northwind.value.id)?.assignments.length, 1);
  }

  const agentList = await h.service.list(AGENT);
  assert.equal(agentList.ok, true);
  if (agentList.ok) assert.deepEqual(agentList.value.map((entry) => entry.client.name), ["Northwind Logistics"]);

  const otherList = await h.service.list(OTHER_AGENT);
  assert.equal(otherList.ok, true);
  if (otherList.ok) assert.deepEqual(otherList.value, []);

  // canSee is the same rule, available to a page that has an id in hand.
  assert.equal(await h.service.canSee(AGENT, northwind.value.id), true);
  assert.equal(await h.service.canSee(AGENT, contoso.value.id), false);
  assert.equal(await h.service.canSee(ADMIN, contoso.value.id), true);

  const denied = await h.service.list(REQUESTER);
  assert.equal(denied.ok, false);
});

test("clients, contacts and assignments are managed, refused and recorded", async () => {
  const h = await harness();
  const created = await h.service.create(ADMIN, { name: "  Northwind Logistics  " });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.name, "Northwind Logistics");

  // A duplicate name is how somebody picks the wrong client, so it is refused.
  const duplicate = await h.service.create(ADMIN, { name: "northwind logistics" });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /already exists/);

  // Only a client manager writes.
  assert.equal((await h.service.create(AGENT, { name: "Nope" })).ok, false);
  assert.equal((await h.service.addContact(AGENT, created.value.id, { name: "x", email: "x@y.test" })).ok, false);
  assert.equal((await h.service.assign(AGENT, created.value.id, "agent-1")).ok, false);

  // A contact at an unknown client, and the same address twice, are refusals.
  assert.equal((await h.service.addContact(ADMIN, "made-up", { name: "Dana", email: "d@y.test" })).ok, false);
  const contact = await h.service.addContact(ADMIN, created.value.id, { name: "Dana", email: "dana@y.test" });
  assert.equal(contact.ok, true);
  const again = await h.service.addContact(ADMIN, created.value.id, { name: "Dana again", email: "DANA@y.test" });
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /already a contact of this client/);

  const assignment = await h.service.assign(ADMIN, created.value.id, "agent-1");
  assert.equal(assignment.ok, true);
  assert.equal((await h.service.assign(ADMIN, created.value.id, "agent-1")).ok, false);
  assert.equal((await h.service.assign(ADMIN, "made-up", "agent-1")).ok, false);

  const removed = await h.service.unassign(ADMIN, created.value.id, "agent-1");
  assert.equal(removed.ok, true);
  assert.equal((await h.service.unassign(ADMIN, created.value.id, "agent-1")).ok, false);
  assert.deepEqual((await h.service.list(AGENT)).ok && (await h.service.list(AGENT)), (await h.service.list(AGENT)));

  // Every one of those writes is on the audit chain, with names against it.
  const actions = h.audit.snapshot().events.map((event) => event.action);
  assert.ok(actions.includes("client.create"));
  assert.ok(actions.includes("client.contact.add"));
  assert.ok(actions.includes("client.assign"));
  assert.ok(actions.includes("client.unassign"));
  assert.equal(actions.filter((action) => action === "client.unassign").length, 1);
});

test("an act-as window is opened, refused twice over, and closed on the record", async () => {
  const h = await harness();
  const northwind = await h.service.create(ADMIN, { name: "Northwind Logistics" });
  assert.equal(northwind.ok, true);
  if (!northwind.ok) return;

  // A dispatcher may act as a client; an agent may not, even for their own client.
  await h.service.assign(ADMIN, northwind.value.id, "agent-1");
  const agentTry = await h.service.startActingAs(AGENT, northwind.value.id, "checking something");
  assert.equal(agentTry.ok, false);
  if (!agentTry.ok) assert.match(agentTry.error, /role that manages clients/);

  const started = await h.service.startActingAs(ADMIN, northwind.value.id, "reproducing their complaint");
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.expiresAt, "2026-09-20T12:30:00.000Z");
  assert.equal(started.value.endedAt, null);

  // The window is live, a second one is refused, and it is what the console reads.
  const active = await h.service.activeActAs(ADMIN);
  assert.equal(active?.id, started.value.id);
  const second = await h.service.startActingAs(ADMIN, northwind.value.id, "again");
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /Already acting as a client/);

  // It cannot be closed by somebody else, and closing it frees the slot.
  const someoneElse = await h.service.endActingAs(OTHER_ADMIN, started.value.id, "not mine to close");
  assert.equal(someoneElse.ok, false);
  if (!someoneElse.ok) assert.match(someoneElse.error, /belongs to somebody else/);
  const ended = await h.service.endActingAs(ADMIN, started.value.id, "done looking");
  assert.equal(ended.ok, true);
  if (ended.ok) {
    assert.equal(ended.value.endReason, "done looking");
    assert.equal(ended.value.endedAt, NOW);
  }
  assert.equal(await h.service.activeActAs(ADMIN), null);
  assert.equal((await h.service.endActingAs(ADMIN, started.value.id)).ok, false);

  // A window that times out on its own also stops being active.
  const later = await h.service.startActingAs(ADMIN, northwind.value.id, "a second look");
  assert.equal(later.ok, true);
  if (!later.ok) return;
  h.tick("2026-09-20T12:31:00.000Z");
  assert.equal(await h.service.activeActAs(ADMIN), null);
  assert.equal(actAsActive({ ...later.value, endedAt: null, expiresAt: "2026-09-20T12:30:00.000Z" }, "2026-09-20T12:31:00.000Z"), false);

  const actions = h.audit.snapshot().events.map((event) => event.action);
  assert.equal(actions.filter((action) => action === "client.act_as.start").length, 2);
  assert.equal(actions.filter((action) => action === "client.act_as.end").length, 1);
  const start = h.audit.snapshot().events.find((event) => event.action === "client.act_as.start")!;
  assert.equal(start.detail?.reason, "reproducing their complaint");
});

/* ------------------------------------------------------------------ the adapter */

test("the Prisma adapter maps rows to records without leaking a Date", () => {
  const row: ClientRow = { id: "c1", tenantId: "tenant-a", name: "Northwind", createdAt: new Date("2026-09-20T12:00:00.000Z") };
  assert.deepEqual(toClientRecord(row), {
    id: "c1",
    tenantId: "tenant-a",
    name: "Northwind",
    createdAt: "2026-09-20T12:00:00.000Z",
  });

  const assignment = toAssignmentRecord({
    id: "a1",
    tenantId: "tenant-a",
    clientId: "c1",
    userId: "agent-1",
    assignedBy: "admin-1",
    assignedAt: new Date("2026-09-20T12:00:00.000Z"),
  });
  assert.equal(assignment.assignedAt, "2026-09-20T12:00:00.000Z");

  const window = toActAsRecord({
    id: "w1",
    tenantId: "tenant-a",
    clientId: "c1",
    actorId: "admin-1",
    reason: "looking",
    startedAt: new Date("2026-09-20T12:00:00.000Z"),
    expiresAt: new Date("2026-09-20T12:30:00.000Z"),
    endedAt: null,
    endReason: null,
  });
  assert.equal(window.endedAt, null);
  assert.equal(window.expiresAt, "2026-09-20T12:30:00.000Z");
});
