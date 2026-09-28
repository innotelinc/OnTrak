/**
 * OnTrak Tix M2 live test: single sign-on through the *running* app.
 *
 *   ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-sso-live.test.ts
 *
 * Every other SSO test stops at the service boundary or re-implements the route
 * logic. This one does not: it boots a real identity provider, writes a real
 * `IdentityConnection` to Postgres, then drives `GET /api/sso/start` and
 * `GET /api/sso/callback` over HTTP with a cookie jar, exactly as a browser
 * would — and finally fetches a signed-in page with the session the callback
 * issued.
 *
 * It is opt-in (skipped without `ONTRAK_TIX_BASE_URL` and without a reachable
 * database), and it provisions its own throwaway tenant, so it never touches the
 * demo seed. That also makes it the honest answer to "does single sign-on
 * actually work?", rather than "do the pieces add up?".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import { SSO_STATE_COOKIE } from "../src/lib/oidc-rules";
import { TIX_SESSION_COOKIE } from "../src/lib/session-rules";
import { startLocalIdp, LOCAL_IDP_CLIENT_ID } from "./support/local-idp";

const BASE_URL = process.env.ONTRAK_TIX_BASE_URL;

/** Every `Set-Cookie` on a response, keyed by cookie name. */
function cookiesFrom(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>, names: string[]): string {
  return names
    .filter((name) => jar.has(name))
    .map((name) => `${name}=${jar.get(name)}`)
    .join("; ");
}

async function connect(): Promise<PrismaClient | null> {
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
}

test("single sign-on signs a user in through the real routes", async (t) => {
  if (!BASE_URL) {
    t.skip("set ONTRAK_TIX_BASE_URL to run the live SSO test");
    return;
  }
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const idp = await startLocalIdp();
  const slug = `sso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const tenant = await db.tenant.create({ data: { name: "SSO Live Test", slug } });
    // Point the tenant at the local provider. The three checks below then run
    // against the app's own code: the domain allow-list, the group mapping and
    // the first-sign-in provisioning.
    await db.identityConnection.create({
      data: {
        tenantId: tenant.id,
        protocol: "OIDC",
        issuer: idp.issuer,
        clientId: LOCAL_IDP_CLIENT_ID,
        scopes: ["email", "profile", "groups"],
        allowedDomains: ["acme.test"],
        defaultRole: "REQUESTER",
        roleMappings: [{ claim: "groups", value: "tix-dispatchers", role: "DISPATCHER" }],
        mfaRequired: false,
        scimEnabled: false,
      },
    });

    // 1. Start: the route discovers the provider and redirects there.
    const startResponse = await fetch(`${BASE_URL}/api/sso/start?tenant=${slug}&returnTo=/inbox`, { redirect: "manual" });
    assert.equal(startResponse.status, 307, `expected a redirect to the IdP, got ${startResponse.status}`);
    const authorizeUrl = startResponse.headers.get("location") ?? "";
    assert.ok(authorizeUrl.startsWith(idp.issuer), `expected the IdP's authorize endpoint, got ${authorizeUrl}`);
    assert.equal(new URL(authorizeUrl).searchParams.get("code_challenge_method"), "S256");

    // The handshake state must survive in a cookie, or the callback cannot
    // verify that this is the request it started.
    const stateJar = cookiesFrom(startResponse);
    const stateCookie = stateJar.get(SSO_STATE_COOKIE);
    assert.ok(stateCookie, "the SSO state cookie was set");
    assert.ok(!stateCookie!.includes("state="), "the cookie is opaque, not readable state");

    // 2. The browser goes to the IdP, which sends it back with a code.
    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(authorizeResponse.status, 302);
    // The provider sends the browser to the `redirect_uri` the app asked for,
    // which the app derives from its own origin — so assert the route, not the
    // host the test happens to have dialled.
    const callback = new URL(authorizeResponse.headers.get("location") ?? "");
    assert.equal(callback.pathname, "/api/sso/callback");
    assert.ok(callback.searchParams.get("code"));
    assert.equal(callback.searchParams.get("state"), new URL(authorizeUrl).searchParams.get("state"));

    // 3. The callback exchanges the code, verifies the token, provisions the
    //    user and issues the ordinary Tix session.
    const callbackResponse = await fetch(callback.toString(), {
      redirect: "manual",
      headers: { cookie: cookieHeader(stateJar, [SSO_STATE_COOKIE]) },
    });
    assert.equal(callbackResponse.status, 307, `expected a redirect into the app, got ${callbackResponse.status}`);
    const landed = callbackResponse.headers.get("location") ?? "";
    assert.equal(new URL(landed).pathname, "/inbox", "the returnTo destination is honoured");

    const sessionJar = cookiesFrom(callbackResponse);
    const session = sessionJar.get(TIX_SESSION_COOKIE);
    assert.ok(session, "a session cookie was issued");
    // The handshake cookie is cleared on the way through, so it cannot be replayed.
    assert.equal(sessionJar.get(SSO_STATE_COOKIE) ?? "", "");

    // 4. Prove it is a real session: the protected page renders for it, and does
    //    not without it.
    const inbox = await fetch(`${BASE_URL}/inbox`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(sessionJar, [TIX_SESSION_COOKIE]) },
    });
    assert.equal(inbox.status, 200, "the signed-in worklist renders");
    const html = await inbox.text();
    assert.match(html, /Ida SSO|Ida Sso|sso\.user@acme\.test/i, "the shell names the signed-in user");

    const anonymous = await fetch(`${BASE_URL}/inbox`, { redirect: "manual" });
    assert.equal(anonymous.status, 307, "without the cookie the worklist redirects to sign-in");

    // 5. The user the IdP created is a real row, with the role the group mapped
    //    to and the external id recorded for next time.
    const provisioned = await db.user.findFirst({ where: { tenantId: tenant.id, email: "sso.user@acme.test" } });
    assert.ok(provisioned, "the first sign-in provisioned the user");
    assert.equal(provisioned?.role, "DISPATCHER");
    assert.equal(provisioned?.displayName, "Ida SSO");
    assert.equal(provisioned?.externalId, "idp-subject-1");

    // 6. And the sign-in is on the tenant's hash-chained audit log.
    const signedIn = await db.auditEvent.findFirst({
      where: { tenantId: tenant.id, action: "identity.signin" },
      orderBy: { seq: "asc" },
    });
    assert.ok(signedIn, "the sign-in was audited");
    assert.equal(signedIn?.actor, provisioned?.id);
  } finally {
    await db.tenant.delete({ where: { slug } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await idp.close();
  }
});

test("the live routes refuse a workspace that does not exist, and one without SSO", async (t) => {
  if (!BASE_URL) {
    t.skip("set ONTRAK_TIX_BASE_URL to run the live SSO test");
    return;
  }
  const db = await connect();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and run npm run setup");
    return;
  }

  const slug = `nosso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Unknown workspace: the message is deliberate, not a crash.
    const unknown = await fetch(`${BASE_URL}/api/sso/start?tenant=does-not-exist`, { redirect: "manual" });
    assert.equal(unknown.status, 307);
    const unknownTo = new URL(unknown.headers.get("location") ?? "");
    assert.equal(unknownTo.pathname, "/sign-in");
    assert.match(unknownTo.searchParams.get("error") ?? "", /Unknown workspace/);

    // A real tenant with no connection is told so rather than left hanging.
    await db.tenant.create({ data: { name: "No SSO", slug } });
    const unconfigured = await fetch(`${BASE_URL}/api/sso/start?tenant=${slug}`, { redirect: "manual" });
    const unconfiguredTo = new URL(unconfigured.headers.get("location") ?? "");
    assert.match(unconfiguredTo.searchParams.get("error") ?? "", /no single sign-on configured/);

    // And a blank workspace is a prompt, not an error page.
    const blank = await fetch(`${BASE_URL}/api/sso/start`, { redirect: "manual" });
    const blankTo = new URL(blank.headers.get("location") ?? "");
    assert.match(blankTo.searchParams.get("error") ?? "", /Enter your workspace/);

    // The callback refuses a code that did not come from a handshake we started.
    const forged = await fetch(`${BASE_URL}/api/sso/callback?code=made-up&state=made-up`, { redirect: "manual" });
    const forgedTo = new URL(forged.headers.get("location") ?? "");
    assert.equal(forgedTo.pathname, "/sign-in");
    assert.match(forgedTo.searchParams.get("error") ?? "", /could not be verified/);
  } finally {
    await db.tenant.delete({ where: { slug } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
