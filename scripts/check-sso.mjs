/**
 * Live single-sign-on check.
 *
 * Drives a real sign-in against a deployed OnTrak app and the identity provider it
 * is configured with, and fails loudly when any step does not do what the app
 * promises. It exists because the app-side tests cannot see the provider: on
 * 2026-11-16 every app on the shared `ontrak` client was unusable because the
 * provider's authorization flow had been repointed at a redirect stage, and
 * nothing in this repository could have noticed.
 *
 * The provider is driven through its own flow executor rather than its markup, so
 * the check does not break when the sign-in page is restyled:
 *
 *   1. `/api/sso/start` hands off to the configured issuer, naming this
 *      deployment's callback as `redirect_uri` and carrying PKCE.
 *   2. The provider signs the identity in (identification, password).
 *   3. The authorization flow is answered (consent, if the provider asks).
 *   4. The browser lands back on the app with a session cookie, on the expected
 *      page.
 *   5. A forged callback is refused before any code exchange.
 *   6. The provider still issues a code for every OnTrak app's registered callback.
 *
 * Step 6 is the one that covers the rest of the family. All six apps authorize
 * against the same `ontrak` client, and the 2026-11-16 outage was the provider
 * refusing to hand back a code for *any* of them — so a single sign-in proves one
 * app and the matrix proves the handoff the others depend on.
 *
 * Requires a throwaway identity at the provider, in whatever group the deployment
 * maps to the role being checked. Nothing is created or deleted here.
 *
 * Usage:
 *
 *   SSO_USER=sso-check@example.test SSO_PASSWORD=... npm run verify:sso
 *   SSO_BASE=https://its.ontrak.technology SSO_EXPECT_PATH=/instructor \
 *     SSO_ROLE_LABEL=Instructor npm run verify:sso
 *
 * `SSO_ISSUER` defaults to the deployment's `ONTRAK_OIDC_ISSUER`; `CHROME_PATH`
 * overrides the browser Playwright would launch. `SSO_CLIENT_ID` and
 * `SSO_REDIRECT_URIS` override the client and the callbacks the matrix drives.
 */

import { createHash, randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = (process.env.SSO_BASE ?? "https://its.ontrak.technology").replace(/\/+$/, "");
const ISSUER = (process.env.SSO_ISSUER ?? process.env.ONTRAK_OIDC_ISSUER ?? "").replace(/\/+$/, "");
const USER = process.env.SSO_USER;
const PASSWORD = process.env.SSO_PASSWORD;
const START_PATH = process.env.SSO_START_PATH ?? "/api/sso/start";
/** Optional: assert the page the sign-in lands on. Unset means "anywhere but the sign-in page", because the app sends a person to their role's home. */
const EXPECT_PATH = process.env.SSO_EXPECT_PATH ?? "";
const ROLE_LABEL = process.env.SSO_ROLE_LABEL ?? "";
const CLIENT_ID = process.env.SSO_CLIENT_ID ?? "ontrak";
/**
 * The callbacks registered on that client, one per OnTrak app. The list is the
 * provider's, not this file's: override it when an app is added or renamed.
 */
const APP_REDIRECT_URIS = (
  process.env.SSO_REDIRECT_URIS ??
  [
    "https://its.ontrak.technology/api/sso/callback",
    "https://tix.ontrak.technology/api/sso/callback",
    "https://ontrak.technology/api/sso/callback",
    "https://sync.ontrak.technology/api/auth/sso/callback",
    "https://genie.ontrak.technology/api/auth/callback",
    "https://bolt.ontrak.technology/oauth2/callback",
  ].join(",")
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function requireEnv() {
  const missing = ["SSO_USER", "SSO_PASSWORD"].filter((key) => !process.env[key]);
  if (!ISSUER) missing.push("SSO_ISSUER (or ONTRAK_OIDC_ISSUER)");
  if (missing.length) {
    console.error(`missing: ${missing.join(", ")}`);
    process.exit(2);
  }
}

/**
 * Answer one provider flow and return where it sends the browser next.
 *
 * A flow page carries the flow's slug and, when it is a continuation, a `query`
 * that binds the executor call to the pending request. The stages this product's
 * deployments can meet are identification, password and consent; anything else is
 * reported rather than guessed at.
 */
async function answerFlow(context, pageUrl) {
  const url = new URL(pageUrl);
  const slug = url.pathname.replace(/\/+$/, "").split("/").pop();
  // A flow page reached from `authorize` carries the pending request's own query
  // string (`?response_type=code&...`), not a `query=` parameter — pass either
  // form to the executor as one encoded value, or the plan it binds to is new
  // and the consent token it hands back is rejected.
  const query = url.searchParams.get("query") ?? url.search.slice(1);
  const executorUrl = new URL(`${url.origin}/api/v3/flows/executor/${slug}/`);
  if (query) executorUrl.searchParams.set("query", query);
  const executor = executorUrl.toString();
  const csrf = (await context.cookies()).find((cookie) => cookie.name === "authentik_csrf");
  const headers = {
    Accept: "application/json",
    Referer: `${url.origin}${url.pathname}`,
    ...(csrf ? { "X-Authentik-CSRF": csrf.value } : {}),
  };

  let challenge = await (await context.request.get(executor, { headers })).json();
  const stages = [];
  for (let step = 0; step < 10; step++) {
    const component = challenge.component;
    stages.push(component);
    if (component === "xak-flow-redirect" || component === "ak-stage-redirect" || challenge.response_redirect) {
      const to = (challenge.response_redirect ?? {}).to ?? challenge.to ?? "/";
      return { next: new URL(to, `${url.origin}/`).toString(), stages };
    }
    if (challenge.response_errors) {
      throw new Error(`provider refused a stage: ${JSON.stringify(challenge.response_errors)}`);
    }
    const body =
      component === "ak-stage-identification"
        ? { uid_field: USER }
        : component === "ak-stage-password"
          ? { password: PASSWORD }
          : component === "ak-stage-consent"
            ? { token: challenge.token, consent: true }
            : {};
    challenge = await (await context.request.post(executor, { headers, data: body })).json();
  }
  throw new Error(`flow ${slug} did not finish (stages: ${stages.join(" -> ")})`);
}

/**
 * Ask the provider for a code for one registered callback.
 *
 * Deliberately not a browser: the browser follows the callback into the app, and
 * what this has to see is the provider's own answer — a 302 whose `Location` is
 * that app with `code=` on it, or a flow page that means the provider is still
 * stopping to ask something. The session cookies come from the sign-in above.
 */
async function issueCodeFor(context, redirectUri) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("hex");

  // The endpoint comes from discovery, not from the issuer string: Authentik
  // serves `/application/o/authorize/` for every provider, so appending to an
  // issuer that already names a provider asks for a page that does not exist.
  const authorize = new URL(await authorizationEndpoint());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid profile email groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  for (let step = 0; step < 4; step++) {
    // The context's own request client, not a bare `fetch`: the session the
    // provider just issued lives in this context, and `maxRedirects: 0` is what
    // keeps the callback from being followed into the app, which would spend the
    // code before it can be looked at.
    const response = await context.request.get(authorize.toString(), { maxRedirects: 0 });
    const location = new URL(
      response.headers()["location"] ?? "/",
      authorize.origin + "/",
    ).toString();
    if (location.startsWith(redirectUri)) {
      return { code: new URL(location).searchParams.get("code"), status: response.status() };
    }
    if (!location.includes("/if/flow/")) {
      return { code: null, status: response.status(), location };
    }
    // A consent stage finishes by redirecting straight at the callback, so the
    // code arrives in that answer rather than in a second authorize request.
    const answered = await answerFlow(context, location);
    if (answered.next.startsWith(redirectUri)) {
      return { code: new URL(answered.next).searchParams.get("code"), status: response.status() };
    }
  }
  return { code: null, status: 0, location: "the authorization flow did not finish" };
}

/**
 * The provider's authorization endpoint, read from its own discovery document.
 */
let authorization_endpoint = null;
async function authorizationEndpoint() {
  if (authorization_endpoint) return authorization_endpoint;
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery answered ${response.status}`);
  const discovery = await response.json();
  if (typeof discovery.authorization_endpoint !== "string") {
    throw new Error("discovery names no authorization endpoint");
  }
  authorization_endpoint = discovery.authorization_endpoint;
  return authorization_endpoint;
}

async function main() {
  requireEnv();

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const hops = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) hops.push(frame.url().split("?")[0]);
  });

  try {
    // 1. The app starts the handshake.
    await page.goto(`${BASE}${START_PATH}?next=${encodeURIComponent(EXPECT_PATH || "/")}`, {
      waitUntil: "domcontentloaded",
    });
    const providerUrl = new URL(page.url());
    check(
      "start hands off to the configured issuer",
      providerUrl.origin === new URL(ISSUER).origin,
      providerUrl.origin,
    );
    const redirectUri = providerUrl.searchParams.get("redirect_uri");
    check(
      "the authorization request names this deployment's callback",
      redirectUri === `${BASE}/api/sso/callback`,
      String(redirectUri),
    );
    check(
      "the authorization request carries PKCE",
      providerUrl.searchParams.get("code_challenge_method") === "S256",
    );
    const continuation = new URL(providerUrl.searchParams.get("next"), ISSUER).toString();

    // 2-3. The provider signs the identity in, then any authorization flow is answered.
    const signIn = await answerFlow(context, page.url());
    check("the provider completed its sign-in flow", signIn.next.length > 0, signIn.stages.join(" -> "));

    for (let step = 0; step < 5; step++) {
      await page.goto(continuation, { waitUntil: "domcontentloaded" });
      if (page.url().startsWith(BASE)) break;
      if (!page.url().includes("/if/flow/")) {
        throw new Error(`unexpected step in the handshake: ${page.url().split("?")[0]}`);
      }
      const authorization = await answerFlow(context, page.url());
      if (!authorization.next.includes("/application/o/authorize")) {
        await page.goto(authorization.next, { waitUntil: "domcontentloaded" });
        if (page.url().startsWith(BASE)) break;
      }
    }
    await page.waitForLoadState("networkidle").catch(() => {});

    // 4. Back at the app, with a session.
    check("the browser lands back on this deployment", page.url().startsWith(BASE), page.url().split("?")[0]);
    check(
      "a session cookie was issued",
      (await context.cookies()).some((cookie) => cookie.name === "ontrak_training_session"),
    );
    const landedPath = new URL(page.url()).pathname;
    check("the user is signed in, not on the sign-in page", landedPath !== "/login", landedPath);
    if (EXPECT_PATH) {
      check(`landed on ${EXPECT_PATH}`, landedPath.startsWith(EXPECT_PATH), landedPath);
    }
    if (ROLE_LABEL) {
      check(`the page shows ${ROLE_LABEL}`, (await page.content()).includes(ROLE_LABEL));
    }

    // 6. The rest of the family shares this client: every registered callback has to
    //    come back with a code, which is what the repointed flow stopped doing.
    for (const redirectUri of APP_REDIRECT_URIS) {
      const issued = await issueCodeFor(context, redirectUri);
      check(
        `the provider issues a code for ${new URL(redirectUri).host}`,
        Boolean(issued.code),
        issued.code ? redirectUri : `status ${issued.status} ${String(issued.location ?? "").split("?")[0]}`,
      );
    }
  } finally {
    // 5. A forged callback must be refused before any exchange.
    const forged = await context.request.get(`${BASE}/api/sso/callback?code=forged&state=forged`, {
      maxRedirects: 0,
    });
    const location = forged.headers()["location"] ?? "";
    check(
      "a forged callback is refused",
      forged.status() === 307 && location.includes("/login?error="),
      `${forged.status()} ${location.split("?")[0]}`,
    );

    console.log(`hops: ${hops.join(" -> ")}`);
    await browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
});
