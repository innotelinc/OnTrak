/**
 * G0DM0D3: a metered front door to Genie.
 *
 * Genie is a coding agent; this app is the small, public-facing surface that lets a
 * signed-in person run it without signing in to the console — and pays for each run
 * out of the same credit ledger OnTrak Engineer uses. It is deliberately thin: the
 * work happens in Genie, the money happens in the control plane, and everything here
 * is the short path between them plus the bookkeeping that makes a failure cost
 * nobody anything.
 *
 * THREE RULES WORTH WRITING DOWN
 * -----------------------------
 *   * **Identity comes from the proxy.** This app never sees a password. It sits
 *     behind oauth2-proxy, which has already authenticated the person and passes the
 *     address in a header. That header is trusted *only* when
 *     `G0DM0D3_TRUST_PROXY_HEADERS=1`; with it unset every request is refused,
 *     because a header anyone can set is not a login.
 *   * **The charge comes before the run**, and the run id is the idempotency key: a
 *     double-submit, a retried fetch or a reloaded tab charges once, in the plane.
 *   * **A run that produced nothing is refunded.** If Genie refuses the turn or the
 *     stream dies before its first byte, the credit goes back under a
 *     `refund-<run id>` reference (itself idempotent), so an outage is not billed.
 *     Once bytes have reached the browser the answer may be partial but was still
 *     work, and it is not refunded — refunding it would make "stop the stream" a way
 *     to get free runs.
 */

import fs from "node:fs";
import http from "node:http";
import { CreditError, creditStatus, refund, spend } from "./credits.js";
import { entitlementFor } from "./entitlement.js";

export const HEALTH_PATH = "/health";

/**
 * The pages this app serves, read once at start-up.
 *
 * One program, three surfaces, chosen by the product the instance is a front
 * door of:
 *
 *   studio.html     G0DM0D3's own single-file interface, at `uc.genie.innotel.us`
 *   engineer.html   the Genie CLI terminal, at `re.genie.innotel.us`
 *   portal.html     the metered chat this app grew from, kept at `/metered`
 *
 * Reading them at start-up is deliberate: a page that is re-read per request
 * can be half-written by a deploy while somebody is loading it, and none of
 * these is large enough for holding it to matter.
 */
const PAGE = fs.readFileSync(new URL("../public/portal.html", import.meta.url), "utf8");
const STUDIO = fs.readFileSync(new URL("../public/studio.html", import.meta.url), "utf8");
const ENGINEER = fs.readFileSync(new URL("../public/engineer.html", import.meta.url), "utf8");

/** Which document a product's front door opens. */
function entryPage(config) {
  return config.slug === "engineer" ? ENGINEER : STUDIO;
}

const MAX_MESSAGE = 8_000;
const MAX_RUN_ID = 100;

export function readConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    product: String(env.G0DM0D3_PRODUCT ?? "g0dm0d3").trim() || "g0dm0d3",
    creditsPerRun: Number(env.G0DM0D3_CREDITS_PER_RUN ?? 1) || 1,
    /** Genie, and the shared bearer it accepts for a service caller. */
    genieUrl: String(env.GENIE_URL ?? "").trim().replace(/\/+$/, ""),
    genieToken: String(env.WEB_TOKEN ?? "").trim(),
    /** Set by the deployment that actually runs a proxy in front; never by default. */
    trustProxyHeaders: String(env.G0DM0D3_TRUST_PROXY_HEADERS ?? "") === "1",
    /**
     * Which product this instance is the front door of.
     *
     * One program serves both portals — Engineer's and G0DM0D3's — because they ask
     * the same two questions (is this account subscribed, has it any credits left)
     * and differ only in what they are called and which ledger line they spend.
     */
    slug: String(env.PRODUCT_SLUG ?? env.G0DM0D3_PRODUCT ?? "g0dm0d3").trim() || "g0dm0d3",
    name: String(env.PRODUCT_NAME ?? "G0DM0D3").trim() || "G0DM0D3",
    tagline:
      String(env.PRODUCT_TAGLINE ?? "the agent, one credit a run").trim() ||
      "the agent, one credit a run",
    /** Where somebody without a subscription is sent. */
    subscribeUrl: String(env.SUBSCRIBE_URL ?? "https://subscribe.genie.innotel.us").trim(),
    /** Where a subscriber goes to actually do the work. */
    workUrl: String(env.WORK_URL ?? "https://genie.ontrak.innotel.us").trim(),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Who is asking.
 *
 * oauth2-proxy is the only source of identity this app accepts, and which header
 * carries it depends on how the proxy is wired — the two modes differ:
 *
 *   * `x-auth-request-email` is set when the proxy is nginx's `auth_request`
 *     backend, where its answer travels as *response* headers back to nginx
 *     (`--set-xauthrequest`);
 *   * `x-forwarded-email` is what the proxy puts on the request it forwards when
 *     it reverse-proxies the app itself (`--pass-user-headers`).
 *
 * Both consoles deploy the second shape. Reading only the first meant a signed-in
 * person got a page that immediately 401'd on its own `/api/session`, which the
 * browser showed as a sign-in loop.
 *
 * A request carrying neither is not "anonymous with a free run": it is a caller
 * that came around the proxy, and the answer is 401.
 */
export function identityOf(req, config) {
  if (!config.trustProxyHeaders) return null;
  for (const name of ["x-auth-request-email", "x-forwarded-email"]) {
    const raw = req.headers[name];
    const email = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim().toLowerCase();
    if (email !== "") return email;
  }
  return null;
}

/**
 * The page a request without an identity gets.
 *
 * Behind the SSO proxy this is unreachable in normal operation — the proxy
 * answers first. It exists because \"unreachable in normal operation\" is the
 * definition of a gate that is only a deployment assumption: a request that came
 * around the proxy used to be handed the whole application, and the first thing
 * it did was 401 its own session call. A page with one honest link is what that
 * request gets now.
 *
 * No `WWW-Authenticate` header: this is a browser page, not a challenge for a
 * password dialog to answer.
 */
function sendGate(res, req, status = 401) {
  const target = req.url ?? "/";
  const rd = encodeURIComponent(target.startsWith("/") ? target : "/");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — OnTrak</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(900px 600px at 20% -10%, #1d2a3a, transparent 60%), #0b0f14; color: #e8ecf3; }
  main { width: min(430px, calc(100% - 32px)); padding: 30px;
    border: 1px solid rgb(255 255 255 / 12%); border-radius: 20px;
    background: rgb(20 26 34 / 78%); backdrop-filter: blur(20px) saturate(140%);
    box-shadow: 0 30px 80px -30px rgb(0 0 0 / 80%); }
  h1 { margin: 0 0 8px; font-size: 19px; }
  p { margin: 0 0 16px; color: #9aa6b8; }
  a { display: block; text-align: center; text-decoration: none; font-weight: 650;
    background: #7c5cff; color: #fff; border-radius: 11px; padding: 11px 14px; }
  .dim { margin: 14px 0 0; font-size: 12.5px; color: #707d90; }
</style></head>
<body><main>
  <h1>Sign in to continue</h1>
  <p>This console is behind the family's single sign-on. Nothing is served to a request without a session.</p>
  <a href="/oauth2/sign_in?rd=${rd}">Sign in with OnTrak</a>
  <p class="dim">You will come back to the page you asked for.</p>
</main></body></html>`);
}

/**
 * The page a signed-in account without a plan gets.
 *
 * The run endpoint has always answered a non-subscriber with 403 and a link to
 * the plans; the page in front of it answered with the whole application. That
 * made the portal free for anyone with an SSO account, because the studio brings
 * its own model key and never calls this app's run route. A page is part of the
 * product, so it is gated like one: the subscription is asked before a byte of
 * the studio is served.
 *
 * An unaskable billing service is deliberately not a paywall. `unknown` gets 503
 * and a reload, because telling a subscriber to buy what they already own during
 * an outage is worse than telling them to try again.
 */
function sendPlanGate(res, config, entitlement, status = 403) {
  const unknown = entitlement.state === "unknown";
  const title = unknown ? "The subscription check is unavailable" : `No ${config.name} subscription`;
  const copy = unknown
    ? `This console could not ask billing whether ${config.name} is on this account. Nothing was changed; reload in a moment.`
    : `${config.name} is sold as a subscription. This account does not have one yet, so the portal stays closed.`;
  const cta = unknown
    ? `<a href="">Reload</a>`
    : `<a href="${config.subscribeUrl}">See the plans</a>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — OnTrak</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(900px 600px at 20% -10%, #1d2a3a, transparent 60%), #0b0f14; color: #e8ecf3; }
  main { width: min(430px, calc(100% - 32px)); padding: 30px;
    border: 1px solid rgb(255 255 255 / 12%); border-radius: 20px;
    background: rgb(20 26 34 / 78%); backdrop-filter: blur(20px) saturate(140%);
    box-shadow: 0 30px 80px -30px rgb(0 0 0 / 80%); }
  h1 { margin: 0 0 8px; font-size: 19px; }
  p { margin: 0 0 16px; color: #9aa6b8; }
  a { display: block; text-align: center; text-decoration: none; font-weight: 650;
    background: #7c5cff; color: #fff; border-radius: 11px; padding: 11px 14px; }
  .dim { margin: 14px 0 0; font-size: 12.5px; color: #707d90; text-align: center; }
  .dim a { display: inline; padding: 0; background: none; color: #9aa6b8; text-decoration: underline; font-weight: 450; }
</style></head>
<body><main>
  <h1>${title}</h1>
  <p>${copy}</p>
  ${cta}
  <p class="dim"><a href="${config.workUrl}">Back to Genie</a></p>
</main></body></html>`);
}

function log(line) {
  // One JSON line per event: the container's log is the only place a run's fate is
  // visible once the browser has the stream.
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

/**
 * The run itself: charge, ask Genie, relay.
 *
 * Everything before the first upstream byte can still be refused cleanly with a
 * status code; after that the response has begun and the only honest thing left is
 * to end the stream and say why in a final frame.
 */
async function handleRun(req, res, config) {
  const email = identityOf(req, config);
  if (email === null) {
    sendJson(res, 401, { error: "sign in through the console proxy to run anything" });
    return;
  }

  const body = await readJson(req).catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim().slice(0, MAX_RUN_ID) : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (message === "") return sendJson(res, 400, { error: "message is required" });
  if (message.length > MAX_MESSAGE) return sendJson(res, 400, { error: `message is longer than ${MAX_MESSAGE} characters` });
  if (runId.length < 8) return sendJson(res, 400, { error: "runId is required (it is what makes a retry free)" });
  if (config.genieUrl === "") return sendJson(res, 503, { error: "GENIE_URL is unset on this deployment", retryable: true });

  /*
   * The subscription check, before the money and before the model.
   *
   * Three answers, three different pages: a subscriber runs, a non-subscriber is
   * offered one, and an answer nobody could get is a retry rather than a paywall —
   * see `entitlement.js` for why that distinction is not pedantry.
   */
  let entitlement;
  try {
    entitlement = await entitlementFor({ email, plan: config.slug });
  } catch (error) {
    return sendJson(res, 503, { error: `could not check the subscription: ${error.message}`, retryable: true });
  }
  if (entitlement.metered && entitlement.state === "not_entitled") {
    log({ event: "subscription_required", email, runId, plan: config.slug });
    return sendJson(res, 403, {
      error: `no ${config.name} subscription on this account`,
      code: "subscription_required",
      subscribeUrl: config.subscribeUrl,
      plan: entitlement.plan,
    });
  }
  if (entitlement.metered && entitlement.state === "unknown") {
    return sendJson(res, 503, { error: `could not check the subscription: ${entitlement.reason}`, retryable: true });
  }

  let charge;
  try {
    charge = await spend({
      email,
      product: config.product,
      credits: config.creditsPerRun,
      reference: runId,
      reason: `g0dm0d3 run ${runId}`,
    });
  } catch (error) {
    const status = error instanceof CreditError ? 503 : 500;
    return sendJson(res, status, { error: error.message, retryable: true });
  }
  if (!charge.ok) {
    // A refusal is a page state, not a server error: the UI shows the balance and
    // the price beside the same box.
    return sendJson(res, 402, {
      error: charge.code === "insufficient_credits" ? "no credits left" : charge.code,
      balance: charge.balance,
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${config.genieUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.genieToken === "" ? {} : { authorization: `Bearer ${config.genieToken}` }),
        // Who this run belongs to. Genie only reads it when the deployment turned
        // `TRUSTED_ACTOR_HEADER` on, and it never invents an account: the address is
        // resolved against the plane, so the turn lands in the person's own
        // workspace, under their own quota, paying their own gateway key.
        "x-genie-actor": email,
      },
      body: JSON.stringify({ message, ...(sessionId === "" ? {} : { sessionId }) }),
    });
  } catch (error) {
    const back = await refund({
      email,
      product: config.product,
      credits: charge.spent,
      reference: runId,
      reason: `g0dm0d3 run ${runId} could not reach Genie`,
    });
    log({ event: "upstream_unreachable", email, runId, refunded: back.ok, error: error.message });
    return sendJson(res, 502, { error: `Genie is not answering: ${error.message}`, refunded: back.ok });
  }

  if (!upstream.ok || upstream.body === null) {
    const detail = await upstream.text().catch(() => "");
    // Nothing ran, so nothing is owed. `spent` is 0 for an unlimited account or a
    // duplicate reference, and refunding zero would add a meaningless ledger row.
    const back = charge.spent > 0
      ? await refund({ email, product: config.product, credits: charge.spent, reference: runId, reason: `g0dm0d3 run ${runId} was refused by Genie` })
      : { ok: true };
    log({
      event: "upstream_refused",
      email,
      runId,
      status: upstream.status,
      // Say "refunded" only when there was a charge to give back; an unlimited
      // account reads 0 spent, and a refund it never needed is noise in the log.
      refunded: charge.spent > 0 && back.ok,
      detail: detail.slice(0, 300),
    });
    return sendJson(res, 502, { error: `Genie refused the run (HTTP ${upstream.status})`, refunded: back.ok });
  }

  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  log({ event: "run", email, runId, spent: charge.spent, duplicate: charge.duplicate, balance: charge.balance });

  let bytes = 0;
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    // The browser has bytes; the run was work. Report it in the stream and stop.
    res.write(`event: error\ndata: ${JSON.stringify({ error: `stream failed: ${error.message}` })}\n\n`);
    log({ event: "stream_failed", email, runId, error: error.message, bytes });
  } finally {
    res.end();
  }
}

export function createServer(config = readConfig()) {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = req.method ?? "GET";
      try {
        if (url.pathname === HEALTH_PATH && method === "GET") {
          return sendJson(res, 200, { ok: true, product: config.product });
        }
        /*
         * The front door goes to `index.html`, and every door is gated.
         *
         *   /            -> 302 /index.html   (after the identity check)
         *   /index.html  -> the product's own page
         *   /studio      -> 302 /index.html   (the name G0DM0D3's docs use)
         *   /metered     -> the credit meter this app grew from
         *
         * The redirect is not a decoration: "go to the index" is what the
         * deployment asks for, and a 302 keeps one canonical document so a
         * bookmark, a shared link and a cached page all resolve to the same URL.
         */
        if (method === "GET" && (url.pathname === "/" || url.pathname === "/studio")) {
          if (identityOf(req, config) === null) return sendGate(res, req);
          const query = url.search === "" ? "" : url.search;
          res.writeHead(302, { location: `/index.html${query}`, "cache-control": "no-store" });
          return res.end();
        }
        if (method === "GET" && (url.pathname === "/index.html" || url.pathname === "/metered")) {
          const email = identityOf(req, config);
          if (email === null) return sendGate(res, req);
          /*
           * The product's own page is subscription-gated; the metered console is
           * not, because it is where an account without a plan is told about one
           * and where it buys credits. Gating the page matters: the studio brings
           * its own model key, so serving it to a non-subscriber would hand over
           * the product without ever touching this app's run route.
           */
          if (url.pathname === "/index.html") {
            const entitlement = await entitlementFor({ email, plan: config.slug });
            if (entitlement.metered && entitlement.state !== "entitled") {
              log({
                event: "portal_subscription_required",
                email,
                plan: config.slug,
                state: entitlement.state,
                reason: entitlement.reason,
              });
              return sendPlanGate(res, config, entitlement, entitlement.state === "unknown" ? 503 : 403);
            }
          }
          const page = url.pathname === "/metered" ? PAGE : entryPage(config);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(page);
        }
        if (url.pathname === "/api/session" && method === "GET") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to use this console" });
          // The subscription first: a page with no subscription is not a page with
          // no credits, and telling a non-subscriber "you have 0 credits" is the
          // wrong sentence — there is nothing to buy credits against yet.
          const entitlement = await entitlementFor({ email, plan: config.slug });
          const status = await creditStatus({ email, product: config.product });
          return sendJson(res, 200, {
            email,
            product: config.product,
            name: config.name,
            tagline: config.tagline,
            subscribeUrl: config.subscribeUrl,
            workUrl: config.workUrl,
            entitlement,
            creditsPerRun: config.creditsPerRun,
            ...status,
          });
        }
        if (url.pathname === "/api/run" && method === "POST") {
          return await handleRun(req, res, config);
        }
        /*
         * Approvals, relayed.
         *
         * A risky command stops until somebody answers, and the terminal is the
         * somebody: without this route the engineer page could watch a turn ask
         * for permission and have no way to give it. The decision is Genie's to
         * record — this app only carries it there with the service bearer.
         */
        if (url.pathname === "/api/approve" && method === "POST") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to approve anything" });
          const body = await readJson(req).catch(() => ({}));
          const id = typeof body.id === "string" ? body.id.trim() : "";
          const decision = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : "";
          if (id === "" || decision === "") return sendJson(res, 400, { error: "id and decision are required" });
          if (config.genieUrl === "") return sendJson(res, 503, { error: "GENIE_URL is unset on this deployment" });
          try {
            const upstream = await fetch(`${config.genieUrl}/api/approvals/${encodeURIComponent(id)}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(config.genieToken === "" ? {} : { authorization: `Bearer ${config.genieToken}` }),
                "x-genie-actor": email,
              },
              body: JSON.stringify({ decision }),
            });
            const answer = await upstream.json().catch(() => ({}));
            return sendJson(res, upstream.status, answer);
          } catch (error) {
            return sendJson(res, 502, { error: `Genie is not answering: ${error.message}` });
          }
        }
        return sendJson(res, 404, { error: "not found" });
      } catch (error) {
        const status = error instanceof CreditError ? 503 : 500;
        if (!res.headersSent) sendJson(res, status, { error: error.message });
        else res.end();
      }
    })();
  });
}

/* Started only when this file is the entry point, so a test can import it. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig();
  createServer(config).listen(config.port, "0.0.0.0", () => {
    log({ event: "listening", port: config.port, product: config.product, genie: config.genieUrl || null });
  });
}
