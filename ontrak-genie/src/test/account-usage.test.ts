import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, beforeEach } from "node:test";

import type { ControlPlaneConfig } from "../controlplane.js";
import type { Session } from "../oidc.js";
import { accountUsage, resetCallerCache } from "../tenancy.js";

/**
 * Per-account usage the account can read (v0.3).
 *
 * The ledger is written by every turn; this is the half a person can act on —
 * the spend the console shows back, read from the plane's own verdict so the
 * number displayed and the number that refuses the next turn cannot disagree.
 * The cases that matter are the answer (usage + caps), no plane (an answer, not
 * an error) and no account.
 */

const plane = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/api/internal/identity") {
    return send(200, {
      user: { id: "u-1", email: "dev@example.test" },
      oidcSub: "sub-1",
      gatewayKey: "sk-account",
      quota: { plan: "pro" },
    });
  }
  if (req.url === "/api/internal/quota-check") {
    return send(200, {
      allowed: true,
      reasons: [],
      quota: { plan: "pro", requests_per_day: 200, tokens_per_day: 2_000_000, spend_cap_usd: 20 },
      usageToday: { tokens_in: 10, tokens_out: 20, requests: 12, cost_usd: 0.42, date: "2026-10-01" },
    });
  }
  return send(404, { error: "not found" });
});

await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
const planeConfig: ControlPlaneConfig = {
  url: `http://127.0.0.1:${(plane.address() as AddressInfo).port}`,
  token: "internal-token",
};

after(() => {
  plane.close();
});

beforeEach(() => {
  resetCallerCache();
});

const session: Session = {
  sub: "sub-1",
  email: "dev@example.test",
  name: "Dev",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

test("an account reads its own usage and the caps it is judged by", async () => {
  const result = await accountUsage(session, planeConfig);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.email, "dev@example.test");
  assert.equal(result.usage.allowed, true);
  assert.equal(result.usage.quota?.requestsPerDay, 200);
  assert.equal(result.usage.usageToday?.requests, 12);
  assert.equal(result.usage.usageToday?.tokensOut, 20);
});

test("no plane is an answer, not a failure: there is no account to read", async () => {
  const result = await accountUsage(session, null);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 404);
  assert.match(result.ok === false ? result.message : "", /no control plane/);
});

test("no signed-in account is refused the same way a turn is", async () => {
  const result = await accountUsage(null, planeConfig);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 401);
});
