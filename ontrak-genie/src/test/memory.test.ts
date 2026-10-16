/**
 * The project's memory: what lands in `MEMORY.md`, and what a prompt is told.
 *
 * The file is the feature — visible in the tree, committed with the code, editable
 * by hand — so these pin its *shape*: one section per subject, entries dated and
 * newest last inside their own section rather than stacked at the end of the file,
 * and an empty memory that still tells the agent how to use it.
 *
 * The tool is exercised through `runTool`, because the part worth checking is what
 * a caller gets back: a diff and a sentence, exactly as `write_file` gives them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
 * The workspace is set **before** anything is imported, because `config` reads its
 * environment once, at module load — which is why the imports below are dynamic.
 * A static import here would load the configuration first and this suite would
 * write its memory file into whatever workspace the machine happened to have,
 * which is exactly the kind of test that passes while scribbling on the checkout.
 */
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "genie-memory-"));
process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = path.join(WORKSPACE, ".agent");

const { MEMORY_FILE, appendMemory, memoryForPrompt } = await import("../memory.js");
const { runTool } = await import("../tools.js");

const AT = new Date("2026-03-04T05:06:07.000Z");

test("the first thing remembered creates the file", () => {
  const memory = appendMemory("", { entry: "Build with npm run build.", section: "Build", at: AT });
  assert.match(memory, /^# Project memory/);
  assert.match(memory, /## Build\n\n- 2026-03-04: Build with npm run build\.\n$/);
});

test("an entry with no section goes under Notes", () => {
  const memory = appendMemory("", { entry: "The preview proxies /preview/.", at: AT });
  assert.match(memory, /## Notes\n\n- 2026-03-04: The preview proxies \/preview\/\./);
});

test("a new entry joins its section, not the end of the file", () => {
  const first = appendMemory("", { entry: "one", section: "Build", at: AT });
  const second = appendMemory(first, { entry: "two", section: "Traps", at: AT });
  const third = appendMemory(second, { entry: "three", section: "Build", at: AT });

  const build = third.slice(third.indexOf("## Build"));
  assert.match(build, /- 2026-03-04: one\n- 2026-03-04: three\n\n## Traps/, "newest last, and Traps still follows");
  assert.equal(third.match(/## Build/g)?.length, 1, "a section is not repeated");
});

test("a multi-line entry is one bullet", () => {
  const memory = appendMemory("", { entry: "first line\nsecond line", at: AT });
  assert.match(memory, /- 2026-03-04: first line second line/);
});

test("an empty entry is refused rather than written", () => {
  assert.throws(() => appendMemory("", { entry: "   " }), /nothing to remember/);
});

test("the prompt says how to use an empty memory, and carries a full one", () => {
  const empty = memoryForPrompt("");
  assert.match(empty, /Project memory: empty\./);
  assert.match(empty, /`remember` tool/);

  const filled = memoryForPrompt("# Project memory\n\n## Build\n\n- 2026-03-04: npm run build\n");
  assert.match(filled, /what earlier sessions recorded/);
  assert.match(filled, /## Build/);

  // A very long memory is bounded, and says where the rest is.
  const huge = memoryForPrompt("x".repeat(20_000));
  assert.match(huge, /memory truncated; read MEMORY\.md/);
  assert.ok(huge.length < 20_000);
});

/* ---------------------------------------------- the tool, in a real workspace */

test("the remember tool writes MEMORY.md and answers with a diff", async () => {
  const created = await runTool("remember", JSON.stringify({ entry: "Tests run on dist, not src.", section: "Build" }));
  assert.equal(created.ok, true);
  assert.match(created.content, /Created MEMORY\.md under "Build"/);
  assert.equal(created.diff?.added, 11, "a create is a diff like any other change");
  assert.ok(fs.existsSync(path.join(WORKSPACE, MEMORY_FILE)));

  const updated = await runTool("remember", JSON.stringify({ entry: "The preview proxies /preview/." }));
  assert.equal(updated.ok, true);
  assert.match(updated.content, /Updated MEMORY\.md under "Notes"/);
  assert.match(fs.readFileSync(path.join(WORKSPACE, MEMORY_FILE), "utf8"), /Tests run on dist, not src\./);

  const refused = await runTool("remember", JSON.stringify({ entry: "  " }));
  assert.equal(refused.ok, false, "an empty entry is a refusal, not an empty write");
});

test("a skill is listed, loaded and pointed at its own files, through the tools", async () => {
  // `list_skills` and `use_skill` are what a console chat has instead of the
  // terminal's `/skill`: the menu is in the prompt, and the playbook arrives when
  // the model asks for it.
  const dir = path.join(WORKSPACE, ".agent", "skills");
  fs.mkdirSync(path.join(dir, "audit", "reference"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "audit", "SKILL.md"),
    "---\nname: audit\ndescription: Review hierarchy and contrast\n---\nLook at the page first.\n",
  );
  fs.writeFileSync(path.join(dir, "audit", "reference", "checklist.md"), "- [ ] contrast\n");

  const listed = await runTool("list_skills", "{}");
  assert.equal(listed.ok, true);
  assert.match(listed.content, /audit\s+Review hierarchy and contrast/);

  const loaded = await runTool("use_skill", JSON.stringify({ name: "audit", task: "the settings page" }));
  assert.equal(loaded.ok, true);
  assert.match(loaded.content, /Applying skill "audit"/);
  assert.match(loaded.content, /<skill>\nLook at the page first\.\n<\/skill>/);
  assert.match(loaded.content, /own files are in .*audit — read them/);
  assert.match(loaded.content, /Task:\nthe settings page$/);

  const missing = await runTool("use_skill", JSON.stringify({ name: "nothing-like-this" }));
  assert.equal(missing.ok, false);
  assert.match(missing.content, /Available: audit/);
});
