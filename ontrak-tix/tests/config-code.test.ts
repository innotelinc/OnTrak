/**
 * OnTrak Tix 2.4 tests: config as code.
 *
 * The milestone's exit is a sentence about bytes — *a staging configuration
 * promotes byte-identically* — so the round trip here is asserted as bytes, not
 * as deep equality of two objects that both happen to be spelled the same way by
 * `deepEqual`. Alongside it, the parts that decide whether a promotion is safe:
 *
 *  - **Refusals name the row.** A file with several mistakes gets all of them in
 *    one pass, each pointing at `macros.0.actions.0`, because the person fixing
 *    it reads a terminal at 02:00 with the file open beside it.
 *  - **The diff is what the import does.** The dry run and the apply share one
 *    comparison, so the review cannot disagree with the write. Rows present only
 *    in the target are not called deletions: the import leaves them alone.
 *  - **Import upserts.** A re-import is a no-op; a queue keeps its id when its
 *    name changes, because its tickets point at it; a client-scoped SLA policy
 *    is carried nowhere, because a client is business data, not configuration.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/config-code.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditEventInput, AuditSink } from "../src/lib/audit-chain";
import {
  applyToState,
  buildBundle,
  diffBundle,
  readBundle,
  serializeBundle,
  type ConfigState,
} from "../src/lib/config-bundle";
import {
  applyConfigBundle,
  loadConfigState,
  type ConfigCodeDb,
  type ConfigFieldRow,
  type ConfigMacroRow,
  type ConfigQueueRow,
  type ConfigSlaRow,
} from "../src/lib/config-code";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                 */
/* -------------------------------------------------------------------------- */

const HOURS = { startMinute: 9 * 60, endMinute: 17 * 60 };
/** Sunday first, the way `BusinessCalendar.week` numbers the days. */
const weekly = () => [[], [HOURS], [HOURS], [HOURS], [HOURS], [HOURS], []];

const EMPTY_CALENDAR = { name: "24x7", utcOffsetMinutes: 0, week: weekly(), holidays: [] };

function state(overrides: Partial<ConfigState> = {}): ConfigState {
  return {
    tenant: "acme",
    queues: [
      { slug: "service-desk", name: "Service desk" },
      { slug: "network", name: "Network" },
    ],
    slaPolicies: [
      {
        name: "Standard",
        queue: "service-desk",
        priority: "HIGH",
        responseMinutes: 60,
        resolutionMinutes: 240,
        warningFraction: 0.2,
        calendar: {
          name: "Desk hours",
          utcOffsetMinutes: -300,
          week: weekly(),
          // Out of order, with a duplicate: the bundle must carry the
          // normalised list, or two equal configurations export differently.
          holidays: ["2026-12-25", "2026-01-01", "2026-12-25"],
        },
      },
      {
        name: "Fallback",
        queue: null,
        priority: null,
        responseMinutes: 240,
        resolutionMinutes: 960,
        warningFraction: 0.25,
        calendar: EMPTY_CALENDAR,
      },
    ],
    customFields: [
      {
        key: "location",
        label: "Location",
        type: "SELECT",
        options: ["HQ", "Branch"],
        requiredByDefault: true,
        placeholder: "",
        helpText: "Where the ticket is.",
        archived: false,
      },
      {
        key: "change_window",
        label: "Change window",
        type: "TEXT",
        options: [],
        requiredByDefault: false,
        placeholder: "e.g. Tuesday 02:00",
        helpText: "",
        archived: false,
      },
    ],
    macros: [
      {
        name: "Triage",
        description: "Sort it out.",
        actions: [
          { kind: "set_priority", value: "HIGH" },
          { kind: "add_tag", value: "triage" },
        ],
        enabled: true,
      },
      { name: "Retired", description: "", actions: [{ kind: "notify", value: "Gone." }], enabled: false },
    ],
    ...overrides,
  };
}

const EMPTY_STATE: ConfigState = { tenant: "acme", queues: [], slaPolicies: [], customFields: [], macros: [] };

function bundleOf(source: ConfigState) {
  return buildBundle(source);
}

function issueFields(raw: unknown): string[] {
  const read = readBundle(raw);
  assert.equal(read.ok, false, "expected the bundle to be refused");
  if (read.ok) return [];
  for (const issue of read.issues) assert.ok(issue.message.trim().length > 0, `empty message at ${issue.field}`);
  return read.issues.map((issue) => issue.field);
}

/* -------------------------------------------------------------------------- */
/*  The bytes                                                                */
/* -------------------------------------------------------------------------- */

test("the same configuration serialises to the same bytes, through a read and an apply", () => {
  const bytes = serializeBundle(bundleOf(state()));

  const read = readBundle(JSON.parse(bytes) as unknown);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(serializeBundle(read.bundle), bytes, "reading and re-serialising changed the file");

  const applied = applyToState(EMPTY_STATE, read.bundle);
  assert.equal(serializeBundle(buildBundle(applied)), bytes, "applying and re-exporting changed the file");
  assert.equal(applied.tenant, "acme", "applying kept the target tenant");
});

test("row order in the source does not change the file", () => {
  const first = serializeBundle(bundleOf(state()));

  const shuffled = state();
  shuffled.queues.reverse();
  shuffled.slaPolicies.reverse();
  shuffled.customFields.reverse();
  shuffled.macros.reverse();

  assert.equal(serializeBundle(bundleOf(shuffled)), first);
});

test("a calendar's closures are normalised, sorted and de-duplicated", () => {
  const bundle = bundleOf(state());
  const standard = bundle.slaPolicies.find((policy) => policy.name === "Standard");
  assert.ok(standard);
  assert.deepEqual(standard.calendar.holidays, ["2026-01-01", "2026-12-25"]);
  // Always present, even when empty: a key that sometimes exists is a key a
  // diff reports as a change.
  const fallback = bundle.slaPolicies.find((policy) => policy.name === "Fallback");
  assert.deepEqual(fallback?.calendar.holidays, []);
});

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                 */
/* -------------------------------------------------------------------------- */

test("every problem in a file is named at once", () => {
  const raw = JSON.parse(serializeBundle(bundleOf(state()))) as Record<string, unknown>;

  const queues = raw.queues as Array<Record<string, unknown>>;
  queues[1]!.slug = "Network"; // upper case is not a slug
  queues.push({ ...queues[0] }); // a duplicate of service-desk

  const policies = raw.slaPolicies as Array<Record<string, unknown>>;
  policies[0]!.queue = "missing-queue";
  policies[0]!.priority = "CRITICAL";

  const fields = raw.customFields as Array<Record<string, unknown>>;
  fields[0]!.type = "BLOB";

  const macros = raw.macros as Array<Record<string, unknown>>;
  macros[0]!.name = "";
  macros[0]!.actions = [{ kind: "explode" }];

  const found = issueFields(raw);
  for (const field of [
    "queues.1.slug",
    "queues.2.slug",
    "slaPolicies.0.queue",
    "slaPolicies.0.priority",
    "customFields.0.type",
    "macros.0.name",
    "macros.0.actions.0",
  ]) {
    assert.ok(found.includes(field), `no refusal for ${field}; got ${found.join(", ")}`);
  }
});

test("a hand-edited calendar or action shape is refused, not crashed on", () => {
  const raw = JSON.parse(serializeBundle(bundleOf(state()))) as Record<string, unknown>;
  const policies = raw.slaPolicies as Array<Record<string, unknown>>;
  (policies[0]!.calendar as Record<string, unknown>).week = [[null], [], [], [], [], [], []];
  const macros = raw.macros as Array<Record<string, unknown>>;
  macros[0]!.actions = [{ kind: "set_priority", value: 3 }];

  const found = issueFields(raw);
  assert.ok(found.includes("slaPolicies.0.calendar"), found.join(", "));
  assert.ok(found.includes("macros.0.actions.0.value"), found.join(", "));
});

test("a missing section is refused, because a truncated file is not an empty desk", () => {
  const raw = JSON.parse(serializeBundle(bundleOf(state()))) as Record<string, unknown>;
  delete raw.macros;
  assert.ok(issueFields(raw).includes("macros"));
});

test("a key this build does not know is refused rather than ignored", () => {
  const raw = JSON.parse(serializeBundle(bundleOf(state()))) as Record<string, unknown>;
  raw["slaCalendars"] = [];
  assert.ok(issueFields(raw).includes("slaCalendars"));
});

test("an unknown format version ends the read with one sentence", () => {
  const read = readBundle({ format: "ontrak.tix.config/v2", tenant: "acme" });
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.issues.length, 1);
  assert.equal(read.issues[0]!.field, "format");
  assert.match(read.issues[0]!.message, /ontrak\.tix\.config\/v1/);
});

test("a bundle that is not an object is refused as such", () => {
  const read = readBundle([]);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.issues[0]!.field, "bundle");
});

/* -------------------------------------------------------------------------- */
/*  The diff                                                                 */
/* -------------------------------------------------------------------------- */

test("the diff classifies create, update and unchanged, and names the changed fields", () => {
  const before = state();
  before.queues = [...before.queues, { slug: "legacy", name: "Legacy" }];
  before.slaPolicies = before.slaPolicies.map((policy) =>
    policy.name === "Standard" ? { ...policy, responseMinutes: 30 } : policy,
  );

  const diff = diffBundle(before, bundleOf(state()));

  // The legacy queue is in the target and not in the file: it is not listed at
  // all, because the import does not delete it.
  assert.deepEqual(diff.queues.create.map((entry) => entry.key), []);
  assert.deepEqual(diff.queues.update.map((entry) => entry.key), []);
  assert.equal(diff.queues.unchanged.length, 2);
  assert.equal(diff.queues.total, 2);

  assert.deepEqual(diff.slaPolicies.update.map((entry) => [entry.key, entry.fields]), [
    ["Standard", ["responseMinutes"]],
  ]);
  assert.equal(diff.changes, 1);
  assert.match(diff.summary, /1 change/);
  // Unchanged sections are still named with their count: a promotion review needs
  // to see that the file carries two fields and neither of them moves.
  assert.match(diff.summary, /2 custom fields \(0 new, 0 changed, 2 unchanged\)/);
});

test("a renamed queue is an update of one field, not a new queue", () => {
  const incoming = bundleOf(
    state({
      queues: [
        { slug: "service-desk", name: "Service Desk" },
        { slug: "network", name: "Network" },
        { slug: "identity", name: "Identity" },
      ],
      slaPolicies: [],
      customFields: [],
      macros: [],
    }),
  );

  const diff = diffBundle(state(), incoming);
  assert.deepEqual(diff.queues.create.map((entry) => entry.key), ["identity"]);
  assert.deepEqual(diff.queues.update.map((entry) => [entry.key, entry.fields]), [["service-desk", ["name"]]]);
  assert.equal(diff.changes, 2);
});

/* -------------------------------------------------------------------------- */
/*  Applying, without a database                                             */
/* -------------------------------------------------------------------------- */

test("applying a bundle leaves what the bundle does not name exactly as it was", () => {
  const target = state({ queues: [...state().queues, { slug: "legacy", name: "Legacy" }] });
  const applied = applyToState(target, bundleOf(state()));
  assert.ok(applied.queues.some((queue) => queue.slug === "legacy"));
  assert.equal(applied.queues.length, 3);
});

/* -------------------------------------------------------------------------- */
/*  The database half, over a fake                                           */
/* -------------------------------------------------------------------------- */

/** The Prisma surface `config-code.ts` uses, as an in-memory object. */
class FakeDb implements ConfigCodeDb {
  readonly tenants = [{ id: "t1", slug: "acme" }];
  queues: ConfigQueueRow[] = [{ id: "q1", slug: "service-desk", name: "Old name" }];
  policies: Array<ConfigSlaRow & { clientId: string | null }> = [];
  fields: ConfigFieldRow[] = [];
  macros: ConfigMacroRow[] = [];
  writes: string[] = [];
  private nextId = 2;

  tenant = {
    findUnique: async (args: unknown) => {
      const { where } = args as { where: { slug: string } };
      return this.tenants.find((tenant) => tenant.slug === where.slug) ?? null;
    },
  };

  queue = {
    findMany: async (_args: unknown) => this.queues.map((queue) => ({ ...queue })),
    upsert: async (args: unknown) => {
      const { where, create, update } = args as {
        where: { tenantId_slug: { slug: string } };
        create: { slug: string; name: string };
        update: { name: string };
      };
      const slug = where.tenantId_slug.slug;
      this.writes.push(`queue:${slug}`);
      const existing = this.queues.find((queue) => queue.slug === slug);
      if (existing) existing.name = update.name;
      else this.queues.push({ id: `q${this.nextId++}`, slug: create.slug, name: create.name });
      return null;
    },
  };

  slaPolicy = {
    findMany: async (_args: unknown) => this.policies.map((policy) => ({ ...policy })),
    upsert: async (args: unknown) => {
      const { where, create, update } = args as {
        where: { tenantId_name: { name: string } };
        create: { name: string; queueId: string | null };
        update: {
          priority: string | null;
          responseMinutes: number;
          resolutionMinutes: number;
          warningFraction: number;
          calendar: unknown;
          queueId: string | null;
        };
      };
      const name = where.tenantId_name.name;
      this.writes.push(`slaPolicy:${name}`);
      const queueRow = create.queueId ? this.queues.find((queue) => queue.id === create.queueId) : undefined;
      const row: ConfigSlaRow & { clientId: string | null } = {
        name,
        priority: update.priority,
        responseMinutes: update.responseMinutes,
        resolutionMinutes: update.resolutionMinutes,
        warningFraction: update.warningFraction,
        calendar: update.calendar,
        queue: queueRow ? { slug: queueRow.slug } : null,
        clientId: null,
      };
      const existing = this.policies.find((policy) => policy.name === name);
      if (existing) Object.assign(existing, row);
      else this.policies.push(row);
      return null;
    },
  };

  customField = {
    findMany: async (_args: unknown) => this.fields.map((field) => ({ ...field })),
    upsert: async (args: unknown) => {
      const { where, update } = args as {
        where: { tenantId_key: { key: string } };
        update: Omit<ConfigFieldRow, "key">;
      };
      const key = where.tenantId_key.key;
      this.writes.push(`customField:${key}`);
      const row: ConfigFieldRow = {
        key,
        label: update.label,
        type: update.type,
        options: [...update.options],
        requiredByDefault: update.requiredByDefault,
        placeholder: update.placeholder,
        helpText: update.helpText,
        archived: update.archived,
      };
      const existing = this.fields.find((field) => field.key === key);
      if (existing) Object.assign(existing, row);
      else this.fields.push(row);
      return null;
    },
  };

  macro = {
    findMany: async (_args: unknown) => this.macros.map((macro) => ({ ...macro })),
    upsert: async (args: unknown) => {
      const { where, update } = args as {
        where: { tenantId_name: { name: string } };
        update: Omit<ConfigMacroRow, "name">;
      };
      const name = where.tenantId_name.name;
      this.writes.push(`macro:${name}`);
      const row: ConfigMacroRow = {
        name,
        description: update.description,
        actions: update.actions,
        enabled: update.enabled,
      };
      const existing = this.macros.find((macro) => macro.name === name);
      if (existing) Object.assign(existing, row);
      else this.macros.push(row);
      return null;
    },
  };

  $transaction = async <T>(work: (tx: ConfigCodeDb) => Promise<T>): Promise<T> => work(this);
}

class FakeAudit implements AuditSink {
  events: AuditEventInput[] = [];

  append(event: AuditEventInput): AuditEventInput {
    this.events.push(event);
    return event;
  }
}

test("a dry run writes nothing and says what would change", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();

  const result = await applyConfigBundle(db, audit, {
    targetSlug: "acme",
    bundle: bundleOf(state()),
    actor: "admin-1",
    dryRun: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.applied, false);
  assert.ok(result.diff.queues.create.some((entry) => entry.key === "network"));
  assert.deepEqual(db.writes, []);
  assert.equal(audit.events.length, 0);
  assert.equal(db.queues[0]!.name, "Old name");
});

test("an import writes in dependency order, keeps row ids, and audits itself once", async () => {
  const db = new FakeDb();
  const audit = new FakeAudit();

  const first = await applyConfigBundle(db, audit, { targetSlug: "acme", bundle: bundleOf(state()), actor: "admin-1" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.applied, true);

  // Queues before the policies that point at them, and each section canonical.
  assert.deepEqual(db.writes, [
    "queue:network",
    "queue:service-desk",
    "slaPolicy:Fallback",
    "slaPolicy:Standard",
    "customField:change_window",
    "customField:location",
    "macro:Retired",
    "macro:Triage",
  ]);

  // A rename updates the row its tickets already point at.
  assert.equal(db.queues.find((queue) => queue.slug === "service-desk")!.id, "q1");
  assert.equal(db.queues.find((queue) => queue.slug === "service-desk")!.name, "Service desk");
  assert.equal(db.policies.find((policy) => policy.name === "Standard")!.queue?.slug, "service-desk");
  assert.equal(db.fields.find((field) => field.key === "location")!.type, "SELECT");
  assert.equal(db.macros.find((macro) => macro.name === "Retired")!.enabled, false);

  assert.equal(audit.events.length, 1);
  const event = audit.events[0]!;
  assert.equal(event.action, "config.import");
  assert.equal(event.tenantId, "t1");
  assert.equal(event.actor, "admin-1");
  assert.deepEqual(event.detail?.["source"], "acme");

  // Re-running the same file is a no-op, and a no-op is not worth a second
  // entry on the chain.
  const second = await applyConfigBundle(db, audit, { targetSlug: "acme", bundle: bundleOf(state()), actor: "admin-1" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.diff.changes, 0);
  assert.equal(audit.events.length, 1);
});

test("a bundle from another environment is refused unless the promotion is stated", async () => {
  const db = new FakeDb();
  const bundle = bundleOf(state({ tenant: "staging" }));

  const refused = await applyConfigBundle(db, null, { targetSlug: "acme", bundle, actor: "admin-1" });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /“staging”/);
  assert.match(refused.error, /“acme”/);
  assert.match(refused.error, /--allow-tenant-slug/);
  assert.deepEqual(db.writes, []);

  const allowed = await applyConfigBundle(db, null, {
    targetSlug: "acme",
    bundle,
    actor: "admin-1",
    allowTenantSlug: true,
  });
  assert.equal(allowed.ok, true);
  assert.ok(db.writes.length > 0);
});

test("a client-scoped SLA policy is not carried, and cannot be taken over by name", async () => {
  const db = new FakeDb();
  db.policies.push({
    name: "Standard",
    priority: null,
    responseMinutes: 60,
    resolutionMinutes: 120,
    warningFraction: 0.2,
    calendar: EMPTY_CALENDAR,
    queue: null,
    clientId: "client-1",
  });

  const loaded = await loadConfigState(db, "acme");
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.bundle.slaPolicies.length, 0);
  assert.equal(loaded.omitted.length, 1);
  assert.match(loaded.omitted[0]!, /scoped to a client/);

  const missing = await loadConfigState(db, "nope");
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.match(missing.error, /“nope”/);

  // `(tenantId, name)` is unique, so a bundle's "Standard" would otherwise
  // turn the client's promise into the whole desk's. It is refused by name.
  const refused = await applyConfigBundle(db, null, { targetSlug: "acme", bundle: bundleOf(state()), actor: "admin-1" });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /“Standard”/);
  assert.match(refused.error, /scoped to a client/);
  assert.deepEqual(db.writes, []);
});

test("an export refuses a desk whose own rows the bundle reader would reject", async () => {
  const db = new FakeDb();
  // A macro action stored under the wrong field name (the desk's own validator
  // would never have written it, but a migration or a hand edit can). The
  // canonical form keeps only `kind` and `value`, so exporting would quietly drop
  // what the database says; the export refuses and names the row instead.
  db.macros = [{ name: "Close", description: "", actions: [{ value: "RESOLVED" }], enabled: true }];

  const loaded = await loadConfigState(db, "acme");
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /would not be accepted back/);
  assert.match(loaded.error, /actions\.0/);
  assert.deepEqual(db.writes, []);
});
