import crypto from "node:crypto";

import { approvalRequired, denialReason, requestApproval, type ApprovalDecision } from "./approval.js";
import { config, gatewayConsoleUrl } from "./config.js";
import type { FileDiff } from "./diff.js";
import { draftPreview, draftStreamed, textDraftPreview, type DraftSequence } from "./draft.js";
import {
  GatewayError,
  completeChat,
  isAbortError,
  isRetryableFailure,
  salvageToolCalls,
  streamChat,
  type ChatMessage,
  type ChatResult,
} from "./omniroute.js";
import { modelHealth } from "./modelHealth.js";
import { deriveTitle, saveSession, type Session } from "./store.js";
import { previewTool, runTool, toolSchemas, tools, type ToolOutcome } from "./tools.js";

export const SYSTEM_PROMPT = `You are a coding agent working inside a sandboxed workspace.

You have tools to inspect and modify the workspace: read_file, list_dir, write_file, edit_file, search_code and run_command.

How to work:
- Inspect before you change. Read the relevant files or search for the symbols first; never guess at what a file contains.
- Prefer search_code over reading whole directories, and read_file with offset/limit over dumping a large file.
- Use edit_file for surgical changes, and write_file only for new files or complete rewrites.
- Match the conventions already present in the code. Look at neighbouring files before inventing a new pattern.
- After changing code, verify it when the project supports it (typecheck, tests, linter) with run_command.
- Keep the app runnable. The console shows the user a live preview of this
  workspace: it runs the project's own start command (\`npm run dev\`, \`npm run
  start\`, \`python3 -m http.server\`, \`python3 manage.py runserver\`) and reloads
  it as files change. So when you build something new, give it a way to start — a
  \`dev\` or \`start\` script in package.json, or an index.html — and do not leave the
  start path broken. If the app needs a port, read \`PORT\` from the environment
  rather than hard-coding one.
- Install what you need instead of working around it. The workspace carries a
  working toolchain (bash, git, curl, wget, jq, make, gcc/g++, python3 + pip,
  node + npm). If a command fails because a tool is missing, install it —
  \`apk add <pkg>\` on this image, or \`pip install\` / \`npm install\` for
  language packages — and carry on. Do not tell the user to install something
  you could install yourself, and do not rewrite a script to avoid a tool that
  is one command away.
- Fix the cause of an error, not the symptom. If a tool call fails, change your
  approach rather than repeating the identical call - it will fail identically.

Boundaries:
- Every path is relative to the workspace root. Paths that escape it are rejected, and you cannot read or write anything outside it.
- You have no host privileges: no privilege escalation, no service or account management, no filesystem formatting. Do not attempt them; those commands are blocked.
- Do not try to obtain credentials, tokens or keys from outside the workspace. If a task needs access you do not have, say so plainly rather than working around it.

Style:
- Keep replies short. Summarize what changed and why instead of narrating every tool call.
- Do not paste large file contents back at the user; they can see the results themselves.
- If a request is ambiguous, or would be destructive, ask before acting.`;

export type AgentEvent =
  | { type: "session"; id: string; title: string; models: string[] }
  | { type: "step"; index: number }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      content: string;
      /** Present when the tool changed a file, for the UI's diff view. */
      diff?: FileDiff;
    }
  /**
   * A file being generated, before the tool call that writes it is complete.
   * `content` is what has arrived so far, so the UI can show the code being
   * written rather than only reporting it afterwards. `reset` marks the first
   * draft of an attempt: a retry on another model must not leave the previous
   * attempt's half-written file on screen.
   */
  | {
      type: "draft";
      reset: boolean;
      /**
       * Whether the pane showed this file before it was complete. False means
       * the gateway handed the whole call over in one frame, so the preview can
       * only report the finished file — the UI says as much instead of implying
       * a stream that never happened (see `draftStreamed`).
       */
      streamed: boolean;
      name: string;
      path: string | null;
      content: string;
      started: boolean;
      complete: boolean;
    }
  | {
      type: "approval_request";
      id: string;
      name: string;
      summary: string;
      diff?: FileDiff;
    }
  | { type: "approval_result"; id: string; decision: ApprovalDecision }
  /**
   * Which gateway is actually answering from here on. Emitted when it changes,
   * so the UI can show that the local model has taken over rather than leaving
   * the user to spot it in a notice that scrolls away.
   */
  | { type: "gateway"; mode: "primary" | "offline"; model: string; url?: string }
  | { type: "notice"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; steps: number };

/** A one-line, bounded version of an error message for a notice or summary. */
function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? text.trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export interface RunAgentOptions {
  session: Session;
  userMessage: string;
  model?: string;
  /** Overrides the session's saved model chain for this turn only. */
  fallbackModels?: string[];
  /** Overrides the session's saved offline setting for this turn only. */
  useOffline?: boolean;
  /** Overrides the session's saved step budget for this turn only. */
  maxSteps?: number;
  /**
   * The key this turn spends on the primary gateway. Set by the tenancy gate:
   * with a control plane configured it is the caller's own key, and otherwise
   * nothing is passed and the shared `OMNIROUTE_API_KEY` applies as before.
   */
  apiKey?: string;
  /**
   * Called when the gateway rejects the key this turn spends (401/403).
   *
   * That answer is about the *credential*, not the model: no other model on the
   * chain can fix it, which is why the turn stops there. The tenancy gate caches
   * the account it resolved, so a key that was rotated or re-minted after that
   * keeps being replayed until the cache ages out — five minutes of "every model
   * failed" for a key that is already fixed. The caller uses this to drop the
   * cached account and resolve again on the next turn.
   */
  onGatewayAuthFailure?: () => void;
  /**
   * Called with the gateway's own usage report after each successful model step.
   * The caller decides what a running total means — this loop only knows that a
   * step happened and what the gateway said it cost.
   */
  onUsage?: (usage: unknown, model: string) => void;
  signal?: AbortSignal;
}

/** The system prompt is prepended at request time, never stored in the transcript. */
function modelMessages(session: Session): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    // Diffs are a UI artefact; strip them so no provider sees an unknown field.
    ...session.messages.map(({ diff: _diff, ...message }) => message),
  ];
}

/** How streamed text is being treated while we decide what the model is doing. */
type TextMode = "streaming" | "holding" | "suppressing";

/**
 * Index where a text-mode tool call could begin: a leading JSON object/array, or
 * an embedded code fence (models often wrap the call in ```json). Returns -1 when
 * there is no candidate, which means the text is safe to stream as normal prose —
 * important, because ordinary code answers are full of fences too.
 */
export function toolCallMarkerIndex(text: string): number {
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return leading;
  return text.indexOf("```");
}

/**
 * Does this text name one of *our* tools? Matching against the real tool list is
 * what keeps a code answer that merely contains JSON from being swallowed.
 */
export function looksLikeTextToolCall(text: string, toolNames: ReadonlySet<string>): boolean {
  for (const match of text.matchAll(/"(?:name|tool)"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)"/g)) {
    if (match[1] !== undefined && toolNames.has(match[1])) return true;
  }
  return false;
}

/** Held text this long without naming a tool: release it as ordinary prose. */
const HOLD_LIMIT = 400;

/**
 * Stop drafting a file once its arguments reach this size. The pane is for
 * watching code appear, not for mirroring a megabyte over SSE; past this the
 * finished write still arrives as a `tool_call`.
 */
const DRAFT_MAX_CHARS = 128_000;

/**
 * Smallest step between text-mode drafts, in characters. Updates also get
 * sparser as the file grows (see the caller), because sending the whole body on
 * every token would be quadratic in the size of the file.
 */
const DRAFT_MIN_STEP = 48;

/** Give up once the same failing call has been made this many times. */
const STUCK_AFTER = 3;

/** Longest a retry will wait, however many attempts are configured. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Would this turn start knowing that nothing in the chain can answer?
 *
 * The health check runs on a timer, so its last word can be minutes old - good
 * enough to warn with, not good enough to refuse on. Only entries this turn would
 * actually use are considered, so a chat that has opted out of the offline
 * gateway is not told it is fine because the local model happens to work.
 */
function readinessWarning(useOffline: boolean): string | null {
  const report = modelHealth();
  if (report.checkedAt === null || report.entries.length === 0) return null;

  const relevant = report.entries.filter((entry) => useOffline || !entry.offline);
  if (relevant.length === 0 || relevant.some((entry) => entry.ok)) return null;

  const names = relevant.map((entry) => entry.model).join(", ");
  const reasons = relevant
    .map((entry) => entry.error)
    .filter((reason): reason is string => reason !== null)
    .slice(0, 2)
    .join("; ");
  return (
    `Heads up: the last model check could not get a tool call out of anything in the chain ` +
    `(${names}).${reasons === "" ? "" : ` Most recent: ${reasons}.`} ` +
    "This turn may fail or be slow; the sidebar has the detail and a sweep."
  );
}

/**
 * Wait, unless the user cancels. Resolves immediately on abort rather than
 * rejecting: the caller decides what a cancelled wait means, and a rejection here
 * would surface as a spurious error.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw === "" ? "{}" : raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * One entry in the fallback chain. `baseUrl` is set only for the offline
 * gateway; without it the entry means the primary gateway.
 */
interface ModelTarget {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Drive one user turn to completion: call the model, execute any tools it asks
 * for, feed the results back, and repeat until it answers without a tool call
 * (or the step budget runs out). Every event is also yielded to the caller so
 * the UI can render progress as it happens.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { session } = options;

  // A per-request choice wins, then the session's saved preference, then the
  // server default. Both are remembered so reopening the chat restores them.
  const requestedModel = options.model ?? session.model;
  const maxSteps = options.maxSteps ?? session.maxSteps ?? config.maxSteps;
  // A per-chat chain beats the server default. An empty list is a real choice,
  // so it is checked for `undefined` rather than for emptiness.
  const requestedFallbacks = options.fallbackModels ?? session.fallbackModels;
  const fallbackModels = requestedFallbacks ?? config.fallbackModels;
  // Opting out of the offline gateway is per chat, for work where a local 7B
  // answer would be worse than an honest failure.
  const useOffline = options.useOffline ?? session.useOffline ?? true;
  if (requestedModel !== undefined) session.model = requestedModel;
  if (options.fallbackModels !== undefined) session.fallbackModels = options.fallbackModels;
  if (options.useOffline !== undefined) session.useOffline = options.useOffline;
  if (options.maxSteps !== undefined) session.maxSteps = options.maxSteps;

  // Fallbacks are tried in order when a provider throttles, errors, or answers
  // with nothing at all - routine on free tiers. Deduplicated so a fallback that
  // repeats the chosen model is not attempted twice.
  const chain: ModelTarget[] = [];
  const seen = new Set<string>();
  for (const model of [requestedModel ?? config.model, ...fallbackModels]) {
    if (seen.has(model)) continue;
    seen.add(model);
    chain.push({ model, apiKey: options.apiKey });
  }
  // The offline gateway goes last: a local model is slower and weaker, but it
  // keeps working when the network - or the primary gateway - is down. Keyed by
  // URL too, since the same model id can exist on both gateways.
  if (config.offlineUrl !== "" && useOffline) {
    for (const model of config.offlineModels) {
      const key = `${config.offlineUrl}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push({ model, baseUrl: config.offlineUrl, apiKey: config.offlineKey });
    }
  }

  if (session.title === "New chat") session.title = deriveTitle(options.userMessage);
  session.messages.push({ role: "user", content: options.userMessage });
  await saveSession(session);
  yield {
    type: "session",
    id: session.id,
    title: session.title,
    models: chain.map((target) => target.model),
  };

  const schemas = toolSchemas();
  const toolNames = new Set(tools.map((tool) => tool.name));
  let steps = 0;

  // Weak models can wedge on one failing call. Track repeats so we can nudge the
  // model and eventually stop, instead of quietly burning the whole step budget.
  let repeatedFailures = 0;
  let lastFailureSignature = "";
  let lastFailureMessage = "";
  // Whether anything was actually executed, so a late failure is described honestly.
  let toolsRan = false;
  // Which gateway the last successful step used, so the switching event is only
  // sent when it actually changes. Reset per turn, so every turn says who
  // answered at least once.
  let gatewayMode: "primary" | "offline" | null = null;

  // A warning costs nothing and saves a turn: if the last check could not get a
  // tool call out of anything, the user should know before the agent tries again.
  const unready = readinessWarning(useOffline);
  if (unready !== null) yield { type: "notice", text: unready };

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1;
    yield { type: "step", index: steps };

    // `targets` starts as the chain and grows if the whole thing fails for a
    // reason that might pass: walking it again after a wait is what turns a
    // cooldown from "press send again" into something the turn survives.
    const targets: ModelTarget[] = [...chain];
    let repeats = 0;
    // Whether anything in this step failed for a reason that could clear later.
    let throttled = false;

    let result: ChatResult | null = null;
    // Set on every attempt; only read once one of them has succeeded.
    let answeringTarget: ModelTarget | null = null;
    let usedModel = chain[0]?.model ?? config.model;
    let failure: Error | null = null;
    // How much of the reply has reached the client, so nothing is lost or repeated.
    let emitted = 0;
    const failures: string[] = [];

    for (let attempt = 0; attempt < targets.length; attempt += 1) {
      const target = targets[attempt] ?? { model: config.model };
      answeringTarget = target;
      const candidate = target.model;
      usedModel = candidate;
      let mode: TextMode = "streaming";
      // Whether this attempt has already sent a draft, so the first one resets.
      let drafted = false;
      // The file the pane is currently watching, so a draft can tell whether it
      // is a live stream or the finished body arriving in one piece.
      let draftSequence: DraftSequence = { key: null, complete: false };
      // How much of a text-mode draft has been sent, to throttle the updates.
      let draftedChars = 0;
      let draftedComplete = false;
      result = null;
      failure = null;
      emitted = 0;

      try {
        if (config.stream) {
          const stream = streamChat({
            messages: modelMessages(session),
            tools: schemas,
            model: candidate,
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            signal: options.signal,
          });
          let held = "";
          for (;;) {
            const next = await stream.next();
            if (next.done) {
              result = next.value;
              break;
            }
            if (next.value.type === "tool_draft") {
              // A write arrives as a tool call, and its arguments stream in like
              // any other text. Pass the file so far to the UI now rather than
              // making it wait for the call to be complete.
              if (next.value.args.length > DRAFT_MAX_CHARS) continue;
              const draft = draftPreview(next.value.name, next.value.args);
              if (draft === null) continue;
              const reset = !drafted;
              drafted = true;
              if (reset) draftSequence = { key: null, complete: false };
              const streamed = draftStreamed(draftSequence, draft);
              draftSequence = streamed.next;
              yield { type: "draft", reset, streamed: streamed.streamed, ...draft };
              continue;
            }
            if (next.value.type !== "text") continue;
            held += next.value.text;

            if (mode === "streaming") {
              const marker = toolCallMarkerIndex(held);
              if (marker !== -1 && marker >= emitted) {
                // Send the prose that preceded the candidate, then hold the rest.
                const prose = held.slice(emitted, marker);
                if (prose !== "") yield { type: "text", text: prose };
                emitted = marker;
                mode = "holding";
              } else {
                yield { type: "text", text: next.value.text };
                emitted = held.length;
              }
            } else if (mode === "holding") {
              if (looksLikeTextToolCall(held, toolNames)) {
                mode = "suppressing";
              } else if (held.length - emitted > HOLD_LIMIT) {
                // Not a tool call after all: release everything held so far.
                mode = "streaming";
                yield { type: "text", text: held.slice(emitted) };
                emitted = held.length;
              }
            }

            // Prose that names a tool and carries its arguments is a file being
            // written in text mode, and it arrives token by token - so this is
            // where the preview really is live.
            if (mode !== "streaming") {
              const textDraft = textDraftPreview(held, toolNames);
              if (textDraft !== null && textDraft.content.length <= DRAFT_MAX_CHARS) {
                const step = Math.max(DRAFT_MIN_STEP, Math.floor(draftedChars / 8));
                const grew = textDraft.content.length - draftedChars >= step;
                // Say "complete" exactly once: the model carries on writing prose
                // after the call, and the arguments sit unchanged while it does.
                const finished = textDraft.complete && !draftedComplete;
                if (grew || finished) {
                  draftedChars = textDraft.content.length;
                  draftedComplete = textDraft.complete;
                  const reset = !drafted;
                  drafted = true;
                  if (reset) draftSequence = { key: null, complete: false };
                  const streamed = draftStreamed(draftSequence, textDraft);
                  draftSequence = streamed.next;
                  yield { type: "draft", reset, streamed: streamed.streamed, ...textDraft };
                }
              }
            }
          }
        } else {
          result = await completeChat({
            messages: modelMessages(session),
            tools: schemas,
            model: candidate,
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            signal: options.signal,
          });
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        // A rejected credential is the one failure another model cannot fix, and
        // it may be one the caller can: a stale cached account, above all.
        if (failure instanceof GatewayError && (failure.status === 401 || failure.status === 403)) {
          try {
            options.onGatewayAuthFailure?.();
          } catch {
            // Bookkeeping must never replace the failure that caused it.
          }
        }
      }

      const empty =
        failure === null && result !== null && result.content.trim() === "" && result.toolCalls.length === 0;
      // Anything that might pass later: throttling, a transport failure, an empty
      // answer (the gateway's way of reporting a cooled-down credential).
      const temporary = failure === null || isRetryableFailure(failure);
      if (temporary) throttled = true;
      if (failure === null && !empty) break;

      // A retry is only honest while the client has seen nothing: anything
      // already streamed would otherwise arrive twice.
      const next = targets[attempt + 1];
      if (next !== undefined && temporary && emitted === 0 && !isAbortError(failure)) {
        const reason = failure === null ? "returned an empty response" : firstLine(failure.message);
        failures.push(`${candidate} ${reason}`);
        const where = next.baseUrl === undefined ? "" : " on the offline gateway";
        yield { type: "notice", text: `${candidate} ${reason}; retrying with ${next.model}${where}.` };
        continue;
      }

      // End of the chain with nothing to show and nothing done yet. When the
      // failures were all of the kind that clears on its own, wait it out and
      // walk the chain again rather than returning an error the user can only
      // answer by pressing send again. Never after a tool has run: replaying real
      // work would be worse than failing.
      const idle = emitted === 0 && !toolsRan && !isAbortError(failure);
      if (next === undefined && throttled && idle && repeats < config.retryAttempts) {
        // Back off per attempt, so a long outage is not hammered every 20 seconds.
        const waitMs = Math.min(config.retryDelayMs * 2 ** repeats, MAX_RETRY_DELAY_MS);
        repeats += 1;
        yield {
          type: "notice",
          text:
            "Everything in the chain was throttled or silent; retrying in " +
            `${Math.round(waitMs / 1000)}s (attempt ${repeats} of ${config.retryAttempts}).`,
        };
        await sleep(waitMs, options.signal);
        // Stopping mid-wait is the user's decision, not a failure to report.
        if (options.signal?.aborted === true) {
          await saveSession(session);
          yield { type: "notice", text: "Stopped." };
          yield { type: "done", steps };
          return;
        }
        failures.length = 0;
        throttled = false;
        targets.push(...chain);
        continue;
      }
      break;
    }

    // Tell the UI which gateway is answering, once per turn and again whenever
    // it changes, so a quiet switch to the local model cannot go unnoticed.
    if (failure === null && result !== null) {
      const mode = answeringTarget?.baseUrl === undefined ? "primary" : "offline";
      if (mode !== gatewayMode) {
        gatewayMode = mode;
        yield {
          type: "gateway",
          mode,
          model: usedModel,
          ...(mode === "offline" && answeringTarget?.baseUrl !== undefined
            ? { url: answeringTarget.baseUrl }
            : {}),
        };
      }
      // The one place a step's cost is known, and the last point at which the
      // caller can still attribute it to the account that asked for it.
      options.onUsage?.(result.usage, usedModel);
    }

    if (isAbortError(failure)) {
      // The user pressed Stop. Not a failure worth reporting as one.
      await saveSession(session);
      yield { type: "notice", text: "Stopped." };
      yield { type: "done", steps };
      return;
    }

    const emptyResult =
      failure === null && result !== null && result.content.trim() === "" && result.toolCalls.length === 0;
    if (failure !== null || emptyResult) {
      if (failure !== null) failures.push(`${usedModel} ${firstLine(failure.message)}`);
      const lead =
        failure !== null
          ? "Every model in the chain failed to answer."
          : toolsRan
            ? "The models returned an empty response and the turn stopped early. Changes already made are on disk."
            : "The models returned an empty response, so nothing was changed.";
      const tried = failures.length > 0 ? ` Tried: ${failures.join("; ")}.` : "";
      const message =
        `${lead}${tried} This normally means none of the configured models is usable right now - ` +
        "free tiers rate-limit often. Connect another provider at " +
        `${gatewayConsoleUrl()}, pick a different model above, and ask me to continue.`;
      session.messages.push({ role: "assistant", content: `[gateway error] ${message}` });
      await saveSession(session);
      yield { type: "error", message };
      yield { type: "done", steps };
      return;
    }

    if (result === null) {
      // Unreachable in practice; keeps the type checker satisfied.
      yield { type: "error", message: "the gateway produced no result" };
      yield { type: "done", steps };
      return;
    }

    let toolCalls = result.toolCalls;
    if (toolCalls.length === 0) {
      // Weaker and free-tier models often print the call as JSON text instead of
      // using the structured channel. Accept that rather than failing the turn.
      const salvaged = salvageToolCalls(result.content, toolNames);
      if (salvaged.length > 0) {
        toolCalls = salvaged;
        yield {
          type: "notice",
          text: "The model wrote its tool call as text rather than using the structured channel; interpreted it as a tool call.",
        };
      }
    }

    // Release anything still unsent. When the turn really was a tool call there is
    // nothing to release: the JSON is intentionally dropped from the transcript.
    if (toolCalls.length === 0) {
      const remaining = result.content.slice(emitted);
      if (remaining !== "") yield { type: "text", text: remaining };
    }

    session.messages.push({
      role: "assistant",
      content: result.content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      await saveSession(session);
      yield { type: "done", steps };
      return;
    }

    for (const call of toolCalls) {
      const args = parseArguments(call.function.arguments);

      // Ask before anything that could hurt. The preview is computed without
      // touching the workspace, so declining really does leave it alone.
      const preview = await previewTool(call.function.name, call.function.arguments);
      let outcome: ToolOutcome | null = null;

      if (approvalRequired(call.function.name, preview)) {
        const approvalId = crypto.randomUUID();
        const summary = preview?.summary ?? `${call.function.name} needs approval`;
        yield {
          type: "approval_request",
          id: approvalId,
          name: call.function.name,
          summary,
          ...(preview?.diff ? { diff: preview.diff } : {}),
        };

        // The same name and summary the card shows, so a driver answering from
        // `GET /api/approvals` is deciding on what the browser would have shown.
        const decision = await requestApproval(approvalId, {
          name: call.function.name,
          summary,
          signal: options.signal,
        });
        yield { type: "approval_result", id: approvalId, decision };

        if (decision === "approve") {
          yield { type: "tool_call", id: call.id, name: call.function.name, args };
          outcome = await runTool(call.function.name, call.function.arguments);
        } else {
          // Hand the refusal back as a normal failed result, so the "do not
          // repeat a failing call" guard covers it too.
          outcome = {
            ok: false,
            content: `${denialReason(decision)} Do not repeat it unchanged - say what you wanted to do and ask how to proceed.`,
          };
        }
      } else {
        yield { type: "tool_call", id: call.id, name: call.function.name, args };
        outcome = await runTool(call.function.name, call.function.arguments);
      }

      toolsRan = true;
      let content = outcome.content;

      if (!outcome.ok) {
        const signature = `${call.function.name}:${call.function.arguments}`;
        if (signature === lastFailureSignature) {
          repeatedFailures += 1;
        } else {
          lastFailureSignature = signature;
          repeatedFailures = 1;
        }
        lastFailureMessage = outcome.content;

        // Intervening successes are ignored on purpose: a stuck loop often
        // alternates a failing call with a harmless read.
        if (repeatedFailures >= 2) {
          content +=
            "\n\nNote: you already made this exact call and it failed the same way. " +
            "Repeating it will not work - change the arguments or use a different tool.";
        }
      }

      session.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content,
        ...(outcome.diff ? { diff: outcome.diff } : {}),
      });

      yield {
        type: "tool_result",
        id: call.id,
        name: call.function.name,
        ok: outcome.ok,
        content,
        ...(outcome.diff ? { diff: outcome.diff } : {}),
      };
    }

    if (repeatedFailures >= STUCK_AFTER) {
      const message =
        `Stopped: the model repeated the same failing tool call ${repeatedFailures} times ` +
        `(${lastFailureSignature.split(":")[0]}) and was not adapting.\nLast error: ${lastFailureMessage.slice(0, 300)}\n` +
        "This usually means the model is too weak for the task. Try a stronger model, or restate the request with more specific instructions.";
      session.messages.push({ role: "assistant", content: `[stuck] ${message}` });
      await saveSession(session);
      yield { type: "error", message };
      yield { type: "done", steps };
      return;
    }

    await saveSession(session);
  }

  const notice = `Stopped after ${maxSteps} steps without finishing. Ask me to continue if there is more to do.`;
  session.messages.push({ role: "assistant", content: notice });
  await saveSession(session);
  yield { type: "text", text: notice };
  yield { type: "done", steps };
}
