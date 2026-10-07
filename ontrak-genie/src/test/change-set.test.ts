import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Propose then commit (v0.4).
 *
 * The roadmap asked for a queued write a reviewer approves as a *set*, rather than
 * one write at a time. These cases hold the three things that make it a review
 * rather than a second way to write:
 *
 *   * in propose mode the file tool stages and does **not** write — the file is
 *     still absent (or unchanged) until a commit;
 *   * the same path proposed twice is **one** entry, the later one winning, so a
 *     reviewer approves the net change and not every revision;
 *   * applying writes the staged bytes and clears the set, and discarding writes
 *     nothing.
 *
 * The write mode and the workspace are read once, at import, so this file sets them
 * before it imports anything.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-change-"));
process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = path.join(WORKSPACE, ".agent");
process.env.AGENT_WRITE_MODE = "propose";

const { addEntry, changeSetSummary, sortEntriesForApply, totalChanges, hasEntries } = await import(
  "../change-set.js"
);
const { applyChangeSet, currentChangeSet, discardChangeSet, resetChangeSets, stageChange } = await import(
  "../proposals.js"
);
const { runTool } = await import("../tools.js");
type StagedEntry = import("../change-set.js").StagedEntry;

function entry(over: Partial<StagedEntry> & { path: string }): StagedEntry {
  return { kind: "create", content: "", added: 0, removed: 0, ...over };
}

test("a later proposal for a path replaces the earlier one", () => {
  let entries: StagedEntry[] = [];
  entries = addEntry(entries, entry({ path: "a.txt", content: "first", added: 1 }));
  entries = addEntry(entries, entry({ path: "b.txt", content: "b", added: 1 }));
  entries = addEntry(entries, entry({ path: "a.txt", content: "second", added: 2, kind: "overwrite" }));
  assert.equal(entries.length, 2, "one entry per path");
  assert.equal(entries.find((e) => e.path === "a.txt")?.content, "second");
  // Order is preserved for a path already present: a.txt keeps its position.
  assert.deepEqual(entries.map((e) => e.path), ["a.txt", "b.txt"]);
});

test("totals and summary count files and lines", () => {
  const entries = [
    entry({ path: "a.ts", added: 3, removed: 1 }),
    entry({ path: "b.ts", added: 2, removed: 4 }),
  ];
  assert.deepEqual(totalChanges(entries), { files: 2, added: 5, removed: 5 });
  assert.equal(changeSetSummary(null), "no proposed changes");
  assert.equal(changeSetSummary({ id: "x", createdAt: "now", entries: [] }), "no proposed changes");
  assert.equal(changeSetSummary({ id: "x", createdAt: "now", entries }), "2 files (+5 −5)");
  assert.equal(hasEntries(null), false);
  assert.equal(hasEntries({ id: "x", createdAt: "now", entries }), true);
});

test("apply order is deterministic, by path", () => {
  const entries = [entry({ path: "z.ts" }), entry({ path: "a/b.ts" }), entry({ path: "a/a.ts" })];
  assert.deepEqual(sortEntriesForApply(entries).map((e) => e.path), ["a/a.ts", "a/b.ts", "z.ts"]);
});

test("propose mode stages a write instead of writing it", async () => {
  resetChangeSets();
  const outcome = await runTool("write_file", JSON.stringify({ path: "hello.txt", content: "hi\n" }));
  assert.equal(outcome.ok, true);
  assert.match(outcome.content, /Proposed creation of hello\.txt/);
  assert.match(outcome.content, /Nothing has been written/);

  // The whole point: the file is not on disk yet.
  await assert.rejects(fs.readFile(path.join(WORKSPACE, "hello.txt")), /ENOENT/);

  const set = currentChangeSet();
  assert.equal(set?.entries.length, 1);
  assert.equal(set?.entries[0]?.path, "hello.txt");
});

test("applying writes the staged bytes and clears the set", async () => {
  resetChangeSets();
  await runTool("write_file", JSON.stringify({ path: "a.txt", content: "one\n" }));
  await runTool("write_file", JSON.stringify({ path: "a.txt", content: "two\n" }));
  // A second path, to prove a set applies more than one file.
  await runTool("write_file", JSON.stringify({ path: "b.txt", content: "bee\n" }));

  assert.equal(currentChangeSet()?.entries.length, 2, "one entry per path");

  const result = await applyChangeSet("tester");
  assert.equal(result.applied, 2);
  assert.deepEqual(result.paths, ["a.txt", "b.txt"], "applied in path order");
  assert.equal(await fs.readFile(path.join(WORKSPACE, "a.txt"), "utf8"), "two\n", "the later proposal won");
  assert.equal(await fs.readFile(path.join(WORKSPACE, "b.txt"), "utf8"), "bee\n");
  assert.equal(currentChangeSet(), null, "the set is closed after it lands");
});

test("an edit is staged against the file as it is, and composes", async () => {
  resetChangeSets();
  await runTool("write_file", JSON.stringify({ path: "c.txt", content: "alpha\n" }));
  await applyChangeSet("tester");

  const outcome = await runTool(
    "edit_file",
    JSON.stringify({ path: "c.txt", oldString: "alpha", newString: "beta" }),
  );
  assert.equal(outcome.ok, true);
  assert.match(outcome.content, /Proposed edit to c\.txt/);
  assert.equal(await fs.readFile(path.join(WORKSPACE, "c.txt"), "utf8"), "alpha\n", "not written yet");

  // A second edit is computed against the file as it still is, so it is refused
  // when its anchor is not there — exactly as a direct edit would be.
  const missing = await runTool(
    "edit_file",
    JSON.stringify({ path: "c.txt", oldString: "gamma", newString: "delta" }),
  );
  assert.equal(missing.ok, false);

  await applyChangeSet("tester");
  assert.equal(await fs.readFile(path.join(WORKSPACE, "c.txt"), "utf8"), "beta\n");
});

test("discarding writes nothing", async () => {
  resetChangeSets();
  await runTool("write_file", JSON.stringify({ path: "gone.txt", content: "nope\n" }));
  assert.equal(discardChangeSet("tester"), true);
  assert.equal(currentChangeSet(), null);
  await assert.rejects(fs.readFile(path.join(WORKSPACE, "gone.txt")), /ENOENT/);
  assert.equal(discardChangeSet("tester"), false, "nothing left to discard");
});

test("staging by hand and applying is the same path the tools take", async () => {
  resetChangeSets();
  stageChange({ path: "manual.txt", kind: "create", content: "by hand\n", added: 1, removed: 0 });
  assert.equal(currentChangeSet()?.entries.length, 1);
  await applyChangeSet("tester");
  assert.equal(await fs.readFile(path.join(WORKSPACE, "manual.txt"), "utf8"), "by hand\n");
});
