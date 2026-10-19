import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

/**
 * G0DM0D3 against a fake plane and a fake Genie.
 *
 * What is worth pinning is the bookkeeping, because it is the part a person
 * experiences as money:
 *
 *   * nothing runs without an identity the proxy vouched for;
 *   * nothing runs without a charge, and the charge carries the run id so a
 *     double-submit is free;
 *   * a run Genie refused, or never answered, is refunded — once, and under a
 *     reference that makes the refund itself idempotent;
 *   * a run that produced bytes relays them untouched.
 */
const charges = [];
const grants = [];
const genieCalls = [];
let balance = 2;
let service = false;
let genieReply = { status: 200, chunks: ['data: {"text":"hel"}\n\n', 'data: {"text":"lo"}\n\n'], headers: { "content-type": "text/event-stream" } };

/**
 * What the plane answers about a subscription: `entitled`, `not entitled`, or an
 * answer nobody could get. Mutable, because the three states lead to three
 * different pages and the tests are about telling them apart.
 */
let entitlement = { entitled: true, plan: "free", service: false, reason: "subscribed" };

const plane = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const json = (payload) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (url.pathname === "/api/internal/entitlement") {
      // this fake writes 200 and takes the payload alone, like the other branches
      return json({ email: url.searchParams.get("user"), plan_asked: url.searchParams.get("plan"), source: "distro", ...entitlement });
    }
    if (url.pathname === "/api/internal/credits") {
      if (service) return json({ allowed: true, unlimited: true, balance: null, credits_per_project: 1, price_per_credit_usd: 5 });
      return json({ allowed: balance > 0, unlimited: false, balance, credits_per_project: 1, price_per_credit_usd: 5, reason: balance > 0 ? "credits available" : "no credits left" });
    }
    if (url.pathname === "/api/internal/credits/spend") {
      charges.push({ ...body, token: req.headers["x-control-internal-token"] });
      const seen = charges.some((c) => c !== charges.at(-1) && c.reference === body.reference);
      if (service) return json({ ok: true, service: true, spent: 0, balance: null });
      if (seen) return json({ ok: true, duplicate: true, spent: 0, balance });
      if (balance <= 0) return json({ ok: false, code: "insufficient_credits", balance: 0 });
      balance -= 1;
      return json({ ok: true, spent: 1, balance });
    }
    if (url.pathname === "/api/internal/credits/grant") {
      grants.push(body);
      balance += Number(body.credits ?? 0);
      return json({ ok: true, balance });
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => plane.listen(0, "127.0.0.1", r));

const genie = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    genieCalls.push({
      path: req.url,
      auth: req.headers.authorization,
      actor: req.headers["x-genie-actor"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    res.writeHead(genieReply.status, genieReply.headers ?? { "content-type": "application/json" });
    if (genieReply.status === 200) {
      for (const chunk of genieReply.chunks) res.write(chunk);
      res.end();
      return;
    }
    res.end(genieReply.chunks.join(""));
  });
});
await new Promise((r) => genie.listen(0, "127.0.0.1", r));

const planeOrigin = `http://127.0.0.1:${plane.address().port}`;
const genieOrigin = `http://127.0.0.1:${genie.address().port}`;

const { createServer } = await import("../src/app.js");

const config = {
  port: 0,
  product: "g0dm0d3",
  slug: "g0dm0d3",
  name: "G0DM0D3",
  tagline: "the agent, one credit a run",
  subscribeUrl: "https://subscribe.genie.innotel.us",
  workUrl: "https://genie.ontrak.innotel.us",
  creditsPerRun: 1,
  genieUrl: genieOrigin,
  genieToken: "genie-service-token",
  trustProxyHeaders: true,
};
process.env.CONTROL_PLANE_INTERNAL_URL = planeOrigin;
process.env.CONTROL_INTERNAL_TOKEN = "plane-token";

const app = createServer(config);
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;

test.after(() => {
  app.close();
  plane.close();
  genie.close();
});

test.beforeEach(() => {
  charges.length = 0;
  grants.length = 0;
  genieCalls.length = 0;
  balance = 2;
  service = false;
  genieReply = { status: 200, chunks: ['data: {"text":"hel"}\n\n', 'data: {"text":"lo"}\n\n'], headers: { "content-type": "text/event-stream" } };
  entitlement = { entitled: true, plan: "free", service: false, reason: "subscribed" };
});

const headers = { "content-type": "application/json", "x-auth-request-email": "atheniq@innotel.us" };

test("health answers without a session, because the portal's light is unauthenticated", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("no proxy identity means no session and no run", async () => {
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 401);
  const run = await fetch(`${base}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", runId: "run-12345678" }) });
  assert.equal(run.status, 401);
  assert.equal(charges.length + genieCalls.length, 0);
});

test("a header is not a login when the deployment has not said to trust it", async () => {
  const strict = createServer({ ...config, trustProxyHeaders: false });
  await new Promise((r) => strict.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${strict.address().port}/api/session`, { headers });
  assert.equal(res.status, 401);
  await new Promise((r) => strict.close(r));
});

test("the session shows the balance and the price before anything is spent", async () => {
  const res = await fetch(`${base}/api/session`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email, "atheniq@innotel.us");
  assert.equal(body.balance, 2);
  assert.equal(body.creditsPerRun, 1);
  assert.equal(body.pricePerCreditUsd, 5);
  assert.equal(body.allowed, true);
});

test("a run charges once, carries the run id, and relays the stream untouched", async () => {
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "say hello", runId: "run-aaaaaaaa" }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"hel"/);
  assert.match(text, /"lo"/);
  assert.equal(balance, 1);

  const charge = charges.at(-1);
  assert.equal(charge.user, "atheniq@innotel.us");
  assert.equal(charge.product, "g0dm0d3");
  assert.equal(charge.reference, "run-aaaaaaaa");
  assert.equal(charge.token, "plane-token");

  const call = genieCalls.at(-1);
  assert.equal(call.path, "/api/chat");
  assert.equal(call.auth, "Bearer genie-service-token");
  assert.equal(call.body.message, "say hello");
  assert.equal(call.actor, "atheniq@innotel.us", "the run is attributed to the signed-in person, not to the service");
});

test("the same run id twice costs one credit", async () => {
  await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-bbbbbbbb" }) });
  await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-bbbbbbbb" }) });
  assert.equal(balance, 1, "a retried run must not be billed twice");
  assert.equal(charges.length, 2, "both attempts are asked about; the plane answers the second as a duplicate");
});

test("an empty balance is a 402 and Genie is never called", async () => {
  balance = 0;
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-cccccccc" }) });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, "no credits left");
  assert.equal(genieCalls.length, 0);
});

test("a run without a run id is refused, because a retry would cost a second credit", async () => {
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go" }) });
  assert.equal(res.status, 400);
  assert.equal(charges.length, 0);
});

test("Genie refusing the run refunds it, under a reference of its own", async () => {
  genieReply = { status: 429, chunks: ["slow down"] };
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-dddddddd" }) });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.refunded, true);
  assert.equal(grants.length, 1);
  assert.equal(grants.at(0).reference, "refund-run-dddddddd");
  assert.equal(grants.at(0).credits, 1);
  assert.equal(balance, 2, "the credit is back");
});

test("Genie not answering refunds it too", async () => {
  const saved = config.genieUrl;
  config.genieUrl = "http://127.0.0.1:9"; // discard port: refuses
  try {
    const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-eeeeeeee" }) });
    assert.equal(res.status, 502);
    assert.equal(grants.length, 1);
    assert.equal(balance, 2);
  } finally {
    config.genieUrl = saved;
  }
});

test("a service account is unlimited and is never refunded anything", async () => {
  service = true;
  genieReply = { status: 500, chunks: ["boom"] };
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-ffffffff" }) });
  assert.equal(res.status, 502);
  assert.equal(grants.length, 0, "nothing was charged, so a refund row would be noise");
});

test("the session says whether there is a subscription, and where to get one", async () => {
  const res = await fetch(`${base}/api/session`, { headers });
  const body = await res.json();
  assert.equal(body.entitlement.state, "entitled");
  assert.equal(body.name, "G0DM0D3");
  assert.equal(body.subscribeUrl, "https://subscribe.genie.innotel.us");
});

test("a page with no subscription is an offer, not an empty wallet", async () => {
  entitlement = { entitled: false, plan: "free", service: false, reason: "no subscription" };
  const res = await fetch(`${base}/api/session`, { headers });
  const body = await res.json();
  assert.equal(body.entitlement.state, "not_entitled");
  assert.equal(body.subscribeUrl, "https://subscribe.genie.innotel.us");
});

test("a run without a subscription is refused with the plan to buy, and nothing is charged", async () => {
  entitlement = { entitled: false, plan: "free", service: false, reason: "no subscription" };
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-nosub-0001" }) });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "subscription_required");
  assert.equal(body.subscribeUrl, "https://subscribe.genie.innotel.us");
  assert.equal(charges.length, 0, "a non-subscriber is not charged");
  assert.equal(genieCalls.length, 0, "and nothing runs");
  assert.equal(balance, 2, "and their credits, if any, are untouched");
});

test("the page offers a way in and a way to top up", async () => {
  // Both are the difference between a console somebody can use and one that tells
  // them what is wrong with them: an unsigned visitor needs a button pointed at the
  // proxy's own sign-in, and a subscriber who has spent every credit needs one
  // pointed at the plans — the run box already stays on the page for them.
  const page = await (await fetch(`${base}/`)).text();

  assert.match(page, /href="\/oauth2\/sign_in"/, "the sign-in link is in the markup, not assembled later");
  assert.match(page, /id="signin-cta"/, "and it is the button the page reveals when the session is refused");
  assert.match(page, /\/oauth2\/sign_in\?rd=/, "it carries a return path back to this page");
  assert.match(page, /id="credits-cta"/, "the out-of-credits offer is on the page too");
  assert.match(page, /Out of credits/, "with a heading that says which state it is for");
});

test("billing that cannot answer is a retry, never a paywall", async () => {
  // `entitled: null` is the plane saying it could not get a verdict out of billing.
  entitlement = { entitled: null, plan: "free", service: false, reason: "HTTP 404", source: "unreachable" };
  const session = await (await fetch(`${base}/api/session`, { headers })).json();
  assert.equal(session.entitlement.state, "unknown");

  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-unknown-01" }) });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.retryable, true);
  assert.equal(body.code, undefined, "an outage must not answer with a plan to buy");
  assert.equal(charges.length, 0);
});

test("a service account is subscribed by rule, and still runs", async () => {
  entitlement = { entitled: true, service: true, plan: "service", reason: "service account: no subscription, no limits" };
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-service-01" }) });
  assert.equal(res.status, 200);
  assert.equal(charges.length, 1);
});
