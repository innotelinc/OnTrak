/**
 * Where this *deployment* keeps skills, and which of them this caller can see.
 *
 * The CLI has always read skills from directories the person owns
 * (`~/.config/ontrak-genie/skills`, `./.genie/skills`). A console chat has no
 * filesystem of its own, so the server needs the same three answers — whose skills,
 * which ones, and from where — and they are deliberately the same idea:
 *
 *   1. **the project**: `<workspace>/.genie/skills`, the directory the CLI also
 *      reads, so a skill committed beside the code works in both places;
 *   2. **the account**: `<AGENT_DATA_DIR>/skills/accounts/<account>/`, so one
 *      person installing a skill does not hand it to everybody on a shared
 *      deployment;
 *   3. **the deployment**: `<AGENT_DATA_DIR>/skills/`, which an operator fills —
 *      this is what makes a skill available to everyone here without anybody
 *      installing anything.
 *
 * Order is precedence: a project skill shadows an account one of the same name,
 * which shadows the deployment's. That is the same rule the CLI's loader has always
 * used, one level further out — a more specific place wins.
 *
 * Nothing here writes. Installing is `skill-install.ts`, driven by
 * `genie skills add` or by an operator copying a directory in; loading is a read,
 * which is why it can happen on the prompt path.
 */

import path from "node:path";

import { config } from "./config.js";
import { accountDirName, currentScope, workspaceRoot } from "./scope.js";
import { loadSkills, type Skill } from "./skills.js";

/** Where installed, deployment-wide skills live. */
export function deploymentSkillsDir(): string {
  return path.join(config.dataDir, "skills");
}

/**
 * Where one account's own skills live.
 *
 * Keyed with `accountDirName`, the same function the workspace and the transcripts
 * use, so an account id that could be a path is sanitised in exactly one place and
 * two accounts whose ids slug the same way still get different directories.
 */
export function accountSkillsDir(userId: string | null = currentScope().userId): string {
  if (userId === null) return path.join(deploymentSkillsDir(), "shared");
  return path.join(deploymentSkillsDir(), "accounts", accountDirName(userId));
}

/** The directories a skill may come from here, most specific first. */
export function skillRoots(): string[] {
  return [
    path.join(workspaceRoot(), ".genie", "skills"),
    accountSkillsDir(),
    deploymentSkillsDir(),
  ];
}

/**
 * Every skill this caller can use.
 *
 * Read fresh on each call rather than cached: a skill installed while a chat is
 * open should be usable in that chat, and the cost is a handful of `readdir`s
 * against directories that are usually absent.
 */
export function loadSkillsForScope(): Skill[] {
  return loadSkills(skillRoots());
}
