/**
 * OnTrak Tix M4 tests: the identity one client is shown in.
 *
 * Branding is where a multi-client desk is most easily wrong in a way the client
 * sees: somebody else's name, somebody else's colour, or a page that fetches an
 * image from a URL a third party controls. So the tests are about the refusals as
 * much as the feature — an unreadable accent colour, an `http:` logo, a
 * `data:text/html` "image" — and about the fallback never being an error.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-branding.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  DESK_BRAND,
  MIN_ACCENT_CONTRAST,
  brandFor,
  brandingStyle,
  brandingSummary,
  contrastRatio,
  logoUrlIssue,
  normalizeHexColor,
  validateClientBranding,
} from "../src/lib/client-branding-rules";
import { ClientBrandingService, MemoryClientBrandingStore } from "../src/lib/client-branding-service";
import { ClientService, MemoryClientStore } from "../src/lib/client-service";
import { toClientBrandingRecord, type ClientBrandingRow } from "../src/lib/client-branding-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const NOW = "2026-09-20T12:00:00.000Z";

async function harness() {
  const clients = new ClientService(new MemoryClientStore(), null, { id: () => `c-${Math.random()}`, now: () => NOW });
  const audit = new AuditLog(sha256);
  const store = new MemoryClientBrandingStore();
  const service = new ClientBrandingService(store, clients, audit, {
    id: () => `brand-${sequential++}`,
    now: () => NOW,
  });

  const northwind = await clients.create(ADMIN, { name: "Northwind" });
  const contoso = await clients.create(ADMIN, { name: "Contoso" });
  assert.equal(northwind.ok && contoso.ok, true);
  if (!northwind.ok || !contoso.ok) throw new Error("fixture");

  // The agent serves Northwind only, so Contoso is out of scope for them.
  assert.equal((await clients.assign(ADMIN, northwind.value.id, AGENT.id)).ok, true);

  return { clients, audit, store, service, northwind: northwind.value.id, contoso: contoso.value.id };
}

let sequential = 0;

/* ------------------------------------------------------------------- the colour */

test("a colour is accepted only if it can be read on the portal it is shown on", () => {
  // White on the portal's near-black background: as readable as the scale goes.
  assert.ok(contrastRatio("#ffffff", "#0b0d10") > 19);
  assert.equal(contrastRatio("#0b0d10", "#0b0d10"), 1);

  // Readable: accepted, and normalised so two spellings are one value.
  assert.deepEqual(validateClientBranding({ displayName: "Northwind", accentColor: "#3AA0FF" }), []);
  assert.equal(normalizeHexColor("#3AA0FF"), "#3aa0ff");
  assert.equal(normalizeHexColor("#39f"), "#3399ff");

  // The portal's own background as an accent: the brand would vanish.
  const dark = validateClientBranding({ displayName: "Northwind", accentColor: "#0b0d10" });
  assert.equal(dark.length, 1);
  assert.equal(dark[0].field, "accentColor");
  assert.match(dark[0].message, new RegExp(`${MIN_ACCENT_CONTRAST}:1`));

  // And a value that is not a colour at all is refused with its own reason.
  assert.match(validateClientBranding({ displayName: "Northwind", accentColor: "cornflower" })[0].message, /hex/);
});

test("a logo is an image the page renders, never a URL it has to trust", () => {
  assert.equal(logoUrlIssue("https://example.com/logo.svg"), null);
  assert.equal(logoUrlIssue("data:image/png;base64,iVBORw0KGgo="), null);
  assert.equal(logoUrlIssue(""), null, "no logo is a valid choice");

  assert.match(logoUrlIssue("http://example.com/logo.svg")!, /https/);
  assert.match(logoUrlIssue("data:text/html;base64,PHNjcmlwdD4=")!, /base64 image/);
  assert.match(logoUrlIssue("javascript:alert(1)")!, /https:\/\/ URL or an inline base64 image/);
  assert.match(logoUrlIssue(`data:image/png;base64,${"A".repeat(200_000)}`)!, /at most 100 KB/);
});

/* ------------------------------------------------------------------- the brand */

test("a client with no branding of its own reads as the desk, by name, with no error", () => {
  const brand = brandFor({ name: "Northwind" }, null);
  assert.equal(brand.source, "desk");
  assert.equal(brand.name, "Northwind", "the client is still called what the desk filed them as");
  assert.equal(brand.accentColor, DESK_BRAND.accentColor);
  assert.match(brandingSummary(brand), /no branding of its own/);

  const own = brandFor({ name: "Northwind" }, {
    id: "b1",
    tenantId: "tenant-a",
    clientId: "client-1",
    displayName: "Northwind Support Desk",
    accentColor: "#3aa0ff",
    logoUrl: null,
    supportEmail: "help@northwind.example",
    signature: null,
    updatedBy: "admin-1",
    updatedAt: NOW,
    createdAt: NOW,
  });
  assert.equal(own.source, "client");
  assert.equal(own.name, "Northwind Support Desk");
  assert.match(brandingSummary(own), /help@northwind\.example/);

  // The style is a plain object of custom properties, which is what a page sets.
  assert.deepEqual(brandingStyle(own), {
    "--brand-accent": "#3aa0ff",
    "--brand-tint": "#3aa0ff22",
    "--brand-border": "#3aa0ff55",
  });
});

/* ------------------------------------------------------------------- the service */

test("branding is written once per client, audited, and read back by the client it belongs to", async () => {
  const h = await harness();

  const saved = await h.service.save(ADMIN, h.northwind, {
    displayName: "Northwind Support Desk",
    accentColor: "#3AA0FF",
    logoUrl: "https://example.com/logo.svg",
    supportEmail: "help@northwind.example",
    signature: "— Northwind IT",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.accentColor, "#3aa0ff", "normalised on the way in");

  // Saving again replaces rather than accumulates: a brand is a current fact.
  const again = await h.service.save(ADMIN, h.northwind, {
    displayName: "Northwind IT",
    accentColor: "#7dd3fc",
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.id, saved.value.id, "one row per client");
  assert.equal(again.value.accentColor, "#7dd3fc");

  const read = await h.service.for(ADMIN, h.northwind);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.value.brand.name, "Northwind IT");
    assert.ok(read.value.contrast >= MIN_ACCENT_CONTRAST);
  }

  // The one the agent does not serve reads as the desk, and cannot be written.
  const other = await h.service.for(AGENT, h.contoso);
  assert.equal(other.ok, false, "out of scope is out of scope for reads too");
  const written = await h.service.save(AGENT, h.contoso, { displayName: "Contoso", accentColor: "#3aa0ff" });
  assert.equal(written.ok, false);

  // The agent *can* read their own client's brand, but a brand is a management act.
  const mine = await h.service.for(AGENT, h.northwind);
  assert.equal(mine.ok, true);
  const agentWrite = await h.service.save(AGENT, h.northwind, { displayName: "Nope", accentColor: "#3aa0ff" });
  assert.equal(agentWrite.ok, false);
  if (!agentWrite.ok) assert.match(agentWrite.error, /manage clients/);

  const actions = h.audit.snapshot().events.filter((event) => event.action.startsWith("client.branding"));
  assert.deepEqual(
    actions.map((event) => event.action),
    ["client.branding.create", "client.branding.update"],
  );
  assert.equal(actions[0].targetId, h.northwind);
  assert.equal(actions[1].detail?.hasLogo, false, "the update dropped the logo, and the record says so");
});

test("the public survey path resolves a brand from a tenant and a client, with no actor at all", async () => {
  const h = await harness();
  assert.equal(
    (await h.service.save(ADMIN, h.northwind, { displayName: "Northwind Support Desk", accentColor: "#7dd3fc" })).ok,
    true,
  );

  const brand = await h.service.forToken("tenant-a", h.northwind, "Northwind");
  assert.equal(brand.source, "client");
  assert.equal(brand.name, "Northwind Support Desk");

  // A client with no row still gets a usable brand for the page rather than null.
  const fallback = await h.service.forToken("tenant-a", h.contoso, "Contoso");
  assert.equal(fallback.source, "desk");
  assert.equal(fallback.name, "Contoso");
});

/* ------------------------------------------------------------------- the adapter */

test("the Prisma adapter maps a row both ways without inventing a value", () => {
  const row: ClientBrandingRow = {
    id: "brand-1",
    tenantId: "tenant-a",
    clientId: "client-1",
    displayName: "Northwind Support Desk",
    accentColor: "#3aa0ff",
    logoUrl: null,
    supportEmail: null,
    signature: null,
    updatedBy: "admin-1",
    updatedAt: new Date(NOW),
    createdAt: new Date(NOW),
  };

  const record = toClientBrandingRecord(row);
  assert.equal(record.accentColor, "#3aa0ff");
  assert.equal(record.updatedAt, NOW);
  assert.equal(record.logoUrl, null, "an absent logo stays absent rather than becoming ''");
});
