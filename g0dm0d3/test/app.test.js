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

/*
 * The gateway half of the plane: who an address resolves to, which key pays, and
 * whether the key may spend. Mutable per test because each of those has one
 * interesting failure — an address the plane has never seen, a refusal, an
 * outage — and they lead to three different statuses.
 */
let identities = [];
let reports = [];
let quotaAllowed = true;
let quotaReasons = [];
let resolveStatus = 200;
const GATEWAY_KEY = "sk-the-users-own-key";

const plane = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const json = (payload) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (url.pathname === "/api/internal/identity/resolve") {
      if (resolveStatus !== 200) return res.writeHead(resolveStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "user_not_found" }));
      const email = url.searchParams.get("email");
      if (email !== "atheniq@innotel.us") return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "user_not_found" }));
      return json({ id: "u-1", email, sub: "sub-atheniq", plan: "free" });
    }
    if (url.pathname === "/api/internal/identity") {
      identities.push({ ...body, token: req.headers["x-control-internal-token"] });
      return json({ user: { id: "u-1", email: body.email }, oidcSub: body.sub, gatewayKey: GATEWAY_KEY, created: false, quota: { plan: "free" } });
    }
    if (url.pathname === "/api/internal/quota-check") {
      // The gateway key *is* the credential here, exactly as Genie's gate does it.
      return json({ allowed: quotaAllowed, reasons: quotaReasons, quota: { plan: "free" }, bearer: req.headers.authorization });
    }
    if (url.pathname === "/api/internal/usage-report") {
      reports.push({ ...body, bearer: req.headers.authorization });
      return json({ ok: true });
    }
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

/*
 * The gateway, as an OpenAI-compatible surface. What matters to the tests is the
 * credential it is called with and the body it is handed — the response itself is
 * relayed untouched, which is the point of the route.
 */
const gatewayCalls = [];
let gatewayReply = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto/chat", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
};
const gatewayServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    gatewayCalls.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      body: text === "" ? null : JSON.parse(text),
    });
    res.writeHead(gatewayReply.status, gatewayReply.headers);
    res.end(gatewayReply.body);
  });
});
await new Promise((r) => gatewayServer.listen(0, "127.0.0.1", r));
const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;

const { createServer } = await import("../src/app.js");
const { resetGatewayCache } = await import("../src/gateway.js");

const config = {
  port: 0,
  product: "g0dm0d3",
  slug: "g0dm0d3",
  name: "G0DM0D3",
  tagline: "the agent, one credit a run",
  subscribeUrl: "https://subscribe.genie.innotel.us",
  workUrl: "https://genie.ontrak.technology",
  creditsPerRun: 1,
  genieUrl: genieOrigin,
  genieToken: "genie-service-token",
  trustProxyHeaders: true,
  gatewayUrl: gatewayOrigin,
  gatewayModel: "auto/chat",
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
  gatewayServer.close();
});

test.beforeEach(() => {
  charges.length = 0;
  grants.length = 0;
  genieCalls.length = 0;
  gatewayCalls.length = 0;
  identities.length = 0;
  reports.length = 0;
  quotaAllowed = true;
  quotaReasons = [];
  resolveStatus = 200;
  gatewayReply = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto/chat", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  };
  // A cached gateway key would make one case's identity answer leak into the next.
  resetGatewayCache();
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

test("the theme is served from this door, unauthenticated, as css and js", async () => {
  // The pages are read into memory and served as one document, so the two files
  // that make them wear Unity have to come from the same app. No identity: a
  // stylesheet carries nothing, and gating it would only make the signed-in page
  // paint the wrong colours while the cookie is checked.
  const css = await fetch(`${base}/unity-theme.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const sheet = await css.text();
  assert.match(sheet, /--canvas:/);
  assert.match(sheet, /data-scheme="operations"/);

  const js = await fetch(`${base}/unity-theme.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.match(await js.text(), /data-mode/);
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

test("the identity header the proxy actually forwards is accepted", async () => {
  // --set-xauthrequest only fills response headers; what reaches this app from
  // the reverse proxy is X-Forwarded-Email. Reading it is what makes a signed-in
  // person a session instead of a sign-in loop.
  const res = await fetch(`${base}/api/session`, {
    headers: { "x-forwarded-email": "atheniq@innotel.us" },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, "atheniq@innotel.us");
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
  //
  // The metered page is `/metered` now: `/` is the door to the product's own UI,
  // and this is the console's credit-facing half, kept where it was.
  const page = await (await fetch(`${base}/metered`, { headers })).text();

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

test("the front door sends an unauthenticated request to sign in, not to the app", async () => {
  // A request that came around the proxy used to receive the whole application.
  // The page then 401'd its own session call, which is a page that looks broken;
  // a gate with one link is the honest answer.
  for (const path of ["/", "/index.html", "/studio", "/metered"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} must not be served without an identity`);
    const page = await res.text();
    assert.match(page, /\/oauth2\/sign_in\?rd=/, `${path} must offer the proxy's sign-in`);
    assert.doesNotMatch(page, /modeSwitcher/, `${path} must not leak the studio`);
  }
});

test("with an identity the front door redirects to index.html", async () => {
  const res = await fetch(`${base}/`, { headers, redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/index.html");

  // The query is carried across: `?embed=1` is how the console embeds the page
  // without a second menu bar, and dropping it on the redirect would restore it.
  const embedded = await fetch(`${base}/?embed=1`, { headers, redirect: "manual" });
  assert.equal(embedded.headers.get("location"), "/index.html?embed=1");
});

test("index.html is the studio for G0DM0D3", async () => {
  const res = await fetch(`${base}/index.html`, { headers });
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /id="modeSwitcher"/, "the studio's own mode switcher is on the page");
  assert.match(page, /data-godmode-embed/, "and the embed rule that removes the duplicate bar");
  assert.doesNotMatch(page, /id="signin-cta"/, "the studio is not the metered page");
});

test("the portal page is closed without a subscription, and offers one", async () => {
  // The studio brings its own model key and never calls `/api/run`, so serving
  // the page to a signed-in account with no plan would hand over the product.
  // The page is part of the product: it is gated like the run.
  entitlement = { entitled: false, plan: null, service: false, reason: "no subscription" };
  const res = await fetch(`${base}/index.html`, { headers });
  assert.equal(res.status, 403);
  const page = await res.text();
  assert.match(page, /No G0DM0D3 subscription/);
  assert.match(page, /See the plans/, "a non-subscriber is offered the plans, not a dead end");
  assert.match(page, /https:\/\/subscribe\.genie\.innotel\.us/);
  assert.doesNotMatch(page, /modeSwitcher/, "and not one byte of the studio");
});

test("billing that cannot answer closes the portal as a retry, not a paywall", async () => {
  entitlement = { entitled: null, plan: null, service: false, reason: "HTTP 404", source: "unreachable" };
  const res = await fetch(`${base}/index.html`, { headers });
  assert.equal(res.status, 503);
  const page = await res.text();
  assert.match(page, /subscription check is unavailable/);
  assert.match(page, /Reload/);
  assert.doesNotMatch(page, /See the plans/, "an outage must not sell a plan");
  assert.doesNotMatch(page, /modeSwitcher/);
});

test("the Engineer instance opens a Genie CLI, not the studio", async () => {
  const engineer = createServer({ ...config, slug: "engineer", product: "engineer", name: "OnTrak Engineer" });
  await new Promise((r) => engineer.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${engineer.address().port}`;
    const res = await fetch(`${origin}/index.html`, { headers });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /id="form"[^>]*class="prompt"|class="prompt"/, "the terminal prompt is the page");
    assert.match(page, /REA MCP attached/);
    assert.doesNotMatch(page, /modeSwitcher/, "the studio is the other product's page");
  } finally {
    await new Promise((r) => engineer.close(r));
  }
});

test("an approval is relayed to Genie with the service bearer", async () => {
  genieReply = { status: 200, chunks: [JSON.stringify({ resolved: true })], headers: { "content-type": "application/json" } };
  const res = await fetch(`${base}/api/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "approval-1", decision: "approve" }),
  });
  assert.equal(res.status, 200);
  const call = genieCalls.at(-1);
  assert.equal(call.path, "/api/approvals/approval-1");
  assert.equal(call.body.decision, "approve");
  assert.equal(call.auth, "Bearer genie-service-token");
  assert.equal(call.actor, "atheniq@innotel.us");
});

test("a service account is subscribed by rule, and still runs", async () => {
  entitlement = { entitled: true, service: true, plan: "service", reason: "service account: no subscription, no limits" };
  const res = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "go", runId: "run-service-01" }) });
  assert.equal(res.status, 200);
  assert.equal(charges.length, 1);
});

/*
 * The app beside the terminal, and the button that leaves the machine.
 *
 * Both are the same shape as every other route here: identity comes from the
 * proxy, and nothing reaches Genie without the service bearer and the address it
 * acts for. The preview is bytes and the ship is one JSON call — this app parses
 * neither, which is what lets the preview be whatever the project made.
 */

test("the preview status is Genie's, asked as the signed-in person", async () => {
  genieReply = {
    status: 200,
    chunks: [JSON.stringify({ running: true, command: "npm run dev", cwd: ".", pending: false })],
    headers: { "content-type": "application/json" },
  };
  const res = await fetch(`${base}/api/preview`, { headers });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).command, "npm run dev");
  const call = genieCalls.at(-1);
  assert.equal(call.path, "/api/preview");
  assert.equal(call.auth, "Bearer genie-service-token");
  assert.equal(call.actor, "atheniq@innotel.us");
});

test("starting a preview forwards the request, not a command of this app's own", async () => {
  genieReply = {
    status: 200,
    chunks: [JSON.stringify({ running: true, command: "python3 -m http.server $PORT", pending: true })],
    headers: { "content-type": "application/json" },
  };
  const res = await fetch(`${base}/api/preview/start`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).pending, true);
  assert.equal(genieCalls.at(-1).path, "/api/preview/start");
  assert.equal(genieCalls.at(-1).actor, "atheniq@innotel.us");
});

test("the running app is proxied unchanged under /preview/", async () => {
  genieReply = {
    status: 200,
    chunks: ["<!doctype html><title>app</title>"],
    headers: { "content-type": "text/html; charset=utf-8" },
  };
  const res = await fetch(`${base}/preview/`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /<title>app<\/title>/);
  assert.equal(genieCalls.at(-1).path, "/preview/");
  assert.equal(genieCalls.at(-1).actor, "atheniq@innotel.us");
});

test("a preview without a proxy identity is the sign-in page, not the app", async () => {
  genieReply = { status: 200, chunks: ["<html>secret</html>"], headers: { "content-type": "text/html" } };
  const res = await fetch(`${base}/preview/`);
  assert.equal(res.status, 401);
  assert.doesNotMatch(await res.text(), /secret/);
  assert.equal(genieCalls.length, 0, "nothing is asked of Genie for an anonymous preview");
});

test("ship saves the project, commits and pushes through Genie, and relays both halves", async () => {
  genieReply = {
    status: 201,
    chunks: [
      JSON.stringify({
        project: { id: "p1", name: "disputebee", dir: "disputebee-abcd12", existing: true, copied: 0 },
        publish: { repo: "a039/disputebee", url: "http://192.168.1.90:3004/a039/disputebee", branch: "main", commit: "abc123", files: 12 },
      }),
    ],
    headers: { "content-type": "application/json" },
  };
  const res = await fetch(`${base}/api/ship`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "disputebee", target: "atlas", message: "Ship it" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.project.name, "disputebee");
  assert.equal(body.publish.files, 12);

  const call = genieCalls.at(-1);
  assert.equal(call.path, "/api/ship");
  assert.equal(call.body.name, "disputebee");
  assert.equal(call.body.target, "atlas");
  assert.equal(call.auth, "Bearer genie-service-token");
  assert.equal(call.actor, "atheniq@innotel.us");
});

test("a ship without an identity never reaches Genie", async () => {
  const res = await fetch(`${base}/api/ship`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", target: "atlas" }),
  });
  assert.equal(res.status, 401);
  assert.equal(genieCalls.length, 0);
});

/*
 * The family gateway.
 *
 * The studio used to ask every visitor for a personal OpenRouter key: the spend
 * landed on their card and the accounting landed nowhere. The route below is the
 * other half of the fix — the page calls its own origin, and the server attaches
 * the key Distro issued to *this person*, checks their quota, and records what the
 * completion cost. So what these tests pin is attribution: whose key, whose quota,
 * whose ledger row.
 */

const gatewayHeaders = { "content-type": "application/json", "x-auth-request-email": "atheniq@innotel.us" };

test("the studio is served with the family gateway written into it", async () => {
  const page = await (await fetch(`${base}/index.html`, { headers })).text();
  assert.match(page, /window\.G0DM0D3_GATEWAY=/, "the page has to be told where the models are");
  assert.match(page, /"baseUrl":"\/api\/gateway\/v1"/, "same origin: no CSP exception and no key in the browser");
  assert.match(page, /"model":"auto\/chat"/);
});

test("a completion spends the caller's own gateway key, and records the usage", async () => {
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, "ok");

  const call = gatewayCalls.at(-1);
  assert.equal(call.path, "/chat/completions");
  assert.equal(call.auth, `Bearer ${GATEWAY_KEY}`, "the key Distro issued for this account, not the deployment's");
  assert.equal(call.body.model, "anthropic/claude-sonnet-4", "the model id is the page's to choose");

  assert.equal(identities.at(-1).email, "atheniq@innotel.us");
  assert.equal(identities.at(-1).sub, "sub-atheniq", "the plane's subject, resolved from the proxy's address");
  assert.equal(identities.at(-1).token, "plane-token");

  const report = reports.at(-1);
  assert.equal(report.bearer, `Bearer ${GATEWAY_KEY}`);
  assert.equal(report.tokensIn, 7);
  assert.equal(report.tokensOut, 3);
  assert.equal(report.requests, 1);
});

test("a streamed completion is relayed frame for frame, and its usage frame is recorded", async () => {
  gatewayReply = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body:
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
      'data: {"model":"deepseek/deepseek-v4","choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n' +
      "data: [DONE]\n\n",
  };

  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ model: "auto/chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /"hel"/);
  assert.match(text, /"lo"/);
  assert.match(text, /\[DONE\]/);

  const call = gatewayCalls.at(-1);
  assert.deepEqual(call.body.stream_options, { include_usage: true }, "without this a stream reports no tokens at all");
  assert.equal(call.body.stream, true);

  const report = reports.at(-1);
  assert.equal(report.tokensIn, 11);
  assert.equal(report.tokensOut, 5);
  assert.equal(report.model, "deepseek/deepseek-v4", "the model that answered, not the one that was asked for");
});

test("an account the plane has never seen is a 403, not the deployment's shared key", async () => {
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: { ...gatewayHeaders, "x-auth-request-email": "stranger@innotel.us" },
    body: JSON.stringify({ model: "auto/chat", messages: [] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "no_account");
  assert.equal(gatewayCalls.length, 0, "nothing reaches the gateway without somebody's own key");
});

test("no proxy identity means no gateway", async () => {
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto/chat", messages: [] }),
  });
  assert.equal(res.status, 401);
  assert.equal(gatewayCalls.length, 0);
});

test("a quota refusal never reaches the gateway", async () => {
  quotaAllowed = false;
  quotaReasons = ["daily request limit reached"];
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ model: "auto/chat", messages: [] }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, "quota_exceeded");
  assert.deepEqual(body.reasons, ["daily request limit reached"], "the plane's own words, not a generic refusal");
  assert.equal(gatewayCalls.length, 0);
});

test("a non-subscriber cannot use the gateway the page would have hidden", async () => {
  entitlement = { entitled: false, plan: "free", service: false, reason: "no subscription" };
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ model: "auto/chat", messages: [] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "subscription_required");
  assert.equal(gatewayCalls.length, 0);
  assert.equal(identities.length, 0, "not even a key is minted for an account that cannot use it");
});

test("a gateway refusal is relayed with its own status and words", async () => {
  gatewayReply = {
    status: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { message: "no provider for that model" } }),
  };
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ model: "openrouter/nope", messages: [] }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no provider for that model/);
  assert.equal(reports.length, 0, "a completion that never ran is not a request in the ledger");
});

test("the models list is proxied with the caller's key", async () => {
  gatewayReply = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [{ id: "auto/chat" }] }),
  };
  const res = await fetch(`${base}/api/gateway/v1/models`, { headers });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data[0].id, "auto/chat");
  assert.equal(gatewayCalls.at(-1).path, "/models");
  assert.equal(gatewayCalls.at(-1).auth, `Bearer ${GATEWAY_KEY}`);
});

test("a path the page does not use is this app's 404, not the gateway's", async () => {
  for (const path of ["/api/gateway/v1/admin", "/api/gateway/v1/../../auth", "/api/gateway/v2/chat/completions"]) {
    const res = await fetch(`${base}${path}`, { headers });
    assert.equal(res.status, 404, `${path} must not be forwarded`);
  }
  assert.equal(gatewayCalls.length, 0);
});

test("a completion without a model is refused before it is anyone's spend", async () => {
  const res = await fetch(`${base}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders,
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
  assert.equal(gatewayCalls.length, 0);
});

test("a deployment with no gateway keeps the studio as it was", async () => {
  const plain = createServer({ ...config, gatewayUrl: "" });
  await new Promise((r) => plain.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${plain.address().port}`;
    const page = await (await fetch(`${origin}/index.html`, { headers })).text();
    assert.doesNotMatch(page, /window\.G0DM0D3_GATEWAY=/, "no injection means the page asks for its own key");

    const res = await fetch(`${origin}/api/gateway/v1/chat/completions`, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify({ model: "auto/chat", messages: [] }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).retryable, true);
  } finally {
    await new Promise((r) => plain.close(r));
  }
});
