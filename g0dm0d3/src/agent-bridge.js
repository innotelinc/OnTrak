/**
 * The studio's chat, answered by Genie's agent instead of a bare completion.
 *
 * The studio page is a multi-model race: it fires several `chat/completions`
 * requests for one prompt, scores the answers and shows the winner. None of
 * those calls can use a tool, because a completion is a single turn. Genie is
 * the thing that has tools — the shell, the files, the skills, MCP, memory — so
 * a studio turn that wants them has to be run by Genie's agent loop.
 *
 * This module is the seam. A studio chat call (identified by its `X-Title`, see
 * `isAgentRequest`) is answered here rather than proxied to OmniRoute:
 *
 *   browser ──▶ g0dm0d3 ──▶ Genie /api/chat ──▶ tools, skills, the workspace
 *        ◀── OpenAI-shaped SSE/JSON ──┘
 *
 * THREE THINGS IT HAS TO GET RIGHT
 * --------------------------------
 *   * **One agent run per prompt, not one per racer.** The race asks the same
 *     question five times at once. Every request for one turn joins the run that
 *     is already in flight (`turnKey`), so the agent — and its `run_command` —
 *     happens once. A late sibling still gets the finished answer.
 *   * **The conversation, not the request, owns the Genie session.** Genie keeps
 *     the transcript; the studio sends its own history every time. The mapping
 *     from a studio conversation id to a Genie session id is what makes turn two
 *     continue turn one, and it survives a restart.
 *   * **Tools are shown, not hidden.** The studio renders markdown, so tool
 *     activity arrives as blockquote lines in the answer: what ran, whether it
 *     worked. The output itself stays in the agent's transcript; the reply is the
 *     model's summary of it, exactly as in the console.
 *
 * Nothing here charges a credit: the studio has always paid per token through
 * the caller's own gateway key, and Genie's turn accounting does the same. A
 * bridged turn is not billed twice.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Titles that are the page asking itself something, not the person talking. */
const AUXILIARY = new Set([
  "classifier",
  "prefill",
  "tastemaker",
  "refusal-detector",
  "accuracy-check",
  "vision",
  "pliny-coach",
  "pliny-improve",
  "liquid-refiner",
]);

/** The studio marks its cloud calls with this prefix (see `cloudChatRequest`). */
const TITLE_PREFIX = "GODMOD3.AI";

const MAX_QUERY = 8_000;
const SESSION_LIMIT = 500;
const RUN_GRACE_MS = 5_000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const IDLE_ABORT_MS = 10_000;

/**
 * Is this the person's own chat turn, rather than the page classifying, judging
 * or prefilling one? Only the former goes to the agent; the rest are short,
 * single-shot model calls where a tool loop would be wrong (and expensive).
 */
export function isAgentRequest(req) {
  const title = String(req.headers["x-title"] ?? "").trim();
  if (!title.startsWith(TITLE_PREFIX)) return false;
  const suffix = title.slice(TITLE_PREFIX.length).replace(/^-/, "");
  return !AUXILIARY.has(suffix);
}

// --- sessions ---------------------------------------------------------------

/** studio conversation key -> { sessionId, used } */
const sessions = new Map();
let sessionsLoaded = false;

function sessionsFile() {
  return process.env.G0DM0D3_AGENT_SESSIONS || path.join("/tmp", "g0dm0d3-agent-sessions.json");
}

function loadSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
    for (const [key, value] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof value?.sessionId === "string" && value.sessionId !== "") {
        sessions.set(key, { sessionId: value.sessionId, used: Number(value.used) || 0 });
      }
    }
  } catch {
    // No file yet, or one a previous version wrote badly: a missing mapping only
    // means a new Genie session, never a failed turn.
  }
}

function saveSessions() {
  try {
    const file = sessionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sessions: Object.fromEntries(sessions) }));
    fs.renameSync(temporary, file);
  } catch {
    // Continuity across a restart is a convenience; it must never break a turn.
  }
}

function sessionFor(key) {
  loadSessions();
  return sessions.get(key)?.sessionId ?? "";
}

function rememberSession(key, sessionId) {
  loadSessions();
  sessions.set(key, { sessionId, used: Date.now() });
  if (sessions.size > SESSION_LIMIT) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, sessions.size - SESSION_LIMIT);
    for (const [stale] of oldest) sessions.delete(stale);
  }
  saveSessions();
}

/** Test hook: forget every mapping and every in-flight run. */
export function resetAgentState() {
  sessions.clear();
  sessionsLoaded = false;
  for (const run of runs.values()) {
    try {
      run.controller?.abort();
    } catch {
      // Already gone.
    }
  }
  runs.clear();
  try {
    fs.rmSync(sessionsFile(), { force: true });
  } catch {
    // Best effort.
  }
}

// --- request interpretation -------------------------------------------------

function textOf(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter((part) => part !== "")
      .join("\n");
  }
  return "";
}

function decodeHeader(raw) {
  const header = String(raw ?? "").trim();
  if (header === "") return "";
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    // A base64 string that was not utf8 decodes to replacement characters; that
    // is a header we cannot read, not a query.
    return decoded.includes("\uFFFD") ? "" : decoded.trim();
  } catch {
    return "";
  }
}

/**
 * The text the person typed.
 *
 * The page sends its jailbreak template as the last user message and puts the
 * real query in a header (see the injected bridge in `studioDocument`). The
 * transcript is the authority, though: the page embeds the query in the
 * template, so a header that is not in the transcript is stale — a regenerated
 * turn, an edited message — and the transcript wins.
 */
function queryOf(req, body, messages) {
  const last = [...messages].reverse().find((message) => message && message.role === "user");
  const transcript = textOf(last).trim();
  const header = decodeHeader(req.headers["x-genie-query"]);
  if (header !== "" && (transcript === "" || transcript.includes(header))) return header.slice(0, MAX_QUERY);
  return transcript.slice(0, MAX_QUERY);
}

function conversationOf(req, actor, messages) {
  const header = String(req.headers["x-genie-conversation"] ?? "").trim();
  if (header !== "") return `id:${header.slice(0, 120)}`;
  const first = messages.find((message) => message && message.role === "user");
  // No conversation id (an older cached page): the opening line is the next best
  // identity. Two chats that open with the same words would share a session; that
  // is a rarer accident than losing the thread on every turn.
  return `open:${digest(actor, textOf(first).slice(0, 2_000))}`;
}

function digest(...parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

// --- text shaping -----------------------------------------------------------

function oneLine(value, limit) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function describeArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "query", "pattern", "name", "url", "skill", "source"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return ` · \`${oneLine(value, 140).replace(/`/g, "'")}\``;
    }
  }
  return "";
}

// --- runs -------------------------------------------------------------------

/** turn key -> run */
const runs = new Map();

function append(run, text) {
  if (typeof text !== "string" || text === "" || run.done) return;
  run.text += text;
  for (const listener of run.listeners) {
    try {
      listener();
    } catch {
      // A browser that went away is handled by the close listener.
    }
  }
}

function finish(run) {
  if (run.done) return;
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  if (run.idleTimer) clearTimeout(run.idleTimer);
  if (run.sessionId) rememberSession(run.sessionKey, run.sessionId);
  for (const listener of run.listeners) {
    try {
      listener();
    } catch {
      // As above: the detached listener is not this run's problem.
    }
  }
  run.resolve();
  setTimeout(() => {
    if (runs.get(run.key) === run) runs.delete(run.key);
  }, RUN_GRACE_MS).unref?.();
}

function detach(run, listener) {
  run.listeners.delete(listener);
  if (run.listeners.size > 0 || run.done) return;
  // Every racer has gone (the winner exited early, or Stop was pressed). Give a
  // straggler a moment to join, then stop paying for a turn nobody is reading.
  run.idleTimer = setTimeout(() => {
    if (run.listeners.size === 0 && !run.done) {
      try {
        run.controller?.abort();
      } catch {
        // Already finished.
      }
    }
  }, IDLE_ABORT_MS);
  run.idleTimer.unref?.();
}

function eventOf(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "")
    .join("\n");
  if (data === "") return null;
  if (data === "[DONE]") return "done";
  try {
    const parsed = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function approveInGenie(config, id) {
  if (config.genieUrl === "") return;
  try {
    await fetch(`${config.genieUrl}/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.genieToken === "" ? {} : { authorization: `Bearer ${config.genieToken}` }),
      },
      body: JSON.stringify({ decision: "approve" }),
    });
  } catch {
    // Genie times the prompt out on its own; the tool then does not run.
  }
}

function applyEvent(run, event) {
  switch (event.type) {
    case "session":
      if (typeof event.id === "string" && event.id !== "") run.sessionId = event.id;
      break;
    case "text":
      if (typeof event.text === "string") append(run, event.text);
      break;
    case "tool_call":
      append(run, `\n\n> ⚙ **${oneLine(event.name, 80)}**${describeArgs(event.args)}\n`);
      break;
    case "tool_result": {
      const failed = event.ok === false;
      append(run, `> ${failed ? `✗ failed${typeof event.content === "string" && event.content !== "" ? `: ${oneLine(event.content, 160)}` : ""}` : "✓ done"}\n`);
      break;
    }
    case "approval_request":
      // The product is "enabled automatically": a prompt nobody is watching would
      // stall every studio turn. This is only reachable when the deployment turned
      // AGENT_APPROVAL on, and the approval log records it either way.
      append(run, `\n\n> ⏵ **${oneLine(event.name, 80)}** — auto-approved\n`);
      void approveInGenie(run.config, event.id);
      break;
    case "notice": {
      if (typeof event.text !== "string" || event.text === "") break;
      // A retry notice carries the gateway's whole JSON error; the reason is the
      // part before it, and the rest is the console's to show, not a chat answer.
      const brace = event.text.indexOf("{");
      const reason = brace > 0 ? `${event.text.slice(0, brace)}…` : event.text;
      append(run, `\n\n> ℹ ${oneLine(reason, 240)}\n`);
      break;
    }
    case "error":
      append(run, `\n\n**Error:** ${oneLine(event.message, 400)}\n`);
      break;
    default:
      // `step`, `draft`, `gateway`, `approval_result` and `done` carry no prose.
      break;
  }
}

async function startRun(run) {
  const { config, email, log } = run;
  const controller = new AbortController();
  run.controller = controller;
  run.timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  run.timer.unref?.();

  if (config.genieUrl === "") {
    append(run, "\n\n**Error:** GENIE_URL is unset on this deployment.\n");
    finish(run);
    return;
  }

  const sessionId = sessionFor(run.sessionKey);

  try {
    const upstream = await fetch(`${config.genieUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.genieToken === "" ? {} : { authorization: `Bearer ${config.genieToken}` }),
        // The same identity the run route sends: Genie resolves it to the
        // person's own workspace and their own gateway key.
        "x-genie-actor": email,
      },
      body: JSON.stringify({
        message: run.query,
        ...(sessionId === "" ? {} : { sessionId }),
        ...(typeof config.agentModel === "string" && config.agentModel !== "" ? { model: config.agentModel } : {}),
        ...(Array.isArray(config.agentFallbackModels) && config.agentFallbackModels.length > 0 ? { fallbackModels: config.agentFallbackModels } : {}),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || upstream.body === null) {
      const detail = await upstream.text().catch(() => "");
      throw new Error(`Genie refused the turn (HTTP ${upstream.status})${detail === "" ? "" : `: ${oneLine(detail, 200)}`}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    const consume = (frame) => {
      const event = eventOf(frame);
      if (event === "done") {
        done = true;
        return;
      }
      if (event !== null) applyEvent(run, event);
    };

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        consume(frame);
        if (done) break;
      }
      // A frame that never ends is not an event; do not grow a buffer for it.
      if (buffer.length > 1_000_000) buffer = buffer.slice(-4_096);
    }

    buffer += decoder.decode();
    if (!done && buffer.trim() !== "") consume(buffer);

    log({ event: "agent_completion", email, conversation: run.conversation, mode: run.streaming ? "stream" : "json", bytes: run.text.length });
  } catch (error) {
    const message = error?.name === "AbortError" ? "the agent run was stopped" : error.message;
    if (run.text === "") append(run, `**Error:** ${oneLine(message, 400)}\n`);
    else append(run, `\n\n**Error:** ${oneLine(message, 400)}\n`);
    log({ event: "agent_failed", email, conversation: run.conversation, error: oneLine(message, 300) });
  } finally {
    finish(run);
  }
}

function acquireRun({ key, sessionKey, conversation, query, streaming, config, email, log }) {
  const existing = runs.get(key);
  if (existing !== undefined) return existing;
  const run = {
    key,
    sessionKey,
    conversation,
    query,
    streaming,
    config,
    email,
    log,
    text: "",
    done: false,
    sessionId: "",
    controller: null,
    timer: null,
    idleTimer: null,
    listeners: new Set(),
    resolve: null,
  };
  run.finished = new Promise((resolve) => {
    run.resolve = resolve;
  });
  runs.set(key, run);
  void startRun(run);
  return run;
}

// --- responses --------------------------------------------------------------

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function chunk(id, created, model, content, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: content === "" ? {} : { content }, finish_reason: finishReason }],
  })}\n\n`;
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
      json(res, 502, { error: { message: "the agent run produced nothing", type: "agent_error" } });
      return;
    }
    json(res, 200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: run.text }, finish_reason: "stop" }],
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
