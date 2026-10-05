/**
 * OnTrak Tix M6 tests: the connector marketplace.
 *
 * A marketplace is where a third-party integration is *installed*, so each test
 * follows one of the ways installing one goes wrong:
 *
 *  1. a manifest that is not really a connector, admitted to the catalog anyway;
 *  2. a first-party connector "installed" here as well as on its own screen, which
 *     is two sources of truth for one endpoint;
 *  3. a config saved without the field it needs, or with a field the connector does
 *     not have — both of which fail silently at the first event;
 *  4. a credential written into the audit trail, which is a document that outlives
 *     the deployment;
 *  5. an event routed to a connector that is off, to one that never asked for it,
 *     to one in another tenant, or to one with no handler at all; and
 *  6. a handler that throws taking the caller's real work down with it.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-connectors.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Actor } from "../src/lib/access-rules";
import type { AuditEventInput, AuditSink } from "../src/lib/audit-chain";
import {
  BUILTIN_CONNECTORS,
  ConnectorRegistry,
  auditConfigSummary,
  installationsForCapability,
  manifestProblems,
  maskConfig,
  secretKeys,
  validateInstallation,
  type ConnectorInstallationRecord,
  type ConnectorManifest,
} from "../src/lib/connector-rules";
import {
  ConnectorService,
  MemoryConnectorStore,
  catalogSections,
  cleanConfig,
  type ConnectorIds,
} from "../src/lib/connector-service";
import {
  asConfig,
  PrismaConnectorStore,
  toConnectorCreate,
  toConnectorRecord,
  toConnectorUpdate,
  type ConnectorInstallationRow,
  type ConnectorPrismaClient,
} from "../src/lib/connector-store-prisma";

const ADMIN: Actor = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" };
const AGENT: Actor = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" };

/** A third-party connector: two fields, one of them a credential. */
const ACME: ConnectorManifest = {
  id: "acme-assets",
  name: "Acme Asset Sync",
  vendor: "Acme",
  category: "EXPORT",
  summary: "Pushes ticket records to Acme's asset register.",
  capabilities: ["ticket.export"],
  configFields: [
    { key: "baseUrl", label: "Base URL", required: true, secret: false },
    { key: "apiKey", label: "API key", required: true, secret: true },
  ],
  docsPath: "docs/connectors.md",
  builtin: false,
  managePath: null,
};

function countingIds(): ConnectorIds {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    // A fixed, increasing clock keeps every timestamp distinct without a real one.
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}

interface Harness {
  service: ConnectorService;
  registry: ConnectorRegistry;
  store: MemoryConnectorStore;
  events(): Array<{ action: string; detail?: Record<string, unknown> }>;
}

/** A recording audit sink — enough to assert what a change did and did not say. */
function recordingSink(): AuditSink & { events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, append: (event: AuditEventInput) => void events.push(event) };
}

function harness(): Harness {
  const registry = new ConnectorRegistry();
  assert.deepEqual(registry.register(ACME), []);
  const store = new MemoryConnectorStore();
  const audit = recordingSink();
  const service = new ConnectorService(store, registry, audit, countingIds());
  return {
    service,
    registry,
    store,
    events: () => audit.events.map((event) => ({ action: event.action, detail: event.detail })),
  };
}

/* -------------------------------------------------------------------------- */
/*  The catalog                                                               */
/* -------------------------------------------------------------------------- */

test("the built-in catalog is well formed and lists only first-party connectors", () => {
  for (const manifest of BUILTIN_CONNECTORS) {
    assert.deepEqual(manifestProblems(manifest), [], `${manifest.id} should be a valid manifest`);
    assert.equal(manifest.builtin, true);
  }
  const registry = new ConnectorRegistry();
  assert.equal(registry.size, BUILTIN_CONNECTORS.length);
  // First-party connectors sort first.
  assert.equal(registry.list()[0].builtin, true);
});

test("a malformed manifest is refused at registration, not admitted", () => {
  const registry = new ConnectorRegistry();
  const problems = registry.register({
    ...ACME,
    id: "Acme Assets", // spaces and capitals
    capabilities: [],
  });
  assert.ok(problems.some((problem) => problem.includes("id")), problems.join(" "));
  assert.ok(problems.some((problem) => problem.includes("capability")), problems.join(" "));
  assert.equal(registry.get("Acme Assets"), null);
});

test("a connector cannot impersonate a built-in or be registered twice", () => {
  const registry = new ConnectorRegistry();
  const shadow = registry.register({ ...ACME, id: "signed-webhooks" });
  assert.ok(shadow.some((problem) => problem.includes("already")), shadow.join(" "));
  // The built-in is unchanged.
  assert.equal(registry.get("signed-webhooks")?.builtin, true);

  assert.deepEqual(registry.register(ACME), []);
  assert.ok(registry.register(ACME).length > 0);
});

/* -------------------------------------------------------------------------- */
/*  Install validation                                                        */
/* -------------------------------------------------------------------------- */

test("a required field that is blank is refused, and never stored", async () => {
  const { service } = harness();
  const result = await service.install(ADMIN, { connectorId: ACME.id, config: { baseUrl: "https://acme.test" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /API key is required/);
});

test("a key the connector does not declare is refused rather than dropped", () => {
  const issues = validateInstallation(ACME, { baseUrl: "https://acme.test", apiKey: "k", extra: "x" });
  assert.ok(issues.some((issue) => issue.field === "extra" && issue.message.includes("not a setting")));
});

test("secret fields are the ones masked on screen and named in the audit summary", () => {
  assert.deepEqual(secretKeys(ACME), ["apiKey"]);
  const shown = maskConfig(ACME, { baseUrl: "https://acme.test", apiKey: "super-secret" });
  assert.equal(shown.baseUrl, "https://acme.test");
  assert.notEqual(shown.apiKey, "super-secret");
  assert.ok(!JSON.stringify(shown).includes("super-secret"));

  const summary = auditConfigSummary(ACME, { baseUrl: "https://acme.test", apiKey: "super-secret" });
  assert.deepEqual(summary.fields.sort(), ["apiKey", "baseUrl"]);
  assert.deepEqual(summary.secrets, ["apiKey"]);
  assert.ok(!JSON.stringify(summary).includes("super-secret"));
});

test("cleaning drops blanks and undeclared keys", () => {
  const clean = cleanConfig(ACME, { baseUrl: "https://acme.test", apiKey: "", extra: "x" });
  assert.deepEqual(clean, { baseUrl: "https://acme.test" });
});

/* -------------------------------------------------------------------------- */
/*  Install lifecycle                                                         */
/* -------------------------------------------------------------------------- */

test("a third-party connector installs with config and lands on the chain without the secret", async () => {
  const { service, events } = harness();
  const result = await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "super-secret" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.connectorId, ACME.id);
    assert.equal(result.value.enabled, true);
    assert.equal(result.value.config.apiKey, "super-secret"); // stored, just never echoed elsewhere
  }
  const install = events().find((event) => event.action === "connector.install");
  assert.ok(install);
  assert.deepEqual(install?.detail?.secrets, ["apiKey"]);
  assert.ok(!JSON.stringify(install).includes("super-secret"));
});

test("a first-party connector cannot be installed here, and says where it lives", async () => {
  const { service } = harness();
  const result = await service.install(ADMIN, { connectorId: "signed-webhooks", config: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /\/admin\/integrations/);
});

test("an unknown connector and a second install are both refused", async () => {
  const { service } = harness();
  const missing = await service.install(ADMIN, { connectorId: "nope", config: {} });
  assert.equal(missing.ok, false);

  const first = await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "k" },
  });
  assert.equal(first.ok, true);
  const again = await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "k" },
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /already installed/);
});

test("an agent cannot install, configure or remove a connector", async () => {
  const { service } = harness();
  assert.equal((await service.install(AGENT, { connectorId: ACME.id, config: {} })).ok, false);
  assert.equal((await service.configure(AGENT, "id-1", {})).ok, false);
  assert.equal((await service.remove(AGENT, "id-1")).ok, false);
});

test("configuring replaces the config, validates it, and audits fields not values", async () => {
  const { service, events } = harness();
  const installed = await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "old" },
  });
  assert.equal(installed.ok, true);
  if (!installed.ok) return;

  // An unknown key is refused, and nothing is written.
  const bad = await service.configure(ADMIN, installed.value.id, { nope: "x" });
  assert.equal(bad.ok, false);

  // A blank (or masked) field keeps what is stored — a secret the console never
  // showed cannot be re-posted, so an edit that does not mention it must not clear it.
  const kept = await service.configure(ADMIN, installed.value.id, {
    baseUrl: "https://acme.test/v2",
    apiKey: "",
  });
  assert.equal(kept.ok, true);
  if (kept.ok) {
    assert.equal(kept.value.config.baseUrl, "https://acme.test/v2");
    assert.equal(kept.value.config.apiKey, "old");
  }

  const good = await service.configure(ADMIN, installed.value.id, { apiKey: "new-secret" });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.config.apiKey, "new-secret");

  const configure = events().find((event) => event.action === "connector.configure");
  assert.ok(configure);
  assert.ok(!JSON.stringify(configure).includes("new-secret"));
});

test("an installation is disabled without losing its config, and can be removed and re-installed", async () => {
  const { service, store } = harness();
  const installed = await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "k" },
  });
  assert.equal(installed.ok, true);
  if (!installed.ok) return;

  const off = await service.disable(ADMIN, installed.value.id);
  assert.equal(off.ok, true);
  if (off.ok) {
    assert.equal(off.value.enabled, false);
    assert.ok(off.value.disabledAt);
    assert.equal(off.value.config.apiKey, "k");
  }

  const on = await service.enable(ADMIN, installed.value.id);
  assert.equal(on.ok, true);
  if (on.ok) assert.equal(on.value.enabled, true);

  assert.equal((await service.remove(ADMIN, installed.value.id)).ok, true);
  assert.equal(await store.find("tenant-a", ACME.id), null);
  assert.equal(
    (await service.install(ADMIN, { connectorId: ACME.id, config: { baseUrl: "https://acme.test", apiKey: "k2" } })).ok,
    true,
  );
});

test("the catalog shows the installation with its secrets masked", async () => {
  const { service } = harness();
  await service.install(ADMIN, {
    connectorId: ACME.id,
    config: { baseUrl: "https://acme.test", apiKey: "super-secret" },
  });
  const catalog = await service.catalog("tenant-a");
  const sections = catalogSections(catalog);
  assert.equal(sections.installed.length, 1);
  assert.equal(sections.installed[0].manifest.id, ACME.id);
  assert.ok(!JSON.stringify(sections.installed[0].shownConfig).includes("super-secret"));

  // Built-ins are catalogued but never installed.
  assert.ok(sections.builtin.length >= 1);
});

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

test("an event reaches the enabled connectors that asked for it, and nothing else", async () => {
  const { service, registry } = harness();
  const heard: string[] = [];
  registry.register(
    { ...ACME, id: "acme-a", capabilities: ["ticket.notify"], configFields: [] },
    async () => {
      heard.push("acme-a");
      return { ok: true };
    },
  );
  registry.register(
    { ...ACME, id: "acme-b", capabilities: ["ticket.notify"], configFields: [] },
    async () => {
      heard.push("acme-b");
      return { ok: true };
    },
  );
  // A connector that asked for something else must not hear a ticket event.
  registry.register({ ...ACME, id: "exporter", capabilities: ["ticket.export"], configFields: [] }, async () => {
    heard.push("exporter");
    return { ok: true };
  });

  await service.install(ADMIN, { connectorId: "acme-a", config: {} });
  await service.install(ADMIN, { connectorId: "exporter", config: {} });
  // acme-b is installed disabled: a connector that is off asks for nothing.
  const b = await service.install(ADMIN, { connectorId: "acme-b", config: {}, enabled: false });
  assert.equal(b.ok, true);

  const report = await service.dispatch({ tenantId: "tenant-a", capability: "ticket.notify", payload: { ref: "T-1" } });
  assert.deepEqual(heard, ["acme-a"]);
  assert.equal(report.capability, "ticket.notify");
  assert.equal(report.delivered.length, 1);
});

test("a handler that throws is reported, and does not take the caller down", async () => {
  const { service, registry } = harness();
  registry.register({ ...ACME, id: "boom", capabilities: ["ticket.notify"], configFields: [] }, async () => {
    throw new Error("the far end went away");
  });
  await service.install(ADMIN, { connectorId: "boom", config: {} });

  const report = await service.dispatch({ tenantId: "tenant-a", capability: "ticket.notify", payload: {} });
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].outcome.ok, false);
  assert.match(report.delivered[0].outcome.error ?? "", /went away/);
});

test("an installation with no handler is reported as unanswered, not skipped silently", async () => {
  const { service, registry } = harness();
  registry.register({ ...ACME, id: "no-handler", capabilities: ["ticket.notify"], configFields: [] });
  await service.install(ADMIN, { connectorId: "no-handler", config: {} });

  const report = await service.dispatch({ tenantId: "tenant-a", capability: "ticket.notify", payload: {} });
  assert.equal(report.delivered.length, 0);
  assert.equal(report.unanswered.length, 1);
  assert.match(report.unanswered[0].outcome.error ?? "", /No handler/);
});

test("one tenant's connectors never hear another tenant's event", async () => {
  const { service, registry } = harness();
  const heard: string[] = [];
  registry.register({ ...ACME, id: "acme-a", capabilities: ["ticket.notify"], configFields: [] }, async () => {
    heard.push("a");
    return { ok: true };
  });
  await service.install(ADMIN, { connectorId: "acme-a", config: {} });

  const report = await service.dispatch({ tenantId: "tenant-b", capability: "ticket.notify", payload: {} });
  assert.deepEqual(heard, []);
  assert.equal(report.delivered.length, 0);
});

test("routing is by capability over the manifest, and the selector skips unknown connectors", () => {
  const record = (overrides: Partial<ConnectorInstallationRecord>): ConnectorInstallationRecord => ({
    id: "i",
    tenantId: "t",
    connectorId: "c",
    config: {},
    enabled: true,
    installedBy: "u",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  });
  const chosen = installationsForCapability(
    [record({ id: "1", connectorId: "acme-assets" }), record({ id: "2", connectorId: "ghost" })],
    (id) => (id === "acme-assets" ? ACME : null),
    "ticket.export",
  );
  assert.deepEqual(chosen.map((entry) => entry.id), ["1"]);
});

/* -------------------------------------------------------------------------- */
/*  The Prisma adapter                                                        */
/* -------------------------------------------------------------------------- */

test("the row mapper narrows config to text and converts dates both ways", () => {
  const record = toConnectorRecord({
    id: "ci-1",
    tenantId: "tenant-a",
    connectorId: "acme-assets",
    config: { baseUrl: "https://acme.test", apiKey: "k", weird: { nested: true }, n: 3 },
    enabled: true,
    installedBy: "admin-1",
    installedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    disabledAt: null,
  });
  // A non-text value is dropped, not leaked into the rules as an object.
  assert.deepEqual(record.config, { baseUrl: "https://acme.test", apiKey: "k", n: "3" });
  assert.equal(record.installedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(asConfig(null), {});

  const create = toConnectorCreate(record);
  assert.equal(create.connectorId, "acme-assets");
  assert.ok(create.installedAt instanceof Date);
  // The identity of the installation is not an updateable column.
  assert.ok(!("connectorId" in toConnectorUpdate(record)));
});

test("the Prisma store scopes every read by tenant", async () => {
  const rows = new Map<string, ConnectorInstallationRow>();
  const make = (tenantId: string, connectorId: string, id: string): ConnectorInstallationRow => ({
    id,
    tenantId,
    connectorId,
    config: { baseUrl: "https://acme.test", apiKey: "k" },
    enabled: true,
    installedBy: "admin-1",
    installedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    disabledAt: null,
  });
  rows.set("a", make("tenant-a", "acme-assets", "ci-a"));
  rows.set("b", make("tenant-b", "acme-assets", "ci-b"));

  const client: ConnectorPrismaClient = {
    connectorInstallation: {
      create: async () => ({}),
      findUnique: async ({ where }) => {
        const key = (where as { tenantId_connectorId: { tenantId: string } }).tenantId_connectorId.tenantId;
        return rows.get(key === "tenant-a" ? "a" : key === "tenant-b" ? "b" : "") ?? null;
      },
      findMany: async (args) => {
        const where = (args as { where: { tenantId: string; id?: string } }).where;
        return [...rows.values()].filter(
          (row) => row.tenantId === where.tenantId && (where.id === undefined || row.id === where.id),
        );
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
  };

  const store = new PrismaConnectorStore(client);
  const a = await store.find("tenant-a", "acme-assets");
  assert.equal(a?.id, "ci-a");
  // Asking tenant A for tenant B's installation id gets nothing, not B's row.
  assert.equal(await store.findById("tenant-a", "ci-b"), null);
  assert.equal((await store.findById("tenant-b", "ci-b"))?.id, "ci-b");
});
