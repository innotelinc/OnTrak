/**
 * The memory Genie shares with every other interface.
 *
 * claude-mem is a worker that turns tool activity into observations, summaries
 * and a searchable history. Its worker is an HTTP API, and this module is the
 * only place Genie talks to it: the console, the CLI and every front door that
 * calls `/api/chat` get the same memory because they all run this loop.
 *
 * Three rules shape the module:
 *
 * 1. **Memory never fails a turn.** Every call is best-effort, bounded by
 *    `CLAUDE_MEM_TIMEOUT_MS`, and returns an empty answer on any failure. A
 *    worker that is down costs the turn its history, not its reply.
 * 2. **The worker is optional.** With `CLAUDE_MEM_URL` unset nothing here
 *    reaches the network and `recall_memory` is not offered.
 * 3. **Capture is fire-and-forget.** A turn must not wait for an observation to
 *    be summarized before it can show the next think; the worker queues it and
 *    the model that writes the observation runs separately.
 */

import { config } from "./config.js";
import type { Session } from "./store.js";

/** How much of the injected history is allowed into the prompt. */
const MAX_CONTEXT_CHARS = 12_000;

/** How much of one tool result is sent for observation. */
const MAX_TOOL_RESPONSE_CHARS = 8_000;

/** Tool calls that are themselves memory lookups are never recorded. */
const SKIP_TOOLS = new Set(["recall_memory"]);

export function claudeMemEnabled(): boolean {
  return config.claudeMemUrl !== "";
}

/** The directory the worker files this deployment's memory under. */
export function claudeMemProjectCwd(): string {
  return config.claudeMemProjectCwd !== "" ? config.claudeMemProjectCwd : config.workspace;
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response | null> {
  if (!claudeMemEnabled()) return null;
  const headers = new Headers(init.headers);
  if (config.claudeMemToken !== "") headers.set("authorization", `Bearer ${config.claudeMemToken}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  try {
    return await fetch(`${config.claudeMemUrl}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(config.claudeMemTimeoutMs),
    });
  } catch {
    // Unreachable, timed out, or refused: all the same to a turn that can go on.
    return null;
  }
}

function truncate(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}\n\n... [truncated ${value.length - limit} characters]` : value;
  }
  return value;
}

/**
 * The history the turn should start with, as one block for the system prompt.
 *
 * `projects=all` is deliberate on a shared worker: the console, the CLI, G0DM0D3
 * and the Engineer portal are different doors into the same work, and a memory
 * written at one should be visible at the next. A worker that answers nothing
 * yields the empty string, so this cannot make a prompt worse.
 */
export async function memoryContext(): Promise<string> {
  if (!claudeMemEnabled()) return "";
  const cwd = encodeURIComponent(claudeMemProjectCwd());
  const response = await request(`/api/context/inject?projects=all&cwd=${cwd}`);
  if (response === null || !response.ok) return "";
  let text = "";
  try {
    text = (await response.text()).trim();
  } catch {
    return "";
  }
  if (text === "") return "";
  const clipped =
    text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n... [memory context truncated]` : text;
  return (
    "Memory from earlier sessions, shared across this deployment's interfaces " +
    "(console, CLI, G0DM0D3, Engineer). Search it with `recall_memory` when the request " +
    `touches work done before this chat.\n\n${clipped}`
  );
}

export interface ToolObservation {
  name: string;
  input: unknown;
  response: unknown;
}

/**
 * Send one executed tool call to the worker for observation.
 *
 * The same `session.id` is sent as both the Claude and content session id: the
 * worker's current API requires the pair, and Genie has one id that means the
 * same thing to both. A rejected or slow worker is ignored here — capture is a
 * record of the work, not a condition of it.
 */
export async function recordObservation(session: Session, observation: ToolObservation): Promise<void> {
  if (!claudeMemEnabled()) return;
  if (SKIP_TOOLS.has(observation.name)) return;
  await request("/api/sessions/observations", {
    method: "POST",
    body: JSON.stringify({
      claudeSessionId: session.id,
      contentSessionId: session.id,
      tool_name: observation.name,
      tool_input: truncate(observation.input, MAX_TOOL_RESPONSE_CHARS),
      tool_response: truncate(observation.response, MAX_TOOL_RESPONSE_CHARS),
      cwd: claudeMemProjectCwd(),
    }),
  });
}

/**
 * Ask the worker to summarize the turn that just finished.
 *
 * Summaries are what a later session is primed with; observations alone give it
 * details without the thread. Best-effort like everything else here.
 */
export async function summarizeTurn(
  session: Session,
  lastUserMessage: string,
  lastAssistantMessage: string,
): Promise<void> {
  if (!claudeMemEnabled()) return;
  await request("/api/sessions/summarize", {
    method: "POST",
    body: JSON.stringify({
      claudeSessionId: session.id,
      contentSessionId: session.id,
      last_user_message: lastUserMessage,
      last_assistant_message: lastAssistantMessage,
    }),
  });
}

/**
 * Search the shared history for the `recall_memory` tool.
 *
 * The worker's search route answers in the MCP content envelope even over HTTP;
 * the text inside it is already written for a model to read (an index of IDs,
 * dates, titles and files), so it is returned as-is. Plain text is accepted too,
 * for a worker whose route is a version older or newer than this one.
 */
export async function searchMemory(query: string, limit: number): Promise<string | null> {
  if (!claudeMemEnabled()) return null;
  const params = new URLSearchParams({ query, format: "index", limit: String(limit) });
  const response = await request(`/api/search?${params.toString()}`);
  if (response === null || !response.ok) return null;
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return null;
  try {
    const body = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(body.content)) {
      const text = body.content.find((part) => part.type === "text" && typeof part.text === "string")?.text;
      if (typeof text === "string" && text.trim() !== "") return text;
    }
  } catch {
    // Not the envelope: fall through to the raw body.
  }
  return raw;
}
