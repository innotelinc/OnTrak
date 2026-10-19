import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A deployment with no control plane is a single-operator tool, and Engineer must
 * keep working there.
 *
 * Genie ships with no billing service; the gate therefore has to fail *open* and
 * say why, rather than refusing to analyse anything because `CONTROL_INTERNAL_TOKEN`
 * is unset. The plane is still listening on a real port in this test, so a request
 * that did go out would be counted — and must not be. (That a *placeholder* token also
 * reads as absent is `readControlPlaneConfig`'s rule, pinned in the control-plane
 * suite; nothing here could re-read the environment to check it.)
 *
 * Separate from `engineer.test.ts` because `config.ts` reads the environment once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "engineer-unset-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

let asked = 0;
const server = http.createServer((_req, res) => {
  asked += 1;
  res.writeHead(500).end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.CONTROL_PLANE_INTERNAL_URL = origin;
process.env.CONTROL_INTERNAL_TOKEN = "";

const { chargeProject, creditStatusFor } = await import("../engineer.js");

test.after(() => {
  server.close();
});

test("no token means no plane: the status is ungated and allows the work", async () => {
  const status = await creditStatusFor("atheniq@innotel.us");
  assert.equal(status.gated, false);
  assert.equal(status.allowed, true);
  assert.equal(status.unlimited, true);
  assert.match(status.reason, /no control plane configured/);
  assert.equal(asked, 0, "with no credential, nothing is asked");
});

test("no token means a charge is a no-op that says it was one", async () => {
  const charge = await chargeProject("atheniq@innotel.us", "proj-1");
  assert.equal(charge.gated, false);
  assert.equal(charge.spent, 0);
  assert.equal(charge.allowed, true);
  assert.equal(asked, 0);
});
