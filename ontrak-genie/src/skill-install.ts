/**
 * Installing a skill from a public repository.
 *
 * The ecosystem's skills are markdown in git — a `SKILL.md` with front matter, and
 * whatever reference files the playbook needs beside it — so "adding a skill" is
 * "fetch that directory", and everything interesting is in deciding *what* to
 * fetch and *where* it lands.
 *
 * WHAT A REPOSITORY LOOKS LIKE
 * ----------------------------
 * Two shapes, both common, and a skill command that only handled one would fail on
 * half the repositories a person names:
 *
 *   * the repository **is** the skill — `SKILL.md` at the root, with `references/`,
 *     `assets/` and `scripts/` beside it (`awesome-skills/mobile-app-design`);
 *   * the repository **holds** skills — `skills/<name>/SKILL.md`, one directory
 *     each, or several providers' copies of one skill (`impeccable`, which ships
 *     the same skill under `.agents/`, `.claude/`, `plugin/` and a dozen more).
 *
 * `chooseSkillRoot` picks between them from the repository's own file list, and it
 * is pure: the choices are the part worth testing, and a test can make them without
 * a network. When a repository holds several skills, the one that is *picked* is
 * installed and the rest are **named in the result**, so a person is one `--path`
 * away from the other rather than looking at a directory listing on GitHub.
 *
 * WHAT IS NEVER INSTALLED
 * -----------------------
 * A repository is somebody else's tree, so the installer takes a narrow slice:
 * only files under the chosen skill root, never `.git`, `node_modules`, `.github`,
 * `tests/` or build output, with a ceiling on file count and total size. A path is
 * refused if it is absolute or climbs (`..`), because it came from a remote answer
 * and would otherwise decide where a write lands. Nothing is executed: a skill is
 * text this program reads, and `scripts/` inside one is only ever run if the agent
 * decides to run it through the same gate as every other command.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { slug, SOURCE_FILE, SKILL_FILE } from "./skills.js";

/** An install that could not be carried out, with a message a caller can print. */
export class SkillInstallError extends Error {}

/** The network, injectable so tests can install from a fake repository. */
export type SkillFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Where a skill's playbook has to be for the directory shape to be recognised. */
const MAX_FILES = 400;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * Paths inside a repository that are never part of a skill.
 *
 * Applied to the repository's own layout, before a root is chosen, so `.git`,
 * a vendored tree and the fixtures in `tests/` are out of the running — and a
 * dot-file at the repository root (`.gitignore`, `.editorconfig`) is not part of
 * somebody's playbook either.
 */
const NOISE = [
  ".git/",
  ".github/",
  "node_modules/",
  "tests/",
  "test/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".hive/",
  ".venv/",
  "vendor/",
];

/** Locations that mean "this is the skill", best first, when picking between copies. */
const PREFERRED_ROOTS = [
  ".agents/skills",
  "skills",
  "plugin/skills",
  "cursor-plugin/skills",
  ".claude/skills",
  ".agent/skills",
  ".cursor/skills",
];

/** A repository on GitHub, as `owner/name`. */
export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Read `owner/repo` out of what a person typed.
 *
 * Accepts the bare slug, a URL, an scp-style address and a `.git` suffix, and
 * **only** github.com: the installer fetches from GitHub's API and raw host, so a
 * GitLab URL accepted here would be a URL it cannot serve — better refused than
 * quietly treated as a GitHub path with the same shape.
 */
export function parseGitHubRepo(input: unknown): GitHubRepoRef | null {
  if (typeof input !== "string") return null;
  let raw = input.trim();
  if (raw === "" || raw.length > 300) return null;

  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:([^/@]+)@)?([^/:\s]+)(?::\d+)?[/:](.+)$/i.exec(raw);
  if (match) {
    const host = (match[2] ?? "").toLowerCase().replace(/^www\./, "");
    const rest = match[3] ?? "";
    if (host === "github.com" || host === "raw.githubusercontent.com") {
      raw = rest;
    } else if (rest.includes("/")) {
      return null;
    }
  }

  const parts = raw
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part !== "");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** One directory in a repository that looks like a skill. */
export interface SkillRoot {
  /** Repository-root-relative directory holding `SKILL.md`, or `""` at the root. */
  root: string;
  /** The name it would be installed under. */
  name: string;
}

function isNoise(file: string): boolean {
  if (!file.includes("/") && file.startsWith(".")) return true;
  return NOISE.some((prefix) => file.startsWith(prefix) || file.includes(`/${prefix}`));
}

/**
 * How well a root suits a name and a place, lower being better.
 *
 * The name is weighted first and the *location* breaks the tie, which is what
 * makes the thirteen identical copies of one skill a solved problem rather than a
 * coin toss: a repository that publishes the same playbook for every provider
 * names them all the same, so `preferred provider` is the only signal left, and
 * without it the alphabet decided which one you got.
 */
function rootRank(root: SkillRoot, wanted: string): number {
  const named = wanted === "" || slug(root.name) === slug(wanted);
  const preferred = PREFERRED_ROOTS.findIndex(
    (base) => root.root === `${base}/${root.name}` || root.root === base,
  );
  const place = preferred === -1 ? 100 + root.root.split("/").length : preferred;
  return (named ? 0 : 50) + place;
}

/**
 * Every skill a repository tree holds, best candidate first.
 *
 * `paths` is the repository's blob list. A directory counts when it has a
 * `SKILL.md` directly inside it; a repository whose root *is* the skill counts the
 * same way. Files inside `tests/` or a vendored tree do not, which is what keeps
 * `impeccable`'s twenty-five provider copies from being twenty-five skills — they
 * are one skill, and the ranking below picks the canonical one.
 */
export function skillRootsIn(paths: readonly string[], wanted = ""): SkillRoot[] {
  const roots = new Map<string, SkillRoot>();
  for (const file of paths) {
    if (isNoise(file)) continue;
    if (file !== SKILL_FILE && !file.endsWith(`/${SKILL_FILE}`)) continue;
    const root = file === SKILL_FILE ? "" : file.slice(0, file.length - SKILL_FILE.length - 1);
    const name = root === "" ? "" : (root.split("/").pop() ?? "");
    const key = root;
    if (!roots.has(key)) roots.set(key, { root, name: name === "" ? "root" : name });
  }
  return [...roots.values()].sort((a, b) => {
    const byRank = rootRank(a, wanted) - rootRank(b, wanted);
    if (byRank !== 0) return byRank;
    const byDepth = a.root.split("/").length - b.root.split("/").length;
    if (byDepth !== 0) return byDepth;
    return a.root.localeCompare(b.root);
  });
}

/** What is being installed, once the repository's own answer is in hand. */
export interface ChosenSkill {
  root: string;
  name: string;
  /** Files to fetch, repository-root-relative. */
  files: string[];
  /** The playbook's own file, always inside `files`. */
  skillFile: string;
  /**
   * What to strip before writing, so the skill lands as `SKILL.md` at the top of
   * its own directory rather than nested under the repository's own layout — the
   * two are the same only when the repository *is* the skill.
   */
  prefix: string;
}

export interface ChooseOptions {
  /** `--name`: what to call it. */
  name?: string;
  /** `--path`: which skill inside the repository. */
  path?: string;
  /** The repository's name, used when nothing says otherwise. */
  repo: string;
}

/** Strip a trailing `-skill`/`_skill`, which is how repositories are named. */
function baseName(value: string): string {
  return value.replace(/[-_]skill$/i, "");
}

/**
 * Choose what to install from a repository's file list.
 *
 * Refuses rather than guesses when a repository holds several skills and nothing
 * says which: the caller prints the alternatives, and one `--path` settles it.
 * That is a better answer than installing the alphabetically first of ten
 * playbooks somebody did not ask for.
 */
export function chooseSkill(paths: readonly string[], options: ChooseOptions): ChosenSkill {
  const files = paths.filter((file) => !isNoise(file) && file !== "" && !file.endsWith("/"));
  const roots = skillRootsIn(files, options.name ?? baseName(options.repo));

  if (options.path !== undefined && options.path !== "") {
    const wanted = options.path.replace(/^\/+|\/+$/g, "");
    const match =
      roots.find((root) => root.root === wanted) ??
      roots.find((root) => root.name === wanted) ??
      roots.find((root) => root.root.endsWith(`/${wanted}`));
    if (match === undefined) {
      throw new SkillInstallError(
        roots.length === 0
          ? "that repository does not hold a skill (no SKILL.md anywhere in it)"
          : `no skill called "${wanted}" in it — it holds ${roots.map((root) => root.name).join(", ")}`,
      );
    }
    return { ...match, ...filesFor(files, match.root, options) };
  }

  if (roots.length === 0) {
    return singleFileSkill(files, options);
  }

  const [best] = roots;
  if (best === undefined) throw new SkillInstallError("that repository holds no files");
  /*
   * Several *different* skills and no way to choose: say so rather than pick. One
   * name in several directories is a different thing entirely — it is one skill
   * published for a dozen providers (`impeccable` ships the same playbook under
   * `.agents/`, `.claude/`, `plugin/` and more), and the ranking above already
   * chose between those copies.
   */
  const names = [...new Set(roots.map((root) => root.name))];
  if (options.name === undefined && names.length > 1) {
    throw new SkillInstallError(
      `that repository holds several skills (${names.join(", ")}) — pick one with --path <name>`,
    );
  }
  return { ...best, ...filesFor(files, best.root, options) };
}

/** The files that belong to one root, and the name the skill takes. */
function filesFor(
  files: readonly string[],
  root: string,
  options: ChooseOptions,
): { name: string; files: string[]; skillFile: string; prefix: string } {
  const prefix = root === "" ? "" : `${root}/`;
  const inside = files.filter((file) => file.startsWith(prefix));
  const skillFile = `${prefix}${SKILL_FILE}`;
  if (!inside.includes(skillFile)) {
    throw new SkillInstallError(`no ${SKILL_FILE} in that repository`);
  }
  const declared = options.name ?? (root === "" ? baseName(options.repo) : (root.split("/").pop() ?? ""));
  const name = slug(declared);
  if (name === "") throw new SkillInstallError("that skill has no usable name");
  return {
    name,
    files: inside,
    skillFile,
    prefix,
  };
}

/**
 * A repository that is not a skill directory but a single markdown playbook.
 *
 * Some people publish one file. It is installed into a directory of its own, so it
 * behaves exactly like every other skill afterwards — one shape on disk, not two
 * behaviours to remember.
 *
 * It is named after the **file**, not the repository: the file is the playbook's
 * own title (`no-bullshit-review.md`), while the repository is where it happens to
 * live (`review-skills`), and the title is the thing somebody is invoking.
 * `--name` settles it either way.
 */
function singleFileSkill(files: readonly string[], options: ChooseOptions): ChosenSkill {
  const candidates = files.filter((file) => !file.includes("/") && /\.md$/i.test(file));
  const usable = candidates.filter((file) => !/^(readme|license|contributing|changelog)\.md$/i.test(file));
  if (usable.length !== 1) {
    throw new SkillInstallError(
      "that repository does not hold a skill (no SKILL.md, and no single markdown playbook at its root)",
    );
  }
  const file = usable[0] as string;
  const declared = options.name ?? file.replace(/\.md$/i, "");
  const name = slug(declared);
  if (name === "") throw new SkillInstallError("that skill has no usable name");
  return { root: "", name, files: [file], skillFile: file, prefix: "" };
}

/** What an installer walked away with, in a shape both callers can print. */
export interface InstallOutcome {
  skill: {
    name: string;
    dir: string;
    files: number;
    description: string;
    repo: string;
    ref: string;
    path: string;
  };
  /** Other skills the repository holds, so a caller can name them. */
  others: string[];
  /** True when something was already installed there and has been replaced. */
  replaced: boolean;
}

export interface InstallInput {
  owner: string;
  repo: string;
  /** The skills directory the skill's own directory is created inside. */
  dir: string;
  name?: string;
  ref?: string;
  path?: string;
  /**
   * A GitHub token, when there is one.
   *
   * Two reasons it is worth carrying rather than requiring: a **private**
   * repository cannot be read without it, and GitHub answers an unauthenticated
   * caller with a fast hourly limit — sixty requests an hour, which installing a
   * handful of skills from an estate's worth of repositories runs into. With a
   * token the same calls are five thousand an hour. The deployment already holds
   * `AGENT_GIT_TOKEN` for its own forge, and `GITHUB_TOKEN` is what a developer's
   * machine has.
   */
  token?: string;
}

interface TreeEntry {
  path?: unknown;
  type?: unknown;
  size?: unknown;
}

/** A file path that is safe to write, or null. */
function safeRelative(file: string): string | null {
  if (file === "" || file.startsWith("/") || file.includes("\\")) return null;
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return file;
}

/**
 * Fetch a skill from GitHub and write it into a skills directory.
 *
 * The order is: ask who the default branch is (unless one was named), ask for the
 * file list, choose, download each file, then write the provenance that makes the
 * install reversible and `skills list` informative. The tree is read in **one**
 * request and the files are fetched raw, which is the difference between two
 * requests and three hundred.
 */
export async function installSkill(
  input: InstallInput,
  deps: { fetchImpl?: SkillFetcher } = {},
): Promise<InstallOutcome> {
  const fetchImpl = deps.fetchImpl ?? (fetch as SkillFetcher);
  const repoSlug = `${input.owner}/${input.repo}`;
  const token = input.token ?? "";

  const ref = input.ref ?? (await defaultBranch(fetchImpl, input.owner, input.repo, token));
  const paths = await treePaths(fetchImpl, input.owner, input.repo, ref, token);
  const chosen = chooseSkill(paths, {
    repo: input.repo,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.path === undefined ? {} : { path: input.path }),
  });

  const roots = skillRootsIn(paths, input.name ?? baseName(input.repo));
  const others = [...new Set(roots.map((root) => root.name).filter((name) => slug(name) !== chosen.name))];

  if (chosen.files.length > MAX_FILES) {
    throw new SkillInstallError(`that skill has ${chosen.files.length} files — more than this installs`);
  }

  const target = path.join(input.dir, chosen.name);
  const existed = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

  const downloads = await Promise.all(
    chosen.files.map(async (file) => {
      // Written relative to the skill root, fetched from the repository root: the
      // difference is what makes `skills/<name>/SKILL.md` install as `SKILL.md`.
      const relative = safeRelative(file.slice(chosen.prefix.length));
      if (relative === null) throw new SkillInstallError(`that repository names a path this will not write: ${file}`);
      return { file, relative, body: await download(fetchImpl, input.owner, input.repo, ref, file, token) };
    }),
  );

  const total = downloads.reduce((sum, entry) => sum + entry.body.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new SkillInstallError(`that skill is ${Math.round(total / 1024 / 1024)}MB — larger than this installs`);
  }

  // Replace rather than merge: a skill is a snapshot of one repository at one ref,
  // and yesterday's file that is gone today would otherwise stay behind forever.
  await fs.rm(target, { recursive: true, force: true });
  for (const entry of downloads) {
    const destination = path.join(target, entry.relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, entry.body);
  }

  const { readSkillDir } = await import("./skills.js");
  const installed = readSkillDir(target);
  if (installed === null) {
    await fs.rm(target, { recursive: true, force: true });
    throw new SkillInstallError("that repository's SKILL.md has no usable content");
  }

  const provenance = {
    repo: repoSlug,
    ref,
    path: chosen.skillFile,
    installedAt: new Date().toISOString(),
    files: downloads.length,
  };
  await fs.writeFile(path.join(target, SOURCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  return {
    skill: {
      name: installed.name === "" ? chosen.name : installed.name,
      dir: target,
      files: downloads.length,
      description: installed.description,
      repo: repoSlug,
      ref,
      path: chosen.skillFile,
    },
    others,
    replaced: existed,
  };
}

async function defaultBranch(fetchImpl: SkillFetcher, owner: string, repo: string, token: string): Promise<string> {
  const response = await get(fetchImpl, `${API}/repos/${owner}/${repo}`, token);
  const body = (await response.json().catch(() => ({}))) as { default_branch?: unknown; full_name?: unknown };
  if (typeof body.default_branch !== "string" || body.default_branch === "") {
    throw new SkillInstallError(`${owner}/${repo} did not say which branch to read`);
  }
  return body.default_branch;
}

async function treePaths(
  fetchImpl: SkillFetcher,
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string[]> {
  const response = await get(fetchImpl, `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
  const body = (await response.json().catch(() => ({}))) as { tree?: unknown };
  if (!Array.isArray(body.tree)) {
    throw new SkillInstallError(`${owner}/${repo}@${ref} has no file list to read`);
  }
  return (body.tree as TreeEntry[])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string);
}

async function get(fetchImpl: SkillFetcher, url: string, token: string): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ontrak-genie",
      ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(20_000),
  }).catch((error: unknown) => {
    throw new SkillInstallError(`could not reach GitHub: ${(error as Error).message}`);
  });
  if (response.status === 404) throw new SkillInstallError("GitHub has no such repository (or it is private)");
  if (response.status === 403) {
    throw new SkillInstallError(
      token === ""
        ? "GitHub refused (HTTP 403) — that is usually its hourly limit for anonymous callers; set GITHUB_TOKEN and try again"
        : "GitHub refused (HTTP 403) with the token that was supplied — check it has access to this repository",
    );
  }
  if (!response.ok) throw new SkillInstallError(`GitHub answered HTTP ${response.status}`);
  return response;
}

async function download(
  fetchImpl: SkillFetcher,
  owner: string,
  repo: string,
  ref: string,
  file: string,
  token: string,
): Promise<Buffer> {
  const url = `${RAW}/${owner}/${repo}/${encodeURIComponent(ref)}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "ontrak-genie",
      ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new SkillInstallError(`could not download ${file}: ${(error as Error).message}`);
  });
  if (!response.ok) throw new SkillInstallError(`could not download ${file} (HTTP ${response.status})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_FILE_BYTES) {
    throw new SkillInstallError(`${file} is too large to install (${Math.round(body.byteLength / 1024 / 1024)}MB)`);
  }
  return body;
}

/**
 * Remove a directory this installer created.
 *
 * The provenance file is the permission slip: a directory that has no `.source.json`
 * was not installed here, and deleting somebody's hand-written skill directory
 * because the name matched would be the one unrecoverable mistake this command
 * could make.
 */
export async function removeSkill(dir: string): Promise<{ files: number }> {
  const provenance = await fs
    .readFile(path.join(dir, SOURCE_FILE), "utf8")
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null);
  if (provenance === null) {
    throw new SkillInstallError(
      `${dir} was not installed by \`skills add\` (no ${SOURCE_FILE}), so it is not this command's to remove`,
    );
  }
  const files = await fs
    .readdir(dir)
    .then((entries) => entries.length)
    .catch(() => 0);
  await fs.rm(dir, { recursive: true, force: true });
  return { files };
}
