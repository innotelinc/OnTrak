/**
 * Where the CLI points, and as whom.
 *
 * Two things are stored apart on purpose. The **address** is ordinary
 * configuration a person is happy to see in a file; the **credential** is a
 * secret with an expiry. Keeping them in one file is convenient, and it also
 * means a config file copied into a dotfiles repo is a leaked session — so the
 * credential is written with `0600`, lives in one predictable place, and can be
 * cleared on its own with `genie logout`.
 *
 * Resolution order, narrowest first: an explicit flag, then the environment,
 * then the file, then the deployment's own default bind. The same order the
 * `approvals` script uses, so one mental model covers both.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  /** Origin of the Genie deployment, no trailing slash. */
  url?: string;
  /** `WEB_TOKEN`, when the deployment still allows one. */
  token?: string;
  /** The signed-in session cookie value (`ontrak_genie_session`). */
  cookie?: string;
  /** Model to ask for by default, when the plan allows a choice. */
  model?: string;
  /** Extra directory to load skills from, beside the built-in ones. */
  skillsDir?: string;
}

export interface ResolvedTarget {
  base: string;
  token?: string;
  cookie?: string;
  /** True when at least one credential was found, so the caller can prompt. */
  hasCredential: boolean;
}

export const DEFAULT_URL = "http://127.0.0.1:3400";

/** The one file, overridable so a test does not touch a real home directory. */
export function configPath(): string {
  const override = (process.env.ONTRAK_GENIE_CONFIG ?? "").trim();
  if (override !== "") return override;
  const dir =
    (process.env.XDG_CONFIG_HOME ?? "").trim() ||
    path.join(os.homedir(), ".config");
  return path.join(dir, "ontrak-genie", "config.json");
}

export function readConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as CliConfig;
  } catch {
    // No file, or a hand-edited one that does not parse: an unconfigured CLI is
    // the same as an empty config, not an error to report on every command.
    return {};
  }
}

/**
 * Merge a patch into the config and write it back.
 *
 * A value of `undefined` deletes the key rather than writing `null`, so
 * `genie logout` can remove `cookie` without leaving a `cookie: null` that a
 * later reader has to special-case.
 */
export function writeConfig(patch: CliConfig): CliConfig {
  const next: CliConfig = { ...readConfig() };
  for (const [key, value] of Object.entries(patch) as [keyof CliConfig, string | undefined][]) {
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written `0600` because it can hold a session, and atomically because a
  // half-written credential file is a confusing way to be signed out.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return next;
}

/** Normalize an origin: require a scheme, drop a trailing slash. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export interface ResolveFlags {
  url?: string;
  token?: string;
}

/**
 * Decide the address and credential for this invocation.
 *
 * `--token` and the environment win over the file; a flag is the most explicit
 * thing a person can type, and `ONTRAK_GENIE_TOKEN` is how a CI job holds one
 * without a home directory.
 */
export function resolveTarget(flags: ResolveFlags = {}): ResolvedTarget {
  const file = readConfig();
  const base = normalizeUrl(
    flags.url ?? process.env.ONTRAK_GENIE_URL ?? file.url ?? DEFAULT_URL,
  );
  const token = firstNonEmpty(
    flags.token,
    process.env.ONTRAK_GENIE_TOKEN,
    process.env.WEB_TOKEN,
    file.token,
  );
  const cookie = firstNonEmpty(process.env.ONTRAK_GENIE_COOKIE, file.cookie);
  return { base, token, cookie, hasCredential: token !== undefined || cookie !== undefined };
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * The deployment's own skills directory, when this process is a deployment's.
 *
 * `AGENT_DATA_DIR` is what the container sets, and `<it>/skills` is where the
 * *server* keeps the skills every account is offered (`src/skill-roots.ts`). Read
 * from the environment rather than from `config.dataDir`, whose fallback is
 * `./.agent`: that would make every laptop look like a deployment.
 */
export function deploymentSkillsDir(): string | undefined {
  const dir = (process.env.AGENT_DATA_DIR ?? "").trim();
  if (dir === "") return undefined;
  return path.join(path.resolve(dir), "skills");
}

/** The directories a skill may be loaded from, most specific last. */
export function skillDirs(cwd: string): string[] {
  const configured = (process.env.ONTRAK_GENIE_SKILLS ?? readConfig().skillsDir ?? "").trim();
  const deployment = deploymentSkillsDir();
  return [
    path.join(path.dirname(configPath()), "skills"),
    ...(configured === "" ? [] : [configured]),
    path.join(cwd, ".genie", "skills"),
    /*
     * The deployment's, last — and this is the entry that makes `genie skills add`
     * *inside the container* visible to the console. Without it the CLI installed
     * into `/root/.config/ontrak-genie/skills`, which no chat ever reads, so the
     * command appeared to work and changed nothing a person could see.
     */
    ...(deployment === undefined ? [] : [deployment]),
  ];
}

/**
 * Where `genie skills add` writes when the line names no directory.
 *
 * The deployment's own skills directory when this process is one (`AGENT_DATA_DIR`
 * set): a deployment is not a person, the console reads that directory and not
 * this process's home, and a skill installed anywhere else would be a skill no chat
 * is ever offered. Everywhere else it is the user's own directory — the first one
 * `skillDirs` reads, so what was just installed is what the next turn loads.
 */
export function defaultSkillsDir(cwd: string): string | undefined {
  return deploymentSkillsDir() ?? skillDirs(cwd)[0];
}
