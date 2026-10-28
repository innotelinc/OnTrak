import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A model the gateway does not serve, and what the chain must do with it.
 *
 * OmniRoute advertises every id its providers *claim*, so a chain can name a
 * model that is not in its catalogue at all. That answers 404 on every turn
 * until somebody fixes the list — a configuration fault, not a provider having a
 * bad minute. Read as permanent it ended the turn on the first entry while the
 * rest of the chain sat untried; read as a throttle it spent the turn's retries
 * waiting for a model that will never appear. The properties pinned here are
 * that it is recognised, that the next entry answers, and that the person is
 * told the name, because only they can fix the chain.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-unknown-model-"));

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_OFFLINE_URL = "";
process.env.AGENT_OFFLINE_MODELS = "";
process.env.AGENT_RETRY_ATTEMPTS = "1";
process.env.AGENT_RETRY_DELAY_MS = "0";
process.env.AGENT_STREAM = "true";
process.env.AGENT_HEALTH_INTERVAL_MS = "0";

/** The model id this gateway refuses to serve, as OmniRoute does for a bad id. */
const GHOST = "openrouter/ghost/does-not-exist:free";

/** Every model the stub gateway was asked for, in order. */
const asked: string[] = [];

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, any>);
    const model = String(body.model ?? "");
    asked.push(model);

    if (model === GHOST) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `model ${model} not found` } }));
      return;
    }
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: "Ready." }, finish_reason: "stop" }] }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ choices: [{ delta: { content: "Ready." }, finish_reason: null }] }));
    res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port;
process.env.OMNIROUTE_URL = `http://127.0.0.1:${port}/v1`;

const { GatewayError, completeChat, isRetryableFailure, isUnknownModelFailure } = await import(
  "../omniroute.js"
);
const { runAgent } = await import("../agent.js");
const { createSession } = await import("../store.js");

async function eventsFor(model: string, fallbackModels: string[]) {
  const events: any[] = [];
  for await (const event of runAgent({
    session: createSession(),
    userMessage: "say ready",
    model,
    fallbackModels,
    maxSteps: 1,
  })) {
    events.push(event);
  }
  return events;
}

test.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));

test("a refused model id is a wrong entry, not a throttle", () => {
  // The gateway is not consistent about how it refuses one: an id it does not
  // know came back 404 for one model, 400 for another, and an empty choice for a
  // third. Every one of them is the chain's problem, not the turn's.
  for (const status of [400, 404, 422]) {
    assert.equal(isUnknownModelFailure(new GatewayError("refused", status, "")), true, String(status));
  }
  // A busy provider is the opposite case: waiting is exactly what helps.
  assert.equal(isUnknownModelFailure(new GatewayError("busy", 429, "")), false);
  assert.equal(isUnknownModelFailure(new GatewayError("bad gateway", 502, "")), false);
  // The account, not the model: the person has to fix that one.
  assert.equal(isUnknownModelFailure(new GatewayError("unauthorized", 401, "")), false);
  assert.equal(isUnknownModelFailure(new Error("something else")), false);
  assert.equal(isRetryableFailure(new GatewayError("not found", 404, "")), false);
});

test("a model the gateway does not serve is skipped, not fatal", async () => {
  asked.length = 0;
  const events = await eventsFor(GHOST, ["fake/open"]);

  assert.deepEqual(asked.slice(-2), [GHOST, "fake/open"], "the chain walked past the ghost");

  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
  assert.equal(text, "Ready.", "the answering model's reply is the turn");
  assert.equal(events.some((event) => event.type === "error"), false);

  const notices = events.filter((event) => event.type === "notice").map((event) => String(event.text));
  assert.equal(
    notices.some((notice) => notice.includes(GHOST) && /not a model this gateway serves/.test(notice)),
    true,
    `expected a notice naming the missing model, got ${JSON.stringify(notices)}`,
  );
});

test("a chain of nothing but missing models ends in one clear sentence", async () => {
  asked.length = 0;
  const events = await eventsFor(GHOST, []);

  const error = events.find((event) => event.type === "error");
  assert.ok(error, `expected an error event, got ${JSON.stringify(events.map((e) => e.type))}`);
  assert.match(String(error.message), /404|not found/i);
  // Waited for nothing: a missing model is not a cooldown, so the retry path
  // must not run. One attempt, one failure.
  const waited = events.filter((event) => event.type === "notice" && /retrying in/.test(String(event.text)));
  assert.deepEqual(waited, [], "no backoff for a model that will never answer");
});
