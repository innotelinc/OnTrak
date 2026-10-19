import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Engineer's credit gate, against a fake control plane.
 *
 * The module is deliberately thin — it asks Distro for a balance, asks Distro to
 * spend, and reports the answer — so what is worth pinning is the contract with
 * that plane, because a mistake here is a mistake about money:
 *
 *   * the credential is the internal token, and nothing between here and the plane
 *     may cache the answer;
 *   * the project goes over as the idempotency key, and the module believes the
 *     plane's `duplicate`/`spent` rather than assuming it charged;
 *   * a refusal is a readable answer (402 material), not an exception;
 *   * an *unreachable* plane fails open for the operator while an unreachable plane
 *     during a charge throws — one is a page render, the other is a decision about
 *     somebody's balance, and they must not behave the same way;
 *   * `user_not_found` is a deployment problem, not a customer with an empty
 *     wallet, so it does not read as "buy credits".
 *
 * Two cases cannot live here: "no plane configured" and "plane unreachable" are
 * decided by `config.ts` at import time and the object is read-only, so each lives in
 * its own file — the same split `entitlement-route-unset.test.ts` uses. They are
 * `engineer-unset.test.ts` and `engineer-outage.test.ts`.
 *
 * The environment is set before the imports because `src/config.ts` reads it once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "engineer-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

interface Seen {
  path: string;
  method: string;
  internal: string | undefined;
  authorization: string | undefined;
  cache: string | undefined;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];

/**
 * The plane's ledger for this test: a small balance, and the references already
 * charged. Charging a reference twice is what a retry does, so the fake plane
 * deduplicates exactly as Distro does — the point is to watch the console pass the
 * key through and believe the answer.
 */
const ledger = { balance: 2, charged: new Set<string>() };
let service = false;

/** What the status route answers next; replaced per test where it matters. */
let statusOverride: Record<string, unknown> | null = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let body: Record<string, unknown> | null = null;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    seen.push({
      path: url.pathname,
      method: req.method ?? "GET",
      internal: req.headers["x-control-internal-token"] as string | undefined,
      authorization: req.headers.authorization,
      cache: req.headers["cache-control"] as string | undefined,
      body,
    });
    const json = (status: number, payload: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));

    if (url.pathname === "/api/internal/credits") {
      if (statusOverride !== null) return json(200, statusOverride);
      if (service) {
        return json(200, {
          allowed: true,
          balance: null,
          unlimited: true,
          credits_per_project: 1,
          price_per_credit_usd: 5,
          reason: "service account",
        });
      }
      return json(200, {
        allowed: ledger.balance >= 1,
        balance: ledger.balance,
        unlimited: false,
        credits_per_project: 1,
        price_per_credit_usd: 5,
        reason: ledger.balance >= 1 ? "" : "no credits left",
      });
    }

    if (url.pathname === "/api/internal/credits/spend") {
      const reference = typeof body?.reference === "string" ? body.reference : null;
      if (service) return json(200, { ok: true, service: true, spent: 0, balance: null });
      if (reference !== null && ledger.charged.has(reference)) {
        return json(200, { ok: true, spent: 0, duplicate: true, balance: ledger.balance });
      }
      if (ledger.balance < 1) {
        return json(200, { ok: false, code: "insufficient_credits", balance: 0 });
      }
      if (reference !== null) ledger.charged.add(reference);
      ledger.balance -= 1;
      return json(200, { ok: true, spent: 1, balance: ledger.balance });
    }

    json(404, { error: "not found" });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.CONTROL_PLANE_INTERNAL_URL = origin;
process.env.CONTROL_INTERNAL_TOKEN = "internal-token-for-tests";

const { CreditError, ENGINEER_PRODUCT, chargeProject, creditStatusFor } = await import("../engineer.js");

test.after(() => {
  server.close();
});

test.beforeEach(() => {
  seen.length = 0;
  statusOverride = null;
  ledger.balance = 2;
  ledger.charged.clear();
  service = false;
});

test("the balance is asked with the internal token, uncached, and read back", async () => {
  const status = await creditStatusFor("atheniq@innotel.us");
  assert.equal(status.gated, true);
  assert.equal(status.allowed, true);
  assert.equal(status.balance, 2);
  assert.equal(status.creditsPerProject, 1);
  assert.equal(status.pricePerCreditUsd, 5);
  assert.equal(status.unlimited, false);

  const call = seen.at(-1);
  assert.ok(call);
  assert.equal(call.path, "/api/internal/credits");
  assert.equal(call.internal, "internal-token-for-tests");
  assert.equal(call.authorization, undefined, "the billing bearer must never stand in for the plane's credential");
  assert.match(call.cache ?? "", /no-store/);
});

test("a charge spends one credit and sends the project as the reference", async () => {
  const charge = await chargeProject("atheniq@innotel.us", "proj-42");
  assert.equal(charge.allowed, true);
  assert.equal(charge.spent, 1);
  assert.equal(charge.balance, 1);
  assert.equal(charge.duplicate, false);
  assert.equal(ledger.balance, 1);

  const call = seen.at(-1);
  assert.ok(call);
  assert.equal(call.path, "/api/internal/credits/spend");
  assert.equal(call.method, "POST");
  assert.equal(call.body?.user, "atheniq@innotel.us");
  assert.equal(call.body?.product, ENGINEER_PRODUCT);
  assert.equal(call.body?.reference, "proj-42");
  assert.match(String(call.body?.reason), /proj-42/);
});

test("the same project charged twice costs one credit, because the plane says so", async () => {
  await chargeProject("atheniq@innotel.us", "proj-42");
  const again = await chargeProject("atheniq@innotel.us", "proj-42");
  assert.equal(again.allowed, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.spent, 0);
  assert.equal(ledger.balance, 1, "a retry must not take a second credit");
});

test("an empty balance is a refusal with a reason, not an exception", async () => {
  ledger.balance = 0;
  const charge = await chargeProject("atheniq@innotel.us", "proj-7");
  assert.equal(charge.allowed, false);
  assert.equal(charge.spent, 0);
  assert.equal(charge.balance, 0);
  assert.equal(charge.reason, "insufficient_credits");
});

test("a service account is unlimited and is never charged", async () => {
  service = true;
  const charge = await chargeProject("genie@innotel.us", "proj-9");
  assert.equal(charge.allowed, true);
  assert.equal(charge.unlimited, true);
  assert.equal(charge.balance, null);
  assert.equal(charge.spent, 0);
});

test("an account the plane does not know is a deployment problem, not an empty wallet", async () => {
  statusOverride = { reason: "user_not_found" };
  const status = await creditStatusFor("nobody@innotel.us");
  assert.equal(status.gated, false);
  assert.equal(status.allowed, true, "an unknown account must not be told it has no credits");
  assert.match(status.reason, /no account/);
});
