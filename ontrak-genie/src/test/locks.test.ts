import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * One writer per file.
 *
 * The failure this prevents is silent: two turns editing one file both read it,
 * both write, and the second write wins while both are told they succeeded. So the
 * tests are about the *second* writer — it must be told, by the tool, that the file
 * is busy, and that answer must not be a generic tool failure the model reads as a
 * bad argument.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "locks-test-"));
const workspace = path.join(scratch, "workspace");
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
await fs.mkdir(workspace, { recursive: true });

const { FileLockedError, activeLocks, lockedByOther, releaseLocks, runAsLockOwner, withFileLock } = await import(
  "../locks.js"
);
const { runTool } = await import("../tools.js");

test.after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Start holding a lock, returning the handle and a way to end it. */
async function hold(rel: string, owner: string): Promise<{ done: Promise<unknown>; release: () => void }> {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withFileLock(rel, owner, async () => {
    await gate;
    return "held";
  });
  // The hold is registered synchronously inside `withFileLock`, but a turn's
  // scheduling means waiting for the observable state is the honest check.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (activeLocks().some((lock) => lock.path === rel)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { done, release };
}

test("a second turn is refused while a file is being changed", async () => {
  await fs.writeFile(path.join(workspace, "a.txt"), "original\n", "utf8");
  const held = await hold("a.txt", "session-one");
  try {
    const error = await withFileLock("a.txt", "session-two", async () => "should not run").catch(
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof FileLockedError, `expected FileLockedError, got ${String(error)}`);
    assert.equal(error.path, "a.txt");
    assert.equal(error.holder, "session-one");
    assert.match(error.message, /being changed by another turn/);
    assert.match(error.message, /nothing was written/);
    assert.match(error.message, /make this change again/);
    // The lock is a claim about the file, not about the spelling of its path.
    assert.ok(lockedByOther("./a.txt", "session-two") !== null);
    assert.equal(lockedByOther("a.txt", "session-one"), null, "the holder is not blocked by itself");
  } finally {
    held.release();
    await held.done;
  }
});

test("the same turn may re-enter, and the outer hold still releases once", async () => {
  await fs.writeFile(path.join(workspace, "b.txt"), "b\n", "utf8");
  const held = await hold("b.txt", "session-one");
  try {
    const nested = await withFileLock("b.txt", "session-one", async () => "inner");
    assert.equal(nested, "inner");
    assert.ok(lockedByOther("b.txt", "session-two") !== null, "the inner call must not release the outer hold");
  } finally {
    held.release();
    await held.done;
  }
  assert.equal(activeLocks().length, 0, "the outer hold releases it");
});

test("a change that throws leaves the file unlocked", async () => {
  await assert.rejects(
    () =>
      withFileLock("c.txt", "session-one", async () => {
        throw new Error("the write failed");
      }),
    /the write failed/,
  );
  assert.equal(lockedByOther("c.txt", "session-two"), null);
});

test("a file locked by a turn that is gone is released by name", () => {
  const held = withFileLock("d.txt", "abandoned-turn", async () => {
    // A promise that never settles, like a tool whose sandbox was killed.
    await new Promise(() => {});
    return "never";
  });
  void held.catch(() => {});
  assert.equal(releaseLocks("abandoned-turn"), 1);
  assert.equal(lockedByOther("d.txt", "session-two"), null);
  assert.equal(releaseLocks("abandoned-turn"), 0, "releasing twice is not an error");
});

test("the tool tells the model which file is busy, and does not write", async () => {
  await fs.writeFile(path.join(workspace, "e.txt"), "alpha\n", "utf8");
  const held = await hold("e.txt", "session-one");
  try {
    const outcome = await runAsLockOwner("session-two", () =>
      runTool("edit_file", JSON.stringify({ path: "e.txt", oldString: "alpha", newString: "beta" }), "session-two"),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.content, /e\.txt is being changed by another turn/);
    assert.equal(await fs.readFile(path.join(workspace, "e.txt"), "utf8"), "alpha\n");
  } finally {
    held.release();
    await held.done;
  }

  // And once the turn is over, the same edit lands.
  const after = await runTool(
    "edit_file",
    JSON.stringify({ path: "e.txt", oldString: "alpha", newString: "beta" }),
    "session-two",
  );
  assert.equal(after.ok, true);
  assert.equal(await fs.readFile(path.join(workspace, "e.txt"), "utf8"), "beta\n");
});

test("a lock cannot be taken on a path outside the workspace", async () => {
  await assert.rejects(() => withFileLock("../escape.txt", "session-one", async () => "no"), /escapes the workspace/);
});
