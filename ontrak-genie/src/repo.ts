/**
 * Repository-aware workspaces (v0.4) — cloning, branching and opening a pull
 * request from the console.
 *
 * The pure decisions live in `repo-rules.ts`; this is the half that runs `git` and
 * speaks HTTP. Both are reached through a **port** rather than the real thing, so a
 * test drives the whole flow with a fake runner and a fake `fetch` and never needs a
 * git binary or a network — the same shape `change-set.ts` / `proposals.ts` use.
 *
 * THE TWO FENCES
 * --------------
 * A clone lands through `resolveInWorkspace`, so a repository name can never become
 * a path out of the account's own working directory — `owner/name` is a name, and the
 * directory it produces is resolved and checked like any other write. And the token
 * is supplied **per command** and never stored: the clone rewrites `origin` back to
 * the plain URL, and a push carries the credential inline, so `.git/config` in the
 * workspace never holds a live token a later reader could take. Every string this
 * module returns is passed through `redactToken` first, because a git error can echo
 * the URL it was given.
 *
 * THE GATE
 * --------
 * These are console operations, not agent tools, so they sit behind the same
 * authorization every `/api` route does and are not dispatched from the model's tool
 * set. What the agent *does* inside a cloned workspace — committing, editing — goes
 * through the ordinary tools and their gate; the console only provides the source,
 * the branch and the pull request.
 */

import { config } from "./config.js";
import {
  authenticatedCloneUrl,
  branchNameFor,
  cloneUrlFor,
  isBranchName,
  normalizeTitle,
  parsePullRequest,
  parseRepoSpec,
  pullRequestApiUrl,
  pullRequestPayload,
  redactToken,
  repoLabel,
  repoSlug,
  type PullRequest,
  type RepoRef,
} from "./repo-rules.js";
import { workspaceRoot } from "./scope.js";
import { runShellCommand } from "./shell.js";
import { resolveInWorkspace } from "./workspace.js";
import fs from "node:fs/promises";

/** A repository operation that was refused, with a message a caller can print. */
export class RepoError extends Error {}

/** What a git invocation returned, in the shape this module needs. */
export interface GitResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  refused?: string;
}

/**
 * How to run one git command in one directory. The port a test replaces.
 *
 * The real runner is `runShellCommand`, so a repository operation passes the *same*
 * guard list, sandbox decision and timeout the agent's `run_command` and the
 * console's terminal do — cloning is not a second, weaker route to a shell.
 */
export type GitRunner = (command: string, cwd: string) => Promise<GitResult>;

const defaultRunner: GitRunner = async (command, cwd) => {
  const result = await runShellCommand({ command, cwd });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    output: result.output,
    ...(result.refused === undefined ? {} : { refused: result.refused }),
  };
};

/** Single-quote a value for a shell command, so a name can never become an argument. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whether a git host is configured. The feature is off, not half-on, when it is not. */
export function gitConfigured(): boolean {
  return config.gitBaseUrl !== "";
}

/** The base URL and whether a token is present, for `GET /api/repo`. */
export function gitInfo(): { base: string; token: boolean; defaultBranch: string } {
  return { base: config.gitBaseUrl, token: config.gitToken !== "", defaultBranch: config.gitDefaultBranch };
}

/** The repository the working directory is a clone of, or `null` when it is not one. */
export async function detectRepoRef(run: GitRunner = defaultRunner): Promise<RepoRef | null> {
  const result = await run("git remote get-url origin", workspaceRoot());
  if (!result.ok) return null;
  return parseRepoSpec(result.output.trim());
}

export interface CloneInput {
  spec: unknown;
  /** Where to clone, relative to the working directory. Defaults to the repo name. */
  dir?: unknown;
  /** A branch to check out after cloning, when it is not the default one. */
  branch?: unknown;
}

export interface CloneResult {
  /** Workspace-relative path of the clone. */
  rel: string;
  /** The `owner/name` that was cloned. */
  repo: string;
  /** The host path, for display — never the URL a credential was on. */
  url: string;
  branch: string | null;
}

/**
 * Clone a repository into the working directory.
 *
 * The target is resolved through `resolveInWorkspace`, so a `dir` of `../..` or an
 * absolute path is refused before git is asked to write anything, and a directory
 * that already holds files is refused rather than clobbered — cloning over work is
 * not a thing a person means. The default branch is whatever the host checks out;
 * a named `branch` is switched to afterwards, and a branch that does not exist is a
 * plain git failure reported as one.
 */
export async function cloneRepository(input: CloneInput, run: GitRunner = defaultRunner): Promise<CloneResult> {
  if (!gitConfigured()) {
    throw new RepoError("no git host is configured (set AGENT_GIT_BASE_URL)");
  }
  const ref = parseRepoSpec(input.spec);
  if (ref === null) throw new RepoError("a repository is named as owner/name");

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : ref.name;
  let abs: string;
  try {
    abs = resolveInWorkspace(requested);
  } catch {
    throw new RepoError("that path is outside the workspace");
  }

  // An existing, non-empty directory is refused: git would refuse it too, but a
  // clearer message here is the difference between "try another name" and a cryptic
  // "destination path already exists".
  try {
    const entries = await fs.readdir(abs);
    if (entries.length > 0) throw new RepoError("there is already something in that directory");
  } catch (error) {
    if (error instanceof RepoError) throw error;
    // ENOENT and friends: the directory is new, which is what we want.
  }

  const authUrl = authenticatedCloneUrl(config.gitBaseUrl, ref, config.gitToken);
  const cloned = await run(`git clone ${shq(authUrl)} ${shq(abs)}`, workspaceRoot());
  if (cloned.refused !== undefined) throw new RepoError(redactToken(cloned.refused, config.gitToken));
  if (!cloned.ok) {
    throw new RepoError(`could not clone the repository: ${redactToken(cloned.output.trim(), config.gitToken)}`);
  }

  // Strip the credential back out of the workspace: the remote is rewritten to the
  // plain URL, so nothing a later reader of `.git/config` finds is a live token.
  await run(`git remote set-url origin ${shq(cloneUrlFor(config.gitBaseUrl, ref))}`, abs);

  let branch: string | null = null;
  const wanted = typeof input.branch === "string" && input.branch.trim() !== "" ? input.branch.trim() : null;
  if (wanted !== null) {
    if (!isBranchName(wanted)) throw new RepoError("that is not a valid branch name");
    const checkedOut = await run(`git checkout ${shq(wanted)}`, abs);
    if (!checkedOut.ok) {
      throw new RepoError(`could not check out ${wanted}: ${redactToken(checkedOut.output.trim(), config.gitToken)}`);
    }
    branch = wanted;
  }

  return { rel: requested, repo: repoSlug(ref), url: repoLabel(config.gitBaseUrl, ref), branch };
}

export interface BranchInput {
  /** An explicit name; when absent one is derived from `title`. */
  name?: unknown;
  title?: unknown;
  /** A short tag that makes a derived name unique. */
  suffix?: unknown;
}

/** Create and check out a working branch in the current repository. */
export async function createBranch(
  input: BranchInput,
  run: GitRunner = defaultRunner,
): Promise<{ branch: string }> {
  const suffix =
    typeof input.suffix === "string" && input.suffix.trim() !== ""
      ? input.suffix.trim()
      : Date.now().toString(36).slice(-6);
  const name =
    typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : branchNameFor(input.title, suffix);
  if (!isBranchName(name)) throw new RepoError("that is not a valid branch name");

  const created = await run(`git checkout -b ${shq(name)}`, workspaceRoot());
  if (!created.ok) {
    throw new RepoError(`could not create the branch: ${redactToken(created.output.trim(), config.gitToken)}`);
  }
  return { branch: name };
}

export interface PushInput {
  branch: unknown;
}

export interface PushResult {
  branch: string;
  repo: string | null;
}

/**
 * Push a local branch to the repository's `origin`.
 *
 * The owner/name comes from `origin` itself — read back with `git remote get-url` and
 * reduced by `parseRepoSpec`, so the host in the stored URL is discarded and the push
 * goes to the configured base — which is what lets a push work after the clone has
 * rewritten the remote to the plain URL. The credential is inline and unpersisted,
 * for the same reason it is on the clone.
 */
export async function pushBranch(input: PushInput, run: GitRunner = defaultRunner): Promise<PushResult> {
  const branch = input.branch;
  if (!isBranchName(branch)) throw new RepoError("that is not a valid branch name");

  const ref = await detectRepoRef(run);
  if (ref === null) throw new RepoError("the working directory is not a clone of a repository");
  if (!gitConfigured()) throw new RepoError("no git host is configured (set AGENT_GIT_BASE_URL)");

  const authUrl = authenticatedCloneUrl(config.gitBaseUrl, ref, config.gitToken);
  const pushed = await run(`git push ${shq(authUrl)} ${shq(branch)}`, workspaceRoot());
  if (pushed.refused !== undefined) throw new RepoError(redactToken(pushed.refused, config.gitToken));
  if (!pushed.ok) {
    throw new RepoError(`could not push the branch: ${redactToken(pushed.output.trim(), config.gitToken)}`);
  }
  return { branch, repo: repoSlug(ref) };
}

export interface PullRequestInputShape {
  title: unknown;
  head: unknown;
  base?: unknown;
  body?: unknown;
  /** The repository; when absent it is read back from `origin`. */
  spec?: unknown;
}

/**
 * Open a pull request for a pushed branch.
 *
 * `head` is the branch that holds the work, `base` is where it merges (the caller's
 * choice, or the configured default). A token is required: opening a pull request is
 * an authenticated write on the host, and — unlike a public clone — there is no
 * unauthenticated form of it. The response is read structurally, so an API that
 * renames a field degrades to a partial answer rather than failing an operation that
 * already succeeded.
 */
export async function openPullRequest(
  input: PullRequestInputShape,
  run: GitRunner = defaultRunner,
  fetchImpl: typeof fetch = fetch,
): Promise<PullRequest & { repo: string; head: string; base: string }> {
  if (!gitConfigured()) throw new RepoError("no git host is configured (set AGENT_GIT_BASE_URL)");
  if (config.gitToken === "") throw new RepoError("a git token is required to open a pull request");

  const ref = input.spec !== undefined ? parseRepoSpec(input.spec) : await detectRepoRef(run);
  if (ref === null) throw new RepoError("a repository is named as owner/name, or the workspace must be its clone");

  const head = typeof input.head === "string" ? input.head.trim() : "";
  if (!isBranchName(head)) throw new RepoError("a branch to open the pull request from is required");
  const base =
    typeof input.base === "string" && input.base.trim() !== "" ? input.base.trim() : config.gitDefaultBranch;
  if (!isBranchName(base)) throw new RepoError("that is not a valid base branch name");
  const title = normalizeTitle(input.title);
  const body = typeof input.body === "string" ? input.body : undefined;

  const response = await fetchImpl(pullRequestApiUrl(config.gitBaseUrl, ref), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${config.gitToken}`,
    },
    body: JSON.stringify(pullRequestPayload({ title, head, base, ...(body === undefined ? {} : { body }) })),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RepoError(
      `could not open a pull request: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  return { ...parsePullRequest(payload), repo: repoSlug(ref), head, base };
}
