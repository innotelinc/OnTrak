import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Shipping a terminal session.
 *
 * The interesting half is the failure: a push can be refused for a hundred reasons
 * that have nothing to do with the project — no forge configured, no token, a host
 * that is down — and in every one of them the work was still saved. So the test
 * pins that the project exists after a failed ship and that the error carries its
 * name, because "saved but not pushed" is a sentence a person needs to read.
 *
 * No network is reached: with no Atlas and no GitHub token, the publish path
 * refuses before it dials anything.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ship-test-"));
const workspace = path.join(scratch, "workspace");
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.AGENT_ATLAS_URL = "";
process.env.AGENT_GIT_TOKEN = "";
process.env.AGENT_REMOTE_ENABLED = "true";

const { defaultShipTarget, shipProject, ShipError } = await import("../ship.js");
const { listProjects } = await import("../projects.js");
const { setSelectedWorkspace } = await import("../scope.js");

test.after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

test("with no Atlas configured the default target is GitHub", () => {
  assert.equal(defaultShipTarget(), "github");
});

test("a ship that cannot push still saves the project, and says so", async () => {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "index.html"), "<h1>shipped</h1>\n");
  await setSelectedWorkspace("");

  const error = await shipProject({ name: "Ship Me" }).catch((caught: unknown) => caught);
  assert.ok(error instanceof ShipError, `expected a ShipError, got ${String(error)}`);
  assert.match(error.message, /saved “Ship Me” as a project, but the push failed/);
  assert.match(error.message, /GitHub token/);
  assert.equal(error.project?.name, "Ship Me");

  const projects = await listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "Ship Me");
  assert.equal(
    await fs.readFile(path.join(workspace, projects[0]!.dir, "index.html"), "utf8"),
    "<h1>shipped</h1>\n",
    "the files are in the project, not moved out of the workspace",
  );
});

test("an unknown target is refused before anything is saved", async () => {
  const before = (await listProjects()).length;
  await assert.rejects(() => shipProject({ name: "Nope", target: "dropbox" }), ShipError);
  assert.equal((await listProjects()).length, before);
});
