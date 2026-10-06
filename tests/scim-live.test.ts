/**
 * Live test: a directory pushing people in, through the *running* training app.
 *
 *   ONTRAK_SCIM_LIVE=1 DATABASE_URL=postgresql://… \
 *     ./node_modules/.bin/tsx --tsconfig tests/tsconfig.json --test tests/scim-live.test.ts
 *
 * `tests/scim.test.ts` proves the rules and the service against `MemoryScimStore` —
 * every refusal, both PATCH shapes, the filter subset. What it cannot prove is that
 * the *routes* pass a connector's request through unchanged: that Entra's filter,
 * which names the attribute with a schema URN
 * (`urn:ietf:params:scim:schemas:core:2.0:User:userName eq "…"`), survives the query
 * string and the guard; that Okta's PATCH, which carries no `path` and puts the
 * attributes in the `value` object, reaches the service intact; and that the token
 * check answers the way a connector's "Test Connection" reads it.
 *
 * So this file boots the app, then drives `/api/scim/v2/*` over real HTTP with a
 * connector's bearer token — the same requests Entra's provisioning client and
 * Okta's SCIM 2.0 app make, down to the URL encoding.
 *
 * It is opt-in twice over, like `tests/sso-live.test.ts` and `tests/lti-live.test.ts`:
 * `ONTRAK_SCIM_LIVE=1` says "start a server for this", and a reachable Postgres is
 * required because a push writes a row. Neither is true in CI, so `npm test` skips
 * it — and it cleans up the account it provisions, so a local run leaves no trace.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  SCIM_CONTENT_TYPE,
  SCIM_PATCH_SCHEMA,
  SCIM_PATHS,
  SCIM_USER_SCHEMA,
} from "../src/lib/scim-rules";

const ENABLED = Boolean(process.env.ONTRAK_SCIM_LIVE);
const PORT = Number(process.env.ONTRAK_SCIM_LIVE_PORT ?? 3244);
// Derived from the port this test starts the app on, never from the ambient
// environment: the links the app hands out (`meta.location`, the `Location` header)
// have to be the ones it is actually serving.
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "scim-live-token-0123456789abcdef";
const AUTH_SECRET = "scim-live-test-secret-value-0123456789";

/** A request as a connector makes it: the deployment's base, and the bearer token. */
function scimFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
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
 * Start the app the way a deployment would, with the SCIM token it must accept.
 *
 * `detached` so the whole process group can be signalled on the way out: `next dev`
 * is `npx` plus the actual server plus its workers, and killing only the wrapper
 * leaves a dev server holding the pipes — and the test process never exits.
 */
function startApp(): ChildProcess {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      AUTH_SECRET,
      ONTRAK_TRAINING_BASE_URL: BASE,
      ONTRAK_SCIM_TOKEN: TOKEN,
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

test("the training app serves SCIM the way Entra and Okta drive it", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_SCIM_LIVE=1 to run the live SCIM test (it boots a server)");
    return;
  }
  const db = await reachable();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and apply the migrations");
    return;
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `scim-live-${tag}@ontrak.local`;
  const externalId = `dir-${tag}`;
  const app = startApp();
  let userId = "";

  try {
    await waitForApp(app);

    // 1. Discovery needs no token — a connector cannot fail it by getting the
    //    credential wrong, which is what lets "Test Connection" report a useful
    //    error. It is also where the honest capability list is read.
    const config = await fetch(`${BASE}${SCIM_PATHS.serviceProviderConfig}`);
    assert.equal(config.status, 200, "ServiceProviderConfig is readable without a token");
    assert.match(config.headers.get("content-type") ?? "", /application\/scim\+json/);
    const capabilities = (await config.json()) as { patch: { supported: boolean }; bulk: { supported: boolean } };
    assert.equal(capabilities.patch.supported, true);
    assert.equal(capabilities.bulk.supported, false, "the discovery document is honest, not optimistic");

    // 2. Unconfigured and wrong-token are different answers, because only one of
    //    them is the caller's to fix. `ONTRAK_SCIM_TOKEN` is set, so an anonymous
    //    call is a 401 with the challenge a connector looks for.
    const anonymous = await fetch(`${BASE}${SCIM_PATHS.users}`);
    assert.equal(anonymous.status, 401, "no token is refused");
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");

    const wrong = await scimFetch(SCIM_PATHS.users, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(wrong.status, 401, "a wrong token is refused");

    // 3. A push creates the account, and the response is a SCIM resource with a
    //    `Location` a connector stores and uses for every later write.
    const created = await scimFetch(SCIM_PATHS.users, {
      method: "POST",
      headers: { "content-type": SCIM_CONTENT_TYPE },
      body: JSON.stringify({
        schemas: [SCIM_USER_SCHEMA],
        userName: email,
        externalId,
        name: { formatted: "Dana Directory" },
        roles: [{ value: "INSTRUCTOR" }],
        active: true,
      }),
    });
    assert.equal(created.status, 201, "a provisioned user answers 201");
    const provisioned = (await created.json()) as { id: string; userName: string; displayName: string };
    // Recorded before the assertions below so the cleanup in `finally` covers a
    // failure at any point after this row exists.
    userId = provisioned.id;
    assert.equal(created.headers.get("location"), `${BASE}${SCIM_PATHS.users}/${provisioned.id}`);
    assert.equal(provisioned.userName, email);
    assert.equal(provisioned.displayName, "Dana Directory");
    assert.equal(JSON.stringify(provisioned).includes("password"), false, "a provisioned resource carries no credential");

    // 4. Entra's filter: the attribute is a schema URN, and the whole thing arrives
    //    URL-encoded in one query parameter. If the route dropped or re-encoded it,
    //    this is where a connector would silently see an empty directory.
    const byUserName = new URLSearchParams({
      filter: `urn:ietf:params:scim:schemas:core:2.0:User:userName eq "${email}"`,
    });
    const listed = await scimFetch(`${SCIM_PATHS.users}?${byUserName}`);
    assert.equal(listed.status, 200, `a URN-form filter is accepted: ${await listed.clone().text()}`);
    const page = (await listed.json()) as { totalResults: number; Resources: { id: string; userName: string }[] };
    assert.equal(page.totalResults, 1);
    assert.equal(page.Resources[0]?.id, userId);
    assert.equal(page.Resources[0]?.userName, email);

    //    The same, on `externalId`, which is the attribute a connector actually
    //    matches on so a rename moves the account instead of making a twin.
    const byExternalId = new URLSearchParams({
      filter: `urn:ietf:params:scim:schemas:core:2.0:User:externalId eq "${externalId}"`,
    });
    const matched = await scimFetch(`${SCIM_PATHS.users}?${byExternalId}`);
    assert.equal(matched.status, 200);
    assert.equal(((await matched.json()) as { totalResults: number }).totalResults, 1);

    // 5. A filter outside the subset is refused by name, not answered with a
    //    narrower result — the failure mode this surface exists to avoid.
    const prefix = new URLSearchParams({ filter: `userName co "${email}"` });
    const refused = await scimFetch(`${SCIM_PATHS.users}?${prefix}`);
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { scimType?: string }).scimType, "invalidFilter");

    // 6. Okta's PATCH: no `path`, the attributes in the `value` object. The route
    //    parses the body and the guard trusts the token, so this is the shape that
    //    would break if either were wrong.
    const patched = await scimFetch(`${SCIM_PATHS.users}/${userId}`, {
      method: "PATCH",
      headers: { "content-type": SCIM_CONTENT_TYPE },
      body: JSON.stringify({
        schemas: [SCIM_PATCH_SCHEMA],
        Operations: [{ op: "replace", value: { active: false, displayName: "Dana Learner" } }],
      }),
    });
    assert.equal(patched.status, 200, `an object-form PATCH is accepted: ${await patched.clone().text()}`);
    const patchedBody = (await patched.json()) as { active: boolean; displayName: string };
    assert.equal(patchedBody.active, false, "the deactivation was applied");
    assert.equal(patchedBody.displayName, "Dana Learner", "the rename was applied in the same operation");

    // 7. The database agrees, and the switch-off was written down as its own event —
    //    `active:false` is a deprovision, not an update.
    const row = await db.user.findUnique({ where: { email }, select: { id: true, active: true, externalId: true, role: true } });
    assert.equal(row?.id, userId);
    assert.equal(row?.active, false);
    assert.equal(row?.externalId, externalId);
    assert.equal(row?.role, "INSTRUCTOR", "the role the push named");

    const audit = await db.auditLog.findFirst({
      where: { action: "scim.user.deprovision", targetType: "user", targetId: userId },
    });
    assert.ok(audit, "the deprovision is in the audit trail");
  } finally {
    stopApp(app);
    // Leave nothing behind: the audit rows naming the account, then the account.
    if (userId) {
      await db.auditLog.deleteMany({ where: { targetType: "user", targetId: userId } }).catch(() => undefined);
      await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await db.$disconnect().catch(() => undefined);
  }
});
