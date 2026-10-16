/**
 * The skill model: what a skill file is, what a directory of them loads to, and
 * what the model is shown.
 *
 * These are the decisions that make a skill *work* — the two on-disk shapes, the
 * block-scalar description half the ecosystem writes, which of two skills of the
 * same name wins, and what the prompt costs. The fetching is
 * `skill-install.test.ts`; the tools and the prompt assembly are exercised through
 * the modules that own them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeSkillMessage,
  describeSkills,
  findSkill,
  loadSkills,
  parseSkill,
  readFrontMatter,
  readSkillDir,
  skillMenu,
  slug,
} from "../skills.js";

/** A throwaway skills directory. */
function skillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-skills-"));
}

function writeFile(dir: string, rel: string, body: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return file;
}

test("a name is typeable whatever it was called", () => {
  assert.equal(slug("Release Check"), "release-check");
  assert.equal(slug("  Impeccable!!  "), "impeccable");
  assert.equal(slug("..."), "");
});

test("front matter is read, quotes and all", () => {
  const { name, description, body } = readFrontMatter(
    `---\nname: "release-check"\ndescription: 'Verify a release before tagging it'\nmetadata:\n  version: 1.2.3\n---\n\nRun the tests.\n`,
  );
  assert.equal(name, "release-check");
  assert.equal(description, "Verify a release before tagging it");
  assert.equal(body.trim(), "Run the tests.", "and the front matter is not in the body");
});

test("a block scalar description is read, not just its marker", () => {
  /*
   * `description: >` with the text underneath is how half the published skills
   * write a description that is a paragraph. Reading only the marker gave the model
   * a menu of skills described as ">" — which is a skill nobody would ever pick.
   */
  const folded = readFrontMatter(
    `---\nname: canvas\ndescription: >\n  A live React app the user can open\n  beside the chat.\n\n  Use it for charts.\nother: yes\n---\nbody\n`,
  );
  assert.equal(folded.name, "canvas");
  assert.equal(folded.description, "A live React app the user can open beside the chat. Use it for charts.");
  assert.equal(folded.body.trim(), "body", "and the block ends at the next key");

  const literal = readFrontMatter(`---\ndescription: |\n  first line\n  second line\n---\nbody\n`);
  assert.equal(literal.description, "first line\nsecond line");
});

test("a file with no front matter still becomes a skill", () => {
  const parsed = parseSkill("/skills/release-check.md", "Verify a release before tagging it.\n\nThen tag.\n");
  assert.equal(parsed?.name, "release-check", "the file name is the name");
  assert.equal(parsed?.description, "Verify a release before tagging it.", "the first line is the description");
  assert.equal(parsed?.body.startsWith("Verify a release"), true);

  assert.equal(parseSkill("/skills/empty.md", "   \n\n"), null, "nothing usable is nothing");
});

test("a long first line is cut for the menu", () => {
  const long = "x".repeat(400);
  const parsed = parseSkill("/skills/verbatim.md", `${long}\n`);
  assert.equal(parsed?.description.length, 120);
});

test("both shapes on disk load, and a directory keeps its reference files", () => {
  const dir = skillsDir();
  writeFile(dir, "release-check.md", "---\nname: release-check\ndescription: Verify a release\n---\nRun the tests.\n");
  writeFile(dir, path.join("impeccable", "SKILL.md"), "---\nname: impeccable\ndescription: Design guidance\n---\nBe deliberate.\n");
  writeFile(dir, path.join("impeccable", "reference", "audit.md"), "# audit\n");
  writeFile(dir, path.join("impeccable", ".source.json"), JSON.stringify({ repo: "pbakaus/impeccable", ref: "main", path: "skills/impeccable/SKILL.md", installedAt: "2026-01-01T00:00:00.000Z", files: 2 }));
  // A directory with no SKILL.md is not a skill, and a hidden entry is not read.
  writeFile(dir, path.join("notes", "scratch.md"), "not a skill\n");
  writeFile(dir, ".hidden.md", "name: hidden\n");

  const skills = loadSkills([dir]);
  assert.deepEqual(skills.map((skill) => skill.name), ["impeccable", "release-check"]);

  const directorySkill = skills[0];
  assert.equal(directorySkill?.dir, path.join(dir, "impeccable"));
  assert.deepEqual(directorySkill?.files, ["reference/audit.md"], "the playbook and provenance are not 'other files'");
  assert.equal(directorySkill?.provenance?.repo, "pbakaus/impeccable");
  assert.equal(skills[1]?.dir, undefined, "a single markdown file has no directory");
});

test("an earlier directory wins, so a project skill shadows a personal one", () => {
  const project = skillsDir();
  const personal = skillsDir();
  writeFile(project, path.join("style", "SKILL.md"), "---\nname: style\ndescription: The project's way\n---\nProject rules.\n");
  writeFile(personal, path.join("style", "SKILL.md"), "---\nname: style\ndescription: Somebody's way\n---\nPersonal rules.\n");

  const skills = loadSkills([project, personal]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.description, "The project's way");
});

test("a missing directory is empty, not an error", () => {
  assert.deepEqual(loadSkills([path.join(skillsDir(), "nope")]), []);
  assert.deepEqual(loadSkills([]), []);
});

test("a skill is found by name or by an unambiguous prefix", () => {
  const dir = skillsDir();
  writeFile(dir, "release-check.md", "---\nname: release-check\ndescription: x\n---\nbody\n");
  writeFile(dir, "refine.md", "---\nname: refine-web-design\ndescription: y\n---\nbody\n");
  const skills = loadSkills([dir]);
  assert.equal(findSkill(skills, "release-check")?.name, "release-check");
  assert.equal(findSkill(skills, "rel")?.name, "release-check");
  assert.equal(findSkill(skills, "re"), undefined, "an ambiguous prefix is not a match");
  assert.equal(findSkill(skills, "nothing"), undefined);
});

test("the menu names skills and truncates, and the body is not in it", () => {
  const dir = skillsDir();
  writeFile(dir, path.join("big", "SKILL.md"), `---\nname: big\ndescription: ${"d".repeat(400)}\n---\n${"BODY\n".repeat(50)}`);
  const skills = loadSkills([dir]);
  const menu = skillMenu(skills);
  assert.equal(menu.length, 1);
  assert.match(menu[0] ?? "", /^- big: d+…$/);
  assert.equal((menu[0] ?? "").includes("BODY"), false, "a playbook is fetched when it is wanted");
  assert.ok((menu[0] ?? "").length < 260, "and a menu entry is one line");
});

test("a composed message fences the playbook and leaves the task last", () => {
  const dir = skillsDir();
  writeFile(dir, path.join("audit", "SKILL.md"), "---\nname: audit\ndescription: Review it\n---\nLook at hierarchy.\n");
  writeFile(dir, path.join("audit", "reference", "checklist.md"), "- [ ] contrast\n");
  const skill = readSkillDir(path.join(dir, "audit"));
  assert.ok(skill !== null);

  const composed = composeSkillMessage(skill, "audit the settings page");
  assert.match(composed, /^Applying skill "audit"\./);
  assert.match(composed, /<skill>\nLook at hierarchy\.\n<\/skill>/);
  assert.match(composed, /reference\/checklist\.md|own files are in/);
  assert.match(composed, /Task:\naudit the settings page$/, "the task is what the model reads last");

  // No task means the skill's own instruction is the task.
  assert.match(composeSkillMessage(skill, "  "), /Do what the skill describes/);
});

test("an empty installation says how to fix it", () => {
  const lines = describeSkills([]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /genie skills add/);
});
