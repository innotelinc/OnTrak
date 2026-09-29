/**
 * Live test: single sign-on through the *running* training app.
 *
 *   ONTRAK_SSO_LIVE=1 DATABASE_URL=postgresql://… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/sso-live.test.ts
 *
 * `tests/oidc.test.ts` proves the rules, the client and a real handshake against
 * a real provider — everything except the app's own routes, which need a running
 * server, a database and a session cookie. This file is that part: it boots the
 * app with a provider it starts itself, then walks `/api/sso/start` → the
 * provider → `/api/sso/callback` with a cookie jar exactly as a browser would,
 * and fetches a protected page with the session the callback issued.
 *
 * It is opt-in twice over: `ONTRAK_SSO_LIVE=1` says "start a server for this",
 * and a reachable Postgres is required because a sign-in provisions an account.
 * Neither is true in CI, so `npm test` skips it — and it cleans up the account it
 * provisions, so a local run leaves no trace.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import { SESSION_COOKIE } from "../src/lib/auth-rules";
import { SSO_STATE_COOKIE } from "../src/lib/oidc-rules";
import { LOCAL_IDP_CLIENT_ID, startLocalIdp } from "./support/local-idp";

const ENABLED = Boolean(process.env.ONTRAK_SSO_LIVE);
const PORT = Number(process.env.ONTRAK_SSO_LIVE_PORT ?? 3242);
// Derived from the port this test starts the app on, never from the ambient
// environment: the address the handshake names has to be the one the app is
// actually serving, or the redirect URI it builds matches nothing.
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_SECRET = "sso-live-test-secret-value-0123456789";
const GROUP = "sso-live-admins";

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

/**
 * A redirect's destination, resolved against this app.
 *
 * Middleware answers with a same-site redirect and Next is entitled to emit it as
 * a bare path (`/login?next=…`), where a route handler building its own absolute
 * URL does not. Resolving against the deployment is right for both and would
 * silently accept a relative provider redirect — which is why the provider's URLs
 * are asserted to be absolute before they are used.
 */
function locationOf(response: Response): URL {
  const location = response.headers.get("location");
  assert.ok(location, "the response carried no Location header");
  return new URL(location, BASE);
}

function cookieHeader(jar: Map<string, string>, names: string[]): string {
  return names
    .filter((name) => jar.has(name))
    .map((name) => `${name}=${jar.get(name)}`)
    .join("; ");
}

async function reachable(): Promise<PrismaClient | null> {
  if (!process.env.DATABASE_URL) return null;
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
}

/**
 * Start the app the way a deployment would, with the provider it must trust.
 *
 * `detached` so the whole process group can be signalled on the way out: `next dev`
 * is `npx` plus the actual server plus its workers, and killing only the wrapper
 * leaves a dev server holding the pipes — and the test process never exits.
 */
function startApp(issuer: string): ChildProcess {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      AUTH_SECRET,
      ONTRAK_TRAINING_BASE_URL: BASE,
      ONTRAK_OIDC_ISSUER: issuer,
      ONTRAK_OIDC_CLIENT_ID: LOCAL_IDP_CLIENT_ID,
      ONTRAK_OIDC_SCOPES: "profile, email, groups",
      ONTRAK_OIDC_ROLE_MAPPINGS: `${GROUP}=ADMIN`,
      ONTRAK_OIDC_ALLOWED_DOMAINS: "ontrak.local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Kept for the failure message: "the server never answered" is not something
  // anybody can act on, and a compile error is.
  child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

function stopApp(child: ChildProcess): void {
  try {
    // Negative pid: the group, not the wrapper.
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // Release the pipes whether or not the group answered, so nothing can hold this
  // process open after the test has finished.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function waitForApp(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/login`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the app never answered on /login");
}

test("the training app signs somebody in through the real SSO routes", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_SSO_LIVE=1 to run the live SSO test (it boots a server)");
    return;
  }
  const db = await reachable();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and apply the migrations");
    return;
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `sso-live-${tag}@ontrak.local`;
  const subject = `sso-live-subject-${tag}`;

  const idp = await startLocalIdp({
    // The provider is the authority on the address and the groups, so the app has
    // to be the one that adopts them.
    claims: { sub: subject, email, name: "Live SSO", groups: [GROUP] },
  });
  const app = startApp(idp.issuer);

  try {
    await waitForApp(app);

    // 1. The deployment offers the button, because it can actually complete a
    //    handshake — the whole reason the page checks rather than assumes.
    const login = await fetch(`${BASE}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Sign in with single sign-on/);

    // 2. Start: the route discovers the provider and redirects to it.
    const start = await fetch(`${BASE}/api/sso/start?next=/admin`, { redirect: "manual" });
    assert.equal(start.status, 307, `expected a redirect to the provider, got ${start.status}`);
    const authorizeUrl = start.headers.get("location") ?? "";
    assert.ok(authorizeUrl.startsWith(idp.issuer), `expected the provider's authorize endpoint, got ${authorizeUrl}`);
    const authorize = new URL(authorizeUrl);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorize.searchParams.get("nonce"), "a replay nonce is sent");

    // The round trip's state must survive in a cookie, or the callback cannot tell
    // that this is the request it started.
    const stateJar = cookiesFrom(start);
    const stateCookie = stateJar.get(SSO_STATE_COOKIE);
    assert.ok(stateCookie, "the SSO state cookie was set");
    assert.ok(!stateCookie!.includes("state="), "the cookie is opaque, not readable state");

    // 3. The browser goes to the provider, which sends it back with a code.
    const authorized = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(authorized.status, 302);
    const callback = new URL(authorized.headers.get("location") ?? "");
    assert.equal(callback.pathname, "/api/sso/callback");
    assert.ok(callback.searchParams.get("code"));
    assert.equal(callback.searchParams.get("state"), authorize.searchParams.get("state"));

    // 4. The callback exchanges the code, verifies the token, provisions the
    //    account and issues the ordinary session.
    const landed = await fetch(callback.toString(), {
      redirect: "manual",
      headers: { cookie: cookieHeader(stateJar, [SSO_STATE_COOKIE]) },
    });
    assert.equal(landed.status, 307, `expected a redirect into the app, got ${landed.status}`);
    assert.equal(locationOf(landed).pathname, "/admin", "the returnTo is honoured");

    const sessionJar = cookiesFrom(landed);
    assert.ok(sessionJar.get(SESSION_COOKIE), "a session cookie was issued");
    assert.equal(sessionJar.get(SSO_STATE_COOKIE) ?? "", "", "the handshake cookie is cleared, so it cannot be replayed");

    // 5. Prove it is a real session: the administrator page renders for it, and
    //    sends an anonymous visitor to the sign-in screen without it.
    const admin = await fetch(`${BASE}/admin`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(sessionJar, [SESSION_COOKIE]) },
    });
    assert.equal(admin.status, 200, "the signed-in administrator page renders");

    const anonymous = await fetch(`${BASE}/admin`, { redirect: "manual" });
    assert.equal(anonymous.status, 307);
    assert.equal(locationOf(anonymous).pathname, "/login");

    // 6. The account is a real row with the provider's subject on it and no local
    //    password, which is what makes the password form refuse it.
    const user = await db.user.findUnique({ where: { email }, select: { id: true, role: true, active: true, externalId: true, passwordHash: true } });
    assert.ok(user, "the first sign-in provisioned the account");
    assert.equal(user?.externalId, subject);
    assert.equal(user?.passwordHash, null);
    assert.equal(user?.role, "ADMIN", "the group mapping decided the role");
    assert.equal(user?.active, true);

    const audited = await db.auditLog.findFirst({
      where: { actorId: user?.id, action: "auth.sso_sign_in" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audited, "the sign-in was audited");
    assert.equal((audited?.detail as { provisioned?: boolean } | null)?.provisioned, true);
    assert.equal(
      JSON.stringify(audited?.detail ?? {}).includes(email),
      false,
      "the trail does not record the address the assertion carried",
    );

    // 7. A second sign-in from the same subject lands on the same account — the
    //    provider's subject is what identifies a person here, not their address.
    const second = await fetch(`${BASE}/api/sso/start`, { redirect: "manual" });
    const secondJar = cookiesFrom(second);
    const secondAuthorize = await fetch(second.headers.get("location") ?? "", { redirect: "manual" });
    const secondCallback = await fetch(secondAuthorize.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { cookie: cookieHeader(secondJar, [SSO_STATE_COOKIE]) },
    });
    assert.equal(secondCallback.status, 307);
    const again = await db.user.count({ where: { email } });
    assert.equal(again, 1, "the second sign-in updated the account rather than creating another");

    // 8. A callback that did not come from a handshake we started is refused with
    //    something a person can read.
    const forged = await fetch(`${BASE}/api/sso/callback?code=made-up&state=made-up`, { redirect: "manual" });
    assert.equal(forged.status, 307);
    const forgedTo = locationOf(forged);
    assert.equal(forgedTo.pathname, "/login");
    assert.match(forgedTo.searchParams.get("error") ?? "", /could not be verified/);
  } finally {
    stopApp(app);
    await idp.close();
    // Leave nothing behind: the audit rows naming the account, then the account.
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await db.auditLog.deleteMany({ where: { actorId: user.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
    await db.$disconnect().catch(() => undefined);
  }
});
