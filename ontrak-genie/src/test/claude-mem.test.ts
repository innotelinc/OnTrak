/**
 * The memory worker, as this console uses it.
 *
 * claude-mem is a separate service, so the only thing worth pinning here is the
 * wire: the context that reaches the prompt, the observation and summary bodies
 * the worker expects, and the search envelope turned back into text a model can
 * read. A fake worker owns the answers, so the test never depends on one running.
 *
 * The environment is set before the imports because `config.ts` reads it once.
 */

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "genie-claude-mem-"));
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.CLAUDE_MEM_PROJECT_CWD = "/workspace";
process.env.CLAUDE_MEM_TIMEOUT_MS = "2000";

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

const captured: Captured[] = [];

const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  request.on("end", () => {
    const url = request.url ?? "/";
    const parsed = raw === "" ? undefined : (JSON.parse(raw) as unknown);
    captured.push({ method: request.method ?? "GET", url, body: parsed });

    if (url.startsWith("/api/context/inject")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("## Memory\n\nThe redirect bug was fixed in src/auth.ts.");
      return;
    }
    if (url.startsWith("/api/search")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: "| #1 | Oct 22 | change | Fix redirect |" }],
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "queued" }));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.notEqual(address, null);
assert.equal(typeof address, "object");
const port = typeof address === "object" && address !== null ? address.port : 0;
process.env.CLAUDE_MEM_URL = `http://127.0.0.1:${port}`;

const { memoryContext, recordObservation, searchMemory, summarizeTurn } = await import("../claude-mem.js");
const { allTools } = await import("../tools.js");

const session = {
  id: "session-1",
  title: "Fix the redirect",
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  messageCount: 1,
  messages: [],
};

after(() => server.close());

test("the prompt gets the history the worker returned", async () => {
  const context = await memoryContext();
  assert.match(context, /Memory from earlier sessions/);
  assert.match(context, /The redirect bug was fixed in src\/auth\.ts\./);
  const call = captured.find((entry) => entry.url.startsWith("/api/context/inject"));
  assert.match(call?.url ?? "", /projects=all/);
  assert.match(call?.url ?? "", /cwd=%2Fworkspace/);
});

test("a tool call is recorded with both session ids and the project directory", async () => {
  await recordObservation(session, {
    name: "Edit",
    input: { file_path: "src/auth.ts" },
    response: { ok: true, content: "Applied 1 edit" },
  });
  const call = captured.find((entry) => entry.url === "/api/sessions/observations");
  assert.notEqual(call, undefined);
  const body = call?.body as Record<string, unknown>;
  assert.equal(body.claudeSessionId, "session-1");
  assert.equal(body.contentSessionId, "session-1");
  assert.equal(body.tool_name, "Edit");
  assert.equal(body.cwd, "/workspace");
});

test("the memory lookup itself is never recorded", async () => {
  const before = captured.filter((entry) => entry.url === "/api/sessions/observations").length;
  await recordObservation(session, { name: "recall_memory", input: { query: "redirect" }, response: { ok: true } });
  const after = captured.filter((entry) => entry.url === "/api/sessions/observations").length;
  assert.equal(after, before);
});

test("a finished turn is summarized", async () => {
  await summarizeTurn(session, "Fix the redirect", "Changed buildRedirectUri in src/auth.ts.");
  const call = captured.find((entry) => entry.url === "/api/sessions/summarize");
  assert.notEqual(call, undefined);
  const body = call?.body as Record<string, unknown>;
  assert.equal(body.contentSessionId, "session-1");
  assert.equal(body.last_user_message, "Fix the redirect");
});

test("search unwraps the MCP content envelope", async () => {
  const found = await searchMemory("redirect", 3);
  assert.equal(found, "| #1 | Oct 22 | change | Fix redirect |");
  const call = captured.find((entry) => entry.url.startsWith("/api/search"));
  assert.match(call?.url ?? "", /limit=3/);
});

test("recall_memory is offered only because a worker is configured", () => {
  assert.equal(
    allTools().some((tool) => tool.name === "recall_memory"),
    true,
  );
});
