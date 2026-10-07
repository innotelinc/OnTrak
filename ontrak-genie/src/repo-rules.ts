/**
 * Repository rules (v0.4) — the pure half of *repository-aware workspaces*.
 *
 * The roadmap asked for Gitea/Atlas as the *source* of a workspace: clone a
 * repository, work on a branch, open a pull request, all from the console and all
 * behind the same jail and gate as every other write. The decisions that make that
 * safe and legible are decisions about strings — how a repository is named, what a
 * branch is called, which URL is dialled and which endpoint is called — so they live
 * here, pure and testable without a network or a git binary. The process that
 * actually runs `git` and speaks HTTP is `repo.ts`.
 *
 * WHY THE SPEC IS `owner/name` AND NOT A URL
 * ------------------------------------------
 * A clone URL is a string a caller could point anywhere — an arbitrary host, a
 * `file://` path, an ssh address with its own agent. Accepting one would make "clone
 * this repository" a way to dial the deployment's own network and to make git run a
 * command (`ext::`) on this host. So the caller names a repository in the only form
 * that cannot become a host: `owner/name`, resolved against a base URL the operator
 * configured. A full URL is accepted and **reduced to that form** — convenient for a
 * paste, but the host in it is discarded rather than obeyed.
 */

/** A repository the console may clone, always `owner/name` with no host in it. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** One path segment of a repository: the same set git itself accepts, and no dot names. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SEGMENT_MAX = 100;

/** A branch name git accepts without quoting, and that cannot be a flag or a range. */
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Read a repository reference, or `null` when it is not one.
 *
 * Accepts `owner/name` and the two URL shapes a person pastes
 * (`https://host/owner/name`, `git@host:owner/name`), stripping the scheme and the
 * host so the base the operator configured is the only host ever dialled. `.git`
 * and stray slashes are trimmed. A name that is not exactly two safe path segments
 * is refused rather than sanitised: a repo name is an identifier, and quietly
 * rewriting one would clone something other than what was asked for.
 */
export function parseRepoSpec(input: unknown): RepoRef | null {
  if (typeof input !== "string") return null;
  let raw = input.trim();
  if (raw === "") return null;
  // A pasted URL: keep only the path, so the host in it is discarded, not obeyed.
  const urlMatch = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|git@[^:]+:)(.+)$/i.exec(raw);
  if (urlMatch) raw = urlMatch[1] ?? "";
  raw = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/").filter((part) => part !== "");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  if (owner.length > SEGMENT_MAX || name.length > SEGMENT_MAX) return null;
  return { owner, name };
}

/** The canonical `owner/name` for a reference. */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

/**
 * A URL label for a reference, shaped like the two a person pastes. Kept for
 * display and for the log line that says what was cloned — it is never dialled.
 */
export function repoLabel(base: string, ref: RepoRef): string {
  return `${base.replace(/\/+$/, "")}/${repoSlug(ref)}`;
}

/**
 * The clone URL for a reference, given the operator's base.
 *
 * Deliberately the *plain* URL: any credential is supplied per command by
 * `repo.ts` and never written into `.git/config`, so a workspace this console
 * clones does not hold a token that a later reader of the workspace could take.
 */
export function cloneUrlFor(base: string, ref: RepoRef): string {
  return `${base.replace(/\/+$/, "")}/${ref.owner}/${ref.name}.git`;
}

/**
 * The same URL with the token as credentials, for **one command only**.
 *
 * `https://oauth2:<token>@host/owner/name.git` is the basic-auth shape Gitea and
 * GitHub both accept, and it is what makes a clone or a push work without asking a
 * human to answer a password prompt the sandbox could never surface. It is never
 * stored: the clone rewrites the remote back to the plain URL, and a push supplies
 * it inline. An empty token returns the plain URL, so a public repository needs no
 * credential at all.
 */
export function authenticatedCloneUrl(base: string, ref: RepoRef, token: string): string {
  if (token === "") return cloneUrlFor(base, ref);
  const url = new URL(cloneUrlFor(base, ref));
  url.username = "oauth2";
  url.password = token;
  return url.toString();
}

/** Gitea's REST API root for a host that exposes the web UI at `base`. */
export function apiBaseFor(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

/** `POST` target for opening a pull request on `owner/name`. */
export function pullRequestApiUrl(base: string, ref: RepoRef): string {
  return `${apiBaseFor(base)}/repos/${ref.owner}/${ref.name}/pulls`;
}

/** Normalise a title for a branch or a pull request: one trimmed line, non-empty. */
export function normalizeTitle(title: unknown, fallback = "Agent changes"): string {
  const raw = typeof title === "string" ? title.trim() : "";
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened === "" ? fallback : flattened.slice(0, 200);
}

/** A git-safe slug for a title: lowercase, hyphens, bounded. */
export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/**
 * A branch name for a task, prefixed and suffixed so it is recognisably the
 * console's and cannot collide with another run.
 *
 * `genie/<slug>-<token>`: the prefix keeps the agent's work out of the way of the
 * desk's own branches, the slug says what the branch is for, and the short suffix
 * (a clock reading or a random tag the caller supplies) makes two runs of the same
 * task distinct instead of a checkout that lands on top of the last one. The name is
 * trimmed to a length git and every UI handle comfortably, with any trailing hyphen
 * the trim exposed removed so the name never ends in one.
 */
export function branchNameFor(title: unknown, suffix: string, prefix = "genie"): string {
  const slug = slugify(normalizeTitle(title)).slice(0, 40) || "work";
  const clean = suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase();
  const name = clean === "" ? `${prefix}/${slug}` : `${prefix}/${slug}-${clean}`;
  return name.slice(0, 60).replace(/-+$/, "");
}

/** Whether a name is a branch this console may create or push. */
export function isBranchName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 200 && BRANCH.test(name) && !name.includes("..");
}

/** What a pull request is opened with. `base` is the branch it merges into. */
export interface PullRequestInput {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/** The JSON body Gitea's create-pull-request endpoint expects. */
export function pullRequestPayload(input: PullRequestInput): Record<string, string> {
  return {
    title: input.title,
    head: input.head,
    base: input.base,
    ...(input.body !== undefined && input.body !== "" ? { body: input.body } : {}),
  };
}

/** The parts of a created pull request the console reports back. */
export interface PullRequest {
  number: number | null;
  url: string | null;
  state: string | null;
}

/**
 * Read a created pull request out of whatever the API answered.
 *
 * Structural and forgiving, like the rest of the app's readers: a field that is
 * absent is `null` rather than an exception, so an API that grows or renames a field
 * degrades to a partial answer instead of failing the operation that already
 * succeeded on the server.
 */
export function parsePullRequest(payload: unknown): PullRequest {
  const record = (payload ?? {}) as Record<string, unknown>;
  const number = typeof record.number === "number" && Number.isFinite(record.number) ? record.number : null;
  const url =
    typeof record.html_url === "string" ? record.html_url : typeof record.url === "string" ? record.url : null;
  const state = typeof record.state === "string" ? record.state : null;
  return { number, url, state };
}

/**
 * Replace a credential with `***` anywhere it appears in text.
 *
 * A git command's own error can echo the URL it was given, and that URL carries the
 * token. Every string this module returns to a caller passes through here first, so
 * a failed push explains itself without printing a working credential into the
 * console, the transcript or a log.
 */
export function redactToken(text: string, token: string): string {
  if (token === "") return text;
  return text.split(token).join("***");
}
