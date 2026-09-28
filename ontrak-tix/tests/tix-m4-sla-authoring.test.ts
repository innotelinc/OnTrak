/**
 * OnTrak Tix M4 tests: the promises the desk writes for itself and for a client.
 *
 * M1's policies could only be seeded, which is fine for one internal team and
 * useless for an MSP whose promises differ per client. This covers the write
 * path: what is refused before it is in force, what an edit may not silently
 * change, why a promise tickets depend on cannot be deleted, and who is allowed
 * to do any of it.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-sla-authoring.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import { ClientService, MemoryClientStore } from "../src/lib/client-service";
import { ALWAYS_OPEN_CALENDAR, isOpenAt, resolveSlaPolicy, weekdayCalendar } from "../src/lib/sla-rules";
import {
  calendarFor,
  describeScope,
  MemorySlaPolicyStore,
  SlaPolicyService,
  type SlaPolicyStore,
} from "../src/lib/sla-policy-service";
import {
  PrismaSlaPolicyStore,
  toSlaPolicy,
  toSlaPolicyData,
  type SlaPolicyPrismaClient,
  type SlaPolicyRow,
} from "../src/lib/sla-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const DISPATCHER = { id: "dispatcher-1", tenantId: "tenant-a", role: "DISPATCHER" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const OTHER_ADMIN = { id: "admin-9", tenantId: "tenant-b", role: "ADMIN" as const };
/** A Sunday, so the weekly calendar is closed and the 24×7 one is not. */
const SUNDAY_NOON = "2026-09-20T12:00:00.000Z";
const MONDAY_NOON = "2026-09-21T12:00:00.000Z";
const NOW = SUNDAY_NOON;

function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemorySlaPolicyStore();
  const clients = new ClientService(new MemoryClientStore(), audit, { id: () => "client-row", now: () => NOW });
  let n = 0;
  const service = new SlaPolicyService(store, audit, clients, { id: () => `policy-${++n}`, now: () => NOW });
  return { service, store, clients, audit };
}

/** A real client row: a promise may only name a client the desk actually has. */
async function clientFor(h: ReturnType<typeof harness>, name = "Northwind"): Promise<string> {
  const created = await h.clients.create(ADMIN, { name });
  if (!created.ok) throw new Error(`could not create ${name}: ${created.error}`);
  return created.value.id;
}

/** The shape every authoring call needs, so a test only states what it is about. */
function promise(overrides: Partial<Parameters<SlaPolicyService["create"]>[1]> = {}) {
  return {
    name: "Desk default",
    responseMinutes: 240,
    resolutionMinutes: 1_440,
    ...overrides,
  };
}

/* --------------------------------------------------------------- the ladder */

test("a promise written for a client outranks the desk's own, and says which rung won", async () => {
  const h = await harness();
  const northwind = await clientFor(h);
  const desk = await h.service.create(ADMIN, promise());
  const contract = await h.service.create(
    ADMIN,
    promise({ name: "Northwind contract", clientId: northwind, responseMinutes: 60, resolutionMinutes: 480, hours: "always" }),
  );
  assert.equal(desk.ok, true);
  assert.equal(contract.ok, true);
  if (!desk.ok || !contract.ok) return;

  const policies = await h.service.list(ADMIN);
  assert.equal(policies.ok, true);
  if (!policies.ok) return;

  const mine = resolveSlaPolicy({ policies: policies.value, priority: "NORMAL", clientId: northwind });
  assert.equal(mine.policy?.id, contract.value.id);
  assert.equal(mine.scope, "client");
  assert.equal(mine.because, "the client's policy for any priority");

  // Another client falls through to the desk's own promise rather than inheriting
  // a contract it never signed.
  const theirs = resolveSlaPolicy({ policies: policies.value, priority: "NORMAL", clientId: "client-2" });
  assert.equal(theirs.policy?.id, desk.value.id);
  assert.equal(theirs.scope, "tenant");

  // The console's one-line description, which is what a reader checks a scope on.
  assert.equal(describeScope(contract.value), "this client, any priority");
  assert.equal(describeScope(desk.value), "the desk, any priority");
  assert.equal(describeScope({ ...desk.value, queueId: "queue-1", priority: "URGENT" }), "its queue, URGENT only");

  // The client's promise was written on 24×7 hours, so it is running on a Sunday.
  assert.equal(isOpenAt(SUNDAY_NOON, contract.value.calendar), true);
  assert.equal(isOpenAt(SUNDAY_NOON, desk.value.calendar), false);
  assert.equal(isOpenAt(MONDAY_NOON, desk.value.calendar), true);
});

/* ------------------------------------------------------------ what is refused */

test("a promise is refused before it is in force, in words a person can act on", async () => {
  const h = await harness();

  const noName = await h.service.create(ADMIN, promise({ name: "   " }));
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.match(noName.error, /policy name is required/);

  const tooLong = await h.service.create(ADMIN, promise({ name: "x".repeat(121) }));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /at most 120 characters/);

  // A blank field is not a zero: it is a promise nobody has stated yet.
  const blank = await h.service.create(ADMIN, promise({ responseMinutes: "" }));
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.error, /zero or more minutes/);

  const zero = await h.service.create(ADMIN, promise({ resolutionMinutes: 0 }));
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.match(zero.error, /A promise of zero minutes is not a promise/);

  const backwards = await h.service.create(ADMIN, promise({ responseMinutes: 480, resolutionMinutes: 60 }));
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.match(backwards.error, /Resolution cannot be due before the first response/);

  const nonsense = await h.service.create(ADMIN, promise({ priority: "SOMEDAY" as never }));
  assert.equal(nonsense.ok, false);
  if (!nonsense.ok) assert.match(nonsense.error, /not a priority this desk uses/);

  const badFraction = await h.service.create(ADMIN, promise({ warningFraction: 4 }));
  assert.equal(badFraction.ok, false);
  if (!badFraction.ok) assert.match(badFraction.error, /between 0 and 1/);

  // Nothing above was stored.
  const stored = await h.service.list(ADMIN);
  assert.equal(stored.ok && stored.value.length, 0);

  // Two promises with the same name are one argument, so the second is refused —
  // case-insensitively, because nobody reads the two as different promises.
  const first = await h.service.create(ADMIN, promise({ name: "Northwind contract" }));
  assert.equal(first.ok, true);
  const duplicate = await h.service.create(ADMIN, promise({ name: "northwind CONTRACT" }));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /already has a promise called/);
});

test("the hours are a choice, not a form, and a promise is measured in them", () => {
  const business = calendarFor("business");
  assert.equal(business.name, "Weekdays 09:00–17:00");
  assert.deepEqual(business.week, weekdayCalendar("x").week);
  assert.equal(isOpenAt(SUNDAY_NOON, business), false);

  assert.equal(calendarFor("always"), ALWAYS_OPEN_CALENDAR);
  assert.equal(isOpenAt(SUNDAY_NOON, calendarFor("always")), true);
  assert.equal(isOpenAt("2026-09-21T02:00:00.000Z", calendarFor("business")), false);
});

/* -------------------------------------------------------------- what an edit may not change */

test("an edit keeps the scope it does not mention, and keeps its own identity", async () => {
  const h = await harness();
  const northwind = await clientFor(h);
  const contract = await h.service.create(ADMIN, promise({ name: "Northwind contract", clientId: northwind }));
  const queue = await h.service.create(ADMIN, promise({ name: "Tier 2", queueId: "queue-1" }));
  assert.equal(contract.ok, true);
  assert.equal(queue.ok, true);
  if (!contract.ok || !queue.ok) return;

  // A form that carries only the numbers must not turn a client's promise into
  // the desk's, or a queue's into everybody's.
  const edited = await h.service.update(ADMIN, contract.value.id, promise({ name: "Northwind contract", responseMinutes: 30 }));
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.value.id, contract.value.id);
  assert.equal(edited.value.clientId, northwind);
  assert.equal(edited.value.responseMinutes, 30);
  assert.equal(edited.value.resolutionMinutes, 1_440);

  const queueEdited = await h.service.update(ADMIN, queue.value.id, promise({ name: "Tier 2", hours: "always" }));
  assert.equal(queueEdited.ok, true);
  if (queueEdited.ok) assert.equal(queueEdited.value.queueId, "queue-1");

  // A rename onto another promise's name is refused; onto itself is fine.
  await h.service.create(ADMIN, promise({ name: "Desk default" }));
  const clash = await h.service.update(ADMIN, contract.value.id, promise({ name: "Desk default" }));
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.match(clash.error, /already has a promise called/);

  const kept = await h.service.update(ADMIN, contract.value.id, promise({ name: "Northwind contract" }));
  assert.equal(kept.ok, true);
});

test("a promise tickets are measured against cannot be deleted", async () => {
  const h = await harness();
  const live = await h.service.create(ADMIN, promise({ name: "Desk default" }));
  assert.equal(live.ok, true);
  if (!live.ok) return;

  h.store.attach(live.value.id, 3);
  const refused = await h.service.remove(ADMIN, live.value.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /3 tickets are measured against “Desk default”/);
  assert.equal(await h.store.findById("tenant-a", live.value.id) !== null, true);

  // An unused promise may go, and the audit says who removed it.
  h.store.attach(live.value.id, 0);
  const removed = await h.service.remove(ADMIN, live.value.id);
  assert.equal(removed.ok, true);
  assert.equal(await h.store.findById("tenant-a", live.value.id), null);

  const missing = await h.service.remove(ADMIN, "made-up");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /not on this desk/);
});

/* ------------------------------------------------------------------- the access */

test("who may write a promise, and who may only read one", async () => {
  const h = await harness();

  // Reading is a staff matter; a requester has no business in the desk's promises.
  const requester = await h.service.list(REQUESTER);
  assert.equal(requester.ok, false);
  if (!requester.ok) assert.match(requester.error, /do not have access/);

  // Writing is a manager's: an agent may not promise anything on the desk's behalf.
  const agent = await h.service.create(AGENT, promise());
  assert.equal(agent.ok, false);
  if (!agent.ok) assert.match(agent.error, /do not manage the desk's promises/);
  const dispatcher = await h.service.create(DISPATCHER, promise({ name: "Dispatcher's own" }));
  assert.equal(dispatcher.ok, true);

  const admin = await h.service.create(ADMIN, promise());
  assert.equal(admin.ok, true);
  if (!admin.ok) return;

  // Another tenant cannot see it, change it or delete it.
  const theirList = await h.service.list(OTHER_ADMIN);
  assert.equal(theirList.ok && theirList.value.length, 0);
  const theirEdit = await h.service.update(OTHER_ADMIN, admin.value.id, promise({ name: "Hijacked" }));
  assert.equal(theirEdit.ok, false);
  if (!theirEdit.ok) assert.match(theirEdit.error, /not on this desk/);
  assert.equal((await h.service.remove(OTHER_ADMIN, admin.value.id)).ok, false);

  // A client's promises are theirs to read back, and not confused with the desk's.
  const northwind = await clientFor(h);
  await h.service.create(ADMIN, promise({ name: "Northwind contract", clientId: northwind }));
  const mine = await h.service.forClient(ADMIN, northwind);
  assert.equal(mine.ok, true);
  if (mine.ok) assert.deepEqual(mine.value.map((policy) => policy.name), ["Northwind contract"]);
});

/* ------------------------------------------------------------------ the record */

test("every write is on the audit chain, with the scope it was written at", async () => {
  const h = await harness();
  const northwind = await clientFor(h);
  const created = await h.service.create(ADMIN, promise({ name: "Northwind contract", clientId: northwind, hours: "always" }));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await h.service.update(ADMIN, created.value.id, promise({ name: "Northwind contract", clientId: northwind, responseMinutes: 30 }));
  h.store.attach(created.value.id, 0);
  await h.service.remove(ADMIN, created.value.id);

  // The chain holds the client that was created first, so the promise's own
  // events are the ones this test is about.
  const events = h.audit.snapshot().events.filter((event) => event.action.startsWith("sla.policy"));
  assert.deepEqual(
    events.map((event) => event.action),
    ["sla.policy.create", "sla.policy.update", "sla.policy.delete"],
  );
  assert.equal(events[0].targetType, "sla-policy");
  assert.equal(events[0].targetId, created.value.id);
  assert.equal(events[0].detail?.clientId, northwind);
  assert.equal(events[0].detail?.hours, "24x7");
  assert.equal(events[1].detail?.responseMinutes, 30);
});

/* ------------------------------------------------------------------- the adapter */

test("the Prisma store writes the columns the resolver reads", async () => {
  const row = (overrides: Partial<SlaPolicyRow> = {}): SlaPolicyRow => ({
    id: "policy-1",
    tenantId: "tenant-a",
    name: "Northwind contract",
    priority: null,
    responseMinutes: 60,
    resolutionMinutes: 480,
    calendar: ALWAYS_OPEN_CALENDAR,
    warningFraction: 0.2,
    queueId: null,
    clientId: "client-1",
    ...overrides,
  });

  const written: unknown[] = [];
  const updated: unknown[] = [];
  const removed: unknown[] = [];
  const counted: unknown[] = [];
  const db = {
    slaPolicy: {
      findMany: async () => [row()],
      findFirst: async (args: unknown) => {
        const where = (args as { where?: { id?: string; name?: { equals: string } } }).where;
        if (where?.id === "missing") return null;
        return row({ name: where?.name?.equals ?? "Northwind contract" });
      },
      create: async (args: unknown) => {
        written.push(args);
        return row((args as { data: Partial<SlaPolicyRow> }).data);
      },
      update: async (args: unknown) => {
        updated.push(args);
        return row();
      },
      delete: async (args: unknown) => {
        removed.push(args);
        return row();
      },
    },
    ticket: {
      count: async (args: unknown) => {
        counted.push(args);
        return 2;
      },
    },
  } as unknown as SlaPolicyPrismaClient;

  const store = new PrismaSlaPolicyStore(db);
  const found = await store.findById("tenant-a", "policy-1");
  assert.equal(found?.tenantId, "tenant-a");
  assert.equal(found?.clientId, "client-1");
  // `undefined` is what the resolver reads as "any priority", so a null column
  // must not come back as a priority of "".
  assert.equal(found?.priority, undefined);

  // A malformed calendar in a hand-edited row falls back rather than crashing a sweep.
  assert.equal(toSlaPolicy(row({ calendar: { week: [] } })).calendar.name, "default");
  // The Prisma store is the port the service was written against, not a lookalike.
  const port: SlaPolicyStore = store;
  assert.equal(typeof port.countTickets, "function");

  await store.insert({
    id: "policy-2",
    tenantId: "tenant-a",
    name: "Northwind contract",
    responseMinutes: 60,
    resolutionMinutes: 480,
    calendar: ALWAYS_OPEN_CALENDAR,
    warningFraction: 0.2,
    queueId: null,
    clientId: "client-1",
  });
  const data = (written[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.tenantId, "tenant-a");
  assert.equal(data.clientId, "client-1");
  assert.equal(data.priority, null, "an unscoped priority is stored as null, not as a missing column");
  assert.equal(data.queueId, null);
  assert.equal((data.calendar as { name: string }).name, "24x7");

  await store.update(toSlaPolicy(row()));
  assert.deepEqual((updated[0] as { where: unknown }).where, { id: "policy-1" });
  await store.remove("tenant-a", "policy-1");
  assert.deepEqual((removed[0] as { where: unknown }).where, { id: "policy-1", tenantId: "tenant-a" });

  // How many tickets hold a promise is the database's answer, not the page's.
  assert.equal(await store.countTickets("tenant-a", "policy-1"), 2);
  assert.deepEqual((counted[0] as { where: unknown }).where, { tenantId: "tenant-a", slaPolicyId: "policy-1" });
});

test("a promise may only name a client this desk actually has", async () => {
  const h = await harness();
  const invented = await h.service.create(ADMIN, promise({ name: "Northwind contract", clientId: "made-up" }));
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.match(invented.error, /Client not found/);

  const northwind = await clientFor(h);
  assert.equal((await h.service.create(ADMIN, promise({ name: "Northwind contract", clientId: northwind }))).ok, true);
});

test("a promise can be written for one queue, and only a queue the desk actually has", async () => {
  const audit = new AuditLog(sha256);
  const store = new MemorySlaPolicyStore();
  const queues = { listQueues: async () => [{ id: "queue-1", name: "Tier 2" }] };
  let n = 0;
  const service = new SlaPolicyService(store, audit, null, { id: () => `policy-${++n}`, now: () => NOW }, queues);

  // The console is offered the queues it can scope to.
  const offered = await service.deskQueues(ADMIN);
  assert.equal(offered.ok && offered.value[0].name, "Tier 2");

  const invented = await service.create(ADMIN, promise({ name: "Tier 2 contract", queueId: "made-up" }));
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.match(invented.error, /Queue not found/);

  const created = await service.create(ADMIN, promise({ name: "Tier 2 contract", queueId: "queue-1" }));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.queueId, "queue-1");
  assert.match(describeScope(created.value), /its queue/);

  // And the queue rung is what the resolver answers when no client names one.
  const both = await service.create(ADMIN, promise({ name: "Wrong", queueId: "queue-1", clientId: "client-1" }));
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.error, /not both/);

  const events = audit.snapshot().events.filter((event) => event.action === "sla.policy.create");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail?.queueId, "queue-1");
});

test("an edit that does not mention the scope keeps it — a queue promise stays a queue promise", async () => {
  const audit = new AuditLog(sha256);
  const store = new MemorySlaPolicyStore();
  const queues = { listQueues: async () => [{ id: "queue-1", name: "Tier 2" }] };
  let n = 0;
  const service = new SlaPolicyService(store, audit, null, { id: () => `policy-${++n}`, now: () => NOW }, queues);

  const created = await service.create(ADMIN, promise({ name: "Tier 2 contract", queueId: "queue-1" }));
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // A form carrying only the numbers must not quietly widen the promise to the
  // whole desk: that is how a queue's contract becomes everybody's promise.
  const edited = await service.update(ADMIN, created.value.id, promise({ name: "Tier 2 contract" }));
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.value.queueId, "queue-1");
  assert.equal(edited.value.id, created.value.id, "a promise in force keeps its id");

  // Naming the empty scope explicitly *is* a widening, and is allowed to be one.
  const widened = await service.update(ADMIN, created.value.id, promise({ name: "Tier 2 contract", queueId: null }));
  assert.equal(widened.ok, true);
  assert.equal(widened.ok && widened.value.queueId, null);
});

test("the memory store is the port the Prisma one implements, so tests prove the service", async () => {
  const store: SlaPolicyStore = new MemorySlaPolicyStore();
  const service = new SlaPolicyService(store, null, null, { id: () => "policy-1", now: () => NOW });
  const created = await service.create(ADMIN, promise());
  assert.equal(created.ok, true);
  // Without an audit sink the service still works — a desk with no chain to write
  // to is better than a desk that cannot state its promises.
  const listed = await service.list(ADMIN);
  assert.equal(listed.ok && listed.value[0].name, "Desk default");
});
