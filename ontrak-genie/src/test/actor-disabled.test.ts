import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * `TRUSTED_ACTOR_HEADER` unset: the actor path is closed, even for a caller that
 * holds the shared bearer and names an address.
 *
 * This is the default a deployment gets, and it is the one that matters: a header
 * anyone can set is an identity only where a proxy is the sole way in, so nothing
 * here may be reached by accident. The plane is listening in this test, so a resolve
 * that did go out would be counted — and must not be.
 *
 * Separate from `actor.test.ts` because `config.ts` reads the environment once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "actor-disabled-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

/*
 * Run where no `.env` can be found.
 *
 * `config.ts` loads the repository's own `.env` at import (`process.loadEnvFile`),
 * and in this deployment that file sets `TRUSTED_ACTOR_HEADER=1`. Without this, the
 * file would measure the deployment instead of the fallback it exists to prove —
 * which is exactly how it first failed, once the line was added to the env file.
 */
const home = process.cwd();
process.chdir(scratch);
process.on("exit", () => {
  process.chdir(home);
});

let asked = 0;
const plane = http.createServer((_req, res) => {
  asked += 1;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sub: "s" }));
});
await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));

process.env.CONTROL_PLANE_INTERNAL_URL = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
process.env.CONTROL_INTERNAL_TOKEN = "plane-token-for-tests";
process.env.WEB_TOKEN = "shared-bearer-for-tests";
delete process.env.TRUSTED_ACTOR_HEADER;

const { actorEnabled, actorSession } = await import("../actor.js");

test.after(() => {
  plane.close();
  process.chdir(home);
});

test("the switch is off by default", () => {
  assert.equal(actorEnabled(), false);
});

test("a valid bearer and address are both ignored while the switch is off", async () => {
  const session = await actorSession({
    headers: { authorization: "Bearer shared-bearer-for-tests", "x-genie-actor": "operator@innotel.us" },
  } as unknown as http.IncomingMessage);
  assert.equal(session, null);
  assert.equal(asked, 0, "a closed actor path asks nobody");
});
