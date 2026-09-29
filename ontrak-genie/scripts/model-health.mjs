#!/usr/bin/env node
/**
 * Which of a gateway's advertised models can an agent actually use?
 *
 * A model catalog is not a menu. OmniRoute advertises every id its providers
 * *claim*, which routinely includes models that are out of credit, absent from
 * the provider's live catalog, or unable to accept a tool definition at all.
 * The failure is often a bare `400` or an empty reply, so a model that looks
 * great in a picker can fail the very first turn.
 *
 * This asks each candidate to make one real tool call and reports what came
 * back, because a structured `tool_calls` response is the only hard requirement
 * the agent loop has.
 *
 *   node scripts/model-health.mjs                      # 24 that claim tool calling
 *   node scripts/model-health.mjs --prefix gemini --all
 *   node scripts/model-health.mjs --model gemini/gemini-3-flash-preview --runs 3
 *   node scripts/model-health.mjs --all --json health.json
 *
 * Every flag also reads an environment variable:
 *   --url          OMNIROUTE_URL       (default: http://127.0.0.1:20128/v1)
 *   --api-key      OMNIROUTE_API_KEY
 *   --limit        MODEL_HEALTH_LIMIT  (default 24; --all ignores it)
 *   --concurrency  MODEL_HEALTH_CONCURRENCY (default 6)
 *   --timeout      MODEL_HEALTH_TIMEOUT_MS  (default 30000)
 *   --runs         MODEL_HEALTH_RUNS        (default 1)
 *
 * Exits 1 when nothing it probed worked, so it is usable as a check.
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] !== undefined && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : undefined;
}

function flagAll(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) values.push(args[i + 1]);
  }
  return values;
}

const has = (name) => args.includes(`--${name}`);

/** Read a value from the environment, then from .env, then use the default. */
function setting(flagName, envName, fallback) {
  const fromFlag = flag(flagName);
  if (fromFlag !== undefined) return fromFlag;
  if (process.env[envName]) return process.env[envName];
  return fallback;
}

function readDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

readDotEnv();

const rawUrl = setting("url", "OMNIROUTE_URL", "http://127.0.0.1:20128/v1");
const baseUrl = rawUrl.replace(/\/+$/, "");
const apiKey = setting("api-key", "OMNIROUTE_API_KEY", "");
const limit = Number.parseInt(setting("limit", "MODEL_HEALTH_LIMIT", "24"), 10);
const concurrency = Math.max(1, Number.parseInt(setting("concurrency", "MODEL_HEALTH_CONCURRENCY", "6"), 10));
const timeoutMs = Math.max(1000, Number.parseInt(setting("timeout", "MODEL_HEALTH_TIMEOUT_MS", "30000"), 10));
const runs = Math.max(1, Number.parseInt(setting("runs", "MODEL_HEALTH_RUNS", "1"), 10));
const prefixes = flagAll("prefix");
const only = flagAll("model");
const jsonPath = flag("json");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace and return its contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the file to read" } },
        required: ["path"],
      },
    },
  },
];

const PROMPT =
  "Use the read_file tool to read the file README.md. Do not guess its contents - call the tool.";

const headers = { "Content-Type": "application/json" };
if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;

async function fetchJson(url, init) {
  const response = await fetch(url, { headers, ...init });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { ok: response.ok, status: response.status, body };
}

/** Was this a real structured tool call, rather than prose describing one? */
function inspect(choice) {
  const message = choice?.message ?? {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length === 0) {
    const content = typeof message.content === "string" ? message.content.trim() : "";
    return {
      structured: false,
      reason:
        content === ""
          ? "empty response (no content, no tool call)"
          : "answered without calling the tool",
    };
  }
  const call = calls[0];
  const name = call?.function?.name;
  if (name !== "read_file") return { structured: false, reason: `called an unexpected tool (${name})` };
  let parsed = null;
  try {
    const raw = call?.function?.arguments;
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    parsed = null;
  }
  if (typeof parsed?.path !== "string" || parsed.path === "") {
    return { structured: false, reason: "tool call had no usable path argument" };
  }
  return { structured: true, reason: null };
}

/** A reason short enough to group by, without the JSON noise. */
function shortReason(status, body) {
  const message = body?.error?.message ?? body?.message ?? body?.raw;
  const text = typeof message === "string" ? message : JSON.stringify(body ?? {});
  const oneLine = text.split("\n")[0].trim();
  const trimmed = oneLine.length > 90 ? `${oneLine.slice(0, 87)}...` : oneLine;
  return `HTTP ${status}: ${trimmed || "(no message)"}`;
}

async function probeOnce(model) {
  const started = Date.now();
  let result;
  try {
    result = await fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0,
      }),
    });
  } catch (error) {
    const name = error?.name === "TimeoutError" ? "timed out" : (error?.cause?.message ?? error?.message);
    return { ok: false, ms: Date.now() - started, servedAs: null, reason: `unreachable: ${String(name).slice(0, 90)}` };
  }

  const ms = Date.now() - started;
  if (!result.ok) return { ok: false, ms, servedAs: null, reason: shortReason(result.status, result.body) };

  const choice = result.body?.choices?.[0];
  if (!choice) {
    return { ok: false, ms, servedAs: null, reason: shortReason(result.status, result.body) };
  }

  const verdict = inspect(choice);
  return {
    ok: verdict.structured,
    ms,
    servedAs: typeof result.body.model === "string" ? result.body.model : null,
    reason: verdict.reason,
  };
}

/**
 * Was this a verdict about the model, or about the gateway being busy?
 *
 * A big sweep hammers the shared credential pool, so throttling is something the
 * sweep causes rather than something it discovers. Reading a 429 as "this model
 * is broken" would be wrong, and it is the single easiest way to misread this
 * report.
 */
function isThrottled(reason) {
  return /HTTP 429|cooling down|rate.?limit|quota|too many requests|overload/i.test(reason);
}

/** No answer in time: under a burst this says more about the queue than the model. */
function isInconclusive(reason) {
  return /timed out|unreachable/i.test(reason);
}

function classify(reasons) {
  if (reasons.some(isThrottled)) return "throttled";
  if (reasons.some(isInconclusive)) return "slow";
  return "broken";
}

/** Probe a model `runs` times; it only passes if every run was a real call. */
async function probe(model) {
  const attempts = [];
  for (let i = 0; i < runs; i += 1) attempts.push(await probeOnce(model));
  const failures = attempts.filter((attempt) => !attempt.ok);
  const latencies = attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.ms).sort((a, b) => a - b);
  const reasons = [...new Set(failures.map((attempt) => attempt.reason))];
  return {
    id: model,
    ok: failures.length === 0,
    runs: attempts.length,
    passes: attempts.length - failures.length,
    ms: latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null,
    servedAs: attempts.find((attempt) => attempt.ok)?.servedAs ?? null,
    reasons,
    verdict: failures.length === 0 ? "works" : classify(reasons),
  };
}

// --- pick the candidates -----------------------------------------------------

const catalog = await fetchJson(`${baseUrl}/models`, { method: "GET" });
if (!catalog.ok || !Array.isArray(catalog.body?.data)) {
  console.error(
    `\n✗ Could not read the model list from ${baseUrl}/models\n  ${shortReason(catalog.status, catalog.body)}\n`,
  );
  process.exit(1);
}

const all = catalog.body.data
  .map((entry) => ({ id: entry?.id, tools: entry?.capabilities?.tool_calling }))
  .filter((entry) => typeof entry.id === "string");

/**
 * Take the first `count` ids round-robin across providers.
 *
 * A plain slice would be all `auto/*` combos, since those sort first - which
 * says nothing about whether any given provider works, and is the least useful
 * sample possible. One id per provider per round covers the gateway instead.
 */
function spread(ids, count) {
  const byPrefix = new Map();
  for (const id of ids) {
    const slash = id.indexOf("/");
    const prefix = slash === -1 ? "(none)" : id.slice(0, slash);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(id);
  }
  const buckets = [...byPrefix.values()];
  const picked = [];
  for (let round = 0; picked.length < count; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      if (round >= bucket.length) continue;
      picked.push(bucket[round]);
      added = true;
      if (picked.length >= count) break;
    }
    if (!added) break;
  }
  return picked;
}

let candidates;
if (only.length > 0) {
  candidates = only;
} else {
  // Only ask about models that claim tool calling; the rest can never drive the
  // agent loop, so probing them would just waste the gateway's rate limit.
  const claimsTools = all.filter((entry) => entry.tools !== false).map((entry) => entry.id);
  if (prefixes.length > 0) {
    const filtered = claimsTools.filter((id) => prefixes.some((p) => id.startsWith(p)));
    candidates = has("all") ? filtered : filtered.slice(0, limit);
  } else {
    candidates = has("all") ? claimsTools : spread(claimsTools, limit);
  }
}

if (candidates.length === 0) {
  console.error(`\n✗ Nothing to probe. The gateway reports ${all.length} models, none matching.\n`);
  process.exit(1);
}

// --- run ---------------------------------------------------------------------

console.log(`Gateway   ${baseUrl}`);
console.log(`Catalog   ${all.length} models, ${all.filter((e) => e.tools !== false).length} claiming tool calling`);
const prefixesSeen = new Set(candidates.map((id) => id.slice(0, Math.max(0, id.indexOf("/")))));
console.log(`Probing   ${candidates.length} model(s) across ${prefixesSeen.size} provider(s), ${runs} run(s) each`);
console.log(`          ${concurrency} at a time, ${timeoutMs} ms timeout`);
console.log("");

const results = [];
let next = 0;
let done = 0;

/**
 * Write the report as the sweep runs, not just at the end.
 *
 * A full `--all` sweep of a large catalog can take minutes, and a run that is
 * interrupted should still leave everything it learned on disk.
 */
function writeReport() {
  if (!jsonPath) return;
  fs.writeFileSync(
    path.resolve(process.cwd(), jsonPath),
    JSON.stringify(
      {
        url: baseUrl,
        catalogSize: all.length,
        candidates: candidates.length,
        probed: results.length,
        complete: results.length === candidates.length,
        results,
      },
      null,
      2,
    ),
  );
}

async function worker() {
  for (;;) {
    const index = next;
    next += 1;
    const model = candidates[index];
    if (model === undefined) return;
    const result = await probe(model);
    results.push(result);
    done += 1;
    if (jsonPath && done % 10 === 0) writeReport();
    const mark = result.ok ? "✓" : "✗";
    const detail = result.ok
      ? `${result.ms} ms${result.servedAs && result.servedAs !== model ? ` (served by ${result.servedAs})` : ""}`
      : result.reasons[0];
    console.log(`  ${mark} [${String(done).padStart(3)}/${candidates.length}] ${model} — ${detail}`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

// --- report ------------------------------------------------------------------

const passed = results.filter((result) => result.ok).sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
const failed = results.filter((result) => !result.ok);

console.log("");
console.log(`${passed.length}/${results.length} can drive the agent (structured tool call).`);

const throttled = failed.filter((result) => result.verdict === "throttled");
if (throttled.length > 0) {
  console.log(
    `\nNote: ${throttled.length} could not be measured at all - their credentials were cooling down.\n` +
      "A large sweep causes that itself, so it is not a verdict on those models.\n" +
      "Re-check the ones you care about on their own:",
  );
  console.log(`  npm run model:health -- --model ${throttled[0].id} --runs 3`);
}

if (passed.length > 0) {
  console.log("\nWorking, fastest first:");
  for (const result of passed) {
    const rerouted = result.servedAs && result.servedAs !== result.id ? `  (served by ${result.servedAs})` : "";
    console.log(`  ${String(result.ms ?? "?").padStart(6)} ms  ${result.id}${rerouted}`);
  }
}

if (failed.length > 0) {
  // Grouped, because the same failure usually repeats across many models and a
  // list of 300 identical lines hides the pattern.
  function report(title, explanation, subset) {
    if (subset.length === 0) return;
    const groups = new Map();
    for (const result of subset) {
      for (const reason of result.reasons.length > 0 ? result.reasons : ["unknown"]) {
        if (!groups.has(reason)) groups.set(reason, []);
        groups.get(reason).push(result.id);
      }
    }
    console.log(`\n${title} (${subset.length})${explanation ? ` — ${explanation}` : ""}:`);
    for (const [reason, models] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${models.length} × ${reason}`);
      for (const model of models.slice(0, 4)) console.log(`        ${model}`);
      if (models.length > 4) console.log(`        ...and ${models.length - 4} more`);
    }
  }

  report(
    "Broken",
    "a real verdict, and usually fixable in the gateway's provider settings",
    failed.filter((result) => result.verdict === "broken"),
  );
  report(
    "Throttled",
    "their credentials cooled down; this sweep is probably why",
    throttled,
  );
  report(
    "No answer in time",
    `nothing within ${timeoutMs} ms; under a burst that may just be the queue`,
    failed.filter((result) => result.verdict === "slow"),
  );
}

if (jsonPath) {
  writeReport();
  console.log(`\nWrote ${jsonPath}`);
}

console.log("\nPin one of the working ids as AGENT_MODEL, and keep a second as a fallback.");
process.exit(passed.length === 0 ? 1 : 0);
