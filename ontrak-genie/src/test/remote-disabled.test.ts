import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Remote workspaces, switched off.
 *
 * `AGENT_REMOTE_ENABLED=false` has to mean *off* rather than half-on: a deployment
 * that has decided its console will not dial hosts of a caller's choosing must not
 * be reachable through any of the routes. This is a separate file because the
 * setting is read once, at import (like every other one), and the answer to
 * "what does this deployment allow" should not depend on which test ran first.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-remote-off-"));
process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = path.join(WORKSPACE, ".agent");
process.env.AGENT_REMOTE_ENABLED = "false";

const { cloneGitHub, connectSsh, remoteEnabled, RemoteError } = await import("../remote.js");
const { sshfsCommand, parseSshSpec } = await import("../remote-rules.js");

/** A runner that fails the test if it is ever asked to run something. */
const unused = async () => {
  throw new Error("nothing should have been run");
};
const deps = {
  run: unused,
  mounted: async () => true,
  fetchImpl: (async () => {
    throw new Error("nothing should have been fetched");
  }) as unknown as typeof fetch,
};

test("the deployment reports remote work as off", () => {
  assert.equal(remoteEnabled(), false);
});

test("a mount and a clone are both refused, and nothing is dialled", async () => {
  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /AGENT_REMOTE_ENABLED=false/);
      return true;
    },
  );
  await assert.rejects(
    () => cloneGitHub({ repo: "acme/widgets", token: "ghp_abc12345" }, deps),
    /AGENT_REMOTE_ENABLED=false/,
  );
});

test("the rules are still pure, so the refusal comes from the switch and not a parse", () => {
  // The spec this file refuses above is a perfectly valid one: what stops it is
  // the deployment's decision, which is the difference between a switch and a bug.
  assert.notEqual(parseSshSpec({ host: "dev.example.com", user: "deploy", path: "/srv/app" }), null);
  assert.match(
    sshfsCommand(
      { host: "dev.example.com", port: 22, user: "deploy", path: "/srv/app" },
      { mountPoint: "/tmp/m", knownHostsFile: "/tmp/kh" },
    ),
    /^sshfs /,
  );
});
