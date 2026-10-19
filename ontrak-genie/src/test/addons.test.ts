import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The two add-ons, and what is left to spend on each.
 *
 * Engineer and Uncensored Godmode are separate front doors that spend the same
 * kind of credit out of the same account, so what this pins is that the console
 * asks about the right *product* for each — a list that asked once and showed the
 * same number twice would be worse than no list, because it would be believed.
 *
 * The plane answers per product here, with different balances, which is the only
 * way to tell "the console asked twice" from "the console asked once and printed
 * it twice". The route is asserted over the wire too, with a real session cookie:
 * a balance belongs to an account, so the route has to reach the same account the
 * console is signed in as — and refuse a caller it cannot name rather than answer
 * with somebody else's numbers.
 *
 * The environment is set before the imports because `src/config.ts` reads it once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "addons-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

/** What the plane is asked, and what it holds, per product. */
const asked: { product: string; user: string; internal: string | undefined }[] = [];
const balances: Record<string, number> = { engineer: 3, g0dm0d3: 0 };
/** Turned on to make the same plane fail, so "could not be read" is testable. */
let planeDown = false;

const plane = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (planeDown) {
    req.resume();
    res.writeHead(500, { "content-type": "application/json" }).end("{}");
    return;
  }
  // Who an address is, for a service acting for somebody. `x-genie-actor` is only
  // an identity once a proxy that checks identities can set it, and this is the
  // lookup that turns the address into the subject the turn belongs to.
  if (url.pathname === "/api/internal/identity/resolve" && req.method === "GET") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id: "u-addons", email: "atheniq@innotel.us", sub: "sub-addons", service: false }));
    return;
  }
  // Who the signed-in account is. The tenancy gate asks this before any route that
  // needs an account, so the fake answers it with the one subject the cookie names.
  if (url.pathname === "/api/internal/identity" && req.method === "POST") {
    req.resume();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          user: { id: "u-addons", email: "atheniq@innotel.us" },
          oidcSub: "sub-addons",
          gatewayKey: "sk-account-key",
          created: false,
          quota: { plan: "pro" },
        }),
      );
    return;
  }
  if (url.pathname !== "/api/internal/credits") {
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
    return;
  }
  const product = url.searchParams.get("product") ?? "";
  const user = url.searchParams.get("user") ?? "";
  asked.push({ product, user, internal: req.headers["x-control-internal-token"] as string | undefined });
  const balance = balances[product] ?? 0;
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(
      JSON.stringify({
        allowed: balance > 0,
        balance,
        unlimited: false,
        credits_per_project: 1,
        price_per_credit_usd: 5,
        reason: balance > 0 ? "" : "no credits left",
      }),
    );
});
await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
const planeOrigin = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;

process.env.CONTROL_PLANE_INTERNAL_URL = planeOrigin;
process.env.CONTROL_INTERNAL_TOKEN = "internal-token-for-tests";
// A session is what the console carries; sign-in is on so that a request without
// one is refused instead of quietly spending the deployment's own key.
process.env.ONTRAK_OIDC_ISSUER = "https://idp.invalid";
process.env.ONTRAK_OIDC_CLIENT_ID = "ontrak-genie";
process.env.ONTRAK_OIDC_SESSION_SECRET = "test-session-secret-value";
// A service (G0DM0D3, REA) arrives with the shared bearer and the address it acts
// for, so the add-on rows are read for *that* account rather than nobody's.
process.env.TRUSTED_ACTOR_HEADER = "1";
process.env.WEB_TOKEN = "console-token-for-tests";

const { addonCatalog, addonStatuses } = await import("../engineer.js");
const { createServer } = await import("../server.js");
const { SESSION_COOKIE, mintSession } = await import("../oidc.js");

const app = createServer();
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
const cookie = {
  cookie: `${SESSION_COOKIE}=${encodeURIComponent(
    mintSession({ sub: "sub-addons", email: "atheniq@innotel.us", name: "atheniq@innotel.us" }),
  )}`,
};

test.after(() => {
  app.close();
  plane.close();
});

test.beforeEach(() => {
  asked.length = 0;
  balances.engineer = 3;
  balances.g0dm0d3 = 0;
  planeDown = false;
});

test("each add-on's balance is asked for under its own product", async () => {
  const statuses = await addonStatuses("atheniq@innotel.us");

  assert.deepEqual(
    statuses.map((entry) => entry.key),
    ["engineer", "godmode"],
  );
  assert.deepEqual(
    asked.map((call) => call.product).sort(),
    ["engineer", "g0dm0d3"],
    "one question per product, not one question and two rows",
  );
  assert.equal(asked.every((call) => call.user === "atheniq@innotel.us"), true);
  assert.equal(asked.every((call) => call.internal === "internal-token-for-tests"), true);

  const engineer = statuses.find((entry) => entry.key === "engineer");
  const godmode = statuses.find((entry) => entry.key === "godmode");
  assert.equal(engineer?.credits.balance, 3);
  assert.equal(engineer?.credits.allowed, true);
  assert.equal(godmode?.credits.balance, 0, "a zero on one add-on must not become the other's balance");
  assert.equal(godmode?.credits.allowed, false);
  assert.equal(godmode?.credits.pricePerCreditUsd, 5);
});

test("the catalogue points at the two doors, and names the products they spend", () => {
  const catalog = addonCatalog();
  assert.deepEqual(catalog.map((entry) => entry.product), ["engineer", "g0dm0d3"]);
  for (const addon of catalog) {
    assert.match(addon.url, /^https:\/\//);
    assert.match(addon.name, /\S/);
    assert.match(addon.tagline, /\S/);
  }
  assert.notEqual(catalog[0]?.url, catalog[1]?.url, "two add-ons, two doors");
  // The doors are the two products themselves, not paths inside this console —
  // that separation is the whole point of naming them here.
  assert.equal(catalog[0]?.url, "https://re.genie.innotel.us");
  assert.equal(catalog[1]?.url, "https://uc.genie.innotel.us");
});

test("the route refuses a caller it cannot name, and draws both rows for the account it can", async () => {
  const anonymous = await fetch(`${base}/api/addons`);
  assert.equal(anonymous.status, 401, "a balance belongs to an account; nobody is not one");

  const response = await fetch(`${base}/api/addons`, { headers: cookie });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    email: string;
    topUpUrl: string;
    addons: { key: string; credits: { balance: number | null; allowed: boolean } }[];
  };

  assert.equal(payload.email, "atheniq@innotel.us");
  assert.equal(payload.addons.length, 2);
  assert.deepEqual(payload.addons.map((entry) => entry.key), ["engineer", "godmode"]);
  assert.equal(payload.addons[0]?.credits.balance, 3);
  assert.equal(payload.addons[1]?.credits.balance, 0);
  assert.match(payload.topUpUrl, /^https:\/\//, "somewhere to buy more is part of the answer");
  assert.equal(
    asked.every((call) => call.user === "atheniq@innotel.us"),
    true,
    "the rows must be this account's, not an empty string's",
  );
});

test("a service acting for somebody reads that account's balances, not an empty account's", async () => {
  const response = await fetch(`${base}/api/addons`, {
    headers: {
      authorization: "Bearer console-token-for-tests",
      "x-genie-actor": "atheniq@innotel.us",
    },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { email: string; addons: { credits: { balance: number | null } }[] };

  assert.equal(payload.email, "atheniq@innotel.us", "the actor is who these rows belong to");
  assert.equal(payload.addons[0]?.credits.balance, 3);
  assert.equal(
    asked.every((call) => call.user === "atheniq@innotel.us"),
    true,
    "an empty address would read as the deployment having no metering at all",
  );
});

test("an add-on whose balance cannot be read still draws a row, and does not read as zero", async () => {
  planeDown = true;
  const statuses = await addonStatuses("atheniq@innotel.us");

  assert.equal(statuses.length, 2, "an outage is not an empty list");
  assert.equal(
    statuses.every((entry) => entry.credits.gated === false),
    true,
    "gated: false is the honest answer for a balance nobody could read",
  );
  assert.equal(
    statuses.some((entry) => entry.credits.balance === 0),
    false,
    "zero would be a number the console could act on, and this is not one",
  );
  assert.equal(
    statuses.every((entry) => entry.credits.reason.length > 0),
    true,
    "each row says why, so the page can print it",
  );
});
