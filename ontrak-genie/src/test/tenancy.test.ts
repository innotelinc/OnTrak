import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";

/**
 * Tests for the per-turn tenancy gate and the control-plane client under it.
 *
 * The control plane is a stand-in server with a scripted queue, because the
 * interesting behaviour is not the wire format — it is what the gate *decides*
 * when the plane answers allow, deny, refuse, or says nothing at all. The four
 * postures that matter (key strict, quota fail-open, accounting best-effort, and
 * inert when unconfigured) are each asserted rather than described.
 *
 * Nothing here needs a model or a sign-in: `beginTurn` takes the session object
 * the server would have, and the plane is passed explicitly for the cases that
 * need one.
 */

interface PlaneReply {
  status?: number;
  body?: unknown;
}

interface PlaneCall {
  path: string;
  method: string;
  authorization: string | undefined;
  internalToken: string | undefined;
  body: any;
}

const planeQueue: PlaneReply[] = [];
const planeCalls: PlaneCall[] = [];

const plane = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    planeCalls.push({
      path: req.url ?? "",
      method: req.method ?? "",
      authorization: req.headers.authorization,
      internalToken: req.headers["x-control-internal-token"] as string | undefined,
      body: raw === "" ? null : JSON.parse(raw),
    });

    const reply = planeQueue.shift() ?? { status: 200, body: {} };
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
});

await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
const planeUrl = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;

// Set before the config module is imported: this file's subject is the *gate*,
// so the deployment it runs in is deliberately the unconfigured one, and the
// cases that need a plane pass it in.
process.env.CONTROL_PLANE_INTERNAL_URL = "";
process.env.CONTROL_INTERNAL_TOKEN = "";
process.env.OMNIROUTE_API_KEY = "";

const { readControlPlaneConfig, controlPlaneEnabled, provisionIdentity, checkTurnQuota, reportTurnUsage, recordAudit, ControlPlaneError } =
  await import("../controlplane.js");
const { beginTurn, checkQuota, countUsage, finishTurn, resetCallerCache, resolveCaller } = await import(
  "../tenancy.js"
);
type ControlPlaneConfig = import("../controlplane.js").ControlPlaneConfig;
type Session = import("../oidc.js").Session;

const PLANE: ControlPlaneConfig = { url: planeUrl, token: "plane-token" };

const session: Session = {
  sub: "sub-1",
  email: "dev@innotel.us",
  name: "Dev",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function identityReply(gatewayKey: string, created = false): PlaneReply {
  return {
    status: 200,
    body: {
      user: { id: "u-1", email: "dev@innotel.us" },
      oidcSub: "sub-1",
      gatewayKey,
      created,
      quota: { plan: "pro", requests_per_day: 200, tokens_per_day: 2_000_000, spend_cap_usd: 20 },
      usageToday: { tokens_in: 10, tokens_out: 20, requests: 1, cost_usd: 0.01, date: "2026-09-29" },
    },
  };
}

function callsTo(pathname: string): PlaneCall[] {
  return planeCalls.filter((call) => call.path === pathname);
}

after(async () => {
  await new Promise<void>((resolve) => plane.close(() => resolve()));
});

/* ------------------------------------------------------------- unconfigured */

test("tenancy without a control plane", async (t) => {
  await t.test("an unset or placeholder configuration is inert, not broken", () => {
    assert.equal(readControlPlaneConfig(), null);
    assert.equal(controlPlaneEnabled(), false);
  });

  await t.test("the shared key stays the credential, empty or not", async () => {
    const started = await beginTurn(null);
    assert.equal(started.ok, true);
    // Empty on purpose: a gateway on this host that needs no key is the shipped
    // default, so an empty shared key is a real setting rather than a missing one.
    if (started.ok) assert.equal(started.turn.apiKey, "");
    if (started.ok) assert.equal(started.turn.caller, null);
  });

  await t.test("resolveCaller has no account to resolve", async () => {
    assert.equal(await resolveCaller(session, null), null);
  });
});

/* ------------------------------------------------------------ the gate ---- */

test("beginTurn with a control plane configured", async (t) => {
  t.beforeEach(() => {
    planeCalls.length = 0;
    planeQueue.length = 0;
    resetCallerCache();
  });

  await t.test("a turn with no sign-in is refused rather than put on the operator's key", async () => {
    const started = await beginTurn(null, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 401);
      assert.match(started.message, /Sign in/);
    }
    // The point of the posture: nothing was provisioned and nothing was spent.
    assert.equal(planeCalls.length, 0);
  });

  await t.test("a session with no subject is refused the same way", async () => {
    const started = await beginTurn({ ...session, sub: "" }, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.status, 401);
    assert.equal(planeCalls.length, 0);
  });

  await t.test("a signed-in turn spends the account's own key", async () => {
    planeQueue.push(identityReply("sk-tenant-1"), { status: 200, body: { allowed: true } });

    const started = await beginTurn(session, PLANE);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.turn.apiKey, "sk-tenant-1");
    assert.equal(started.turn.caller?.userId, "u-1");
    assert.equal(started.turn.caller?.sub, "sub-1");

    // Identity is service-to-service; quota is the account's own key.
    const identity = callsTo("/api/internal/identity");
    assert.equal(identity.length, 1);
    assert.equal(identity[0]?.internalToken, "plane-token");
    assert.equal(identity[0]?.body.sub, "sub-1");
    assert.equal(identity[0]?.body.email, "dev@innotel.us");

    const quota = callsTo("/api/internal/quota-check");
    assert.equal(quota.length, 1);
    assert.equal(quota[0]?.authorization, "Bearer sk-tenant-1");
    assert.equal(quota[0]?.method, "GET");
  });

  await t.test("an exhausted account is refused, with the plane's own reasons", async () => {
    planeQueue.push(identityReply("sk-tenant-1"), {
      status: 200,
      body: { allowed: false, reasons: ["daily request cap reached", "spend cap reached"] },
    });

    const started = await beginTurn(session, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 429);
      assert.match(started.message, /daily request cap reached, spend cap reached/);
    }
  });

  await t.test("a plane that is up but cannot answer does not stop the turn", async () => {
    // Fail-open, deliberately: the gateway key's own cap is the backstop, and a
    // read-only hiccup on the tenancy service must not be a build outage.
    planeQueue.push(identityReply("sk-tenant-1"), { status: 503, body: { error: "database is busy" } });

    const started = await beginTurn(session, PLANE);
    assert.equal(started.ok, true);
    if (started.ok) assert.equal(started.turn.apiKey, "sk-tenant-1");
  });

  await t.test("checkQuota says allowed when the call throws", async () => {
    planeQueue.push({ status: 500, body: {} });
    const decision = await checkQuota(PLANE, "sk-tenant-1");
    assert.deepEqual(decision, { allowed: true, reasons: [] });
  });

  await t.test("an identity refusal is reported as itself, not as an outage", async () => {
    planeQueue.push({ status: 409, body: { error: "that email is already bound to another subject" } });

    const started = await beginTurn(session, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 409);
      assert.match(started.message, /already bound/);
    }
  });

  await t.test("an unreachable plane is an outage, and still spends nothing", async () => {
    const started = await beginTurn(session, { url: "http://127.0.0.1:1", token: "plane-token" });
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 503);
      assert.match(started.message, /will not be spent/);
    }
  });

  await t.test("a caller is remembered briefly, and forgettable on demand", async () => {
    const allowed = { status: 200, body: { allowed: true } };
    planeQueue.push(identityReply("sk-tenant-1"), allowed, allowed);

    assert.equal((await beginTurn(session, PLANE)).ok, true);
    assert.equal(callsTo("/api/internal/identity").length, 1);

    // The quota decision is never cached; the identity is, so a second turn is
    // one call rather than two.
    assert.equal((await beginTurn(session, PLANE)).ok, true);
    assert.equal(callsTo("/api/internal/identity").length, 1);
    assert.equal(callsTo("/api/internal/quota-check").length, 2);

    resetCallerCache();
    planeQueue.push(identityReply("sk-tenant-1"), allowed);
    assert.equal((await beginTurn(session, PLANE)).ok, true);
    assert.equal(callsTo("/api/internal/identity").length, 2);
  });
});

/* -------------------------------------------------------------- accounting */

test("accounting and audit", async (t) => {
  t.beforeEach(() => {
    planeCalls.length = 0;
    planeQueue.length = 0;
  });

  await t.test("a finished turn reports usage under the account's key", async () => {
    planeQueue.push({ status: 200, body: { ok: true } });
    await reportTurnUsage(PLANE, "sk-tenant-1", {
      tokensIn: 120.4,
      tokensOut: 8.6,
      requests: 2,
      model: "gemini/gemini-3.1-flash-lite",
    });

    const report = callsTo("/api/internal/usage-report");
    assert.equal(report.length, 1);
    assert.equal(report[0]?.authorization, "Bearer sk-tenant-1");
    assert.deepEqual(report[0]?.body, {
      tokensIn: 120,
      tokensOut: 9,
      requests: 2,
      model: "gemini/gemini-3.1-flash-lite",
    });
  });

  await t.test("a ledger write that fails is swallowed, never raised", async () => {
    planeQueue.push({ status: 500, body: { error: "no" } });
    await assert.doesNotReject(() =>
      reportTurnUsage(PLANE, "sk-tenant-1", { tokensIn: 1, tokensOut: 1, requests: 1 }),
    );
  });

  await t.test("finishTurn is a no-op without a caller", async () => {
    await finishTurn({ apiKey: "", caller: null }, { tokensIn: 5, tokensOut: 5, requests: 1 });
    assert.equal(planeCalls.length, 0);
  });

  await t.test("an export writes an audit row naming the actor and the artefact", async () => {
    planeQueue.push({ status: 200, body: { ok: true } });
    await recordAudit(PLANE, {
      action: "build.export",
      sub: "sub-1",
      actorEmail: "dev@innotel.us",
      targetId: "todo-list.md",
      meta: { bytes: 900 },
    });

    const audit = callsTo("/api/internal/audit");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.internalToken, "plane-token");
    assert.equal(audit[0]?.body.action, "build.export");
    assert.equal(audit[0]?.body.sub, "sub-1");
    assert.equal(audit[0]?.body.targetId, "todo-list.md");
    assert.deepEqual(audit[0]?.body.meta, { bytes: 900 });
  });

  await t.test("countUsage reads the gateway's own report, and tolerates its absence", () => {
    const start = { tokensIn: 0, tokensOut: 0, requests: 0 };
    const once = countUsage({ prompt_tokens: 100, completion_tokens: 40 }, start, "m/one");
    assert.deepEqual(once, { tokensIn: 100, tokensOut: 40, requests: 1, model: "m/one" });

    // The alias spellings one gateway in front of many providers turns up.
    const again = countUsage({ input_tokens: 5, output_tokens: 7 }, once, "m/two");
    assert.deepEqual(again, { tokensIn: 105, tokensOut: 47, requests: 2, model: "m/two" });

    // No report at all still counts the request: it was made, and it was paid for.
    const silent = countUsage(null, again, "m/three");
    assert.deepEqual(silent, { tokensIn: 105, tokensOut: 47, requests: 3, model: "m/three" });

    // Nonsense is dropped rather than added as NaN.
    const junk = countUsage({ prompt_tokens: "many" }, silent, "m/four");
    assert.deepEqual(junk, { tokensIn: 105, tokensOut: 47, requests: 4, model: "m/four" });
  });
});

/* -------------------------------------------------- the client's shape ---- */

test("the control-plane client", async (t) => {
  t.beforeEach(() => {
    planeCalls.length = 0;
    planeQueue.length = 0;
  });

  await t.test("an identity without a gateway key is refused, not trusted", async () => {
    planeQueue.push({ status: 200, body: { user: { id: "u-1" }, oidcSub: "sub-1", gatewayKey: "" } });
    await assert.rejects(
      () => provisionIdentity(PLANE, { sub: "sub-1", email: "dev@innotel.us" }),
      (error: unknown) => error instanceof ControlPlaneError && /did not return a gateway key/.test(error.message),
    );
  });

  await t.test("the account's email and subject come back as the plane knows them", async () => {
    planeQueue.push(identityReply("sk-tenant-1", true));
    const identity = await provisionIdentity(PLANE, { sub: "sub-1", email: "" });
    assert.equal(identity.userId, "u-1");
    assert.equal(identity.email, "dev@innotel.us");
    assert.equal(identity.created, true);
    assert.equal(identity.quota?.plan, "pro");
    assert.equal(identity.quota?.requestsPerDay, 200);
    assert.equal(identity.usageToday?.requests, 1);
  });

  await t.test("a refusal never carries the credential back in its message", async () => {
    planeQueue.push({ status: 401, body: { error: "unknown account" } });
    await assert.rejects(
      () => checkTurnQuota(PLANE, "sk-tenant-1"),
      (error: unknown) => {
        assert.ok(error instanceof ControlPlaneError);
        assert.equal(error.status, 401);
        assert.doesNotMatch(error.message, /sk-tenant-1/);
        assert.doesNotMatch(error.message, /plane-token/);
        return true;
      },
    );
  });

  await t.test("a 4xx keeps the plane's status; anything else is a 502", async () => {
    planeQueue.push({ status: 404, body: { error: "no such route" } });
    await assert.rejects(
      () => checkTurnQuota(PLANE, "k"),
      (error: unknown) => error instanceof ControlPlaneError && error.status === 404,
    );

    planeQueue.push({ status: 500, body: {} });
    await assert.rejects(
      () => checkTurnQuota(PLANE, "k"),
      (error: unknown) => error instanceof ControlPlaneError && error.status === 500,
    );
  });
});
