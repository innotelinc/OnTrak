import { config } from "./config.js";
import { completeChat, salvageToolCalls, type ChatMessage } from "./omniroute.js";
import { toolSchemas, tools } from "./tools.js";

/**
 * Is the configured model chain still able to do its job?
 *
 * The gateway advertises models it cannot serve, credentials cool down without
 * warning, and a provider can quietly run out of credit. None of that shows up
 * until a turn dies halfway through, which is a bad time to find out.
 *
 * This asks one small question per chain entry - can you make a tool call? - on a
 * timer, and the answer is reported by `GET /api/health` so the UI can show it.
 *
 * Two deliberate limits: only the *chain* is probed, never the catalog (a sweep
 * of 374 models would take minutes and rate-limit the providers it is measuring),
 * and the probes run one at a time, for the same reason.
 *
 * A bulk catalog sweep is a different job - see `scripts/model-health.mjs`.
 */

export interface ModelHealthEntry {
  model: string;
  /** True for entries served by the offline gateway rather than the main one. */
  offline: boolean;
  ok: boolean;
  ms: number | null;
  error: string | null;
}

export interface ModelHealthReport {
  /** null until the first check has finished. */
  checkedAt: string | null;
  /** The configured interval; 0 means the check is switched off. */
  intervalMs: number;
  entries: ModelHealthEntry[];
  working: number;
  total: number;
}

const PROBE_TIMEOUT_MS = 30_000;

/** A short, single-line reason - the same rule the UI notices use for errors. */
function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? text.trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * The prompt mirrors the one the bulk script uses: it has to invite a tool call,
 * and it must not depend on anything being in the workspace, since the agent's
 * workspace is not where the probe runs.
 */
const PROBE_MESSAGES: ChatMessage[] = [
  {
    role: "user",
    content: "Use the read_file tool to read the file README.md. Call the tool rather than guessing.",
  },
];

export interface HealthTarget {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Every entry a turn could be placed on, in order, deduplicated.
 *
 * This includes the **free pool** as well as the configured chain, and the free
 * pool is the reason: `modelSelect.ts` orders an automatic turn by this probe, so
 * a model the probe never asks about is a model the automatic chain can never
 * prefer. The two lists overlap in a typical deployment, so duplicates are
 * collapsed — a model probed twice would be two entries in the report and two
 * requests against a provider that is already rate-limiting.
 */
export function healthTargets(): HealthTarget[] {
  const seen = new Set<string>();
  const targets: HealthTarget[] = [];
  const add = (target: HealthTarget): void => {
    const key =
      target.baseUrl === undefined ? target.model : `${target.baseUrl}\u0000${target.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const model of [config.model, ...config.fallbackModels]) add({ model });
  for (const model of config.freeModels) add({ model });
  if (config.offlineUrl !== "") {
    for (const model of config.offlineModels) {
      add({ model, baseUrl: config.offlineUrl, apiKey: config.offlineKey });
    }
  }
  return targets;
}

export interface ToolCallProbe {
  ok: boolean;
  ms: number | null;
  /** The model that actually answered, when the gateway names one. */
  servedAs: string | null;
  error: string | null;
}

/**
 * Ask one model to make one real tool call.
 *
 * Shared by the timed chain check and the catalog sweep in `src/sweep.ts`, so
 * both judge a model exactly the way the agent does.
 */
export async function probeToolCall(target: HealthTarget, timeoutMs = PROBE_TIMEOUT_MS, signal?: AbortSignal): Promise<ToolCallProbe> {
  const started = Date.now();
  // Combined with the caller's signal so an in-flight probe stops with the server.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const result = await completeChat({
      messages: PROBE_MESSAGES,
      tools: toolSchemas(),
      model: target.model,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      signal: combined,
    });
    const ms = Date.now() - started;
    const servedAs = result.servedModel;

    // Judge this the way the agent does, not the way the spec reads. A small
    // local model normally prints `{"name": "read_file", ...}` as text instead of
    // using the structured channel, and the agent salvages that - so counting it
    // as a failure here would report a working offline model as broken.
    const names = new Set(tools.map((tool) => tool.name));
    const calls = [...result.toolCalls, ...salvageToolCalls(result.content, names)].map(
      (call) => call.function.name,
    );

    if (calls.length === 0) {
      // Reachable but useless to an agent, which is worse than being down.
      return { ok: false, ms, servedAs, error: "answered without calling the tool" };
    }
    if (!calls.includes("read_file")) {
      return { ok: false, ms, servedAs, error: `called a different tool (${calls[0]})` };
    }
    return { ok: true, ms, servedAs, error: null };
  } catch (error) {
    return {
      ok: false,
      ms: null,
      servedAs: null,
      error: firstLine((error as Error).message ?? String(error)),
    };
  }
}

async function probeModel(target: HealthTarget, signal?: AbortSignal): Promise<ModelHealthEntry> {
  const probe = await probeToolCall(target, PROBE_TIMEOUT_MS, signal);
  return {
    model: target.model,
    offline: target.baseUrl !== undefined,
    ok: probe.ok,
    ms: probe.ms,
    error: probe.error,
  };
}

let report: ModelHealthReport = {
  checkedAt: null,
  intervalMs: config.healthIntervalMs,
  entries: [],
  working: 0,
  total: 0,
};

let running = false;
const timers: NodeJS.Timeout[] = [];

/** The most recent result. Never throws, and is cheap enough to call per request. */
export function modelHealth(): ModelHealthReport {
  return report;
}

/** Run every probe now. Concurrent calls join the one already in flight. */
export async function refreshModelHealth(signal?: AbortSignal): Promise<ModelHealthReport> {
  if (running) return report;
  running = true;
  try {
    const entries: ModelHealthEntry[] = [];
    for (const target of healthTargets()) {
      entries.push(await probeModel(target, signal));
    }
    report = {
      checkedAt: new Date().toISOString(),
      intervalMs: config.healthIntervalMs,
      entries,
      working: entries.filter((entry) => entry.ok).length,
      total: entries.length,
    };
    return report;
  } finally {
    running = false;
  }
}

/**
 * Start the timer. Called by the entrypoint only - importing this module must
 * never spend a request, or a test would consume the gateway it stands up.
 */
export function startModelHealthLoop(): void {
  if (config.healthIntervalMs <= 0 || timers.length > 0) return;

  // One check shortly after boot so the UI has something to show, then a steady
  // interval. Both are unref'd: a health check must never keep the process alive.
  const kickoff = setTimeout(() => void refreshModelHealth(), 5_000);
  kickoff.unref();
  timers.push(kickoff);

  const interval = setInterval(() => void refreshModelHealth(), config.healthIntervalMs);
  interval.unref();
  timers.push(interval);
}

/** Stop the timer. Only used by tests. */
export function stopModelHealthLoop(): void {
  for (const timer of timers.splice(0)) {
    clearTimeout(timer);
    clearInterval(timer);
  }
}
