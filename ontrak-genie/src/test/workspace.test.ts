import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Clearing the working directory, and the file history that went with it.
 *
 * The things worth pinning are the ones that would be a *quiet* bug: a clear that
 * takes the folder itself, a clear that takes `.git`, and a history drop that
 * leaves a diff rendering against a file nobody can see any more. The rest is
 * bookkeeping.
 *
 * Env is set before any module reads the config, exactly as `projects.test.ts`
 * does, so the workspace and the snapshot store land in a scratch directory.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-clear-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

const { clearDirectory, isDirectory, toRel, WorkspaceError } = await import("../workspace.js");
const { dropSnapshotsUnder, listSnapshots, saveSnapshot } = await import("../snapshots.js");
const { snapshotsDir, workspaceRoot } = await import("../scope.js");

test("clearing the working directory", async (t) => {
  await t.beforeEach(async () => {
    await fs.rm(workspaceRoot(), { recursive: true, force: true });
    await fs.mkdir(workspaceRoot(), { recursive: true });
    await fs.rm(snapshotsDir(), { recursive: true, force: true });
  });

  await t.test("removes the contents and keeps the folder", async () => {
    const root = workspaceRoot();
    await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "deep", "a.ts"), "a");
    await fs.writeFile(path.join(root, "README.md"), "hi");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "x");

    const result = await clearDirectory(root);

    assert.equal(await isDirectory(root), true, "the directory stays");
    await assert.rejects(() => fs.stat(path.join(root, "README.md")), "the file is gone");
    await assert.rejects(() => fs.stat(path.join(root, "src")), "the subtree is gone");
    assert.equal(result.removed, 2, "the two non-dot entries were removed");

    // Dot-entries are the point: identity and configuration survive a fresh start.
    assert.equal((await fs.stat(path.join(root, ".git", "config"))).isFile(), true);
    assert.equal((await fs.stat(path.join(root, ".env"))).isFile(), true);
    assert.deepEqual(result.kept.sort(), [".env", ".git"]);
  });

  await t.test("an already-empty directory is a no-op, not an error", async () => {
    const result = await clearDirectory(workspaceRoot());
    assert.equal(result.removed, 0);
    assert.deepEqual(result.kept, []);
  });

  await t.test("refuses a path outside the workspace", async () => {
    await assert.rejects(() => clearDirectory(path.join(scratch, "elsewhere")), WorkspaceError);
    await assert.rejects(() => clearDirectory(path.join(workspaceRoot(), "..", "..")), WorkspaceError);
  });
});

test("dropping the file history", async (t) => {
  await t.beforeEach(async () => {
    await fs.rm(snapshotsDir(), { recursive: true, force: true });
  });

  await t.test("drops a folder's history and leaves the rest", async () => {
    await saveSnapshot("src/a.ts", "old a");
    await saveSnapshot("src/deep/b.ts", "old b");
    await saveSnapshot("other.ts", "old other");

    const dropped = await dropSnapshotsUnder("src");

    assert.equal(dropped, 2);
    const left = await listSnapshots();
    assert.equal(left.has("other.ts"), true, "a sibling's history is untouched");
    assert.equal(left.has("src/a.ts"), false);
    assert.equal(left.has("src/deep/b.ts"), false);
  });

  await t.test("the working directory itself drops everything", async () => {
    await saveSnapshot("a.ts", "a");
    await saveSnapshot("nested/b.ts", "b");

    assert.equal(await dropSnapshotsUnder("."), 2);
    assert.equal((await listSnapshots()).size, 0);
  });

  await t.test("a missing store is a no-op, not an error", async () => {
    assert.equal(await dropSnapshotsUnder("."), 0);
  });
});

test("toRel names the working directory as \".\"", async (t) => {
  await t.beforeEach(async () => {
    await fs.rm(workspaceRoot(), { recursive: true, force: true });
    await fs.mkdir(workspaceRoot(), { recursive: true });
  });

  assert.equal(toRel(workspaceRoot()), ".");
  assert.equal(toRel(path.join(workspaceRoot(), "src", "a.ts")), "src/a.ts");
});
