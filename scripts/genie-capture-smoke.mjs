/**
 * Post-deploy smoke: can Genie's agent still run a capture?
 *
 * A healthcheck cannot answer this. The REA MCP server used to die on its first
 * `capture_process_scenario` — SIGSEGV from the glibc PTY prebuild on a musl
 * image — while the container stayed healthy and every capture call failed. This
 * runs the real path instead: one turn through Genie's `/api/chat`, the agent
 * choosing the tool, and the tool's own result.
 *
 * Run it where GENIE_URL and WEB_TOKEN live — the deployment's g0dm0d3 container:
 *
 *   docker compose -f docker-compose.all.yml exec -T \
 *     -e GENIE_SMOKE_ACTOR=you@example.com g0dm0d3 \
 *     node --input-type=module - < scripts/genie-capture-smoke.mjs
 *
 * `make capture-smoke GENIE_SMOKE_ACTOR=…` does exactly that. The actor has to be
 * an account the control plane can resolve: Genie attributes the turn (and the
 * gateway key that pays for it) to that account, and will not invent one.
 *
 * Exit status: 0 when the capture ran, 1 when it did not, 2 when the check could
 * not be attempted. `GENIE_SMOKE_MODEL` overrides the model; the deployment's own
 * chain is used otherwise. `GENIE_SMOKE_TIMEOUT_MS` bounds the whole turn.
 */

const TOOL = "mcp__rea__capture_process_scenario";
const base = (process.env.GENIE_URL ?? "").replace(/\/$/, "");
const token = process.env.WEB_TOKEN ?? "";
const actor = (process.env.GENIE_SMOKE_ACTOR ?? "").trim();
const model = (process.env.GENIE_SMOKE_MODEL ?? "").trim();
const timeoutMs = Number(process.env.GENIE_SMOKE_TIMEOUT_MS ?? 240_000) || 240_000;

const fail = (message, status = 1) => {
  console.error(`capture-smoke: ${message}`);
  process.exit(status);
};

if (base === "") fail("GENIE_URL is unset; run this inside the deployment", 2);
if (actor === "") fail("GENIE_SMOKE_ACTOR is unset; name an account on this deployment", 2);

const prompt =
  `Use the rea MCP tool capture_process_scenario to run the command \`echo capture-smoke\` ` +
  `with a five second timeout, then reply in one sentence with the exit code.`;

const started = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
timer.unref?.();

let response;
try {
  response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      "x-genie-actor": actor,
    },
    body: JSON.stringify({ message: prompt, ...(model === "" ? {} : { model }) }),
    signal: controller.signal,
  });
} catch (error) {
  clearTimeout(timer);
  fail(`could not reach ${base}: ${error?.message ?? error}`, 2);
}

if (!response.ok || response.body === null) {
  clearTimeout(timer);
  const detail = await response.text().catch(() => "");
  fail(
    `Genie refused the turn (HTTP ${response.status})${detail === "" ? "" : `: ${detail.slice(0, 300)}`}` +
      (response.status === 401 ? " — is TRUSTED_ACTOR_HEADER on for this deployment?" : ""),
  );
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let call = null;
let result = null;
let streamError = "";

const consume = (frame) => {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (data === "" || data === "[DONE]") return;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  if (event.type === "tool_call" && String(event.name ?? "").includes(TOOL)) {
    call = event;
    console.log(`capture-smoke: agent called ${TOOL}`);
  }
  if (event.type === "tool_result" && String(event.name ?? "").includes(TOOL)) {
    result = event;
  }
  if (event.type === "error") streamError = String(event.message ?? "");
};

try {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      consume(frame);
    }
    if (result !== null) break;
  }
} catch (error) {
  clearTimeout(timer);
  fail(error?.name === "AbortError" ? `no tool result within ${timeoutMs} ms` : String(error));
}
clearTimeout(timer);
await reader.cancel().catch(() => {});

if (call === null) {
  fail(streamError === "" ? "the agent never called the capture tool" : `the turn failed: ${streamError}`);
}
if (result === null) fail("the capture tool returned no result");
if (result.ok === false) {
  fail(`the capture tool failed: ${String(result.content ?? "").slice(0, 300)}`);
}

let evidence = null;
try {
  evidence = JSON.parse(String(result.content ?? ""));
} catch {
  // The result is JSON in practice; a non-JSON body is reported below.
}
if (evidence === null || typeof evidence.evidence_id !== "string" || !evidence.evidence_id.startsWith("ev_")) {
  fail(`the tool answered without Evidence: ${String(result.content ?? "").slice(0, 300)}`);
}

const backend = evidence?.normalized_result?.manifest?.pty_backend;
console.log(
  `capture-smoke: ok — ${TOOL} returned ${evidence.evidence_id.slice(0, 15)}… ` +
    `(${backend ?? "unknown backend"}, ${Date.now() - started} ms)`,
);
