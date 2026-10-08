/**
 * Every product answers its health path, and the portal knows which path that is.
 *
 * The dashboard once drew "not answering" for Sentinel because it probed
 * `/health` on a product that had no such route. This pins the convention — one
 * path, answered by every product, without a credential — so the tile table
 * cannot drift to a path nobody serves. What proves the products agree is the
 * live probe, `npm run health:check`; this is what stops the table itself from
 * being the bug.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCTS } from "../src/lib/portal-rules";

/**
 * The exact path each product serves, written down per product.
 *
 * The convention is `/health`, answered by every product the family builds, and
 * that is what all but one entry lists. The exception is the lab: it is the Python
 * control plane (OnTrak-dev) — a peer service, not a Next.js app, and not ours to
 * change — and it answers `/healthz`. Probing it at `/health` would draw exactly the
 * false "not answering" the dashboard once drew for Sentinel, so the rule is not
 * "every product says `/health`" but "every product declares the path it serves, and
 * the catalogue's list is the whole list". A product whose route moves still fails
 * this, and a product added without a path here fails too.
 */
const EXPECTED_HEALTH: Record<string, string> = {
  its: "/health",
  tix: "/health",
  sentinel: "/health",
  sync: "/health",
  genie: "/health",
  lab: "/healthz",
};

test("the declared list covers exactly the catalogue", () => {
  assert.deepEqual(
    PRODUCTS.map((product) => product.key).sort(),
    Object.keys(EXPECTED_HEALTH).sort(),
    "every product needs a health path, and no path here may name a product that is gone",
  );
});

test("every product declares the path it serves", () => {
  for (const product of PRODUCTS) {
    assert.equal(
      product.health,
      EXPECTED_HEALTH[product.key],
      `${product.key} must answer ${EXPECTED_HEALTH[product.key]} — the dashboard probes this exact path`,
    );
  }
});

test("every product has a single-label host to build a URL from", () => {
  for (const product of PRODUCTS) {
    assert.match(
      product.host,
      /^[a-z0-9-]+$/,
      `${product.key} needs one subdomain label (got "${product.host}")`,
    );
  }
});
