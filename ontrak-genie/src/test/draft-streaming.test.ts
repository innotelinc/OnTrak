import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Whether the pane is really watching a file, or only reporting one.
 *
 * The preview exists because a write arrives as a tool call whose arguments
 * stream in: the file can be shown while it is still being written. That is a
 * property of the gateway and the provider, not of this code, and the LAN Gemini
 * path does *not* have it — it hands the whole call over in one frame, so the
 * pane hears about the file only once it is finished.
 *
 * Both are fine; implying the second is the first is not. So the agent has to
 * say which one happened, and these cases pin it from the gateway's side: one
 * frame means `streamed: false`, several mean `streamed: true`.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-draft-stream-"));

// Read before the config is first imported, like every other test here.
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.AGENT_OFFLINE_URL = "";
process.env.AGENT_OFFLINE_MODELS = "";
process.env.AGENT_RETRY_ATTEMPTS = "1";
process.env.AGENT_RETRY_DELAY_MS = "0";
process.env.AGENT_STREAM = "true";
process.env.AGENT_HEALTH_INTERVAL_MS = "0";

/** Which shape the next turn is answered with. */
let mode: "coalesced" | "streamed" = "coalesced";

const ARGS = '{"path":"note.txt","content":"hello"}';
/** The same call, split the way a provider that streams argument deltas sends it. */
const FRAGMENTS = ['{"path":"note.txt","content":"hel', 'lo"}'];

/** One `tool_calls` delta. The name rides the first frame only, as the real wire does. */
function toolFrame(fragment: string, first: boolean): string {
  const call: Record<string, unknown> = { index: 0, id: "call_1", function: { arguments: fragment } };
  if (first) (call.function as Record<string, unknown>).name = "write_file";
  const payload = { choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const fragments = mode === "coalesced" ? [ARGS] : FRAGMENTS;
  fragments.forEach((fragment, index) => res.write(toolFrame(fragment, index === 0)));
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port;
process.env.OMNIROUTE_URL = `http://127.0.0.1:${port}/v1`;

const { runAgent } = await import("../agent.js");
const { createSession } = await import("../store.js");

async function draftsFor(mode_: "coalesced" | "streamed") {
  mode = mode_;
  const events: any[] = [];
  for await (const event of runAgent({
    session: createSession(),
    userMessage: "write note.txt with the word hello",
    maxSteps: 1,
  })) {
    events.push(event);
  }
  return events.filter((event) => event.type === "draft");
}

test("a streamed tool call is told apart from one that arrives whole", async (t) => {
  // One server, closed once: both cases are answered by the same gateway so that
  // nothing but the frame shape differs between them.
  t.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));

  await t.test("a coalesced tool call is reported as not streamed", async () => {
    const drafts = await draftsFor("coalesced");

    // One frame carrying the whole call: the first the pane hears of the file is
    // its finished body, so there is no stream to show.
    assert.equal(drafts.length, 1, "the whole call arrives at once");
    assert.equal(drafts[0]!.complete, true, "and it is already complete");
    assert.equal(drafts[0]!.streamed, false, "so the pane must not claim to have watched it");
    assert.equal(drafts[0]!.path, "note.txt");
    assert.equal(drafts[0]!.content, "hello");
  });

  await t.test("a fragmented tool call is reported as streamed", async () => {
    const drafts = await draftsFor("streamed");

    assert.ok(drafts.length >= 2, `the body arrives in pieces (got ${drafts.length} draft(s))`);
    assert.equal(drafts[0]!.complete, false, "the first piece is unfinished, as it should be");
    assert.equal(drafts[0]!.streamed, true, "a file still arriving is a live preview");
    assert.equal(drafts.at(-1)!.complete, true);
    assert.equal(drafts.at(-1)!.streamed, true, "a file that was watched growing stays streamed");
    assert.equal(drafts.at(-1)!.content, "hello");
  });
});
