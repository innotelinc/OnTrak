import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A gate a driver can reach, and a record of who opened it.
 *
 * The prompt is what makes an unattended turn safe, so the two things that matter
 * are: a caller who is not watching the tab can find out what is waiting, and
 * every answer — including "nobody answered" — is filed with who gave it. These
 * cases pin both, because a gate whose questions cannot be seen, or whose answers
 * leave no trace, is not a gate.
 */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-approval-"));

// Read before the config is first imported, like every other test here.
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_WORKSPACE = path.join(dataDir, "workspace");

const { approvalLogPath, listPendingApprovals, pendingApprovals, requestApproval, resolveApproval } =
  await import("../approval.js");

/** Every decision filed so far, newest last. */
async function decisions() {
  const raw = await fs.readFile(approvalLogPath(), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("a prompt is listable while it waits, and filed when it is answered", async () => {
  const settled = requestApproval("prompt-1", { name: "run_command", summary: "rm -rf build" });

  const waiting = listPendingApprovals();
  assert.equal(waiting.length, 1, "the prompt has to be visible to a caller that is not watching");
  assert.equal(waiting[0]!.id, "prompt-1");
  assert.equal(waiting[0]!.name, "run_command");
  assert.equal(waiting[0]!.summary, "rm -rf build");
  assert.ok(waiting[0]!.expiresAt >= waiting[0]!.requestedAt, "a prompt says when it gives up on its own");

  assert.equal(resolveApproval("prompt-1", "approve", "someone@example.com"), true);
  assert.equal(await settled, "approve");
  assert.equal(pendingApprovals(), 0, "an answered prompt stops waiting");
  assert.deepEqual(listPendingApprovals(), []);

  const filed = (await decisions()).find((record) => record.id === "prompt-1");
  assert.ok(filed, "the decision has to be filed");
  assert.equal(filed.decision, "approve");
  assert.equal(filed.actor, "someone@example.com", "the record names who answered");
  assert.equal(filed.name, "run_command");
});

test("a prompt nobody answers is filed as the system's, not a person's", async () => {
  const settled = requestApproval("prompt-2", { name: "run_command", summary: "sleep 1", timeoutMs: 20 });

  assert.equal(await settled, "timeout");

  const filed = (await decisions()).find((record) => record.id === "prompt-2");
  assert.equal(filed.decision, "timeout");
  assert.equal(filed.actor, "system", "a timeout is not somebody deciding");
});

test("a cancelled prompt is not a denial", async () => {
  const controller = new AbortController();
  const settled = requestApproval("prompt-3", {
    name: "write_file",
    summary: "overwrite config",
    signal: controller.signal,
  });

  controller.abort();

  assert.equal(await settled, "aborted");

  const filed = (await decisions()).find((record) => record.id === "prompt-3");
  assert.equal(filed.decision, "aborted");
  assert.equal(filed.actor, "system");
  assert.equal(pendingApprovals(), 0);
});

test("answering something that is not waiting changes nothing", async () => {
  assert.equal(resolveApproval("never-asked", "approve"), false);
});
