import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * The tenancy gate over the wire: the half the unit tests cannot see.
 *
 * The unit tests prove the decision; this proves the *wiring* — that the key a
 * decision resolves is the key the model call actually carries, that a refusal
 * happens before the gateway is reached at all, and that the accounting and the
 * audit row are written for the account that asked. A gate that decides correctly
 * and then spends the shared key anyway is exactly the bug worth a test.
 *
 * It lives in its own file because configuring a control plane changes the
 * posture of every route, and the surrounding suite deliberately runs in the
 * single-operator shape.
 */

interface PlaneCall {
  path: string;
  method: string;
  authorization: string | undefined;
  internalToken: string | undefined;
  body: any;
}

const planeCalls: PlaneCall[] = [];
const planeQueue: { status?: number; body?: unknown }[] = [];

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

/** Every key the gateway was actually handed, in order. */
const gatewayKeys: string[] = [];
const gatewayModels: string[] = [];

const gateway = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if ((req.url ?? "").startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake/model" }] }));
      return;
    }
    gatewayKeys.push(String(req.headers.authorization ?? ""));
    let parsed: { model?: string } = {};
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof parsed;
    } catch {
      // A body-less probe still counts as a call; the model is then unknown.
    }
    gatewayModels.push(String(parsed.model ?? ""));

    // A short, well-formed stream that reports usage, so the ledger path has
    // something real to record rather than a placeholder.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: null }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const planeUrl = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
const gatewayPort = (gateway.address() as AddressInfo).port;

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-tenancy-"));
const factoryDir = path.join(workspace, "build-requests");

// Set before the config module is first imported, which is what makes this file
// the control-plane deployment and the rest of the suite the single-operator one.
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.AGENT_OFFLINE_URL = "";
process.env.AGENT_HEALTH_INTERVAL_MS = "0";
process.env.AGENT_FACTORY_DIR = factoryDir;
process.env.OMNIROUTE_URL = `http://127.0.0.1:${gatewayPort}/v1`;
// The one gateway key this deployment holds: it must be *unused* by a turn once a
// control plane is configured, which is the whole posture being tested.
process.env.OMNIROUTE_API_KEY = "sk-shared-not-a-real-key";
process.env.WEB_TOKEN = "shared-bearer";
process.env.CONTROL_PLANE_INTERNAL_URL = planeUrl;
process.env.CONTROL_INTERNAL_TOKEN = "plane-token";
// Sign-in is what tenancy keys on, so it has to be on. The cookie below is minted
// directly: this file tests the gate, not the authorization-code round trip, which
// `oidc.test.ts` covers against a real fake provider.
process.env.ONTRAK_OIDC_ISSUER = "https://idp.invalid";
process.env.ONTRAK_OIDC_CLIENT_ID = "ontrak-genie";
process.env.ONTRAK_OIDC_SESSION_SECRET = "test-session-secret-value";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");
const { SESSION_COOKIE, mintSession } = await import("../oidc.js");
// The caller is cached per subject, deliberately. A test that scripts the identity
// answer has to forget the previous one, or its reply is served from the cache and
// the next queued answer is consumed by the wrong call.
const { resetCallerCache } = await import("../tenancy.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const cookie = `${SESSION_COOKIE}=${encodeURIComponent(
  mintSession({ sub: "sub-1", email: "dev@innotel.us", name: "Dev" }),
)}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => plane.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
});

/* ------------------------------------------------------------------ helpers */

function identityReply(gatewayKey: string): { status?: number; body?: unknown } {
  return {
    status: 200,
    body: {
      user: { id: "u-1", email: "dev@innotel.us" },
      oidcSub: "sub-1",
      gatewayKey,
      created: false,
    },
  };
}

async function post(pathname: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Read an SSE body to the end, so the server's own `finally` block has run. */
async function drain(response: Response): Promise<Array<Record<string, any>>> {
  const events: Array<Record<string, any>> = [];
  const reader = response.body?.getReader();
  if (reader === undefined) return events;
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    let split = pending.indexOf("\n\n");
    while (split !== -1) {
      const frame = pending.slice(0, split);
      pending = pending.slice(split + 2);
      split = pending.indexOf("\n\n");
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        try {
          events.push(JSON.parse(data) as Record<string, any>);
        } catch {
          // A malformed frame is not this test's subject.
        }
      }
    }
  }
  return events;
}

/**
 * Wait for a background write to land. The ledger and the audit are recorded
 * *after* the response, deliberately, so a test has to wait for them rather than
 * assume they happened by the time the stream closed.
 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* --------------------------------------------------------------------- tests */

test("a turn is attributed to the account that asked for it", async () => {
  planeQueue.length = 0;
  planeCalls.length = 0;
  resetCallerCache();
  planeQueue.push(identityReply("sk-tenant-1"), { status: 200, body: { allowed: true } });

  const response = await post("/api/chat", { message: "hello" }, { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await drain(response);
  assert.equal(events.at(-1)?.type, "done");

  // The key the model call carried. Not the shared one, and not absent.
  assert.equal(gatewayKeys.at(-1), "Bearer sk-tenant-1");
  assert.notEqual(gatewayKeys.at(-1), "Bearer sk-shared-not-a-real-key");

  // And the model the console asked for survived the gate.
  assert.equal(gatewayModels.at(-1), "fake/model");

  await waitFor(
    () => planeCalls.some((call) => call.path === "/api/internal/usage-report"),
    "the usage report",
  );
  const report = planeCalls.find((call) => call.path === "/api/internal/usage-report");
  assert.equal(report?.authorization, "Bearer sk-tenant-1");
  assert.equal(report?.body.tokensIn, 11);
  assert.equal(report?.body.tokensOut, 3);
  assert.equal(report?.body.requests, 1);
});

test("the shared bearer alone cannot start a turn once a control plane is configured", async () => {
  planeCalls.length = 0;
  const before = gatewayKeys.length;

  // Authorized as a request — the bearer is valid — but with no subject to spend
  // the model pool on. This is the strict-key posture, stated as a test.
  const response = await post("/api/chat", { message: "hello" }, { authorization: "Bearer shared-bearer" });
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /which account/);

  assert.equal(gatewayKeys.length, before, "the gateway must not have been called");
  assert.equal(planeCalls.length, 0, "nothing should have been provisioned");
});

test("an exhausted account is refused before the gateway is reached", async () => {
  planeQueue.length = 0;
  planeCalls.length = 0;
  resetCallerCache();
  planeQueue.push(identityReply("sk-tenant-1"), {
    status: 200,
    body: { allowed: false, reasons: ["daily token cap reached"] },
  });
  const before = gatewayKeys.length;

  const response = await post("/api/chat", { message: "hello" }, { cookie });
  assert.equal(response.status, 429);
  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /daily token cap reached/);

  assert.equal(gatewayKeys.length, before, "an exhausted account must not reach the model pool");
});

test("an export is attributed and audited", async () => {
  planeCalls.length = 0;
  await fs.writeFile(path.join(workspace, "index.html"), "<h1>hello</h1>\n", "utf8");

  const response = await post("/api/factory/spec", { name: "Todo List", kind: "app" }, { cookie });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { written?: boolean; filename?: string };
  assert.equal(body.written, true);

  await waitFor(() => planeCalls.some((call) => call.path === "/api/internal/audit"), "the audit row");
  const audit = planeCalls.find((call) => call.path === "/api/internal/audit");
  assert.equal(audit?.internalToken, "plane-token");
  assert.equal(audit?.body.action, "build.export");
  assert.equal(audit?.body.sub, "sub-1");
  assert.equal(audit?.body.actorEmail, "dev@innotel.us");
  assert.equal(audit?.body.targetId, body.filename);
});
