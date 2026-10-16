/**
 * `genie skills` — the terminal's side of skills: what is installed, and adding
 * one from a public repository.
 *
 * The model itself — parsing, the two on-disk shapes, loading, composing a
 * playbook into a message — lives in `src/skills.ts`, because the *server* offers
 * the same skills to a console chat and two copies of "what a skill is" would
 * drift apart the first time one of them learned something. What is here is only
 * what a terminal owns:
 *
 *   * **the subcommands.** `genie skills add <owner/repo>` is read here, so the
 *     words are one table and an unknown one is a usage error listing what exists.
 *   * **where installed skills go.** A person running this on a laptop means
 *     `~/.config/ontrak-genie/skills`; `--project` means `./.genie/skills`, so a
 *     skill can be committed beside the code that uses it.
 *   * **the terminal's output.** A list with provenance, or a sentence.
 *
 * The fetching and the validation are `src/skill-install.ts`, which is also what
 * the console's install route calls — so `genie skills add` and the console cannot
 * end up installing different things.
 */

import {
  describeSkills,
  findSkill,
  type Skill,
} from "../skills.js";
import {
  installSkill,
  parseGitHubRepo,
  removeSkill,
  type InstallOutcome,
  type SkillFetcher,
} from "../skill-install.js";
import type { Theme } from "./render.js";

export {
  composeSkillMessage,
  describeSkills,
  findSkill,
  loadSkills,
  parseSkill,
  readFrontMatter,
  readSkillDir,
  slug,
  type Skill,
  type SkillProvenance,
} from "../skills.js";

/** A `skills` line that cannot be carried out as written. Exit code 2. */
export class SkillUsageError extends Error {}

export type SkillsSub = "list" | "add" | "remove";

const SUBCOMMANDS = new Map<string, SkillsSub>([
  ["list", "list"],
  ["ls", "list"],
  ["add", "add"],
  ["install", "add"],
  ["remove", "remove"],
  ["rm", "remove"],
  ["uninstall", "remove"],
]);

export interface SkillsInvocation {
  sub: SkillsSub;
  /** The words after the subcommand. */
  args: string[];
}

export interface SkillsOptions {
  /** Print the installer's own payload instead of a sentence. */
  json: boolean;
  /** Where an installed skill goes. Undefined means the caller's default. */
  dir?: string;
  /** `--project`: install into `./.genie/skills`, beside the code. */
  project: boolean;
  /** `--name`: what to call it, when the repository's own name is not it. */
  name?: string;
  /** `--ref`: a branch, tag or commit to install from. */
  ref?: string;
  /** `--path`: which skill inside the repository, when it holds several. */
  path?: string;
  /**
   * A GitHub token: `--token`, else `GITHUB_TOKEN`, else the deployment's own
   * `AGENT_GIT_TOKEN`. A private repository needs one, and GitHub's anonymous
   * hourly limit is low enough that installing an estate's skills runs into it.
   */
  token?: string;
}

/** The words after `skills`, read the same way from a shell and from the REPL. */
export function parseSkillsCommand(rest: readonly string[]): SkillsInvocation {
  const head = (rest[0] ?? "").toLowerCase();
  // Bare `genie skills` lists, which is what somebody typing it wants to know.
  if (head === "") return { sub: "list", args: [] };
  const sub = SUBCOMMANDS.get(head);
  if (sub === undefined) {
    throw new SkillUsageError(`unknown skills subcommand "${rest[0] ?? ""}" — try list, add or remove`);
  }
  return { sub, args: rest.slice(1) };
}

/** Read a whole `skills` line, flags included. */
export function parseSkillsLine(
  rest: readonly string[],
  defaults: SkillsOptions,
): { invocation: SkillsInvocation; options: SkillsOptions } {
  const words: string[] = [];
  const options: SkillsOptions = { ...defaults };

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const split = word.indexOf("=");
    const name = split === -1 ? word : word.slice(0, split);
    const inline = split === -1 ? undefined : word.slice(split + 1);
    const value = (): string => {
      const found = inline ?? rest[index + 1] ?? "";
      if (inline === undefined) index += 1;
      return found;
    };

    switch (name) {
      case "--dir":
        options.dir = value();
        break;
      case "--project":
        options.project = true;
        break;
      case "--name":
        options.name = value();
        break;
      case "--ref":
        options.ref = value();
        break;
      case "--path":
        options.path = value();
        break;
      case "--token":
        options.token = value();
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          throw new SkillUsageError(`unknown option ${name} for skills`);
        }
        words.push(word);
    }
  }

  return { invocation: parseSkillsCommand(words), options };
}

export interface SkillsContext {
  invocation: SkillsInvocation;
  /** What is installed right now, already loaded from `dirs`. */
  skills: Skill[];
  /** The directories skills come from, most specific first. */
  dirs: string[];
  /** Where `add` writes when nothing says otherwise. */
  installDir: string;
  theme: Theme;
  options: SkillsOptions;
  /** The network, injectable so a test can install from a fake repository. */
  fetchImpl?: SkillFetcher;
  write: (line: string) => void;
}

/** Run a `skills` line. */
export async function runSkills(ctx: SkillsContext): Promise<number> {
  switch (ctx.invocation.sub) {
    case "list":
      return listSkills(ctx);
    case "add":
      return await addSkill(ctx);
    case "remove":
      return await removeInstalledSkill(ctx);
  }
}

function listSkills(ctx: SkillsContext): number {
  if (ctx.options.json) {
    ctx.write(JSON.stringify(ctx.skills, null, 2));
    return 0;
  }
  for (const line of describeSkills(ctx.skills)) ctx.write(line);
  ctx.write(
    ctx.theme.gray(`  from ${ctx.dirs.join(", ")} — \`genie skills add <owner/repo>\` to install one`),
  );
  return 0;
}

async function addSkill(ctx: SkillsContext): Promise<number> {
  const target = (ctx.invocation.args[0] ?? "").trim();
  if (target === "") {
    throw new SkillUsageError("which skill? `genie skills add <owner/repo>`, or a github.com URL");
  }
  const ref = parseGitHubRepo(target);
  if (ref === null) {
    throw new SkillUsageError(`"${target}" is not a GitHub repository — try owner/repo`);
  }

  const dir = ctx.options.dir ?? ctx.installDir;
  const token = ctx.options.token ?? process.env.GITHUB_TOKEN ?? process.env.AGENT_GIT_TOKEN ?? "";
  const outcome: InstallOutcome = await installSkill(
    {
      owner: ref.owner,
      repo: ref.repo,
      dir,
      ...(ctx.options.name === undefined ? {} : { name: ctx.options.name }),
      ...(ctx.options.ref === undefined ? {} : { ref: ctx.options.ref }),
      ...(ctx.options.path === undefined ? {} : { path: ctx.options.path }),
      ...(ctx.options.token === undefined ? {} : { token: ctx.options.token }),
    },
    ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl },
  );

  if (ctx.options.json) {
    ctx.write(JSON.stringify(outcome, null, 2));
    return 0;
  }
  const { skill, others } = outcome;
  ctx.write(`installed ${skill.name} (${skill.files} files) into ${skill.dir}`);
  if (skill.description !== "") ctx.write(ctx.theme.gray(`  ${skill.description}`));
  if (others.length > 0) {
    // A repository that holds several skills is the common case, so naming the
    // others is the difference between a dead end and one more command.
    ctx.write(
      ctx.theme.gray(
        `  also in ${ref.owner}/${ref.repo}: ${others.join(", ")} — add one with --path <name>`,
      ),
    );
  }
  return 0;
}

async function removeInstalledSkill(ctx: SkillsContext): Promise<number> {
  const wanted = (ctx.invocation.args[0] ?? "").trim();
  if (wanted === "") throw new SkillUsageError("which skill? `genie skills list` shows them");
  const skill = findSkill(ctx.skills, wanted);
  if (skill === undefined) throw new SkillUsageError(`no installed skill matches "${wanted}"`);
  if (skill.dir === undefined) {
    // A single markdown file is somebody's own file, in a directory this command
    // does not own. Saying so is better than deleting it.
    throw new SkillUsageError(
      `${skill.name} is a single file at ${skill.source} — remove it by hand`,
    );
  }
  const removed = await removeSkill(skill.dir);
  ctx.write(`removed ${skill.name} (${removed.files} files) from ${skill.dir}`);
  return 0;
}

/** The `skills` lines of `genie help`, defined beside the commands they describe. */
export function skillsHelpLines(): string[] {
  return [
    "  genie skills                        what is installed, and where from",
    "  genie skills add <owner/repo>       install a skill from GitHub",
    "      --name <name>  --ref <branch|tag>  --path <skill>  --project  --token <token>",
    "      (GITHUB_TOKEN is read from the environment for a private repository)",
    "  genie skills remove <name>          remove an installed skill",
  ];
}
