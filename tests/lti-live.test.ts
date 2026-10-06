/**
 * Live test: a scenario launched from an LMS, through the *running* training app.
 *
 *   ONTRAK_LTI_LIVE=1 DATABASE_URL=postgresql://… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/lti-live.test.ts
 *
 * `tests/lti.test.ts` proves the launch decisions and the client seam against
 * fixtures — everything except the app's own routes, which need a running server,
 * a database and a session cookie. This file is that part: it boots the app with
 * a learning platform it starts itself, then walks `/api/lti/login` → the
 * platform's `form_post` page → `/api/lti/launch` with a cookie jar exactly as a
 * browser would, and fetches a protected page with the session the launch issued.
 *
 * It is opt-in twice over, like `tests/sso-live.test.ts`: `ONTRAK_LTI_LIVE=1` says
 * "start a server for this", and a reachable Postgres is required because a first
 * launch provisions an account. Neither is true in CI, so `npm test` skips it — and
 * it cleans up the account it provisions, so a local run leaves no trace.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";
import { jwtVerify } from "jose";

import { SESSION_COOKIE } from "../src/lib/auth-rules";
import { LTI_JWKS_PATH, LTI_LAUNCH_COOKIE, LTI_STATE_COOKIE } from "../src/lib/lti-rules";
import { startLocalLtiPlatform } from "./support/local-lti-platform";

const ENABLED = Boolean(process.env.ONTRAK_LTI_LIVE);
const PORT = Number(process.env.ONTRAK_LTI_LIVE_PORT ?? 3243);
// Derived from the port this test starts the app on, never from the ambient
// environment: the launch URL the app advertises has to be the one it is serving,
// or the redirect URI it builds matches nothing the platform registered.
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_SECRET = "lti-live-test-secret-value-0123456789";

function cookiesFrom(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return jar;
}

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
 * Start the app the way a deployment would, with the platform it must trust.
 *
 * `detached` so the whole process group can be signalled on the way out: `next dev`
 * is `npx` plus the actual server plus its workers, and killing only the wrapper
 * leaves a dev server holding the pipes — and the test process never exits.
 */
function startApp(
  platform: { issuer: string; clientId: string; deploymentId: string; authorizationEndpoint: string; jwksUri: string },
  key: { keyId: string; privateKey: string },
): ChildProcess {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      AUTH_SECRET,
      ONTRAK_TRAINING_BASE_URL: BASE,
      ONTRAK_LTI_ISSUER: platform.issuer,
      ONTRAK_LTI_CLIENT_ID: platform.clientId,
      ONTRAK_LTI_DEPLOYMENT_IDS: platform.deploymentId,
      ONTRAK_LTI_AUTHORIZATION_ENDPOINT: platform.authorizationEndpoint,
      ONTRAK_LTI_JWKS_URI: platform.jwksUri,
      // The key the deployment signs a passback with, so the route that publishes its
      // public half has something real to publish.
      ONTRAK_LTI_KEY_ID: key.keyId,
      ONTRAK_LTI_PRIVATE_KEY: key.privateKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

test("the training app launches a scenario from the real LTI routes", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_LTI_LIVE=1 to run the live LTI test (it boots a server)");
    return;
  }
  const db = await reachable();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and apply the migrations");
    return;
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `lti-live-${tag}@ontrak.local`;
  const subject = `lms-subject-${tag}`;

  // A keypair for this run alone. The public half is what the tool must publish; the
  // private half is what it would sign a client assertion with, and is passed in the
  // spelling an env var can hold.
  const { privateKey: signingKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    keyId: "ontrak-training-live-1",
    privateKey: signingKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n"),
  };

  const platform = await startLocalLtiPlatform({ claims: { sub: subject, email, name: "Lena LMS" } });
  const app = startApp(platform, key);

  try {
    await waitForApp(app);

    // 0. The tool publishes its own public key set, so a platform can register a
    //    Keyset URL instead of being handed a copy of a PEM that can drift. No
    //    credential is needed to read it — a key set is public by construction.
    const jwksResponse = await fetch(`${BASE}${LTI_JWKS_PATH}`);
    assert.equal(jwksResponse.status, 200, "the tool serves its public key set");
    const published = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
    assert.equal(published.keys.length, 1);
    assert.equal(published.keys[0].kid, key.keyId, "the key is published under the id the deployment registered");
    assert.equal(published.keys[0].kty, "RSA");
    assert.equal(published.keys[0].alg, "RS256");
    assert.equal("d" in published.keys[0], false, "the private half is never published");
    const expectedModulus = createPublicKey(signingKey).export({ format: "jwk" }) as Record<string, unknown>;
    assert.equal(published.keys[0].n, expectedModulus.n, "the published key is the one this deployment signs with");

    // 1. The platform starts the login. A launch from somebody else's platform is
    //    refused before anything is begun, which is the one check that must happen
    //    before a round trip exists at all.
    const foreign = await fetch(`${BASE}/api/lti/login?iss=https://other.example.edu&login_hint=1`, { redirect: "manual" });
    assert.equal(foreign.status, 400, "a login naming another platform is refused");

    const start = await fetch(
      `${BASE}/api/lti/login?iss=${encodeURIComponent(platform.issuer)}&login_hint=42&deployment_id=${platform.deploymentId}`,
      { redirect: "manual" },
    );
    assert.equal(start.status, 303, `expected a redirect to the platform, got ${start.status}`);
    const authorize = locationOf(start);
    assert.equal(authorize.origin + authorize.pathname, platform.authorizationEndpoint);
    assert.equal(authorize.searchParams.get("client_id"), platform.clientId);
    assert.equal(authorize.searchParams.get("response_type"), "id_token");
    assert.equal(authorize.searchParams.get("response_mode"), "form_post");
    assert.equal(authorize.searchParams.get("prompt"), "none");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${BASE}/api/lti/launch`);
    assert.ok(authorize.searchParams.get("nonce"), "a replay nonce is sent");
    assert.ok(authorize.searchParams.get("state"), "the round trip is started with a state");

    // The round trip's state must survive in a signed cookie, or the launch cannot
    // be shown to be the one this deployment asked for.
    const stateJar = cookiesFrom(start);
    const stateCookie = stateJar.get(LTI_STATE_COOKIE);
    assert.ok(stateCookie, "the LTI state cookie was set");

    // 2. The browser goes to the platform, which answers with a form_post page. The
    //    test acts as the browser and takes the fields the page would auto-submit.
    const authorized = await fetch(authorize.toString(), { redirect: "manual" });
    assert.equal(authorized.status, 200, "the platform rendered its form_post page");
    const launch = platform.launchFields();
    assert.ok(launch, "the platform kept the launch it is about to post");
    assert.equal(launch!.action, `${BASE}/api/lti/launch`, "the assertion is posted to the launch URL it registered");
    assert.ok(launch!.fields.id_token, "the assertion is in the form");

    // 3. The launch: the assertion is verified against the platform's JWKS, the
    //    account is provisioned and the ordinary session is issued.
    const landed = await fetch(launch!.action, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(stateJar, [LTI_STATE_COOKIE]),
      },
      body: new URLSearchParams(launch!.fields).toString(),
    });
    assert.equal(landed.status, 303, `expected a redirect into the app, got ${landed.status}`);
    assert.equal(locationOf(landed).pathname, "/student", "the learner lands at their own home");

    const jar = cookiesFrom(landed);
    assert.ok(jar.get(SESSION_COOKIE), "a session cookie was issued");
    assert.equal(jar.get(LTI_STATE_COOKIE) ?? "", "", "the handshake cookie is cleared, so it cannot be replayed");
    const launchCookie = jar.get(LTI_LAUNCH_COOKIE);
    assert.ok(launchCookie, "the grading context travelled back in a launch cookie");

    // 4. The launch context carries the line item and the score scope, which is what
    //    lets a later grading find its way back to the platform.
    const { payload: facts } = await jwtVerify(launchCookie!, new TextEncoder().encode(AUTH_SECRET));
    assert.equal(facts.lineItem, platform.lineItem);
    assert.ok(Array.isArray(facts.agsScopes) && (facts.agsScopes as string[]).includes("https://purl.imsglobal.org/spec/lti-ags/scope/score"));
    assert.equal(facts.subject, subject);
    assert.equal(facts.contextId, "course-42");

    // 5. Prove it is a real session: the learner page renders for it.
    const student = await fetch(`${BASE}/student`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar, [SESSION_COOKIE]) },
    });
    assert.equal(student.status, 200, "the signed-in learner page renders");

    // 6. The account is a real row with the namespaced subject on it and no local
    //    password, which is what makes a launch a *move* on a re-launch and not a
    //    second account.
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, role: true, active: true, externalId: true, passwordHash: true },
    });
    assert.ok(user, "the first launch provisioned the account");
    assert.equal(user?.externalId, `lti:${platform.issuer}#${subject}`);
    assert.equal(user?.passwordHash, null);
    assert.equal(user?.role, "STUDENT", "the LIS Learner role decided the local role");

    const audited = await db.auditLog.findFirst({
      where: { actorId: user?.id, action: "auth.lti_launch" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(audited, "the launch was audited");
    const detail = (audited?.detail ?? {}) as { platform?: string; resourceLink?: string; context?: string };
    assert.equal(detail.platform, platform.issuer);
    assert.equal(detail.resourceLink, "rl-1");
    assert.equal(detail.context, "course-42");

    // 7. A second launch from the same platform subject lands on the same account —
    //    the platform's subject is what identifies a person, not their address.
    const again = await fetch(
      `${BASE}/api/lti/login?iss=${encodeURIComponent(platform.issuer)}&login_hint=42&deployment_id=${platform.deploymentId}`,
      { redirect: "manual" },
    );
    const againJar = cookiesFrom(again);
    await fetch(locationOf(again).toString(), { redirect: "manual" });
    const second = platform.launchFields()!;
    const secondLanded = await fetch(second.action, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(againJar, [LTI_STATE_COOKIE]),
      },
      body: new URLSearchParams(second.fields).toString(),
    });
    assert.equal(secondLanded.status, 303, "the second launch completes");
    assert.equal(await db.user.count({ where: { email } }), 1, "the second launch updated the account rather than creating another");

    // 8. A launch with no handshake behind it is refused: this request did not come
    //    from a round trip this deployment started.
    const forged = await fetch(`${BASE}/api/lti/launch`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: "made-up", state: "made-up" }).toString(),
    });
    assert.equal(forged.status, 400, "a launch without our state is refused before the assertion is trusted");
  } finally {
    stopApp(app);
    await platform.close();
    // Leave nothing behind: the audit rows naming the account, then the account.
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await db.auditLog.deleteMany({ where: { actorId: user.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
    await db.$disconnect().catch(() => undefined);
  }
});
