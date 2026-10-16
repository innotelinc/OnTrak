/**
 * Skills — reusable instructions a project, an account or a deployment keeps.
 *
 * A skill is a markdown playbook with a name and a one-line description: how *we*
 * do X here, written down once instead of retyped into every chat. The format is
 * the one everybody already uses — `SKILL.md` with optional front matter for
 * `name` and `description`, then the body — and it is deliberately the same format
 * the wider ecosystem ships, so a skill from a public repository can be installed
 * and used without being rewritten (`skill-install.ts`).
 *
 * TWO SHAPES ON DISK
 * ------------------
 *   * a single markdown file: `<skills>/release-check.md`
 *   * a **directory** with `SKILL.md` in it: `<skills>/impeccable/SKILL.md`, plus
 *     whatever else the skill needs — `reference/*.md`, templates, scripts. The
 *     body is what gets injected; the rest is on disk for the agent to read when
 *     the playbook points at it, and `use_skill` says where that directory is.
 *
 * The directory shape exists because a real skill is more than a paragraph: the
 * design skill this console can install is one `SKILL.md` and twenty-odd reference
 * files, and flattening that into one blob would lose exactly the part a long
 * playbook depends on.
 *
 * WHY THIS IS SHARED CODE
 * -----------------------
 * The CLI composes a skill into a message (`composeSkillMessage`) because a
 * terminal has no other way to hand one over. The server offers the same skills to
 * a console chat as tools, because a chat is a conversation with a model that can
 * ask for one. Both read the same files through `loadSkills`, so "the skill I
 * installed" means the same thing in both places, and a skill cannot work in the
 * terminal and quietly be absent from the console.
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
  /**
   * The directory holding the skill, when it is the directory shape — what the
   * agent needs in order to read the files the playbook refers to. Absent for a
   * single markdown file.
   */
  dir?: string;
  /** Other files that came with it, relative to `dir`. */
  files?: string[];
  /** What `install` recorded, when it recorded anything (`.source.json`). */
  provenance?: SkillProvenance;
}

/** The provenance an installed skill carries, so `skills list` can say where from. */
export interface SkillProvenance {
  repo: string;
  ref: string;
  path: string;
  installedAt: string;
  files: number;
}

export const SKILL_FILE = "SKILL.md";
export const SOURCE_FILE = ".source.json";

/** Slug a name into something typeable. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Read the front matter `name` and `description` without validating anything else.
 *
 * Deliberately forgiving, and deliberately not a YAML parser: the two fields this
 * needs are scalars on their own line, which is what every skill in the wild
 * writes, and a dependency (or a hand-rolled parser that half-works) would be a
 * worse trade than ignoring a field nobody reads.
 */
export function readFrontMatter(raw: string): { name: string; description: string; body: string } {
  let body = raw.replace(/^\uFEFF/, "");
  let name = "";
  let description = "";
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (front) {
    const matter = front[1] ?? "";
    body = body.slice(front[0].length);
    const lines = matter.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index] ?? "");
      if (!match) continue;
      const key = (match[1] ?? "").toLowerCase();
      const inline = (match[2] ?? "").trim();

      /*
       * A block scalar — `description: >` with the text on the following lines.
       * It is how half the skills in the wild write a description that is a
       * paragraph, and reading only the marker gave the model a menu entry that
       * said ">" — a skill nobody would ever choose.
       *
       * `>` folds its lines into one paragraph and `|` keeps them, which is YAML's
       * own distinction; the indented run is consumed either way, so the next
       * key is not mistaken for more of the description.
       */
      let value = inline;
      if (/^[>|][+-]?$/.test(inline)) {
        const block: string[] = [];
        while (index + 1 < lines.length) {
          const next = lines[index + 1] ?? "";
          if (next.trim() !== "" && !/^\s/.test(next)) break;
          block.push(next);
          index += 1;
        }
        const indent = Math.min(
          ...block.filter((line) => line.trim() !== "").map((line) => (line.match(/^\s*/)?.[0] ?? "").length),
        );
        const stripped = block.map((line) => (Number.isFinite(indent) ? line.slice(indent) : line).trim());
        while (stripped.length > 0 && stripped[stripped.length - 1] === "") stripped.pop();
        value = inline.startsWith(">")
          ? stripped.join(" ").replace(/\s+/g, " ").trim()
          : stripped.join("\n").trim();
      } else {
        value = inline.replace(/^["']|["']$/g, "");
      }

      if (key === "name") name = value;
      else if (key === "description") description = value;
    }
  }
  return { name, description, body };
}

/** Parse one skill file. Returns null when there is nothing usable in it. */
export function parseSkill(file: string, raw: string): Skill | null {
  const { name: declared, description: declaredDescription, body } = readFrontMatter(raw);
  const trimmedBody = body.trim();
  if (trimmedBody === "") return null;

  let description = declaredDescription;
  let name = declared;
  if (name === "") name = path.basename(file).replace(/\.(md|markdown|txt)$/i, "");
  if (description === "") {
    description = trimmedBody.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
    if (description.length > 120) description = `${description.slice(0, 119)}…`;
  }

  const slugged = slug(name);
  if (slugged === "") return null;
  return { name: slugged, description, source: file, body: trimmedBody };
}

/** The provenance file a directory skill may carry, or null. */
function readProvenance(dir: string): SkillProvenance | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SOURCE_FILE), "utf8")) as Record<string, unknown>;
    if (typeof raw.repo !== "string" || typeof raw.path !== "string") return null;
    return {
      repo: raw.repo,
      ref: typeof raw.ref === "string" ? raw.ref : "",
      path: raw.path,
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      files: typeof raw.files === "number" ? raw.files : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Read one directory-shaped skill, or null when there is no `SKILL.md` in it.
 *
 * `files` is the rest of the directory, so the console can say that a skill is
 * more than its playbook — and so the agent knows there is something to read.
 */
export function readSkillDir(dir: string): Skill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, SKILL_FILE), "utf8");
  } catch {
    return null;
  }
  const parsed = parseSkill(path.join(dir, SKILL_FILE), raw);
  if (parsed === null) return null;

  const files = listFiles(dir, 500)
    .filter((rel) => rel !== SKILL_FILE && rel !== SOURCE_FILE)
    .sort();

  const provenance = readProvenance(dir);
  return {
    ...parsed,
    // The front matter wins the name, but a directory is allowed to be named
    // differently: what a person typed is what they invoke.
    dir,
    files,
    ...(provenance === null ? {} : { provenance }),
  };
}

/**
 * Every file under a directory, relative to it, walked by hand.
 *
 * By hand rather than with `readdirSync({ recursive: true })` because that shape
 * (and `Dirent.parentPath`) arrived after this project's oldest supported Node,
 * and a skill directory is a small tree either way. `limit` is a guard against a
 * directory somebody pointed at a checkout by mistake.
 */
function listFiles(root: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
      if (found.length >= limit) return;
    }
  };
  walk(root, "");
  return found;
}

/**
 * Every skill in these directories, sorted by name. Missing directories are empty.
 *
 * A directory may hold both shapes: `*.md` files and subdirectories with a
 * `SKILL.md`. Earlier directories win, so a project skill can shadow a personal or
 * a deployment-wide one of the same name.
 */
export function loadSkills(dirs: readonly string[]): Skill[] {
  const byName = new Map<string, Skill>();
  const remember = (skill: Skill): void => {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  };

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // A directory that does not exist is not a problem.
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        const skill = readSkillDir(path.join(dir, entry.name));
        if (skill !== null) remember(skill);
        continue;
      }
      if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const skill = parseSkill(file, raw);
      if (skill !== null) remember(skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find one skill by name, or by a prefix — but only when the prefix is unique.
 *
 * A prefix that matches two skills is not an answer, it is a question: returning
 * whichever came first would make `use_skill("re")` load `refine-web-design` and
 * quietly do the wrong thing for someone who meant `release-check`. The caller
 * gets `undefined` and its own error can list what *is* installed.
 */
export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const wanted = slug(name);
  if (wanted === "") return undefined;
  const exact = skills.find((skill) => skill.name === wanted);
  if (exact !== undefined) return exact;
  const prefixed = skills.filter((skill) => skill.name.startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Compose the message a skill turns into, for a caller that has no other way.
 *
 * The playbook is fenced and the task is left last, because a model reads the end
 * of a prompt most reliably and the task is what must not be missed.
 */
export function composeSkillMessage(skill: Skill, task: string): string {
  const header = `Applying skill "${skill.name}".`;
  const request = task.trim() === "" ? "Do what the skill describes for this workspace." : task.trim();
  const where =
    skill.dir === undefined || (skill.files ?? []).length === 0
      ? []
      : [`The skill's own files are in ${skill.dir} — read them when it refers to one.`, ""];
  return [
    header,
    "",
    "<skill>",
    skill.body,
    "</skill>",
    "",
    ...where,
    "Task:",
    request,
  ].join("\n");
}

/** A compact list for `/skills`. */
export function describeSkills(skills: readonly Skill[]): string[] {
  if (skills.length === 0) {
    return ["no skills found — add a markdown file to ~/.config/ontrak-genie/skills, or `genie skills add <owner/repo>`"];
  }
  return skills.map((skill) => {
    // One skill, one line: a description written as a YAML block runs to several,
    // and a list that wraps is a list nobody scans.
    const bits = [skill.name.padEnd(18), skill.description.replace(/\s+/g, " ")];
    if ((skill.files ?? []).length > 0) bits.push(`(+${skill.files?.length} files)`);
    if (skill.provenance) bits.push(`[${skill.provenance.repo}]`);
    return `  ${bits.join(" ")}`;
  });
}

/**
 * The skills as a menu for the model's prompt: names, one-line descriptions, and
 * nothing else.
 *
 * Bodies are deliberately *not* in the prompt. A skill is fetched with
 * `use_skill` when it is wanted, which is the difference between offering thirty
 * playbooks and shipping thirty playbooks' worth of tokens on every turn. The
 * menu is bounded here rather than by whoever assembles the prompt, so a
 * deployment with a hundred skills still sends a prompt it can afford.
 */
export function skillMenu(skills: readonly Skill[], limit = 40, width = 200): string[] {
  return skills.slice(0, limit).map((skill) => {
    const flat = skill.description.replace(/\s+/g, " ").trim();
    const description = flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
    return `- ${skill.name}: ${description}`;
  });
}
