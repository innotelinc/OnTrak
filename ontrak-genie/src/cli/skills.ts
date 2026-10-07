/**
 * Skills — reusable instructions the CLI can hand the agent.
 *
 * A skill is a markdown playbook with a name and a one-line description. It is
 * how a team writes down "how we do X here" once and then invokes it, rather
 * than typing the same paragraph of context into every chat.
 *
 * The server takes a `message` and nothing else, so a skill is applied by
 * **composing the message**: the playbook's body is prepended to the task,
 * fenced off and labelled, so the model can tell the instruction from the
 * request. That is deliberately a composition and not a second system prompt —
 * there is no hidden state, and what was sent is what `/last` will show.
 *
 * The format is the one everybody already writes: optional front matter for
 * `name` and `description`, then the body.
 *
 *   ---
 *   name: release-check
 *   description: Verify a release before tagging it
 *   ---
 *   Run the test suite, then the typecheck, then …
 *
 * With no front matter the file name is the name and the first non-empty line
 * is the description, because a directory of plain markdown should still work.
 */

import fs from "node:fs";
import path from "node:path";

export interface Skill {
  /** Invoked as `/skill <name>`; lower-cased and slugged. */
  name: string;
  description: string;
  /** Where it came from, shown by `/skills`. */
  source: string;
  body: string;
}

/** Slug a name into something typeable. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse one skill file. Returns null when there is nothing usable in it. */
export function parseSkill(file: string, raw: string): Skill | null {
  let body = raw.replace(/^\uFEFF/, "");
  let name = "";
  let description = "";

  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (front) {
    const matter = front[1] ?? "";
    body = body.slice(front[0].length);
    for (const line of matter.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = (match[1] ?? "").toLowerCase();
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (key === "name") name = value;
      else if (key === "description") description = value;
    }
  }

  const trimmedBody = body.trim();
  if (trimmedBody === "") return null;

  if (name === "") name = path.basename(file).replace(/\.(md|markdown|txt)$/i, "");
  if (description === "") {
    description = trimmedBody.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
    if (description.length > 120) description = `${description.slice(0, 117)}…`;
  }

  const slugged = slug(name);
  if (slugged === "") return null;
  return { name: slugged, description, source: file, body: trimmedBody };
}

/** Every `*.md` skill in a directory, sorted by name. Missing dirs are simply empty. */
export function loadSkills(dirs: string[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // A directory that does not exist is not a problem.
    }
    for (const entry of entries) {
      if (!/\.(md|markdown|txt)$/i.test(entry)) continue;
      const file = path.join(dir, entry);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const skill = parseSkill(file, raw);
      if (skill === null) continue;
      // Earlier directories win, so a project skill can shadow a personal one.
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compose the message a skill turns into.
 *
 * The playbook is fenced and the task is left last, because a model reads the
 * end of a prompt most reliably and the task is what must not be missed.
 */
export function composeSkillMessage(skill: Skill, task: string): string {
  const header = `Applying skill "${skill.name}".`;
  const request = task.trim() === "" ? "Do what the skill describes for this workspace." : task.trim();
  return [
    header,
    "",
    "<skill>",
    skill.body,
    "</skill>",
    "",
    "Task:",
    request,
  ].join("\n");
}

/** A compact list for `/skills`. */
export function describeSkills(skills: Skill[]): string[] {
  if (skills.length === 0) {
    return ["no skills found — add a markdown file to ~/.config/ontrak-genie/skills or ./.genie/skills"];
  }
  return skills.map((skill) => `  ${skill.name.padEnd(18)} ${skill.description}`);
}
