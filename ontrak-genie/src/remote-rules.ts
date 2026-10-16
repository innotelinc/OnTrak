/**
 * Remote rules (v0.6) — the pure half of *working somewhere that is not this
 * machine*: a folder on a server reached over SSH, and a repository on GitHub
 * reached with the caller's own token.
 *
 * The console has always worked in a directory it can *see*, and every fence in
 * the product is built on that: `resolveInWorkspace` refuses an absolute path and
 * a `..`, the sandbox mounts one tree, the preview runs the project where it sits.
 * A remote folder is therefore not a second kind of workspace — it is the same
 * workspace, at a directory a FUSE mount put inside the sandbox. That is what
 * keeps this from being a second, weaker jail, and it is why the decisions that
 * live here are only about *names*: which host, which user, which path, which
 * repository, and which credential is handed to which command.
 *
 * WHAT IS PROVED HERE RATHER THAN IN THE PROCESS RUNNER
 * -----------------------------------------------------
 *   * a host, a user and a path a caller supplies cannot become an argument:
 *     every one of them is character-checked, and a leading `-` is refused on
 *     purpose, because `sshfs` would read it as an option;
 *   * an SSH path is absolute, normalised, and may not contain `..` — the remote
 *     shell would resolve a relative path against a home directory this console
 *     has no business guessing at;
 *   * a path that reaches the sandbox is `.remotes/<id>`, so a remote mount can
 *     never be named by the folder picker and never collides with the user's own
 *     directories;
 *   * a repository is a repository **on github.com**. The Gitea rules
 *     (`repo-rules.ts`) discard a pasted URL's host because the operator chose
 *     one base; here the host is the product's, so `gitlab.com/acme/widgets` is
 *     *refused* rather than quietly cloned from GitHub;
 *   * a command is built by us, never by the caller: `sshfs` and `fusermount`
 *     invocations are assembled here, and every value in them has been through
 *     the same checks and is shell-quoted besides.
 *
 * The process that runs these commands, holds the credentials for the life of the
 * session and mounts the tree is `remote.ts`.
 */

import crypto from "node:crypto";
import path from "node:path";

import type { RepoRef } from "./repo-rules.js";

/* -------------------------------------------------------------------------- */
/*  SSH                                                                       */
/* -------------------------------------------------------------------------- */

/** A remote folder the console may mount: the host, how to reach it, where it is. */
export interface SshSpec {
  host: string;
  port: number;
  user: string;
  /** Absolute, normalised POSIX path on the remote host. */
  path: string;
}

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const MAX_HOST = 253;
const MAX_USER = 64;
const MAX_PATH = 4096;

/**
 * Whether a string is a host this console will dial.
 *
 * A hostname, an IPv4 literal, or a bracketed IPv6 literal — nothing else. The
 * shape matters because the value becomes the target of an `sshfs` argument:
 * anything with a space, a colon, a slash or an `@` in it could add a word to
 * that command line or name another user, and a double dot could reach a name
 * the operator never intended.
 */
export function isSshHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const host = value.trim();
  if (host === "" || host.length > MAX_HOST) return false;
  if (host.includes("..")) return false;
  if (BRACKETED_IPV6.test(host)) return true;
  return HOSTNAME.test(host);
}

/**
 * The port to dial: `22` when nobody said, and `null` when what they said is not
 * one.
 *
 * `null` rather than a fallback on nonsense, because silently dialling 22 for
 * `port=abc` is a connection to a host the caller did not ask for — and the
 * difference between a typo and an intended server is not one this module can
 * guess at.
 */
export function parseSshPort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 22;
  const port = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** Whether a string is a remote user name this console will become. */
export function isSshUser(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_USER && USER.test(value.trim());
}

/**
 * Read a remote path, or `null` when it is not one.
 *
 * Absolute, control-character-free, and with no `.` or `..` segment: the path is
 * handed to a remote shell, and a relative one would resolve against a login
 * directory this console cannot see. Trailing and doubled slashes are collapsed
 * so two spellings of one folder are one mount. Spaces and other punctuation are
 * *allowed* — a real project directory has them — because the value is quoted
 * when it reaches the command line rather than trusted not to need it.
 */
export function normalizeRemotePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || raw.length > MAX_PATH) return null;
  if (!raw.startsWith("/")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `/${segments.join("/")}`;
}

/** Read a whole SSH connection, or `null` when any part of it is not usable. */
export function parseSshSpec(input: unknown): SshSpec | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host.trim() : record.host;
  if (!isSshHost(host)) return null;
  const port = parseSshPort(record.port);
  if (port === null) return null;
  const user = typeof record.user === "string" ? record.user.trim() : record.user;
  if (!isSshUser(user)) return null;
  const remotePath = normalizeRemotePath(record.path);
  if (remotePath === null) return null;
  return { host: host.trim(), port, user: user.trim(), path: remotePath };
}

/** `user@host:path` — the target `sshfs` is given, with no credential in it. */
export function sshTarget(spec: SshSpec): string {
  return `${spec.user}@${spec.host}:${spec.path}`;
}

/** The same thing for a person to read, with the port when it is not the default. */
export function sshLabel(spec: SshSpec): string {
  const where = spec.port === 22 ? `${spec.user}@${spec.host}` : `${spec.user}@${spec.host}:${spec.port}`;
  return `${where}:${spec.path}`;
}

/**
 * Whether a host is one this deployment allows.
 *
 * An empty list means "whatever the person typed", which is the shipped default:
 * the credential is theirs, the connection is outbound, and the console is behind
 * the deployment's own gate. A non-empty list is the operator narrowing that: an
 * exact name, or `*.example.com` for every host under one domain. Matching is
 * case-insensitive because a hostname is.
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const wanted = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule === "") return false;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      return wanted.endsWith(suffix) && wanted.length > suffix.length;
    }
    return wanted === rule;
  });
}

/**
 * A short, stable, filesystem-safe id for one connection.
 *
 * Two people may mount the same host at different paths, and one person may mount
 * two paths on one host, so the id has to distinguish them — and it has to be a
 * *name* the sandbox can hold, since it becomes the mount directory. The digest
 * does the distinguishing (so `a/b` and `a b` cannot collide) and the sanitised
 * host makes the directory legible to whoever lists it.
 */
export function remoteId(spec: SshSpec): string {
  const stem =
    spec.host
      .replace(/[^A-Za-z0-9.-]/g, "-")
      .replace(/^[.-]+/, "")
      .replace(/[.-]+$/, "")
      .slice(0, 32) || "host";
  const digest = crypto
    .createHash("sha256")
    .update(`${spec.user}@${spec.host}:${spec.port}:${spec.path}`)
    .digest("hex")
    .slice(0, 10);
  return `${stem}-${digest}`;
}

/** Where mounts live inside the sandbox: a dot-directory, so it is never offered. */
export const REMOTE_DIR = ".remotes";

/** The sandbox-relative directory one connection is mounted at. */
export function remoteRel(spec: SshSpec): string {
  return `${REMOTE_DIR}/${remoteId(spec)}`;
}

export function mountDirFor(base: string, id: string): string {
  return path.join(base, REMOTE_DIR, id);
}

/**
 * Whether a sandbox-relative path is a remote mount.
 *
 * Used at boot: mounts live in this process's memory, so a selection saved
 * pointing at one is a selection naming a directory that is not there any more.
 */
export function isRemoteRel(rel: string): boolean {
  return rel === REMOTE_DIR || rel.startsWith(`${REMOTE_DIR}/`);
}

/** How a mount is made. Credential paths are ours; nothing here is caller-supplied. */
export interface SshMountOptions {
  /** The (empty) directory the remote tree appears at. */
  mountPoint: string;
  /** Path of the private key file, when the connection uses one. */
  keyFile?: string;
  /**
   * Whether a secret (a password, or a key's passphrase) will be handed to the
   * connection through the environment. It is never an argument.
   */
  secret?: boolean;
  /** Where host keys are pinned, so a first connection is remembered. */
  knownHostsFile: string;
  connectTimeoutSec?: number;
}

/** Single-quote a value for a shell command, so a name can never become an argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `sshfs` command that mounts one remote folder.
 *
 * Assembled rather than templated, and every option is deliberate:
 *
 *   * `IdentityFile` + `IdentitiesOnly=yes` when there is a key, so the
 *     connection uses the credential the caller supplied and no key of this
 *     host's happens to be offered instead;
 *   * `StrictHostKeyChecking=accept-new` with our own `UserKnownHostsFile`:
 *     trust on first use, pinned afterwards, and the pinning never touches the
 *     operator's `~/.ssh`. A host key that *changes* is refused, which is the
 *     point of remembering it;
 *   * `sshpass -e` when a secret was supplied: the password or passphrase is read
 *     from the environment by the child process, so it is not in this command
 *     line, in the process list, or in the mount's own options;
 *   * `BatchMode=yes` only when there is *no* secret — it forbids the very prompt
 *     `sshpass` exists to answer;
 *   * `reconnect` + keepalives, because a laptop that sleeps mid-session should
 *     come back rather than leave a dead mount under the agent's feet.
 *
 * `sshfs` forks into the background once the mount is up, so the command returns
 * — which is what lets this run through the same bounded, sandboxed shell
 * executor every other command does.
 */
export function sshfsCommand(spec: SshSpec, options: SshMountOptions): string {
  const args: string[] = [shellQuote(sshTarget(spec)), shellQuote(options.mountPoint)];
  args.push("-p", String(spec.port));

  const settings: string[] = [];
  if (options.keyFile !== undefined) {
    settings.push(`IdentityFile=${options.keyFile}`, "IdentitiesOnly=yes");
  }
  if (options.secret === true) {
    settings.push("ssh_command=sshpass -e ssh");
  } else {
    settings.push("BatchMode=yes");
  }
  settings.push(
    "StrictHostKeyChecking=accept-new",
    `UserKnownHostsFile=${options.knownHostsFile}`,
    `ConnectTimeout=${options.connectTimeoutSec ?? 15}`,
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
    // A remote tree that changes underneath us — which is the whole point of
    // working on one — must not be answered from a directory cache.
    "dir_cache=no",
    "reconnect",
  );

  for (const setting of settings) args.push("-o", shellQuote(setting));
  return `sshfs ${args.join(" ")}`;
}

/**
 * The environment that carries a secret to `sshfs`'s own `ssh`.
 *
 * The secret is never written into the command: `sshpass -e` reads `SSHPASS`, so
 * it cannot appear in the process list, in the transcript, or in a log line that
 * echoed a command. Empty when the connection has no secret to hand over.
 */
export function sshMountEnv(secret: string | undefined): Record<string, string> {
  return secret === undefined || secret === "" ? {} : { SSHPASS: secret };
}

/** The unmount command, whichever of the three tools this host has. */
export function unmountCommand(mountPoint: string): string {
  const quoted = shellQuote(mountPoint);
  return `fusermount3 -u ${quoted} || fusermount -u ${quoted} || umount ${quoted}`;
}

/* -------------------------------------------------------------------------- */
/*  GitHub                                                                    */
/* -------------------------------------------------------------------------- */

/** A GitHub repository, always `owner/name`. */
export interface GitHubRef {
  owner: string;
  name: string;
}

export const GITHUB_HOST = "github.com";
export const GITHUB_API = "https://api.github.com";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SEGMENT_MAX = 100;
const TOKEN = /^[A-Za-z0-9_-]{8,255}$/;

/**
 * Read a repository reference that must live on **GitHub**.
 *
 * Accepts `owner/name`, `github.com/owner/name`, `https://github.com/owner/name`
 * and `git@github.com:owner/name.git`. The difference from `parseRepoSpec` is the
 * point of the function: there, a pasted host is discarded because the operator's
 * base is the only host dialled; here the host is *checked*. `gitlab.com/acme/x`
 * is refused rather than silently cloned from GitHub, because a person who pasted
 * a GitLab URL does not want a repository with that name from somewhere else.
 */
export function parseGitHubSpec(input: unknown): GitHubRef | null {
  if (typeof input !== "string") return null;
  let raw = input.trim();
  if (raw === "") return null;

  // A pasted URL or scp-style address: keep the path, but *check* the host.
  const urlMatch = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:([^/@]+)@)?([^/:\s]+)(?::\d+)?[/:](.+)$/i.exec(raw);
  if (urlMatch) {
    const host = (urlMatch[2] ?? "").toLowerCase();
    const rest = urlMatch[3] ?? "";
    // `owner/name` also matches the shape above with `owner` as the "host" —
    // that is the bare form, and it is not a host at all.
    if (host === GITHUB_HOST || host === `www.${GITHUB_HOST}`) {
      raw = rest;
    } else if (rest.includes("/")) {
      return null;
    }
  }

  raw = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/").filter((part) => part !== "");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  if (owner.length > SEGMENT_MAX || name.length > SEGMENT_MAX) return null;
  return { owner, name };
}

export function gitHubSlug(ref: GitHubRef): string {
  return `${ref.owner}/${ref.name}`;
}

/** What a person reads: the repository's page. Never dialled by this console. */
export function gitHubUrl(ref: GitHubRef): string {
  return `https://${GITHUB_HOST}/${gitHubSlug(ref)}`;
}

/** The plain clone URL. What `origin` is rewritten to, so no token is stored. */
export function gitHubCloneUrl(ref: GitHubRef): string {
  return `${gitHubUrl(ref)}.git`;
}

/**
 * The same URL with the caller's token as credentials, for **one command only**.
 *
 * `x-access-token` is the username GitHub documents for a personal access token
 * over HTTPS; the password position holds the token. Like the Gitea rules, this
 * URL is never stored: the clone rewrites `origin` back to the plain URL and a
 * push supplies it inline, so `.git/config` is not a place a later reader finds a
 * live credential.
 */
export function gitHubAuthenticatedUrl(ref: GitHubRef, token: string): string {
  if (token === "") return gitHubCloneUrl(ref);
  const url = new URL(gitHubCloneUrl(ref));
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

/**
 * Whether a string is plausibly a GitHub credential.
 *
 * Deliberately loose about the *shape* — classic `ghp_…`, fine-grained
 * `github_pat_…`, and whatever GitHub ships next all pass — and strict about the
 * two things that matter here: it has no whitespace or control characters, so it
 * cannot become a second argument or a header-injecting newline, and it is
 * bounded, so a pasted file is refused instead of sent.
 */
export function isGitHubToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value.trim());
}

/** The API endpoint for one repository, and a path under it. */
export function gitHubApiUrl(ref: GitHubRef, ...segments: string[]): string {
  const tail = segments
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${GITHUB_API}/repos/${ref.owner}/${ref.name}${tail === "" ? "" : `/${tail}`}`;
}

/** Where a repository is created: GitHub's endpoint for the caller's own repos. */
export function gitHubCreateRepoUrl(): string {
  return `${GITHUB_API}/user/repos`;
}

/** Who the token belongs to, which is where a repository named here is created. */
export function gitHubUserUrl(): string {
  return `${GITHUB_API}/user`;
}

/**
 * The JSON body GitHub's create-repository endpoint expects.
 *
 * `auto_init: false` is the decision worth stating: a repository seeded with a
 * README already holds a commit, and pushing a project's own history at it is a
 * non-fast-forward refusal — the project would be on this disk and nowhere else,
 * which is the opposite of what "save it there" means. An empty repository takes
 * the first push and makes that branch its default, which is exactly the desired
 * outcome and needs no extra call to arrange.
 */
export function gitHubCreateRepoPayload(input: {
  name: string;
  description?: string;
  private: boolean;
}): Record<string, unknown> {
  return {
    name: input.name,
    private: input.private,
    auto_init: false,
    ...(input.description !== undefined && input.description !== ""
      ? { description: input.description }
      : {}),
  };
}

/** Read a repository GitHub created, out of whatever it answered. */
export function parseGitHubRepo(payload: unknown): {
  fullName: string | null;
  htmlUrl: string | null;
  defaultBranch: string | null;
} {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    fullName: typeof record.full_name === "string" ? record.full_name : null,
    htmlUrl: typeof record.html_url === "string" ? record.html_url : null,
    defaultBranch: typeof record.default_branch === "string" ? record.default_branch : null,
  };
}

/**
 * The headers GitHub requires, with the caller's token.
 *
 * `Accept: application/vnd.github+json` and the API version are what make the
 * answer stable across GitHub's own evolution, and `User-Agent` is mandatory
 * rather than polite: GitHub refuses a request without one.
 */
export function gitHubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ontrak-genie",
    Authorization: `Bearer ${token}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  A git host the caller names (Gitea — the forge Atlas runs)                */
/* -------------------------------------------------------------------------- */

/**
 * A forge the caller points the console at, and the shape of its URLs.
 *
 * GitHub is *this* module's fixed host; a Gitea forge is a host somebody names,
 * which is why the address itself is validated here rather than assumed. The
 * value is a base — `http://192.168.1.90:3000`, or the same forge behind an edge
 * name — and everything else is derived from it, so a clone URL, an API call and
 * a push cannot end up on three different hosts.
 *
 * Atlas is this shape and nothing more: the ecosystem's Gitea, offered as an
 * add-on. `atlas.ts` supplies the address; this module never needs to know which
 * forge it is talking to.
 */

// The first character may not be a dash for the same reason an SSH user's may not:
// the name is one half of `user:secret@host`, and a name that reads as an option
// somewhere else is not a name this module will carry.
const GIT_HOST_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const SECRET_MAX = 512;

/**
 * Read a forge address, or `null` when it is not one.
 *
 * `http`/`https` only: a `file:` URL is a local path and an `ssh://` one needs an
 * agent this console has no business holding, so both are refused rather than
 * passed to git. Credentials in the URL are refused too — the credential is
 * supplied per command by `remote.ts`, and one smuggled into an address would end
 * up stored in `.git/config` by the first clone. A path prefix (`/gitea`) is
 * kept, because a forge behind a sub-path is a real deployment, and a trailing
 * slash, query and fragment are dropped so two spellings are one host.
 */
export function parseGitHostUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw === "" || raw.length > 300) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** The forge's web address for a repository — for display, and for a person to open. */
export function forgeWebUrl(base: string, ref: RepoRef): string {
  return `${base}/${ref.owner}/${ref.name}`;
}

/** The plain clone URL. What `origin` is rewritten to, so no credential is stored. */
export function forgeCloneUrl(base: string, ref: RepoRef): string {
  return `${forgeWebUrl(base, ref)}.git`;
}

/**
 * The same URL with the caller's credential, for **one command only**.
 *
 * Gitea takes basic auth on a clone and a push, and takes an access token in the
 * password position — so one shape serves a password and a token alike, and a
 * token never has to be exchanged for one. Like every other credential here it is
 * never stored: the clone rewrites `origin` to the plain URL and a push supplies
 * it inline.
 */
export function forgeAuthenticatedUrl(base: string, ref: RepoRef, user: string, secret: string): string {
  if (secret === "") return forgeCloneUrl(base, ref);
  const url = new URL(forgeCloneUrl(base, ref));
  url.username = user;
  url.password = secret;
  return url.toString();
}

/** Gitea's REST API under a forge address, with path segments encoded. */
export function forgeApiUrl(base: string, ...segments: string[]): string {
  const root = base.replace(/\/+$/, "");
  const tail = segments
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${root}/api/v1${tail === "" ? "" : `/${tail}`}`;
}

/**
 * Basic auth for Gitea's API, built here so the credential is never interpolated
 * into a header string by a caller.
 *
 * `btoa` is not available everywhere this runs, and the user name and secret are
 * UTF-8 rather than ASCII in principle, so the encoding is explicit.
 */
export function forgeAuthHeader(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

/** Gitea's token form, for a credential that is an access token. */
export function forgeTokenHeader(secret: string): string {
  return `token ${secret}`;
}

/** Whether a string is a user name a forge can be asked about. */
export function isForgeUser(value: unknown): value is string {
  return typeof value === "string" && GIT_HOST_USER.test(value.trim());
}

/**
 * Whether a string can be a credential: non-empty, bounded, and free of the
 * whitespace and control characters that would break a header or a URL.
 */
export function isForgeSecret(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const secret = value.trim();
  if (secret === "" || secret.length > SECRET_MAX) return false;
  return !/[\u0000-\u001f\u007f\s]/.test(secret);
}

/** A repository name a forge will accept, for creating one. */
export function normalizeRepoName(input: unknown, fallback = ""): string | null {
  const raw = typeof input === "string" ? input.trim() : fallback.trim();
  if (raw === "" || raw.length > SEGMENT_MAX) return null;
  if (!SEGMENT.test(raw)) return null;
  if (raw === "." || raw === "..") return null;
  return raw;
}

/** What a person has to say to create a repository, and nothing else. */
export interface NewRepoInput {
  name: string;
  description?: string;
  /** A private repository is the default: the ecosystem's repos are not public. */
  private: boolean;
  /** Seed it with a README, so a fresh clone is a working repository. */
  autoInit: boolean;
}

/** The JSON body Gitea's create-repository endpoint expects. */
export function forgeRepoPayload(input: NewRepoInput): Record<string, unknown> {
  return {
    name: input.name,
    private: input.private,
    auto_init: input.autoInit,
    default_branch: "main",
    ...(input.description !== undefined && input.description !== ""
      ? { description: input.description }
      : {}),
  };
}

/**
 * Read a created repository out of whatever the forge answered.
 *
 * Structural and forgiving, like the rest of the app's readers: a deployment of
 * Gitea that names a field differently degrades to a partial answer instead of
 * failing an operation that already succeeded on the server.
 */
export function parseForgeRepo(payload: unknown): { fullName: string | null; htmlUrl: string | null; branch: string | null } {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    fullName: typeof record.full_name === "string" ? record.full_name : null,
    htmlUrl: typeof record.html_url === "string" ? record.html_url : null,
    branch: typeof record.default_branch === "string" ? record.default_branch : null,
  };
}

/** The login a `GET /api/v1/user` answer is for, when it says. */
export function parseForgeUser(payload: unknown): string | null {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (typeof record.login === "string" && record.login !== "") return record.login;
  if (typeof record.username === "string" && record.username !== "") return record.username;
  return null;
}
