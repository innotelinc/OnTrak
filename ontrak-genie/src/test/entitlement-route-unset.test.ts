import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A control-plane endpoint with no internal token is a misconfiguration, not a
 * refusal.
 *
 * The distinction is the point of the entitlement module: telling a paying
 * subscriber their plan is inactive because this deployment forgot a secret is the
 * one wrong answer. So the call throws, and the caller decides — a preview name is
 * refused, while Atlas falls back to the deployment credential. This file is
 * separate from `entitlement-route.test.ts` because `config.ts` reads the
 * environment exactly once per process.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "entitlement-route-unset-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

let asked = 0;
const server = http.createServer((_req, res) => {
  asked += 1;
  res.writeHead(200, { "content-type": "application/json" }).end("{}\"entitled\":false");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

process.env.MAGNATE_ENTITLEMENTS_URL = `http://127.0.0.1:${port}/api/internal/entitlement`;
process.env.CONTROL_INTERNAL_TOKEN = "";
process.env.ENTITLEMENTS_API_TOKEN = "";

const { checkEntitlement, EntitlementError } = await import("../entitlements.js");

test.after(() => {
  server.close();
});

test("a control-plane endpoint without an internal token is an error, and nothing is asked", async () => {
  await assert.rejects(
    checkEntitlement({
      plan: "genie",
      user: "atheniq@innotel.us",
      unavailable: "custom preview names are unavailable",
    }),
    (error: unknown) => {
      assert.equal(error instanceof EntitlementError, true);
      assert.match((error as Error).message, /CONTROL_INTERNAL_TOKEN is unset/);
      assert.match((error as Error).message, /custom preview names are unavailable/);
      return true;
    },
  );
  assert.equal(asked, 0, "a request without the credential must not be sent");
});
