import { applyEvent, eventOf } from "./genie-events.js";
import { createRun, finish, runFor } from "./runs.js";
import { sessionFor } from "./sessions.js";
import { oneLine } from "./text.js";

const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The run for this turn, starting it if nobody has yet.
 *
 * The studio's race fires the same prompt several times at once; every racer
 * joins the run already in flight, so the agent (and its `run_command`) happens
 * once. A late sibling still gets the finished answer.
 */
export function acquireRun({ key, sessionKey, conversation, query, streaming, config, email, log }) {
  const existing = runFor(key);
  if (existing !== undefined) return existing;
  const run = createRun({
    key,
    sessionKey,
    conversation,
    query,
    streaming,
    config,
    email,
    log,
  });
  void startRun(run);
  return run;
}

async function startRun(run) {
  const { config, email, log } = run;
  const controller = new AbortController();
  run.controller = controller;
  run.timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  run.timer.unref?.();

  if (config.genieUrl === "") {
    run.append("\n\n**Error:** GENIE_URL is unset on this deployment.\n");
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
        ...(typeof config.agentModel === "string" && config.agentModel !== ""
          ? { model: config.agentModel }
          : {}),
        ...(Array.isArray(config.agentFallbackModels) && config.agentFallbackModels.length > 0
          ? { fallbackModels: config.agentFallbackModels }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || upstream.body === null) {
      const detail = await upstream.text().catch(() => "");
      throw new Error(
        `Genie refused the turn (HTTP ${upstream.status})${detail === "" ? "" : `: ${oneLine(detail, 200)}`}`,
      );
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

    log({
      event: "agent_completion",
      email,
      conversation: run.conversation,
      mode: run.streaming ? "stream" : "json",
      bytes: run.text.length,
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "the agent run was stopped" : error.message;
    if (run.text === "") run.append(`**Error:** ${oneLine(message, 400)}\n`);
    else run.append(`\n\n**Error:** ${oneLine(message, 400)}\n`);
    log({
      event: "agent_failed",
      email,
      conversation: run.conversation,
      error: oneLine(message, 300),
    });
  } finally {
    finish(run);
  }
}
