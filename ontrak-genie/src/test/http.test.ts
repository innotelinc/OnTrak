import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * Tests for the HTTP surface: auth, sessions, the workspace endpoints, the
 * approval endpoint, and the SSE chat stream end to end.
 *
 * Nothing here needs a model. A stand-in gateway is started first and answers
 * `/v1/chat/completions` from a scripted queue, which means the whole path -
 * request framing, tool execution, diffs, approval parking, SSE encoding - runs
 * for real.
 *
 * The server itself is built by `createServer()` rather than started, so it binds
 * an ephemeral port and never collides with a running instance.
 */

interface Reply {
  content?: string;
  toolCall?: { name: string; args: unknown };
  /**
   * A tool call whose arguments arrive in fragments, the way a real stream
   * delivers one. `args` holds the JSON text split into pieces.
   */
  toolCallChunks?: { name: string; args: string[] };
  /**
   * Plain content split across frames, the way a real stream delivers prose.
   * This is how a small model prints a tool call instead of using the channel.
   */
  contentChunks?: string[];
  /** Answer with an HTTP error instead of a stream. */
  failStatus?: number;
  /** Answer 200 with an empty message, like a throttled provider. */
  empty?: boolean;
  /** Hold the answer back this long, to make overlapping requests testable. */
  delayMs?: number;
}

const queue: Reply[] = [];
let lastRequest: { messages?: unknown[]; tools?: unknown[]; model?: string; stream?: boolean } | null =
  null;

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const gateway = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    if (url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake/model" }] }));
      return;
    }
    if (!url.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    lastRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof lastRequest;
    const reply = queue.shift() ?? { content: "no scripted reply left" };

    const respond = (): void => {
      // Non-streaming callers - the chain health check, the sweep, and
      // AGENT_STREAM=false - want one JSON body rather than SSE frames.
      if (lastRequest?.stream === false) {
        if (reply.failStatus !== undefined) {
          res.writeHead(reply.failStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "scripted failure" } }));
          return;
        }
        const message: Record<string, unknown> = {
          role: "assistant",
          content: reply.empty === true ? "" : (reply.content ?? ""),
        };
        if (reply.toolCall) {
          message.tool_calls = [
            {
              id: "call_scripted",
              type: "function",
              function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
            },
          ];
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "fake/model",
            choices: [{ message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }],
          }),
        );
        return;
      }

      if (reply.failStatus !== undefined) {
        res.writeHead(reply.failStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      if (reply.empty === true) {
        sse(res, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        return;
      }
      if (reply.contentChunks) {
        sse(res, [
          ...reply.contentChunks.map((text) => ({
            choices: [{ delta: { content: text }, finish_reason: null }],
          })),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
        return;
      }
      if (reply.toolCallChunks) {
        const { name, args } = reply.toolCallChunks;
        sse(res, [
          ...args.map((text, index) => ({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      // Real streams name the function and give it an id in the
                      // first frame, then send nothing but argument fragments.
                      ...(index === 0 ? { id: "call_scripted", type: "function" } : {}),
                      function: { ...(index === 0 ? { name } : {}), arguments: text },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })),
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
        return;
      }
      if (reply.toolCall) {
        sse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_scripted",
                      type: "function",
                      function: {
                        name: reply.toolCall.name,
                        arguments: JSON.stringify(reply.toolCall.args),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
        return;
      }
      sse(res, [
        { choices: [{ delta: { content: reply.content ?? "" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    };

    // A scripted delay is what makes overlapping requests testable: a sweep of a
    // one-model catalog otherwise finishes before the next request even arrives.
    if (reply.delayMs !== undefined && reply.delayMs > 0) setTimeout(respond, reply.delayMs);
    else respond();
  });
});

/**
 * A second, separate gateway standing in for the local model server. It exists to
 * prove that a turn whose primary models all fail can still finish, on a machine
 * that needs no network at all.
 */
const offlineQueue: Reply[] = [];
let offlineRequest: { model?: string; messages?: unknown[] } | null = null;

const offlineGateway = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if (!(req.url ?? "").startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    offlineRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof offlineRequest;
    // Fail by default: a test that reaches the offline gateway without scripting
    // a reply for it should fail loudly rather than quietly succeed.
    const reply = offlineQueue.shift() ?? { failStatus: 503 };

    if (reply.failStatus !== undefined) {
      res.writeHead(reply.failStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "scripted offline failure" } }));
      return;
    }
    if (reply.empty === true) {
      sse(res, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
      return;
    }
    sse(res, [
      { choices: [{ delta: { content: reply.content ?? "" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  });
});

// The gateway has to be listening before the config is first read.
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-http-"));
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = (gateway.address() as AddressInfo).port;
await new Promise<void>((resolve) => offlineGateway.listen(0, "127.0.0.1", resolve));
const offlinePort = (offlineGateway.address() as AddressInfo).port;

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "risky";
// Short, so a prompt nobody answers fails fast instead of stalling the suite.
process.env.AGENT_APPROVAL_TIMEOUT_MS = "3000";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.AGENT_MODEL = "fake/model";
// One retry, and no waiting: the cooldown path is real and worth exercising, but
// the default 20 s backoff would make this file take minutes.
process.env.AGENT_RETRY_ATTEMPTS = "1";
process.env.AGENT_RETRY_DELAY_MS = "0";
process.env.OMNIROUTE_URL = `http://127.0.0.1:${gatewayPort}/v1`;
process.env.AGENT_OFFLINE_URL = `http://127.0.0.1:${offlinePort}/v1`;
process.env.AGENT_OFFLINE_MODELS = "local/fake";
process.env.WEB_TOKEN = "test-token";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");
const { modelHealth, refreshModelHealth } = await import("../modelHealth.js");
const { sweepState, loadSweep, sweepStale, SWEEP_STALE_MS } = await import("../sweep.js");
const { readSnapshot, saveSnapshot } = await import("../snapshots.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const TOKEN = "test-token";

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await new Promise<void>((resolve) => offlineGateway.close(() => resolve()));
});

/* ------------------------------------------------------------------ helpers */

interface ApiResult {
  status: number;
  body: any;
}

async function api(pathname: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Run a turn to completion, answering an approval prompt if one appears. */
async function chat(
  payload: Record<string, unknown>,
  answer?: "approve" | "deny",
): Promise<Array<Record<string, any>>> {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, any>> = [];
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

        let event: Record<string, any>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        events.push(event);

        if (event.type === "approval_request" && answer !== undefined) {
          // The turn is parked on this, so it has to be answered from here.
          const settled = await api(`/api/approvals/${event.id}`, {
            method: "POST",
            body: JSON.stringify({ decision: answer }),
          });
          assert.equal(settled.status, 200, "the approval should have been accepted");
        }
      }
    }
  }
  return events;
}

/**
 * Read the recorder variables through a function: narrowing does not follow a
 * mutable module-level `let` into another function body, so the declared union
 * survives and the assertions below stay type-safe.
 */
const recorded = () => ({ primary: lastRequest, offline: offlineRequest });

const types = (events: Array<Record<string, any>>): string[] => events.map((event) => String(event.type));
const first = (events: Array<Record<string, any>>, type: string): Record<string, any> | undefined =>
  events.find((event) => event.type === type);

/* --------------------------------------------------------------------- auth */

test("authentication", async (t) => {
  await t.test("the API is closed without the token", async () => {
    for (const pathname of ["/api/health", "/api/sessions", "/api/files", "/api/models"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 401, `${pathname} should be protected`);
    }
  });

  await t.test("the token is accepted as a header or as ?token=", async () => {
    const header = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(header.status, 200);

    const query = await fetch(`${base}/api/health?token=${TOKEN}`);
    assert.equal(query.status, 200);
  });

  await t.test("a wrong token is rejected", async () => {
    const response = await fetch(`${base}/api/health`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(response.status, 401);
  });

  await t.test("the static shell stays public so the token prompt can render", async () => {
    for (const pathname of ["/", "/app.js", "/style.css"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 200, `${pathname} should be served`);
    }
  });
});

/* ---------------------------------------------------------- offline fallback */

test("offline fallback", async (t) => {
  await t.test("a failing primary gateway hands the turn to the offline one", async () => {
    lastRequest = null;
    offlineRequest = null;
    queue.length = 0;
    offlineQueue.length = 0;

    queue.push({ failStatus: 503 });
    offlineQueue.push({ content: "answered without a network" });

    const events = await chat({ message: "are you there?" });
    const seen = recorded();

    assert.equal(events.at(-1)?.type, "done", "the turn should finish rather than error");
    assert.equal(first(events, "error"), undefined);
    // The primary gateway was tried first, then the offline one.
    assert.equal(seen.primary?.model, "fake/model");
    assert.equal(seen.offline?.model, "local/fake");
    // The offline model's reply is the answer the user sees.
    assert.equal(
      events.filter((event) => event.type === "text").map((event) => event.text).join(""),
      "answered without a network",
    );
    // And it was announced, rather than silently swapped in.
    assert.match(
      String(first(events, "notice")?.text ?? ""),
      /retrying with local\/fake on the offline gateway/,
    );
    // Separate from the notice, which scrolls away: the UI keeps a badge up for
    // as long as the local model is the one answering.
    assert.equal(first(events, "gateway")?.mode, "offline");
    assert.equal(first(events, "gateway")?.model, "local/fake");
    assert.equal(first(events, "gateway")?.url, `http://127.0.0.1:${offlinePort}/v1`);
  });

  await t.test("the primary gateway is still used when it works", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    offlineRequest = null;

    queue.push({ content: "answered normally" });
    const events = await chat({ message: "hello" });

    assert.equal(first(events, "notice"), undefined, "no fallback should have been needed");
    assert.equal(recorded().offline, null, "the offline gateway should not have been called");
    // Every turn states its gateway, so the UI never shows last turn's badge.
    assert.equal(first(events, "gateway")?.mode, "primary");
    assert.equal(first(events, "gateway")?.url, undefined);
  });
});

/* ---------------------------------------------------- per-chat model chain */

test("per-chat model chain", async (t) => {
  /** A fresh session, so the subtests cannot inherit each other's settings. */
  async function newSession(): Promise<string> {
    const created = await api("/api/sessions", { method: "POST" });
    assert.equal(created.status, 201);
    return created.body.session.id;
  }

  await t.test("a chain saved on the chat is used by the next turn", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    const patched = await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ fallbackModels: "fake/alt, fake/other" }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.session.fallbackModels, ["fake/alt", "fake/other"]);

    queue.push({ content: "answered" });
    const events = await chat({ message: "hi", sessionId: id });
    // The offline gateway is appended to whatever chain is in force, so it is
    // always the last thing tried no matter what a chat configures.
    assert.deepEqual(first(events, "session")?.models, [
      "fake/model",
      "fake/alt",
      "fake/other",
      "local/fake",
    ]);
  });

  await t.test("a chain sent with the turn beats the saved one", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();
    await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ fallbackModels: ["fake/saved"] }),
    });

    queue.push({ content: "answered" });
    const events = await chat({ message: "hi", sessionId: id, fallbackModels: ["fake/turn"] });
    assert.deepEqual(first(events, "session")?.models, ["fake/model", "fake/turn", "local/fake"]);
  });

  await t.test("an empty chain means nothing else is tried, even the server default", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    queue.push({ content: "answered" });
    const events = await chat({ message: "hi", sessionId: id, fallbackModels: [] });
    assert.deepEqual(first(events, "session")?.models, ["fake/model", "local/fake"]);
  });

  await t.test("the chat's own chain is remembered across turns", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    queue.push({ content: "one" });
    await chat({ message: "hi", sessionId: id, fallbackModels: ["fake/kept"] });
    queue.push({ content: "two" });
    const events = await chat({ message: "again", sessionId: id });
    assert.deepEqual(first(events, "session")?.models, ["fake/model", "fake/kept", "local/fake"]);
  });

  await t.test("a chat can opt out of the offline gateway, and back in", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    const off = await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ useOffline: false }),
    });
    assert.equal(off.body.session.useOffline, false);

    queue.push({ content: "answered" });
    const without = await chat({ message: "hi", sessionId: id });
    assert.deepEqual(first(without, "session")?.models, ["fake/model"]);

    const on = await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ useOffline: true }),
    });
    assert.equal(on.body.session.useOffline, true);

    queue.push({ content: "answered" });
    const with_ = await chat({ message: "again", sessionId: id });
    assert.deepEqual(first(with_, "session")?.models, ["fake/model", "local/fake"]);
  });

  await t.test("the turn's own opt-out beats the saved setting", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    queue.push({ content: "answered" });
    const events = await chat({ message: "hi", sessionId: id, useOffline: false });
    assert.deepEqual(first(events, "session")?.models, ["fake/model"]);
  });

  await t.test("opting out means a dead main gateway is a real failure", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    const id = await newSession();

    // Nothing is scripted for either gateway: every entry fails, and the turn is
    // allowed to say so rather than quietly answering from the 7B model.
    queue.push({ failStatus: 503 }, { failStatus: 503 });
    const events = await chat({ message: "hi", sessionId: id, useOffline: false, fallbackModels: [] });

    assert.ok(first(events, "error"), "an error is expected when there is nowhere left to go");
    assert.equal(recorded().offline, null, "the offline gateway must not be called");
  });
});

/* ------------------------------------------------------- chain health check */

test("chain health check", async (t) => {
  await t.test("importing the server probes nothing on its own", () => {
    // The timer belongs to the entrypoint. If importing spent a request, a test
    // suite would eat the gateway it just stood up.
    assert.equal(modelHealth().checkedAt, null);
  });

  await t.test("reports which entries can make a tool call", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ toolCall: { name: "read_file", args: { path: "README.md" } } });
    offlineQueue.push({ failStatus: 503 });

    const report = await refreshModelHealth();

    assert.equal(report.total, 2);
    assert.equal(report.working, 1);
    assert.ok(report.checkedAt);

    assert.equal(report.entries[0]?.model, "fake/model");
    assert.equal(report.entries[0]?.ok, true);
    assert.equal(report.entries[0]?.offline, false);
    assert.equal(report.entries[1]?.model, "local/fake");
    assert.equal(report.entries[1]?.ok, false);
    assert.equal(report.entries[1]?.offline, true);

    // And the endpoint carries the same report, so the UI can render it.
    const { body } = await api("/api/health");
    assert.equal(body.modelHealth.working, 1);
    assert.equal(body.modelHealth.total, 2);
    assert.equal(body.modelHealth.entries[1]?.offline, true);
  });

  await t.test("answering without calling a tool is not ready", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ content: "I would rather describe the file than read it." });
    offlineQueue.push({ failStatus: 503 });

    const report = await refreshModelHealth();
    assert.equal(report.entries[0]?.ok, false);
    assert.match(String(report.entries[0]?.error), /without calling the tool/);
  });

  await t.test("a tool call written as text counts, because the agent salvages it", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    // Exactly what Ollama returns: no structured channel, the call printed as
    // JSON in the content. Reporting this as broken would be a false alarm.
    queue.push({ content: '{"name": "read_file", "arguments": {"path": "README.md"}}' });
    offlineQueue.push({ failStatus: 503 });

    const report = await refreshModelHealth();
    assert.equal(report.entries[0]?.ok, true);
    assert.equal(report.entries[0]?.error, null);
  });

  await t.test("a turn warns when the last check found nothing usable", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ failStatus: 503 });
    offlineQueue.push({ failStatus: 503 });
    const report = await refreshModelHealth();
    assert.equal(report.working, 0, "this test needs a report where nothing works");

    // The warning is about the check, so the turn itself is allowed to succeed.
    queue.push({ content: "answered anyway" });
    const events = await chat({ message: "hi" });
    assert.match(
      String(first(events, "notice")?.text ?? ""),
      /last model check could not get a tool call out of anything/,
    );
  });

  await t.test("no warning when the check found something that works", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ toolCall: { name: "read_file", args: { path: "README.md" } } });
    offlineQueue.push({ failStatus: 503 });
    const report = await refreshModelHealth();
    assert.equal(report.working, 1);

    queue.push({ content: "answered" });
    const events = await chat({ message: "hi" });
    assert.equal(
      events.filter((event) => event.type === "notice").length,
      0,
      "a working chain should not be warned about",
    );
  });
});

/* ------------------------------------------------------------ catalog sweep */

test("catalog sweep", async (t) => {
  /** The endpoint deliberately does not await the sweep, so poll it like the UI. */
  async function waitForSweep(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (sweepState().running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return (await api("/api/models/sweep")).body.sweep;
  }

  await t.test("a sweep reports which advertised models can be used", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ toolCall: { name: "read_file", args: { path: "README.md" } } });

    const started = await api("/api/models/sweep", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.sweep.running, true);

    const sweep = await waitForSweep();
    assert.equal(sweep.running, false);
    assert.ok(sweep.finishedAt, "a finished sweep records when it finished");
    assert.equal(sweep.total, 1, "the fake gateway advertises exactly one model");
    assert.equal(sweep.done, 1);
    assert.equal(sweep.results[0]?.model, "fake/model");
    assert.equal(sweep.results[0]?.ok, true);
    assert.equal(sweep.results[0]?.verdict, "works");
  });

  const sweepFile = path.join(workspace, ".agent", "sweep.json");

  await t.test("the last report survives a restart", async () => {
    queue.length = 0;
    queue.push({ toolCall: { name: "read_file", args: { path: "README.md" } } });

    await api("/api/models/sweep", { method: "POST", body: JSON.stringify({ all: true }) });
    const before = await waitForSweep();

    // A restart loses every module-level value; re-reading the file is what the
    // next process does at load, so this is the real thing rather than a mock.
    const after = loadSweep();
    assert.equal(after.running, false);
    assert.equal(after.scope, before.scope);
    assert.equal(after.finishedAt, before.finishedAt);
    assert.deepEqual(after.results, before.results);
    assert.equal(after.total, 1);

    // And the served endpoint agrees, since the UI reads it rather than the file.
    assert.deepEqual((await api("/api/models/sweep")).body.sweep.results, before.results);
  });

  await t.test("an unreadable report is ignored rather than fatal", async () => {
    await fs.writeFile(sweepFile, "{ this is not json", "utf8");
    const state = loadSweep();
    assert.equal(state.results.length, 0);
    assert.equal(state.running, false);

    // Leave a real report behind: a later test should not start from a corrupt one.
    queue.length = 0;
    queue.push({ content: "answered" });
    await api("/api/models/sweep", { method: "POST", body: JSON.stringify({ all: true }) });
    await waitForSweep();
  });

  await t.test("an old report is flagged as stale, a current one is not", async () => {
    const { body } = await api("/api/models/sweep");
    assert.equal(body.sweep.stale, false, "a report from a moment ago is current");

    // Time does not pass during a test, so ask the clock directly - the same
    // function the endpoint uses to decide.
    assert.equal(sweepStale(Date.now() + SWEEP_STALE_MS + 1_000), true);
    assert.equal(sweepStale(Date.now() + SWEEP_STALE_MS - 60_000), false);
  });

  await t.test("a throttled model is reported as throttled, not broken", async () => {
    queue.length = 0;
    queue.push({ failStatus: 429 });

    await api("/api/models/sweep", { method: "POST", body: JSON.stringify({ all: true }) });
    const sweep = await waitForSweep();

    // The distinction matters: one of these is worth retrying later, the other is
    // a provider the user needs to fix.
    assert.equal(sweep.results[0]?.verdict, "throttled");
    assert.equal(sweep.results[0]?.ok, false);

    // A throttled verdict is still a result worth keeping across a restart.
    const restored = loadSweep();
    assert.equal(restored.results[0]?.verdict, "throttled");
  });

  await t.test("a second sweep is refused while one is running", async () => {
    queue.length = 0;
    // Hold the probe open, so the second request definitely lands mid-sweep.
    queue.push({ toolCall: { name: "read_file", args: { path: "README.md" } }, delayMs: 300 });

    const first = await api("/api/models/sweep", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    assert.equal(first.status, 202);

    const second = await api("/api/models/sweep", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.sweep.running, true);

    const sweep = await waitForSweep();
    assert.equal(sweep.running, false);
    assert.equal(sweep.done, 1, "the refused request must not have started a second sweep");
  });
});

/* ------------------------------------------------------------------- health */

test("health", async (t) => {
  await t.test("reports the gateway, sandbox, approval mode and limits", async () => {
    const { status, body } = await api("/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.model, "fake/model");
    assert.equal(body.workspace, workspace);
    assert.equal(body.sandbox.backend, "host");
    assert.equal(body.approval.mode, "risky");
    assert.deepEqual(body.limits, { minSteps: 1, maxSteps: 200, defaultSteps: 30 });
    assert.equal(body.authRequired, true);
    assert.equal(body.offline.url, `http://127.0.0.1:${offlinePort}/v1`);
    assert.deepEqual(body.offline.models, ["local/fake"]);
    // The chain a chat starts with when it has not saved one of its own.
    assert.deepEqual(body.fallbackModels, []);
  });

  await t.test("lists the models the gateway advertises", async () => {
    const { body } = await api("/api/models");
    assert.deepEqual(body.models, ["fake/model"]);
  });
});

/* ----------------------------------------------------------------- sessions */

test("sessions", async (t) => {
  await t.test("create, read, rename and delete", async () => {
    const created = await api("/api/sessions", { method: "POST" });
    assert.equal(created.status, 201);
    const id: string = created.body.session.id;

    const patched = await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ model: "fake/other", maxSteps: 12 }),
    });
    assert.equal(patched.status, 200);

    const read = await api(`/api/sessions/${id}`);
    assert.equal(read.body.session.model, "fake/other");
    assert.equal(read.body.session.maxSteps, 12);

    const listed = await api("/api/sessions");
    assert.ok(listed.body.sessions.some((session: any) => session.id === id));

    const removed = await api(`/api/sessions/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await api(`/api/sessions/${id}`)).status, 404);
  });

  await t.test("a step budget is clamped to the allowed range", async () => {
    const created = await api("/api/sessions", { method: "POST" });
    const id: string = created.body.session.id;

    await api(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ maxSteps: 9999 }) });
    assert.equal((await api(`/api/sessions/${id}`)).body.session.maxSteps, 200);

    await api(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ maxSteps: -5 }) });
    assert.equal((await api(`/api/sessions/${id}`)).body.session.maxSteps, 1);
  });

  await t.test("an unknown or malformed id is refused", async () => {
    assert.equal((await api("/api/sessions/00000000-0000-0000-0000-000000000000")).status, 404);
    assert.equal((await api("/api/sessions/not-an-id")).status, 404);
  });
});

/* ----------------------------------------------------------------- approvals */

test("approvals endpoint", async (t) => {
  const { requestApproval, pendingApprovals, resolveApproval } = await import("../approval.js");

  await t.test("answering a parked turn releases it", async () => {
    const id = "http-approval-1";
    const waiting = requestApproval(id, undefined, 10_000);
    assert.equal(pendingApprovals(), 1);

    const answered = await api(`/api/approvals/${id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.resolved, true);
    assert.equal(await waiting, "approve");
  });

  await t.test("a decision of the wrong shape is a bad request", async () => {
    const waiting = requestApproval("http-approval-2", undefined, 10_000);
    const answered = await api("/api/approvals/http-approval-2", {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    });
    assert.equal(answered.status, 400);
    // Still parked, so it has to be released by hand.
    resolveApproval("http-approval-2", "deny");
    assert.equal(await waiting, "deny");
  });

  await t.test("an id nobody is waiting on is a 404", async () => {
    const answered = await api("/api/approvals/http-approval-missing", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(answered.status, 404);
    assert.equal(answered.body.resolved, false);
  });
});

/* -------------------------------------------------------------- workspace io */

test("workspace endpoints", async (t) => {
  await t.test("bad paths are rejected rather than resolving", async () => {
    for (const bad of ["../escape.txt", "/etc/passwd", "../../etc/shadow"]) {
      const response = await api(`/api/file?path=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 400, `${bad} should be refused`);
    }
  });

  await t.test("an unknown route is a 404", async () => {
    assert.equal((await api("/api/nope")).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  await t.test("a missing file reports not found, not a crash", async () => {
    const response = await api("/api/file?path=absent.txt");
    assert.equal(response.status, 500);
    assert.match(response.body.error, /ENOENT|no such file/i);
  });

  await t.test("a file the agent has not touched has no history", async () => {
    const response = await api("/api/file/diff?path=nothing.txt");
    assert.equal(response.status, 200);
    assert.equal(response.body.diff, null);
  });

  await t.test("a file can be deleted, and its history goes with it", async () => {
    await fs.writeFile(path.join(workspace, "doomed.txt"), "hello\n", "utf8");
    // A snapshot is what marks the file as changed in the tree, so give it one.
    await saveSnapshot("doomed.txt", "before\n");

    const marked = await api("/api/files?path=.");
    assert.equal(marked.body.entries.find((e: any) => e.name === "doomed.txt").changed, true);

    const removed = await api("/api/file?path=doomed.txt", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    assert.equal(removed.body.bytes, 6);

    await assert.rejects(fs.access(path.join(workspace, "doomed.txt")));
    assert.equal(await readSnapshot("doomed.txt"), null, "the snapshot should go with the file");

    const after = await api("/api/files?path=.");
    assert.equal(after.body.entries.some((e: any) => e.name === "doomed.txt"), false);
  });

  await t.test("deleting a path that is not there is a 404, not a crash", async () => {
    const response = await api("/api/file?path=absent-forever.txt", { method: "DELETE" });
    assert.equal(response.status, 404);
    assert.equal(response.body.removed, false);
  });

  await t.test("a directory, the root, and an escaping path are not deletable", async () => {
    await fs.mkdir(path.join(workspace, "subdir"), { recursive: true });

    const dir = await api("/api/file?path=subdir", { method: "DELETE" });
    assert.equal(dir.status, 400, "a directory must be refused rather than walked");
    assert.match(dir.body.error, /directory/i);

    const root = await api("/api/file?path=.", { method: "DELETE" });
    assert.equal(root.status, 400);

    for (const bad of ["", "../escape.txt", "/etc/passwd"]) {
      const response = await api(`/api/file?path=${encodeURIComponent(bad)}`, { method: "DELETE" });
      assert.equal(response.status, 400, `${bad} should be refused`);
    }

    // Nothing was taken by the refusals.
    assert.ok((await api("/api/files?path=.")).body.entries.some((e: any) => e.name === "subdir"));
  });

  await t.test("a draft is diffed against the file as it stands on disk", async () => {
    await fs.writeFile(path.join(workspace, "drafted.py"), "one\ntwo\n", "utf8");

    const response = await api("/api/file/diff", {
      method: "POST",
      body: JSON.stringify({ path: "drafted.py", content: "one\nTWO\nthree\n" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.diff.created, false, "the file already exists");
    assert.equal(response.body.diff.added, 2);
    assert.equal(response.body.diff.removed, 1);

    const lines = response.body.diff.hunks.flatMap((hunk: any) => hunk.lines);
    assert.ok(lines.some((line: any) => line.type === "del" && line.text === "two"));
    assert.ok(lines.some((line: any) => line.type === "add" && line.text === "TWO"));
  });

  await t.test("a draft for a file that does not exist yet reads as a new file", async () => {
    const response = await api("/api/file/diff", {
      method: "POST",
      body: JSON.stringify({ path: "brand-new.txt", content: "first\nsecond\n" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.diff.created, true);
    assert.equal(response.body.diff.added, 2);
    assert.equal(response.body.diff.removed, 0);
  });

  await t.test("a draft cannot name a path outside the workspace", async () => {
    for (const bad of ["../escape.txt", "/etc/passwd"]) {
      const response = await api("/api/file/diff", {
        method: "POST",
        body: JSON.stringify({ path: bad, content: "x" }),
      });
      assert.equal(response.status, 400, `${bad} should be refused`);
    }
  });
});

/* ------------------------------------------------------------------ the turn */

test("chat stream", async (t) => {
  await t.test("a file is previewed while it is still being generated", async () => {
    queue.length = 0;
    queue.push(
      {
        toolCallChunks: {
          name: "write_file",
          args: ['{"path":"draft.md","content":"# He', 'llo\\n\\nWorld\\n"}'],
        },
      },
      { content: "Wrote it." },
    );

    const events = await chat({ message: "write draft.md" });
    const drafts = events.filter((event) => event.type === "draft");
    assert.ok(drafts.length >= 2, `expected drafts, got ${types(events).join(", ")}`);

    // The first fragment is a real preview: the path is known and the body is not
    // finished, which is the whole point of the event.
    const opening = drafts[0]!;
    assert.equal(opening.name, "write_file");
    assert.equal(opening.path, "draft.md");
    assert.equal(opening.content, "# He");
    assert.equal(opening.started, true);
    assert.equal(opening.complete, false);
    assert.equal(opening.reset, true, "the first draft of an attempt resets the pane");

    const last = drafts.at(-1)!;
    assert.equal(last.content, "# Hello\n\nWorld\n");
    assert.equal(last.complete, true);
    assert.equal(last.reset, false, "only the first draft of an attempt resets");

    // The drafts are a preview of the call that lands, not a second version of it.
    const call = first(events, "tool_call");
    assert.equal(call?.args?.content, "# Hello\n\nWorld\n");
    assert.equal(await fs.readFile(path.join(workspace, "draft.md"), "utf8"), "# Hello\n\nWorld\n");
  });

  await t.test("a text-mode write is previewed while it is being printed", async () => {
    queue.length = 0;
    queue.push(
      {
        contentChunks: [
          '{"name": "write_file", "arguments": {"path": "text_mode.md", "content": "first line of the file\\n',
          'second line, long enough to pass the draft throttle\\n',
          'third line\\n"}}',
        ],
      },
      { content: "Wrote it." },
    );

    const events = await chat({ message: "write it in text mode" });
    const drafts = events.filter((event) => event.type === "draft");
    assert.ok(drafts.length >= 2, `expected several drafts, got ${types(events).join(", ")}`);

    // The file is named and partly written - the local model's whole reason for
    // the preview pane, since it never uses the structured channel.
    const opening = drafts[0]!;
    assert.equal(opening.name, "write_file");
    assert.equal(opening.path, "text_mode.md");
    assert.equal(opening.reset, true);
    assert.match(opening.content, /first line of the file/);
    assert.equal(opening.complete, false);

    const expected = "first line of the file\nsecond line, long enough to pass the draft throttle\nthird line\n";
    assert.equal(drafts.at(-1)?.content, expected);
    assert.equal(drafts.at(-1)?.complete, true);

    // And the text really was salvaged into a call that ran, as it always was.
    assert.equal(first(events, "tool_call")?.name, "write_file");
    assert.equal(first(events, "tool_call")?.args?.content, expected);
    assert.match(String(first(events, "tool_result")?.content), /text_mode\.md/);
  });

  await t.test("a turn that writes nothing sends no drafts", async () => {
    queue.length = 0;
    queue.push({ content: "No file needed." });

    const events = await chat({ message: "just answer" });
    assert.equal(
      events.filter((event) => event.type === "draft").length,
      0,
      "a plain answer must not open the preview pane",
    );
  });

  await t.test("a write is executed and its diff is sent, then stored", async () => {
    queue.length = 0;
    queue.push(
      { toolCall: { name: "write_file", args: { path: "notes.txt", content: "hello\nworld\n" } } },
      { content: "Wrote the file." },
    );

    const events = await chat({ message: "write notes.txt" });

    assert.equal(first(events, "session")?.models?.[0], "fake/model");
    const call = first(events, "tool_call");
    assert.equal(call?.name, "write_file");

    const result = first(events, "tool_result");
    assert.equal(result?.ok, true);
    assert.match(result?.content, /Created notes\.txt/);
    assert.equal(result?.diff?.added, 2);
    assert.equal(result?.diff?.created, true);

    assert.equal(first(events, "text")?.text, "Wrote the file.");
    assert.equal(types(events).at(-1), "done");

    // The tool schema really went out on the wire.
    assert.ok(Array.isArray(lastRequest?.tools) && lastRequest!.tools!.length > 0);

    // And the endpoints now agree that the agent has touched the file.
    const file = await api("/api/file?path=notes.txt");
    assert.equal(file.body.hasHistory, true);
    assert.match(file.body.content, /world/);

    // A created file's history is the empty pre-state, so its diff is all adds.
    const createdDiff = await api("/api/file/diff?path=notes.txt");
    assert.equal(createdDiff.body.diff.created, true);
    assert.equal(createdDiff.body.diff.added, 2);

    const listing = await api("/api/files?path=.");
    assert.equal(listing.body.entries.find((entry: any) => entry.name === "notes.txt")?.changed, true);
  });

  await t.test("the viewer's diff endpoint shows the change", async () => {
    queue.length = 0;
    queue.push(
      { toolCall: { name: "edit_file", args: { path: "notes.txt", oldString: "world", newString: "there" } } },
      { content: "Edited." },
    );

    await chat({ message: "edit notes.txt" });

    const { status, body } = await api("/api/file/diff?path=notes.txt");
    assert.equal(status, 200);
    assert.ok(body.savedAt, "a snapshot timestamp is reported");
    assert.equal(body.diff.added, 1);
    assert.equal(body.diff.removed, 1);

    const lines = body.diff.hunks.flatMap((hunk: any) => hunk.lines);
    assert.ok(lines.some((line: any) => line.type === "del" && line.text === "world"));
    assert.ok(lines.some((line: any) => line.type === "add" && line.text === "there"));
  });

  await t.test("an approved command runs", async () => {
    queue.length = 0;
    queue.push(
      { toolCall: { name: "run_command", args: { command: "echo http-approved" } } },
      { content: "Ran it." },
    );

    const events = await chat({ message: "run a command" }, "approve");

    const ask = first(events, "approval_request");
    assert.equal(ask?.name, "run_command");
    assert.match(ask?.summary ?? "", /echo http-approved/);

    assert.equal(first(events, "approval_result")?.decision, "approve");

    const result = first(events, "tool_result");
    assert.equal(result?.ok, true);
    assert.match(result?.content, /http-approved/);
    assert.match(result?.content, /ran in this host/);
  });

  await t.test("a denied command never runs", async () => {
    queue.length = 0;
    queue.push(
      { toolCall: { name: "run_command", args: { command: "echo http-denied" } } },
      { content: "Understood." },
    );

    const events = await chat({ message: "run a command" }, "deny");

    assert.equal(first(events, "approval_result")?.decision, "deny");
    // No tool_call event: the model's request was refused, not executed.
    assert.equal(first(events, "tool_call"), undefined);

    const result = first(events, "tool_result");
    assert.equal(result?.ok, false);
    assert.match(result?.content, /denied this action/i);
    assert.equal(types(events).includes("error"), false);
  });

  await t.test("a provider failure becomes an error event, not a blank reply", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ failStatus: 502 }, { failStatus: 502 });
    // The offline gateway is the last link in the chain, so it has to fail too
    // before the turn is allowed to give up.
    offlineQueue.push({ failStatus: 502 }, { failStatus: 502 });

    const events = await chat({ message: "hello" });
    const error = first(events, "error");
    assert.ok(error, "an error event is expected");
    assert.equal(types(events).at(-1), "done");
  });

  await t.test("an empty answer is reported as an error", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    queue.push({ empty: true }, { empty: true });
    offlineQueue.push({ empty: true }, { empty: true });

    const events = await chat({ message: "hello" });
    assert.match(first(events, "error")?.message ?? "", /empty response/i);
  });

  await t.test("a throttled turn waits, then walks the chain again", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    // First walk: everything throttled. Second walk: the primary answers.
    queue.push({ failStatus: 503 }, { content: "answered after the cooldown" });
    offlineQueue.push({ failStatus: 503 });

    const events = await chat({ message: "hi" });

    // The chain-fallback notice comes first; the retry notice follows it.
    const notices = events
      .filter((event) => event.type === "notice")
      .map((event) => String(event.text))
      .join("\n");
    assert.match(notices, /retrying in \d+s \(attempt 1 of 1\)/, "the wait should be announced, not silent");
    assert.equal(first(events, "error"), undefined, "the retry should have rescued the turn");
    assert.equal(types(events).at(-1), "done");
    assert.equal(
      events.filter((event) => event.type === "text").map((event) => event.text).join(""),
      "answered after the cooldown",
    );
  });

  await t.test("a hard failure is not retried, because waiting cannot fix it", async () => {
    queue.length = 0;
    offlineQueue.length = 0;
    // A 400 is a verdict about the request, not a cooldown: waiting is pointless.
    queue.push({ failStatus: 400 });
    offlineQueue.push({ failStatus: 400 });

    const events = await chat({ message: "hi" });
    assert.ok(first(events, "error"), "the turn should fail immediately");
    assert.equal(
      events.filter((event) => event.type === "notice").length,
      0,
      "nothing should claim to be waiting",
    );
  });

  await t.test("a turn with no message is a bad request", async () => {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(response.status, 400);
  });
});
