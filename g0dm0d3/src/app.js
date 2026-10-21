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
import net from "node:net";
import tls from "node:tls";
import { CreditError, creditStatus, refund, spend } from "./credits.js";
import { entitlementFor } from "./entitlement.js";
import {
  GATEWAY_PATH,
  GatewayError,
  accountFor,
  gatewayUrl,
  quotaFor,
  reportUsage,
  usageFrom,
} from "./gateway.js";

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
/**
 * The family theme, served from this app rather than from a CDN or a shared
 * origin: the pages are single files read into memory, so the two assets that
 * make them wear Unity have to come from the same door. Read once, like the
 * pages, for the same reason — a request never sees a half-written file.
 */
const UNITY_CSS = fs.readFileSync(new URL("../public/unity-theme.css", import.meta.url), "utf8");
const UNITY_JS = fs.readFileSync(new URL("../public/unity-theme.js", import.meta.url), "utf8");

const PAGE = fs.readFileSync(new URL("../public/portal.html", import.meta.url), "utf8");
const STUDIO = fs.readFileSync(new URL("../public/studio.html", import.meta.url), "utf8");
const ENGINEER = fs.readFileSync(new URL("../public/engineer.html", import.meta.url), "utf8");

/**
 * The studio document, with the gateway this deployment uses written into it.
 *
 * The page is a vendored single file that knows nothing about this deployment, so
 * the one fact it cannot work out for itself — where the family's models are — is
 * injected at serve time rather than committed into 795 KB. Without a gateway the
 * page keeps its old behaviour (ask the visitor for a personal OpenRouter key),
 * which is the right answer for a deployment that has none.
 *
 * Cached per configuration, because the substitution is a string scan of the
 * whole document and the configuration changes once per deploy.
 */
const studioDocuments = new Map();
function studioDocument(config) {
  if (config.gatewayUrl === "") return STUDIO;
  const key = `${config.gatewayUrl}\u0000${config.gatewayModel}`;
  const cached = studioDocuments.get(key);
  if (cached !== undefined) return cached;

  // `<` is escaped so a model id can never close the script element it lives in.
  const settings = JSON.stringify({ baseUrl: GATEWAY_PATH, model: config.gatewayModel }).replace(/</g, "\\u003c");
  const document = STUDIO.replace("</head>", `  <script>window.G0DM0D3_GATEWAY=${settings};</script>\n</head>`);
  studioDocuments.set(key, document);
  return document;
}

/** Which document a product's front door opens. */
function entryPage(config) {
  return config.slug === "engineer" ? ENGINEER : studioDocument(config);
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
    /**
     * The family's OmniRoute, as an OpenAI-compatible base (`…/v1`).
     *
     * The studio used to bring its own OpenRouter key, which put the spend on a
     * person's card and the accounting nowhere. With this set, the page is served
     * with a same-origin gateway instead, and every completion is paid for by the
     * caller's own account through the control plane (see `gateway.js`).
     */
    gatewayUrl: gatewayUrl(env),
    /** The model a completion asks for when the page does not name one. */
    gatewayModel: String(env.OMNIROUTE_MODEL ?? env.G0DM0D3_GATEWAY_MODEL ?? "auto/chat").trim() || "auto/chat",
    /**
     * The model an *agent* run asks Genie for, and the chain behind it.
     *
     * Empty (the default) means "whatever this deployment's Genie is configured
     * with", which is the same chain the console at `WORK_URL` runs — the right
     * default, since one Genie serves every front door and a second opinion here
     * would only differ from the first by accident.
     *
     * It is set when a front door is meant to be answered by a *different* model
     * than the console: a door whose work is repeatedly stopped by a provider's
     * content filter points this at a model whose provider does not apply that
     * filter, and Genie walks the chain from there. Genie ignores a model sent by
     * an account on the automatic free pool (a free turn is placed by the console,
     * not by the caller), so this only shapes a subscriber's turn.
     */
    agentModel: String(env.G0DM0D3_AGENT_MODEL ?? "").trim(),
    agentFallbackModels: String(env.G0DM0D3_AGENT_FALLBACK_MODELS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
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
  /* The panel is a width plus 30px of padding: without border-box that is 60px
     more than the screen, which is a sideways scrollbar on the one page a phone
     sees when it is being sold something. */
  * { box-sizing: border-box; }
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
  /* The panel is a width plus 30px of padding: without border-box that is 60px
     more than the screen, which is a sideways scrollbar on the one page a phone
     sees when it is being sold something. */
  * { box-sizing: border-box; }
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

/** The two gateway paths the studio uses; anything else under the prefix is a 404. */
const GATEWAY_ROUTES = new Set(["/models", "/chat/completions"]);

/** A completion may hold a connection for a while; a dev chat is not a webhook. */
const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The studio's models, on this origin, paid for by the caller's own account.
 *
 * This is the whole point of the route: the browser sends no key, the page needs
 * no CSP exception, and the credential the gateway sees is the one Distro issued
 * to *this person* — resolved from the address the proxy vouched for, checked
 * against their quota, and charged to their ledger line when the completion is
 * done. A shared key would move one person's spend onto the operator, which is
 * the problem this replaces.
 *
 * The streaming half is relayed byte for byte. Its usage frame is read on the way
 * past (that is what `stream_options.include_usage` asks the gateway for) so the
 * ledger records what the turn cost rather than "one request".
 */
async function handleGateway(req, res, config, email, subpath) {
  if (config.gatewayUrl === "") {
    return sendJson(res, 503, { error: "OMNIROUTE_URL is unset on this deployment", retryable: true });
  }

  /*
   * The subscription, first and for the same reason the page asks: the gateway is
   * the product's model access, and serving it to an account with no plan would
   * make the page's gate a decoration. An unaskable billing service is a retry,
   * never a paywall — `entitlement.js` has the three-state contract.
   */
  let entitlement;
  try {
    entitlement = await entitlementFor({ email, plan: config.slug });
  } catch (error) {
    return sendJson(res, 503, { error: `could not check the subscription: ${error.message}`, retryable: true });
  }
  if (entitlement.metered && entitlement.state === "not_entitled") {
    log({ event: "gateway_subscription_required", email, plan: config.slug });
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

  let account;
  try {
    account = await accountFor(email);
  } catch (error) {
    log({ event: "gateway_identity_failed", email, error: error.message });
    return sendJson(res, error instanceof GatewayError ? 503 : 500, { error: error.message, retryable: true });
  }
  if (account === null) {
    // Not a customer with an empty wallet: nobody here can tell us who they are.
    // Inventing an account for an address the plane has never seen would create a
    // second identity for a person Genie already knows under another subject.
    return sendJson(res, 403, {
      error: `${email} has no account in the control plane, so there is no gateway key to spend`,
      code: "no_account",
    });
  }

  const body = subpath === "/models" ? undefined : await readJson(req).catch(() => ({}));
  if (subpath === "/chat/completions") {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      return sendJson(res, 400, { error: "model is required" });
    }
    const quota = await quotaFor(account.key);
    if (!quota.allowed) {
      const reasons = quota.reasons.length > 0 ? quota.reasons.join(", ") : "quota exhausted";
      return sendJson(res, 429, { error: `this account cannot run another completion — ${reasons}`, code: "quota_exceeded", reasons: quota.reasons });
    }
    // Ask the gateway to report usage on the last streamed frame. Without it a
    // streamed completion is one request and zero tokens in the ledger, which
    // would make the token caps the plane keeps look unused forever.
    if (body.stream === true && body.stream_options === undefined) {
      body.stream_options = { include_usage: true };
    }
  }

  let upstream;
  try {
    upstream = await fetch(`${config.gatewayUrl}${subpath}`, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        ...(account.key === "" ? {} : { authorization: `Bearer ${account.key}` }),
        accept: req.headers.accept ?? "*/*",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    log({ event: "gateway_unreachable", email, error: error.message });
    return sendJson(res, 502, { error: `the model gateway is not answering: ${error.message}`, retryable: true });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.ok || upstream.body === null) {
    const detail = await upstream.text().catch(() => "");
    log({ event: "gateway_refused", email, status: upstream.status, detail: detail.slice(0, 300) });
    // The gateway's own error, relayed: it names the model or the provider that
    // failed, and rewriting it would only lose that.
    res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-store" });
    return res.end(detail);
  }

  res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-store" });

  // The catalog is not a completion: there is nothing to attribute or record.
  if (subpath === "/models") {
    return res.end(await upstream.text());
  }

  if (!contentType.includes("text/event-stream")) {
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    // Recorded before the browser is told it is done: the row is what the
    // completion is paid for, and a report that races the response can be lost to
    // a restart between the two.
    const usage = usageFrom(parsed ?? { model: body.model }, body.model);
    await reportUsage(account.key, usage);
    res.end(text);
    log({ event: "gateway_completion", email, model: body.model, stream: false, usage });
    return;
  }

  const decoder = new TextDecoder();
  let pending = "";
  let usage = null;
  const inspect = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    try {
      const frame = JSON.parse(data);
      if (typeof frame?.usage === "object" && frame.usage !== null) usage = usageFrom(frame, body.model);
    } catch {
      // A frame this app does not need to understand is still the browser's frame.
    }
  };

  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        inspect(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      // A line that never ends is not a usage frame; do not grow a buffer for it.
      if (pending.length > 65_536) pending = pending.slice(-4_096);
    }
    pending += decoder.decode();
    if (pending !== "") inspect(pending);
  } catch (error) {
    // The browser has whatever frames arrived; a stream that died is still worth
    // a log line, and stopping is the only honest thing left to do.
    log({ event: "gateway_stream_failed", email, error: error.message });
  }

  // One request even if the provider reported no tokens: it was still a request.
  // Awaited before the stream closes, for the same reason as the JSON path.
  await reportUsage(account.key, usage ?? { tokensIn: 0, tokensOut: 0, requests: 1, model: body.model });
  res.end();
  log({ event: "gateway_completion", email, model: body.model, stream: true, usage: usage ?? null });
}

/**
 * A path that belongs to the running app rather than to this console.
 *
 * The preview pane is iframed under `/preview/`, and the console rewrites the
 * document's root-relative URLs. What it cannot rewrite is a URL a bundle builds
 * at runtime (`/@vite/client`, `/_next/webpack-hmr`, a dynamic import). Those
 * arrive at this origin's root, so they are forwarded to Genie — which forwards
 * them to the app — instead of being answered with this app's 404.
 *
 * Deliberately narrow: a path with a file extension, or one under a framework's
 * own prefix. Everything else stays this console's namespace, including its 404.
 */
function looksLikePreviewAsset(pathname) {
  if (/^\/(?:@|_next\/|assets?\/|static\/|src\/|node_modules\/|public\/)/.test(pathname)) return true;
  return /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/** The headers every call to Genie carries, whoever made it. */
function genieHeaders(req, config, email) {
  return {
    ...(config.genieToken === "" ? {} : { authorization: `Bearer ${config.genieToken}` }),
    "x-genie-actor": email,
    ...(req.headers["content-type"] === undefined ? {} : { "content-type": req.headers["content-type"] }),
    accept: req.headers.accept ?? "*/*",
  };
}

/** Just enough of a response to be the response: type, caching, redirects. */
const RELAYED_HEADERS = ["content-type", "cache-control", "location", "etag", "last-modified", "content-disposition"];

/**
 * Forward one request to Genie, unchanged, as the signed-in person.
 *
 * No body is parsed on the way through. A preview document, an image, a project
 * bundle and a ship request are all just bytes to this app; parsing them would be
 * a second implementation of somebody else's format, and the preview is the one
 * place where the content type is whatever the project decided it is.
 */
async function forwardToGenie(req, res, config, email, pathAndQuery, timeoutMs = 60_000) {
  if (config.genieUrl === "") return sendJson(res, 503, { error: "GENIE_URL is unset on this deployment", retryable: true });

  let upstream;
  try {
    upstream = await fetch(`${config.genieUrl}${pathAndQuery}`, {
      method: req.method,
      headers: genieHeaders(req, config, email),
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req, duplex: "half" }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return sendJson(res, 502, { error: `Genie is not answering: ${error.message}`, retryable: true });
  }

  const headers = {};
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  res.writeHead(upstream.status, { ...headers, "cache-control": headers["cache-control"] ?? "no-store" });
  if (upstream.body === null) return res.end();
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } finally {
    res.end();
  }
}

/**
 * The preview's own socket.
 *
 * A dev server's hot reload is a WebSocket at an absolute path on this origin,
 * and a proxy that does not carry the upgrade leaves the app in a reconnect loop
 * that looks like a bug in the app. The two sockets are one pipe once the
 * handshake is written, exactly as Genie's own proxy does it.
 */
function attachPreviewUpgrade(server, config) {
  server.on("upgrade", (req, socket, head) => {
    const email = identityOf(req, config);
    const url = new URL(req.url ?? "/", "http://localhost");
    const previewPath = url.pathname === "/preview" || url.pathname.startsWith("/preview/");
    if (email === null || config.genieUrl === "" || !(previewPath || looksLikePreviewAsset(url.pathname))) {
      socket.destroy();
      return;
    }

    let target;
    try {
      target = new URL(config.genieUrl);
    } catch {
      socket.destroy();
      return;
    }
    const secure = target.protocol === "https:";
    const port = Number(target.port === "" ? (secure ? 443 : 80) : target.port);
    const upstream = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname }, onConnect)
      : net.connect({ host: target.hostname, port }, onConnect);

    function onConnect() {
      const headers = { ...req.headers, ...genieHeaders(req, config, email), host: target.host };
      const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    }

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
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
      body: JSON.stringify({
        message,
        ...(sessionId === "" ? {} : { sessionId }),
        // Only when this door was given a chain of its own; otherwise Genie's own
        // configuration answers, exactly as it did before this existed.
        ...(config.agentModel === "" ? {} : { model: config.agentModel }),
        ...(config.agentFallbackModels.length === 0 ? {} : { fallbackModels: config.agentFallbackModels }),
      }),
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
  const server = http.createServer((req, res) => {
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
        /*
         * The theme is served unauthenticated on purpose: it is a stylesheet and
         * a switch, it carries no data, and a gate in front of it would only make
         * the signed-in page flash the wrong colours while the cookie is checked.
         */
        if (method === "GET" && (url.pathname === "/unity-theme.css" || url.pathname === "/unity-theme.js")) {
          const css = url.pathname.endsWith(".css");
          res.writeHead(200, {
            "content-type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=300",
          });
          return res.end(css ? UNITY_CSS : UNITY_JS);
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
         * The studio's models, on this origin.
         *
         * A prefix rather than a closed list of two paths, then a closed list of
         * two paths: the page is what calls this, and `/api/gateway/v1/models` and
         * `/api/gateway/v1/chat/completions` are the OpenAI-compatible names it
         * already understands. Everything else under the prefix is this app's 404
         * rather than a request forwarded to whatever the gateway might serve.
         */
        if (url.pathname === GATEWAY_PATH || url.pathname.startsWith(`${GATEWAY_PATH}/`)) {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to use the model gateway" });
          const subpath = url.pathname.slice(GATEWAY_PATH.length);
          if (!GATEWAY_ROUTES.has(subpath)) return sendJson(res, 404, { error: "not found" });
          if (subpath === "/chat/completions" && method !== "POST") {
            return sendJson(res, 405, { error: "POST is the only method here" });
          }
          if (subpath === "/models" && method !== "GET" && method !== "HEAD") {
            return sendJson(res, 405, { error: "GET is the only method here" });
          }
          return await handleGateway(req, res, config, email, subpath);
        }

        /*
         * The app, running, beside the terminal.
         *
         * Three calls and a byte pipe. The status is polled rather than pushed
         * because it is one small JSON answer and the pane only needs to know
         * when to show the frame; the app itself, once it is up, is proxied
         * unchanged under `/preview/` so its own fetch, cookies and asset URLs
         * behave exactly as they will when it is deployed. Identity comes from
         * the proxy, as everywhere else, and is forwarded as `x-genie-actor` so
         * the preview belongs to the same account as the turn that wrote it.
         */
        if (url.pathname === "/api/preview" && method === "GET") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to see a preview" });
          return await forwardToGenie(req, res, config, email, "/api/preview");
        }
        if ((url.pathname === "/api/preview/start" || url.pathname === "/api/preview/stop") && method === "POST") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to run a preview" });
          return await forwardToGenie(req, res, config, email, url.pathname, 90_000);
        }

        /*
         * Ship: save this workspace as a project in Genie, commit, push.
         *
         * The work is Genie's, and so is the git: this app only carries the one
         * request there with the service bearer and the address it acts for. A
         * project that was created before a push that failed is in the error's
         * `project`, because "saved but not pushed" is a real outcome a person
         * needs the name of.
         */
        if (url.pathname === "/api/ship" && method === "GET") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to ship anything" });
          return await forwardToGenie(req, res, config, email, "/api/ship");
        }
        if (url.pathname === "/api/ship" && method === "POST") {
          const email = identityOf(req, config);
          if (email === null) return sendJson(res, 401, { error: "sign in to ship anything" });
          return await forwardToGenie(req, res, config, email, "/api/ship", 180_000);
        }

        /*
         * The running app's bytes. `/preview/foo` is `/foo` to Genie's preview
         * proxy, and Genie rewrites the document's root-relative URLs back under
         * `/preview/`, so both ends agree on where the app lives.
         */
        if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
          const email = identityOf(req, config);
          if (email === null) return sendGate(res, req);
          return await forwardToGenie(req, res, config, email, `${url.pathname}${url.search}`);
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
        /*
         * Last, and only for a path that belongs to the app: a bundle's runtime
         * URL, a favicon, a dynamic import. The console's own routes are a closed
         * set and are matched above, so what reaches here is the preview's
         * namespace — and a preview that renders is the whole point of the pane.
         */
        if ((method === "GET" || method === "HEAD") && looksLikePreviewAsset(url.pathname)) {
          const email = identityOf(req, config);
          if (email === null) return sendGate(res, req);
          return await forwardToGenie(req, res, config, email, `${url.pathname}${url.search}`);
        }
        return sendJson(res, 404, { error: "not found" });
      } catch (error) {
        const status = error instanceof CreditError ? 503 : 500;
        if (!res.headersSent) sendJson(res, status, { error: error.message });
        else res.end();
      }
    })();
  });

  attachPreviewUpgrade(server, config);
  return server;
}

/* Started only when this file is the entry point, so a test can import it. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig();
  createServer(config).listen(config.port, "0.0.0.0", () => {
    log({ event: "listening", port: config.port, product: config.product, genie: config.genieUrl || null });
  });
}
