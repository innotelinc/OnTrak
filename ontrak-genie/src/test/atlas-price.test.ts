import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * What the Atlas add-on costs, and who says so.
 *
 * The console is not the price list. A number shown beside "subscribe" has to be
 * the number the checkout charges, so the panel asks Magnate's public catalog —
 * `/api/plans` — and shows what comes back. Two outcomes have to stay
 * distinguishable, and this file is about exactly that: a catalog that carries the
 * plan yields its price, and a catalog that does not (or a Magnate that cannot be
 * reached) yields **nothing**, never a plausible-looking number invented here.
 *
 * Atlas is sold *per class*, which is its own shape: one recurring amount for one
 * unit, with the plan-level monthly/yearly figures left at zero. So the catalog
 * here carries both shapes — the per-unit add-on and a plan priced the usual way —
 * because a reader that only understood one of them would quote the other wrongly.
 *
 * The environment is set before the imports because `src/config.ts` reads it once,
 * which is the same discipline `hosting.test.ts` uses for the same reason.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-price-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.AGENT_ATLAS_URL = "http://atlas.test:3000";
process.env.AGENT_ATLAS_USER = "";
process.env.AGENT_ATLAS_PASSWORD = "";
process.env.MAGNATE_ATLAS_PLAN = "atlas";

/** A Magnate that answers its public catalog, and nothing else. */
const plans = [
  {
    slug: "atlas",
    name: "Atlas Forge",
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    billingUnit: "class",
    pricePerUnitCents: 275000,
    perUnit: true,
  },
  {
    slug: "genie",
    name: "Genie Subdomain",
    priceMonthlyCents: 500,
    priceYearlyCents: 5000,
    billingUnit: "",
    pricePerUnitCents: 0,
    perUnit: false,
  },
];
const requested: string[] = [];
const magnate = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/plans") {
    res.writeHead(404).end("{}");
    return;
  }
  requested.push(url.searchParams.get("service") ?? "");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ plans: plans.filter((plan) => plan.slug === url.searchParams.get("service")) }));
});
await new Promise<void>((resolve) => magnate.listen(0, "127.0.0.1", resolve));
const port = (magnate.address() as { port: number }).port;
process.env.MAGNATE_ENTITLEMENTS_URL = `http://127.0.0.1:${port}/api/entitlements`;
// Explicitly empty for the same reason as the endpoint above: the operator's
// `.env` sets the public shop (subscribe.innotel.us), and node's env-file loading
// does not override a variable already in the environment — so without this the
// catalog query would leave the LAN and this test would assert against production.
process.env.MAGNATE_PUBLIC_URL = "";
// The API origin is pinned empty for the same reason as the others: the
// operator's `.env` sets it (app.magnate.innotel.us) and node's env-file
// loading does not override a live variable, so without this the price read
// would leave the test for production.
process.env.MAGNATE_API_URL = "";

const { atlasInfo } = await import("../atlas.js");
const { planPrice, resetPriceCache } = await import("../entitlements.js");

test.after(() => {
  magnate.close();
});

test("Atlas quotes the price Magnate publishes for the plan", async (t) => {
  await t.test("the add-on's cost is read from the catalog, not written here", async () => {
    resetPriceCache();
    const info = await atlasInfo(null);
    assert.equal(info.configured, true);
    assert.equal(info.price?.slug, "atlas");
    assert.equal(info.price?.name, "Atlas Forge");
    // Per class: the plan-level figures are zero because the price belongs to the
    // unit, and both halves come through so the panel can say which it is.
    assert.equal(info.price?.billingUnit, "class");
    assert.equal(info.price?.pricePerUnitCents, 275000);
    assert.equal(info.price?.perUnit, true);
    assert.equal(info.price?.priceMonthlyCents, 0);
    assert.equal(info.price?.priceYearlyCents, 0);
    // One origin for the whole platform: the catalog and the signup page are the
    // same Magnate, so a person is never sent somewhere that sells something else.
    assert.equal(info.signupUrl, `http://127.0.0.1:${port}/signup?plan=atlas`);
    assert.ok(requested.includes("atlas"), "the catalog was asked about this plan");
  });

  await t.test("a plan priced the usual way still reads as monthly and yearly", async () => {
    resetPriceCache();
    const price = await planPrice("genie");
    assert.equal(price?.priceMonthlyCents, 500);
    assert.equal(price?.priceYearlyCents, 5000);
    assert.equal(price?.billingUnit, "");
    assert.equal(price?.perUnit, false);
  });

  await t.test("a plan the catalog does not carry yields no price, not a guess", async () => {
    resetPriceCache();
    assert.equal(await planPrice("not-a-real-plan"), null);
  });
});
