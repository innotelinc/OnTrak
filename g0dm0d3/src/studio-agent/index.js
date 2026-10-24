/**
 * The studio's chat, answered by Genie's agent instead of a bare completion.
 *
 * The studio page is a multi-model race: it fires several `chat/completions`
 * requests for one prompt, scores the answers and shows the winner. None of
 * those calls can use a tool, because a completion is a single turn. Genie is
 * the thing that has tools — the shell, the files, the skills, MCP, memory — so
 * a studio turn that wants them has to be run by Genie's agent loop.
 *
 *   browser ──▶ g0dm0d3 ──▶ Genie /api/chat ──▶ tools, skills, the workspace
 *        ◀── OpenAI-shaped SSE/JSON ──┘
 *
 * The work is split by concern: `request.js` decides whether this call is the
 * person's turn and what they asked, `turn.js` runs it (joining the racers'
 * shared run), `sessions.js` keeps conversation -> Genie session across a
 * restart, `genie-events.js` turns stream events into the answer, `runs.js` owns
 * the in-flight registry, and `responses.js` speaks the OpenAI shape.
 *
 * Nothing here charges a credit: the studio has always paid per token through
 * the caller's own gateway key, and Genie's turn accounting does the same. A
 * bridged turn is not billed twice.
 */
import crypto from "node:crypto";

import { conversationOf, digest, queryOf } from "./request.js";
import { chunk, json } from "./responses.js";
import { abortRuns, detach } from "./runs.js";
import { forgetSessions } from "./sessions.js";
import { acquireRun } from "./turn.js";

export { isAgentRequest } from "./request.js";

/** Test hook: forget every mapping and every in-flight run. */
export function resetAgentState() {
  forgetSessions();
  abortRuns();
}

/**
 * Answer one studio chat call from the shared agent run.
 *
 * `body.stream` decides the shape only: the work, the run and the session are
 * the same whether the page asked for SSE (GODMODE FAST) or one JSON body (the
 * classic race).
 */
export async function handleAgentChat({ req, res, config, email, body, log }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const query = queryOf(req, body, messages);
  if (query === "") {
    json(res, 400, { error: "messages must contain a user message" });
    return;
  }

  const conversation = conversationOf(req, email, messages);
  const sessionKey = digest(email, conversation);
  // All racers for one turn share the prompt and the history length; the next
  // turn has one more message in it, so it is a different key.
  const turnKey = digest(email, conversation, query, String(messages.length));
  const streaming = body.stream === true;
  const model = typeof body.model === "string" && body.model !== "" ? body.model : "genie/agent";

  const run = acquireRun({
    key: turnKey,
    sessionKey,
    conversation,
    query,
    streaming,
    config,
    email,
    log,
  });

  if (!streaming) {
    const watcher = () => {};
    run.listeners.add(watcher);
    res.on("close", () => {
      if (!res.writableEnded) detach(run, watcher);
    });
    await run.finished;
    run.listeners.delete(watcher);
    if (run.text === "") {
      json(res, 502, {
        error: { message: "the agent run produced nothing", type: "agent_error" },
      });
      return;
    }
    json(res, 200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: run.text }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    log({ event: "agent_answer", email, conversation, mode: "json", bytes: run.text.length });
    return;
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sent = 0;
  let closed = false;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`);

  const flush = () => {
    if (closed || run.text.length <= sent) return;
    const delta = run.text.slice(sent);
    sent = run.text.length;
    try {
      res.write(chunk(id, created, model, delta));
    } catch {
      closed = true;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(": ping\n\n");
    } catch {
      closed = true;
    }
  }, 15_000);
  heartbeat.unref?.();

  run.listeners.add(flush);
  if (run.idleTimer) {
    clearTimeout(run.idleTimer);
    run.idleTimer = null;
  }
  flush();

  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    detach(run, flush);
  });

  await run.finished;
  flush();
  clearInterval(heartbeat);
  if (!closed) {
    try {
      res.write(chunk(id, created, model, "", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      // The browser left between the last byte and the last frame.
    }
  }
  log({ event: "agent_answer", email, conversation, mode: "stream", bytes: run.text.length });
}
