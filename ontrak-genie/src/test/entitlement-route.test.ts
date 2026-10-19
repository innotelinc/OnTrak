import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Where the entitlement question goes, and what it brings back.
 *
 * Since 2026-10-18 Genie asks the control plane rather than Magnate directly, so
 * the answer carries the whole subscription — the verdict, the plan's limits, and
 * the service-account rule. Three things have to be true at once and this file
 * pins all of them against one fake server that plays both roles:
 *
 *   * the route changes the credential (internal token, not a billing bearer);
 *   * the answer's limits and `service` flag survive the trip, because a caller
 *     that dropped them would meter an unlimited account;
 *   * the *public* address, not the internal endpoint, is where people are sent
 *     to buy — the endpoint is a container address nobody can open in a browser.
 *
 * The environment is set before the imports because `src/config.ts` reads it once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "entitlement-route-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

interface Seen {
  path: string;
  internal: string | undefined;
  authorization: string | undefined;
}
const seen: Seen[] = [];

/**
 * What the control plane answers next.
 *
 * Mutable so one server can play both subscribers — an unlimited service account
 * and a metered plan — without a second process: `config` is read once, so the
 * endpoint cannot change, but the answer can.
 */
let answer: () => unknown = () => ({
  entitled: true,
  service: true,
  reason: "service account: no subscription, no limits",
  plan: "service",
  limits: null,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  seen.push({
    path: url.pathname,
    internal: req.headers["x-control-internal-token"] as string | undefined,
    authorization: req.headers.authorization,
  });
  if (url.pathname === "/api/internal/entitlement") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer()));
    return;
  }
  if (url.pathname === "/api/plans") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        plans: [
          {
            slug: "genie",
            name: "Genie",
            priceMonthlyCents: 1900,
            priceYearlyCents: 15276,
            billingUnit: "",
            pricePerUnitCents: 0,
            perUnit: false,
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.MAGNATE_ENTITLEMENTS_URL = `${origin}/api/internal/entitlement`;
process.env.CONTROL_INTERNAL_TOKEN = "internal-token-for-tests";
process.env.ENTITLEMENTS_API_TOKEN = "billing-bearer-must-not-be-used";
process.env.MAGNATE_PUBLIC_URL = origin;
// The API origin is the one asked for prices. Pointed at the fake server too, so
// the case below proves the two origins are used for the two different jobs.
process.env.MAGNATE_API_URL = origin;
process.env.MAGNATE_GENIE_PLAN = "genie";

const { checkEntitlement, planPrice, signupUrlFor, isControlPlaneRoute } = await import(
  "../entitlements.js"
);

test.after(() => {
  server.close();
});

test("the control-plane route is recognised by path, with or without a trailing slash", () => {
  assert.equal(isControlPlaneRoute("http://192.168.1.61:20140/api/internal/entitlement"), true);
  assert.equal(isControlPlaneRoute("http://192.168.1.61:20140/api/internal/entitlement/"), true);
  assert.equal(isControlPlaneRoute("http://192.168.1.57:3002/api/entitlements"), false);
  assert.equal(isControlPlaneRoute("not a url"), false);
});

test("an entitlement question to the control plane carries the internal token, not the billing bearer", async () => {
  seen.length = 0;
  const answer = await checkEntitlement({
    plan: "genie",
    user: "atheniq@innotel.us",
    unavailable: "custom preview names are unavailable",
  });

  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.ok(request !== undefined);
  assert.equal(request.path, "/api/internal/entitlement");
  assert.equal(request.internal, "internal-token-for-tests");
  assert.equal(request.authorization, undefined, "the billing bearer must not be sent to the plane");

  // The whole answer survives: an unlimited service account is entitled and its
  // limits are absent, which is not the same as zero.
  assert.equal(answer.entitled, true);
  assert.equal(answer.service, true);
  assert.equal(answer.plan, "service");
  assert.equal(answer.limits, null);
});

test("limits a plan does carry are kept, and a negative cap is not mistaken for one", async () => {
  answer = () => ({
    entitled: true,
    service: false,
    reason: "subscription active",
    plan: "genie",
    limits: { requests_per_day: 200, tokens_per_day: -1, spend_cap_usd: 5 },
  });

  const metered = await checkEntitlement({
    plan: "genie",
    user: "subscriber@example.com",
    unavailable: "unavailable",
  });
  assert.equal(metered.entitled, true);
  assert.equal(metered.service, false);
  assert.equal(metered.plan, "genie");
  assert.deepEqual(metered.limits, { requestsPerDay: 200, tokensPerDay: null, spendCapUsd: 5 });

  // A refusal is a refusal — not an absence of an answer.
  answer = () => ({ entitled: false, service: false, reason: "no subscription", plan: "genie" });
  const refused = await checkEntitlement({
    plan: "genie",
    user: "lapsed@example.com",
    unavailable: "unavailable",
  });
  assert.equal(refused.entitled, false);
  assert.equal(refused.reason, "no subscription");
  assert.equal(refused.limits, null);
});

test("the signup link and the price list point at the public address, not the internal endpoint", async () => {
  assert.equal(signupUrlFor("genie"), `${origin}/signup?plan=genie`);

  const price = await planPrice("genie");
  assert.notEqual(price, null);
  assert.equal(price?.priceMonthlyCents, 1900);
  assert.equal(price?.priceYearlyCents, 15276);
  assert.equal(
    seen.some((request) => request.path === "/api/plans"),
    true,
    "the catalog must be asked of the public origin",
  );
});
