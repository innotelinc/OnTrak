import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A rejected key, and the address a human is sent to when it happens.
 *
 * Two separate things made a key that was already fixed look broken for another
 * five minutes: the tenancy gate caches the account it resolved, so a key that
 * was rotated or re-minted keeps being replayed until that entry expires; and the
 * message telling somebody what to do named the address *this process* dials,
 * which in a deployed stack is a LAN one their browser cannot open. Each half
 * looks fine on its own, so both are asserted here.
 */

/** Every request the stub gateway saw, so the credential can be checked too. */
const seen: string[] = [];
const gateway = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "(none)"}`);
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ error: { code: "AUTH_002", message: "Invalid API key", correlation_id: "test" } }),
  );
});

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-auth-"));
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port;

// Read before the config is first imported, like every other test here.
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.AGENT_OFFLINE_URL = "";
process.env.AGENT_OFFLINE_MODELS = "";
process.env.AGENT_RETRY_ATTEMPTS = "1";
process.env.AGENT_RETRY_DELAY_MS = "0";
process.env.OMNIROUTE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AGENT_GATEWAY_CONSOLE_URL = "https://gateway.example.innotel.us";

const { runAgent } = await import("../agent.js");
const { createSession } = await import("../store.js");

test("a rejected key invalidates the cached account and names a browser-reachable console", async (t) => {
  t.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));

  let invalidations = 0;
  const events: any[] = [];
  for await (const event of runAgent({
    session: createSession(),
    userMessage: "reply with exactly: ok",
    apiKey: "sk-stale-key",
    onGatewayAuthFailure: () => {
      invalidations += 1;
    },
  })) {
    events.push(event);
  }

  const failure = events.find((event) => event.type === "error");
  assert.ok(failure, "a turn that could not answer has to say so");

  // The credential is the thing that failed, so the account must not stay
  // cached: that cache is what turns one rejected key into minutes of failures.
  assert.equal(invalidations, 1, "a 401 has to drop the cached account, exactly once");

  // A 401 is about the key, not the model, so no other model is worth trying.
  assert.equal(seen.length, 1, "a rejected key must not be replayed across the chain");
  assert.match(seen[0]!, /Bearer sk-stale-key/, "the turn's own key is what the gateway saw");

  assert.match(failure.message, /HTTP 401/);
  assert.match(
    failure.message,
    /https:\/\/gateway\.example\.innotel\.us/,
    "the direction has to name the browser-facing address",
  );
  assert.doesNotMatch(
    failure.message,
    new RegExp(`127\\.0\\.0\\.1:${port}`),
    "never the address this process dials",
  );
});

test("the console URL falls back to the dialled one when none is configured", async () => {
  // An override stays optional, so a single-operator checkout reads exactly what
  // it read before: the dialled address, minus the path a browser does not use.
  const { gatewayConsoleHref } = await import("../config.js");
  assert.equal(
    gatewayConsoleHref("http://192.168.1.71:20128/v1", ""),
    "http://192.168.1.71:20128",
  );
  assert.equal(
    gatewayConsoleHref("http://192.168.1.71:20128/v1", "https://gateway.example.innotel.us"),
    "https://gateway.example.innotel.us",
  );
  // And the deployed shape is the configured one, so the message this process
  // would print is the reachable address.
  const { gatewayConsoleUrl } = await import("../config.js");
  assert.equal(gatewayConsoleUrl(), "https://gateway.example.innotel.us");
});
