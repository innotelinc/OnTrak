#!/usr/bin/env node
/**
 * Connect a model provider to a running OmniRoute gateway.
 *
 * OmniRoute handles providers two ways:
 *
 *   1. A custom "node" (any OpenAI-compatible endpoint) plus a "connection"
 *      holding the key. A node on its own is not routable, so both are created.
 *   2. A built-in provider, connected with just a key. Built-in prefixes like
 *      `openrouter`, `groq` and `cerebras` are reserved, and asking for a custom
 *      node with one of those prefixes is an error — so we detect that and
 *      connect the built-in provider instead.
 *
 *   node scripts/add-provider.mjs --name OpenRouter \
 *     --base-url https://openrouter.ai/api/v1 --api-key sk-or-... --prefix openrouter
 *
 * Or via npm (note the extra --):
 *
 *   npm run provider:add -- --name Groq --api-key ... --prefix groq
 *
 * Every flag also reads an environment variable:
 *   --name      PROVIDER_NAME
 *   --base-url  PROVIDER_BASE_URL
 *   --api-key   PROVIDER_API_KEY
 *   --prefix    PROVIDER_PREFIX
 *   --url       OMNIROUTE_ADMIN_URL (default: OMNIROUTE_URL minus "/v1")
 */

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : undefined;
}

function envOr(name, key) {
  return flag(name) ?? process.env[key];
}

const apiKey = envOr("api-key", "PROVIDER_API_KEY");
if (apiKey === undefined || apiKey.trim() === "") fail("missing --api-key");

const name = envOr("name", "PROVIDER_NAME") ?? "Custom Provider";
const baseUrl = envOr("base-url", "PROVIDER_BASE_URL");
const prefix = envOr("prefix", "PROVIDER_PREFIX");

const adminUrl = (
  envOr("url", "OMNIROUTE_ADMIN_URL") ??
  (process.env.OMNIROUTE_URL ?? "http://127.0.0.1:20128/v1")
)
  .replace(/\/v1\/?$/, "")
  .replace(/\/+$/, "");

const gatewayKey = process.env.OMNIROUTE_API_KEY ?? "";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const providerName = name;
// The prefix becomes the model namespace: "groq" makes "groq/llama-3.3-70b".
const providerPrefix =
  prefix ?? providerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const headers = { "Content-Type": "application/json" };
if (gatewayKey !== "") headers.Authorization = `Bearer ${gatewayKey}`;

/** Call the gateway without exiting, so callers can inspect failure bodies. */
async function callRaw(pathname, init = {}) {
  let response;
  try {
    response = await fetch(`${adminUrl}${pathname}`, { headers, ...init });
  } catch (error) {
    fail(
      `cannot reach the OmniRoute gateway at ${adminUrl} (${error.cause?.code ?? error.message}).\n` +
        "  Start it with \"npm run gateway\", or pass --url to point somewhere else.",
    );
  }
  const text = await response.text();
  let body;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, body };
}

async function call(pathname, init = {}) {
  const result = await callRaw(pathname, init);
  if (!result.ok) {
    fail(
      `OmniRoute returned HTTP ${result.status} for ${pathname}\n  ${JSON.stringify(result.body).slice(0, 600)}`,
    );
  }
  return result.body;
}

console.log(`Gateway  ${adminUrl}`);
console.log(`Provider ${providerName} (prefix "${providerPrefix}")`);
if (baseUrl !== undefined) console.log(`Endpoint ${baseUrl}`);
console.log("");

// --- decide between a built-in provider and a custom node -------------------

let nodeId = null;
let builtinProvider = null;

const existingNodes = await call("/api/provider-nodes");
const nodes = Array.isArray(existingNodes.nodes) ? existingNodes.nodes : [];
const matchingNode = baseUrl === undefined ? undefined : nodes.find((entry) => entry.baseUrl === baseUrl);

if (matchingNode) {
  nodeId = matchingNode.id;
  console.log(`✓ Reusing custom node ${nodeId}`);
} else if (baseUrl !== undefined) {
  const validation = await call("/api/provider-nodes/validate", {
    method: "POST",
    body: JSON.stringify({ baseUrl, apiKey }),
  });
  if (validation.valid === true) {
    console.log("✓ Endpoint accepted the key");
  } else {
    console.log(`! Validation said: ${JSON.stringify(validation).slice(0, 300)}`);
    console.log("  Continuing anyway - some providers only answer on the real request.\n");
  }

  const attempt = await callRaw("/api/provider-nodes", {
    method: "POST",
    body: JSON.stringify({ name: providerName, prefix: providerPrefix, apiType: "chat", baseUrl, apiKey }),
  });

  if (attempt.ok && typeof attempt.body.id === "string") {
    nodeId = attempt.body.id;
    console.log(`✓ Created custom node ${nodeId}`);
  } else if (/reserved provider prefix/i.test(JSON.stringify(attempt.body))) {
    builtinProvider = providerPrefix;
    console.log(`✓ "${providerPrefix}" is a built-in provider in OmniRoute - connecting it directly`);
  } else {
    fail(
      `OmniRoute returned HTTP ${attempt.status} for /api/provider-nodes\n  ${JSON.stringify(attempt.body).slice(0, 600)}`,
    );
  }
} else {
  // No endpoint given: the prefix has to name a built-in provider.
  builtinProvider = providerPrefix;
  console.log(`No --base-url given, so treating "${providerPrefix}" as a built-in provider`);
}

// --- create the connection --------------------------------------------------

const connections = (await call("/api/providers")).connections ?? [];
const target = builtinProvider ?? nodeId;
if (connections.some((entry) => entry.provider === target)) {
  console.log("✓ A connection for this provider already exists - nothing to do");
} else {
  const created = await call("/api/providers", {
    method: "POST",
    body: JSON.stringify({ provider: target, name: providerName, apiKey }),
  });
  if (created.error) fail(`could not create the connection: ${JSON.stringify(created).slice(0, 400)}`);
  console.log("✓ Created the connection");
}

// --- report what is now routable -------------------------------------------

const catalog = await call("/v1/models");
const ids = (catalog.data ?? []).map((entry) => entry.id).filter((id) => typeof id === "string");
const models = ids.filter((id) => id.startsWith(`${providerPrefix}/`)).sort();

console.log("");
if (models.length === 0) {
  console.log(`No models are advertised under "${providerPrefix}/" yet.`);
  console.log("The gateway may need a moment, or the provider may not expose /models.");
} else {
  console.log(`${models.length} models are now routable. Free ones first:`);
  const free = models.filter((id) => /:free$/.test(id));
  const shown = (free.length > 0 ? free : models).slice(0, 12);
  for (const id of shown) console.log(`  ${id}`);
}
console.log("\nPick one in the UI's model selector, then send a message.");
