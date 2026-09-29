import { config } from "./config.js";
import type { FileDiff } from "./diff.js";

/**
 * Client for the OmniRoute gateway.
 *
 * OmniRoute exposes an OpenAI-compatible surface at `OMNIROUTE_URL` (default
 * http://127.0.0.1:20128/v1). Its zero-config model id `auto` routes across
 * whatever providers the gateway has connected, so this works with no API keys
 * at all.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A message in the OpenAI wire format. Optional fields are kept optional so the
 * array can be persisted to JSON and sent back verbatim on the next turn.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * The before/after view of a file change, for the UI. Kept on the message so
   * reopening a chat still shows diffs, and stripped by `modelMessages` before
   * anything is sent to the gateway.
   */
  diff?: FileDiff;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: unknown;
  /**
   * The model that actually answered, when the gateway names it. Differs from the
   * requested id whenever a combo or an alias rerouted the request, which is the
   * only way to see through names like `auto/best-coding`.
   */
  servedModel: string | null;
}

export type StreamEvent =
  | { type: "text"; text: string }
  /**
   * A tool call taking shape: `args` is everything accumulated for that call so
   * far, not just the new fragment. A file is written through a tool call whose
   * arguments stream in like any other text, so this is what lets the UI show
   * the code while it is still being generated - the finished `tool_call` only
   * arrives after the last character.
   */
  | { type: "tool_draft"; index: number; name: string; args: string };

export class GatewayError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  /**
   * Set when the failure is a transport one - the gateway could not be reached
   * or did not answer. Always worth another provider, so it does not depend on
   * the message text happening to match the retry patterns below.
   */
  readonly retryable: boolean;

  constructor(message: string, status?: number, body?: string, retryable = false) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

function headers(key: string): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}

/** Combine a caller's abort signal with the configured request timeout. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Status codes where a different provider might well succeed. */
const RETRYABLE_STATUS = new Set([402, 403, 408, 409, 425, 429, 500, 502, 503, 504]);

/** Did the caller (or a timeout) cancel this, rather than the provider failing? */
export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const message = typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  // "This operation was aborted" is the DOMException text; a timeout is not an abort.
  return /\babort(ed)?\b/i.test(message) && !/timed? ?out|timeout/i.test(message);
}

/**
 * Is another provider worth trying? Throttling, quota exhaustion and transient
 * upstream failures are; a bad request or a cancelled one is not.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  // An unreachable gateway is the strongest reason of all to try the next one -
  // in particular the offline fallback, which exists precisely for this case.
  if (error instanceof GatewayError && error.retryable) return true;
  if (error instanceof GatewayError && error.status !== undefined && RETRYABLE_STATUS.has(error.status)) {
    return true;
  }
  const message = `${(error as { message?: unknown }).message ?? ""} ${(error as { body?: unknown }).body ?? ""}`;
  return /rate.?limit|cooling down|cooldown|quota|credit|overload|capacity|too many requests|timed? ?out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|empty response/i.test(
    message,
  );
}

async function request(baseUrl: string, pathname: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, init);
  } catch (error) {
    // A cancelled request is not a gateway problem, so do not disguise it.
    if (isAbortError(error)) throw error;
    // Node hides the real reason one level down: fetch rejects with a bare
    // "fetch failed" TypeError, and the useful text ("connect ECONNREFUSED
    // 127.0.0.1:9") - or an errno code, when there is one - lives on the cause.
    const cause = (error as {
      cause?: { code?: string; message?: string; errors?: { code?: string; message?: string }[] };
    }).cause;
    const nested = cause?.errors?.[0];
    const detail = cause?.code ?? nested?.code ?? cause?.message ?? nested?.message;
    const code =
      typeof detail === "string" && detail.trim() !== ""
        ? detail.split("\n")[0]!.slice(0, 120)
        : (error as Error).name;
    throw new GatewayError(
      `Cannot reach the model gateway at ${baseUrl} (${code}).\n` +
        `Start it with "npm run gateway" or ` +
        `"docker run --rm -p 20128:20128 diegosouzapw/omniroute", ` +
        `or point OMNIROUTE_URL at another gateway.`,
      undefined,
      undefined,
      true,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GatewayError(
      `OmniRoute returned HTTP ${response.status} for ${pathname}: ${body.slice(0, 800) || "(no body)"}`,
      response.status,
      body,
    );
  }
  return response;
}

/**
 * Turn a gateway error body into something worth showing a human. OmniRoute
 * reports provider failures as JSON, including which providers it tried.
 */
function describeGatewayError(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "OmniRoute returned an empty response body";

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown };
      diagnostics?: {
        poolSize?: unknown;
        attempted?: unknown;
        terminalReason?: unknown;
        recovery?: { next_step?: unknown };
      };
    };
    const message =
      typeof parsed.error?.message === "string" ? parsed.error.message : trimmed.slice(0, 800);

    const parts = [message];
    if (typeof parsed.diagnostics?.attempted === "number" && parsed.diagnostics.attempted === 0) {
      parts.push(
        "The gateway did not attempt any provider - connect one in the OmniRoute dashboard.",
      );
    }
    if (parsed.diagnostics?.terminalReason) parts.push(String(parsed.diagnostics.terminalReason));
    if (parsed.diagnostics?.recovery?.next_step) parts.push(String(parsed.diagnostics.recovery.next_step));
    return parts.join("\n");
  } catch {
    return trimmed.slice(0, 800);
  }
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((entry, index) => {
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call?.function?.name === "string" ? call.function.name : "";
    if (!name) return;
    const args = call.function?.arguments;
    calls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${index}_${Date.now().toString(36)}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args || "{}" : JSON.stringify(args ?? {}),
      },
    });
  });
  return calls;
}

/**
 * Recover a tool call that a model emitted as plain text.
 *
 * Smaller and free-tier models frequently print
 * `{"name": "read_file", "arguments": {...}}` straight into the content
 * instead of using the provider's structured tool-call channel. Since the whole
 * point of the gateway is to mix many providers, treat that shape as a real
 * tool call rather than showing the user raw JSON.
 */
export function salvageToolCalls(content: string, knownTools: ReadonlySet<string>): ToolCall[] {
  const trimmed = content.trim();
  if (trimmed === "") return [];
  // Cheap bail-out before attempting any parsing.
  if (!/"(name|tool)"\s*:/.test(trimmed)) return [];

  const regions = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json|tool_code)?\s*([\s\S]*?)```/g)) {
    if (match[1]) regions.push(match[1].trim());
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) regions.push(trimmed.slice(first, last + 1));

  for (const region of regions) {
    // A tidy single object or array parses directly.
    let parsed: unknown;
    try {
      parsed = JSON.parse(region);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const calls = toToolCalls(parsed, knownTools);
      if (calls.length > 0) return calls;
    }

    // Otherwise scan for balanced objects, which also covers several calls
    // pasted one after another inside a single block.
    const calls: ToolCall[] = [];
    for (const objectText of extractJsonObjects(region)) {
      let item: unknown;
      try {
        item = JSON.parse(objectText);
      } catch {
        continue;
      }
      calls.push(...toToolCalls(item, knownTools));
    }
    if (calls.length > 0) return calls;
  }
  return [];
}

/**
 * Pull out every top-level `{...}` span, ignoring braces inside strings and
 * respecting escapes. Returns nothing for unbalanced input.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

/**
 * Ids for calls recovered from text.
 *
 * A counter, not the clock: a reply that prints two calls in one block sends both
 * through `toToolCalls` within the same millisecond, and a clock-derived id gave
 * them the same one. Everything downstream matches calls to results by id - the
 * transcript, the tool cards, the preview pane - so a duplicate silently shows one
 * call's output under another's name.
 */
let salvagedCallId = 0;

function toToolCalls(parsed: unknown, knownTools: ReadonlySet<string>): ToolCall[] {
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];

  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.tool === "string"
          ? record.tool
          : "";
    // Only accept names we actually expose, so prose is never mistaken for a call.
    if (name === "" || !knownTools.has(name)) continue;

    const rawArgs = record.arguments ?? record.parameters ?? record.args ?? {};
    const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);

    salvagedCallId += 1;
    calls.push({
      id: `text_${name}_${salvagedCallId}`,
      type: "function",
      function: { name, arguments: args === "" ? "{}" : args },
    });
  }

  return calls;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: unknown[];
  model?: string;
  /** Override the gateway for this call. Used by the offline fallback. */
  baseUrl?: string;
  /** Key to send to that gateway instead of OMNIROUTE_API_KEY. */
  apiKey?: string;
  signal?: AbortSignal;
}

function buildBody(options: ChatOptions, stream: boolean): string {
  const body: Record<string, unknown> = {
    model: options.model ?? config.model,
    messages: options.messages,
    stream,
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  return JSON.stringify(body);
}

/** Non-streaming completion. Used when AGENT_STREAM=false. */
export async function completeChat(options: ChatOptions): Promise<ChatResult> {
  const response = await request(options.baseUrl ?? config.gatewayUrl, "/chat/completions", {
    method: "POST",
    headers: headers(options.apiKey ?? config.gatewayKey),
    signal: withTimeout(options.signal),
    body: buildBody(options, false),
  });

  const raw = await response.text();
  let json: {
    choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
    usage?: unknown;
    model?: unknown;
    error?: unknown;
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new GatewayError(`OmniRoute returned a non-JSON response: ${raw.slice(0, 400)}`);
  }

  const choice = json.choices?.[0];
  if (!choice) {
    // A 200 with no choices is how the gateway reports provider failures here.
    throw new GatewayError(describeGatewayError(raw));
  }

  return {
    content: typeof choice?.message?.content === "string" ? choice.message.content : "",
    toolCalls: normalizeToolCalls(choice?.message?.tool_calls),
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage ?? null,
    servedModel: typeof json.model === "string" ? json.model : null,
  };
}

/**
 * Streaming completion. Yields text deltas as they arrive and returns the
 * assembled result (full text, tool calls, finish reason), so the caller can
 * both drive the UI and append the assistant turn to the transcript.
 */
export async function* streamChat(options: ChatOptions): AsyncGenerator<StreamEvent, ChatResult> {
  const response = await request(options.baseUrl ?? config.gatewayUrl, "/chat/completions", {
    method: "POST",
    headers: { ...headers(options.apiKey ?? config.gatewayKey), Accept: "text/event-stream" },
    signal: withTimeout(options.signal),
    body: buildBody(options, true),
  });

  // On a provider failure the gateway answers a stream:true request with a JSON
  // error instead of an SSE frame. Without this check that body is swallowed and
  // the user just sees an empty reply.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.text().catch(() => "");
    throw new GatewayError(describeGatewayError(body), undefined, body.slice(0, 4000));
  }

  if (!response.body) {
    throw new GatewayError("OmniRoute accepted the streaming request but returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const slots: ToolCall[] = [];

  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let usage: unknown = null;
  let servedModel: string | null = null;
  let sawDone = false;

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const pending: StreamEvent[] = [];
      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        const line = raw.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          break;
        }

        let parsed: {
          choices?: {
            delta?: { content?: unknown; tool_calls?: unknown };
            message?: { content?: unknown; tool_calls?: unknown };
            finish_reason?: string | null;
          }[];
          usage?: unknown;
          model?: unknown;
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // Ignore keep-alive or malformed frames.
        }

        if (parsed.usage) usage = parsed.usage;
        if (typeof parsed.model === "string") servedModel = parsed.model;
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        // Some providers answer a stream:true request with a whole message.
        const delta = (choice.delta ?? choice.message ?? {}) as {
          content?: unknown;
          tool_calls?: unknown;
        };

        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          pending.push({ type: "text", text: delta.content });
        }

        if (Array.isArray(delta.tool_calls)) {
          // Indexes touched by this frame, so each call is drafted once per frame
          // rather than once per fragment.
          const touched: number[] = [];

          for (const entry of delta.tool_calls) {
            const fragment = entry as {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            };
            const index = typeof fragment.index === "number" ? fragment.index : slots.length;
            while (slots.length <= index) {
              slots.push({ id: "", type: "function", function: { name: "", arguments: "" } });
            }
            const slot = slots[index];
            if (!slot) continue;
            if (fragment.id) slot.id = fragment.id;
            if (fragment.function?.name) slot.function.name += fragment.function.name;
            if (typeof fragment.function?.arguments === "string") {
              slot.function.arguments += fragment.function.arguments;
            }
            if (!touched.includes(index)) touched.push(index);
          }

          for (const index of touched) {
            const slot = slots[index];
            if (slot === undefined) continue;
            pending.push({
              type: "tool_draft",
              index,
              name: slot.function.name,
              args: slot.function.arguments,
            });
          }
        }
      }

      for (const event of pending) yield event;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const toolCalls: ToolCall[] = slots
    .filter((slot) => slot.function.name !== "")
    .map((slot, index) => ({
      id: slot.id || `call_${index}_${Date.now().toString(36)}`,
      type: "function" as const,
      function: { name: slot.function.name, arguments: slot.function.arguments || "{}" },
    }));

  return { content, toolCalls, finishReason, usage, servedModel };
}

/** Model ids the gateway can serve, for the UI's model picker. */
export async function listModels(): Promise<string[]> {
  const response = await request(config.gatewayUrl, "/models", {
    method: "GET",
    headers: headers(config.gatewayKey),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json()) as { data?: { id?: unknown }[] };
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === "string")
    .sort((a, b) => a.localeCompare(b));
}

export interface GatewayHealth {
  ok: boolean;
  url: string;
  modelCount: number;
  error: string | null;
}

export async function gatewayHealth(): Promise<GatewayHealth> {
  try {
    const models = await listModels();
    return { ok: true, url: config.gatewayUrl, modelCount: models.length, error: null };
  } catch (error) {
    return { ok: false, url: config.gatewayUrl, modelCount: 0, error: (error as Error).message };
  }
}
