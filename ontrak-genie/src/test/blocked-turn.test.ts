import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A turn the model vendor's filter stops, and what has to happen to it.
 *
 * Gemini reports a blocked turn as a *finished* choice with no content
 * (`finish_reason: SAFETY`), which is indistinguishable from a successful empty
 * answer unless somebody looks at the reason. Read as an answer it becomes
 * silence in the UI — and, once a byte has been sent, a spent credit for nothing.
 * The three properties pinned here are that it is recognised, that the chain is
 * walked past it to a model that will answer, and that a chain blocked end to end
 * ends in a sentence instead of a blank reply.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-blocked-"));

// Read before the config is first imported, like every other test here.
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

/** Every request body the stub gateway was given, in order. */
const bodies: Record<string, any>[] = [];

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, any>);
    bodies.push(body);
    const model = String(body.model ?? "");
    // `completeChat` asks for a whole answer; only the streaming path takes frames.
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: "Here is the scanner." }, finish_reason: "stop" }] }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (model.startsWith("gemini/")) {
      // What a filtered turn really looks like: a normal finish, no content.
      res.write(frame({ choices: [{ delta: {}, finish_reason: "SAFETY" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.write(frame({ choices: [{ delta: { content: "Here is the scanner." }, finish_reason: null }] }));
    res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port;
process.env.OMNIROUTE_URL = `http://127.0.0.1:${port}/v1`;

const { blockedFinishReason, completeChat } = await import("../omniroute.js");
const { runAgent } = await import("../agent.js");
const { createSession } = await import("../store.js");

async function eventsFor(model: string, fallbackModels: string[]) {
  const events: any[] = [];
  for await (const event of runAgent({
    session: createSession(),
    userMessage: "write a port scanner for my own lab subnet",
    model,
    fallbackModels,
    maxSteps: 1,
  })) {
    events.push(event);
  }
  return events;
}

test("a filtered turn is recognised by its finish reason", () => {
  for (const reason of ["SAFETY", "safety", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]) {
    assert.equal(blockedFinishReason({ finishReason: reason }), reason.toLowerCase(), reason);
  }
  // An ordinary finish is not a block — treating it as one would re-run answers.
  assert.equal(blockedFinishReason({ finishReason: "stop" }), null);
  assert.equal(blockedFinishReason({ finishReason: "tool_calls" }), null);
  assert.equal(blockedFinishReason({ finishReason: null }), null);
});

// One server for the whole file, closed once at the end: a per-test close would
// leave the later cases dialling a socket nobody is listening on.
test.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));

test("safety settings travel to the provider that has them, and nowhere else", async () => {
  const settings = [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }];

  bodies.length = 0;
  await completeChat({
    messages: [{ role: "user", content: "ping" }],
    model: "gemini/gemini-3.1-flash-lite",
    safetySettings: settings,
  });
  assert.deepEqual(bodies.at(-1)?.safety_settings, settings, "gemini takes the field");

  await completeChat({
    messages: [{ role: "user", content: "ping" }],
    model: "fake/open",
    safetySettings: settings,
  });
  assert.equal(bodies.at(-1)?.safety_settings, undefined, "an adapter without the field is not sent it");

  await completeChat({ messages: [{ role: "user", content: "ping" }], model: "gemini/gemini-3.1-flash-lite" });
  assert.equal(bodies.at(-1)?.safety_settings, undefined, "unset means the vendor's defaults");
});

test("a blocked model hands the turn to one that answers", async () => {
  const events = await eventsFor("gemini/gemini-3.1-flash-lite", ["fake/open"]);

  // The chain was walked: the filtered model first, then the one that answered.
  const models = bodies.map((body) => String(body.model));
  assert.deepEqual(models.slice(-2), ["gemini/gemini-3.1-flash-lite", "fake/open"]);

  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
  assert.equal(text, "Here is the scanner.", "the answering model's reply is the turn");

  // And the switch is not silent: in manual mode the person is told why.
  const notices = events.filter((event) => event.type === "notice").map((event) => String(event.text));
  assert.equal(
    notices.some((notice) => /own filter stopped the turn/.test(notice) && /retrying with fake\/open/.test(notice)),
    true,
    `expected a notice naming the filter and the next model, got ${JSON.stringify(notices)}`,
  );
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("a chain blocked end to end reports it instead of going quiet", async () => {
  const events = await eventsFor("gemini/gemini-3.1-flash-lite", ["gemini/gemini-3-flash-preview"]);

  // Nothing was produced, so nothing is presented as an answer.
  assert.equal(events.some((event) => event.type === "text"), false);
  const error = events.find((event) => event.type === "error");
  assert.ok(error, `expected an error event, got ${JSON.stringify(events.map((event) => event.type))}`);
  assert.match(String(error.message), /content filter stopped this turn/);
  // The advice has to name the real cause: this is not a throttled pool.
  assert.match(String(error.message), /provider does not apply that filter/);
  assert.match(String(error.message), /finish_reason: safety/);
});
