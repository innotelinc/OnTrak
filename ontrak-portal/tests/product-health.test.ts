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

test("every product declares the family health path", () => {
  for (const product of PRODUCTS) {
    assert.equal(
      product.health,
      "/health",
      `${product.key} must answer /health — the dashboard probes this exact path`,
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
