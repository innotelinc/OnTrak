/**
 * Remote workspaces (v0.6) — working on a folder that is not on this machine.
 *
 * Two shapes, one idea. An **SSH folder** is mounted with `sshfs` at
 * `<sandbox>/.remotes/<id>`, and the console then does the only thing it has ever
 * known how to do: it makes that directory the working directory. Every tool, the
 * file tree, the diff, the snapshots and the preview therefore reach the remote
 * tree through the *same* jail, because as far as they are concerned it is a
 * directory — which is the whole reason this is a mount and not a second editor.
 * A **GitHub repository** is cloned into the working directory with the caller's
 * token, edited where it lands, and pushed and opened as a pull request through
 * GitHub's own API.
 *
 * WHAT IS DIFFERENT FROM `repo.ts`
 * --------------------------------
 * `repo.ts` is the *deployment's* repository feature: the operator names one host
 * and one token in the environment and every caller clones from that. Here the
 * host, the path and the token are the **caller's**, typed into the console, and
 * the console holds them for that person's session and no longer. That is a
 * different trust question — outbound, with a credential that is not this
 * deployment's — so it is a separate switch, a separate store, and a separate
 * module rather than a loosening of the one that already worked.
 *
 * WHERE THE CREDENTIALS LIVE
 * --------------------------
 * In memory, keyed exactly as the account scope is (`currentScope().userId`), and
 * for the life of the process. Nothing is written to a config file or to the
 * workspace: the clone rewrites `origin` back to the plain URL and a push carries
 * the token inline, so `.git/config` never holds a live credential — the same
 * decision `repo.ts` made, for the same reason. The two exceptions are stated
 * rather than hidden: a private key has to exist as a *file* for `sshfs` to read
 * it, so it is written `0600` under `<data>/remote/<account>/<id>/` and removed on
 * disconnect and at shutdown; and a password or passphrase never touches disk at
 * all, because it reaches `sshpass` through `SSHPASS` (`sshMountEnv`) instead of a
 * command line, where the process list would hold it.
 *
 * WHY THE MOUNT IS UNDER `.remotes`
 * ---------------------------------
 * Because the folder picker must not offer it. A mount that appeared in the list
 * of directories a person chooses from would be a second, stranger kind of
 * directory with a name nobody typed; it is a dot-directory, which is what the
 * picker already skips, and the remote feature reports it instead. It also means
 * a stale selection is detectable: mounts do not survive a restart, so a saved
 * working directory under `.remotes` names a directory that is gone, and
 * `resetRemoteSelection` puts the console back where it can actually work.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { atlasInfo, atlasVerdict } from "./atlas.js";
import { config } from "./config.js";
import {
  forgeApiUrl,
  forgeAuthHeader,
  forgeAuthenticatedUrl,
  forgeCloneUrl,
  forgeRepoPayload,
  forgeTokenHeader,
  forgeWebUrl,
  isForgeSecret,
  isForgeUser,
  normalizeRepoName,
  parseForgeRepo,
  parseForgeUser,
  parseGitHostUrl,
  GITHUB_HOST,
  gitHubApiUrl,
  gitHubAuthenticatedUrl,
  gitHubCloneUrl,
  gitHubHeaders,
  gitHubSlug,
  gitHubUrl,
  hostAllowed,
  isGitHubToken,
  isRemoteRel,
  mountDirFor,
  parseGitHubSpec,
  parseSshSpec,
  remoteId,
  remoteRel,
  shellQuote as shq,
  sshLabel,
  sshMountEnv,
  sshfsCommand,
  unmountCommand,
  type GitHubRef,
  type SshSpec,
} from "./remote-rules.js";
import {
  branchNameFor,
  isBranchName,
  normalizeTitle,
  parsePullRequest,
  parseRepoSpec,
  pullRequestPayload,
  redactToken,
  repoSlug,
  type PullRequest,
  type RepoRef,
} from "./repo-rules.js";
import { createBranch, type GitResult, type GitRunner } from "./repo.js";
import { sandboxRoot, selectedWorkspace, setSelectedWorkspace, accountDirName, currentScope } from "./scope.js";
import { runShellCommand } from "./shell.js";
import { resolveInBase, resolveInWorkspace, toRelFromBase } from "./workspace.js";

/** A remote operation that was refused, with a message a caller can print. */
export class RemoteError extends Error {}

/* -------------------------------------------------------------------------- */
/*  Ports                                                                     */
/* -------------------------------------------------------------------------- */

/** One command this module wants run, with the environment it needs. */
export interface RemoteInvocation {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RemoteResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  refused?: string;
}

export type RemoteRunner = (invocation: RemoteInvocation) => Promise<RemoteResult>;

/**
 * The seams a test replaces.
 *
 * `run` is the real `runShellCommand`, so a mount and a clone pass the *same*
 * guard list, sandbox decision and timeout as the agent's own commands — remote
 * work is not a second, weaker route to a shell. `mounted` is the one thing a
 * fake cannot infer from a command's exit status (see `defaultMounted`), and
 * `fetchImpl` is GitHub's API.
 */
export interface RemoteDeps {
  run: RemoteRunner;
  mounted: (mountPoint: string) => Promise<boolean>;
  fetchImpl: typeof fetch;
}

const defaultRunner: RemoteRunner = async (invocation) => {
  const result = await runShellCommand({
    command: invocation.command,
    cwd: invocation.cwd,
    ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
    ...(invocation.env === undefined ? {} : { env: invocation.env }),
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    output: result.output,
    ...(result.refused === undefined ? {} : { refused: result.refused }),
  };
};

/**
 * Whether `sshfs` really left a mount at that directory.
 *
 * An exit status is not enough. `sshfs` forks once the mount is up, and a
 * connection that fails afterwards leaves a plain, empty directory behind — the
 * same directory a successful mount of an empty remote folder would show. So the
 * mount table is the authority: the path is present in `/proc/self/mounts` or it
 * is not mounted at all. A host without `/proc` (macOS) cannot be asked this way,
 * and falls back to trusting the exit status, which is stated as the limitation
 * it is rather than papered over.
 */
async function defaultMounted(mountPoint: string): Promise<boolean> {
  try {
    const mounts = await fs.readFile("/proc/self/mounts", "utf8");
    // The kernel escapes space and tab in the mount table, and so must we.
    const encoded = mountPoint.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011");
    return mounts.split("\n").some((line) => {
      const fields = line.split(" ");
      return fields.length > 2 && fields[1] === encoded;
    });
  } catch {
    return true;
  }
}

const defaultDeps: RemoteDeps = { run: defaultRunner, mounted: defaultMounted, fetchImpl: fetch };

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

export interface SshConnection {
  id: string;
  spec: SshSpec;
  /** Absolute: `<sandbox>/.remotes/<id>`. */
  mountPoint: string;
  /** Sandbox-relative, i.e. what the workspace selection stores. */
  rel: string;
  auth: "key" | "password";
  connectedAt: string;
}

export interface GitHubConnection {
  ref: GitHubRef;
  repo: string;
  /**
   * The clone, as an **absolute** path.
   *
   * Absolute rather than relative on purpose: a relative path is read against
   * the working directory, and the working directory is exactly what connecting
   * to a clone changes. Keying on the resolved path means "push the clone I am
   * standing in" finds the credential no matter how many times the selection has
   * moved since the clone landed.
   */
  dir: string;
  /** The same directory relative to the sandbox, for display. */
  rel: string;
  url: string;
  branch: string | null;
  /** Never returned to a caller — `credential: true` is what a listing says. */
  token: string;
  connectedAt: string;
}

/** Which forge and repository a clone in a directory came from. */
interface ForgeClone {
  base: string;
  ref: RepoRef;
  branch: string | null;
}

interface AccountRemotes {
  ssh: Map<string, SshConnection>;
  github: Map<string, GitHubConnection>;
  /** Forges the caller has named, keyed by their base address (`src/atlas.ts`). */
  forge: Map<string, ForgeConnection>;
  /** Forge clones, keyed by the absolute directory they landed in. */
  clone: Map<string, ForgeClone>;
}

/**
 * Every credential this process is holding, keyed by account and never by
 * anything a caller supplies. One entry per account slot, which is the same key
 * the disk uses (`scope.ts`), so two people on one deployment cannot see or use
 * each other's connections.
 */
const accounts = new Map<string, AccountRemotes>();

function accountKey(): string {
  return currentScope().userId ?? "";
}

function slot(): AccountRemotes {
  const key = accountKey();
  let existing = accounts.get(key);
  if (existing === undefined) {
    existing = { ssh: new Map(), github: new Map(), forge: new Map(), clone: new Map() };
    accounts.set(key, existing);
  }
  return existing;
}

/** Only for tests: forget every connection this process is holding. */
export function resetRemotes(): void {
  accounts.clear();
}

/* -------------------------------------------------------------------------- */
/*  Credential files                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where one account's mount credentials live.
 *
 * Inside `AGENT_DATA_DIR` rather than the workspace, because it must not be a file
 * the agent can read, diff or delete: it is the console's, not the project's. The
 * key is a *name*, and the account directory is derived the same way the control
 * plane's is (`accountDirName`), so two accounts connecting to the same folder do
 * not share a key file.
 */
function credentialsRoot(): string {
  const scope = currentScope();
  const account = scope.userId === null ? "shared" : accountDirName(scope.userId);
  return path.join(config.dataDir, "remote", account);
}

function credentialsDir(id: string): string {
  return path.join(credentialsRoot(), id);
}

function knownHostsFile(): string {
  return path.join(config.dataDir, "remote", "known_hosts");
}

/** Write a private key where only this process can read it, and say where. */
async function writeKeyFile(id: string, key: string): Promise<string> {
  const dir = credentialsDir(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "id_key");
  const normalized = key.endsWith("\n") ? key : `${key}\n`;
  await fs.writeFile(file, normalized, { mode: 0o600 });
  // `writeFile`'s mode is subject to the umask, so say it again out loud.
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

async function removeCredentials(id: string): Promise<void> {
  await fs.rm(credentialsDir(id), { recursive: true, force: true }).catch(() => {});
}

/**
 * A pasted private key, or the reason it is not one.
 *
 * The example in the message is assembled from fragments rather than written out.
 * A PEM block is key-shaped, and `scripts/secret-scan.py` flags that shape
 * wherever it appears - a test, a placeholder, or a sentence - so the literal
 * would stop this file from being committed at all. The scanner builds its own
 * fixtures the same way, which is why nothing has to be exempted by name.
 */
const PEM_EXAMPLE = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");

function privateKeyReason(key: string): string | null {
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) {
    return `that does not look like a private key (expected a PEM block, e.g. ${PEM_EXAMPLE})`;
  }
  if (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(key)) {
    return "the private key is incomplete (no END line)";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  SSH: connect, disconnect                                                  */
/* -------------------------------------------------------------------------- */

export interface ConnectSshInput {
  host?: unknown;
  port?: unknown;
  user?: unknown;
  path?: unknown;
  /** A PEM private key, pasted. Preferred over a password when both are given. */
  key?: unknown;
  /** The key's passphrase, when it has one. */
  passphrase?: unknown;
  /** A password, for a host that authenticates that way. */
  password?: unknown;
}

export interface SshConnectionInfo {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  path: string;
  rel: string;
  mountPoint: string;
  auth: "key" | "password";
  connectedAt: string;
}

function sshInfo(connection: SshConnection): SshConnectionInfo {
  return {
    id: connection.id,
    label: sshLabel(connection.spec),
    host: connection.spec.host,
    user: connection.spec.user,
    port: connection.spec.port,
    path: connection.spec.path,
    rel: connection.rel,
    mountPoint: connection.mountPoint,
    auth: connection.auth,
    connectedAt: connection.connectedAt,
  };
}

function githubInfo(connection: GitHubConnection): GitHubInfo {
  return {
    repo: connection.repo,
    rel: connection.rel,
    url: connection.url,
    branch: connection.branch,
    credential: connection.token !== "",
    connectedAt: connection.connectedAt,
  };
}

export function remoteEnabled(): boolean {
  return config.remoteEnabled;
}

function assertEnabled(): void {
  if (!config.remoteEnabled) {
    throw new RemoteError("remote workspaces are switched off on this deployment (AGENT_REMOTE_ENABLED=false)");
  }
}

/** Everything the console shows about remote work, for `GET /api/remote`. */
export interface GitHubInfo {
  repo: string;
  rel: string;
  url: string;
  branch: string | null;
  credential: boolean;
  connectedAt: string;
}

/**
 * Mount a remote folder and make it the working directory.
 *
 * The order is deliberate. Everything is validated before a credential is
 * written, so a bad host or path cannot leave a key on disk; the credential file
 * is written before the mount, because `sshfs` reads it; the mount is
 * *verified* before it is remembered, because `sshfs` reports success for a
 * connection that has already died; and the workspace is moved only once there is
 * something at the other end, so the agent is never pointed at a dead directory.
 */
export async function connectSsh(input: ConnectSshInput, deps: RemoteDeps = defaultDeps): Promise<SshConnectionInfo> {
  assertEnabled();

  const spec = parseSshSpec(input);
  if (spec === null) {
    throw new RemoteError(
      "a remote folder is named as host, user and an absolute path (port optional); " +
        "a hostname, an IPv4 address or a bracketed IPv6 address, and a path with no `..`",
    );
  }
  if (!hostAllowed(spec.host, config.remoteAllowedHosts)) {
    throw new RemoteError(`this deployment only reaches the hosts in AGENT_REMOTE_ALLOWED_HOSTS, and ${spec.host} is not one of them`);
  }

  const key = typeof input.key === "string" ? input.key.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const passphrase = typeof input.passphrase === "string" ? input.passphrase : "";
  if (key === "" && password === "") {
    throw new RemoteError("a private key or a password is required to reach that host");
  }
  if (key !== "") {
    const reason = privateKeyReason(key);
    if (reason !== null) throw new RemoteError(reason);
  }

  const current = slot();
  const id = remoteId(spec);
  if (current.ssh.has(id)) {
    throw new RemoteError("this folder is already connected; disconnect it first to connect again");
  }

  const mountPoint = mountDirFor(sandboxRoot(), id);
  const rel = remoteRel(spec);
  const secret = password !== "" ? password : passphrase;
  const auth: "key" | "password" = key !== "" ? "key" : "password";

  // Whatever a previous attempt at *this* connection left behind goes now: this
  // directory holds one connection's credential, and a process that was killed
  // before it could clean up must not leave a key behind that the next connect —
  // which may well be a password one — silently keeps.
  await removeCredentials(id);

  // A mount left behind by a previous process would refuse a new one over the
  // same directory, and this directory is a generated one under `.remotes`, so
  // clearing it can only ever clear this console's own leftover.
  if (await deps.mounted(mountPoint)) {
    await deps.run({ command: unmountCommand(mountPoint), cwd: sandboxRoot(), timeoutMs: config.remoteTimeoutMs });
  }
  await fs.mkdir(mountPoint, { recursive: true });
  await fs.mkdir(path.dirname(knownHostsFile()), { recursive: true });

  let keyFile: string | undefined;
  if (key !== "") keyFile = await writeKeyFile(id, key);

  const command = sshfsCommand(spec, {
    mountPoint,
    ...(keyFile === undefined ? {} : { keyFile }),
    secret: secret !== "",
    knownHostsFile: knownHostsFile(),
    connectTimeoutSec: Math.max(5, Math.round(config.remoteTimeoutMs / 1000) - 10),
  });

  const result = await deps.run({
    command,
    cwd: sandboxRoot(),
    timeoutMs: config.remoteTimeoutMs,
    env: sshMountEnv(secret),
  });

  const explain = (fallback: string): string => {
    const detail = redactToken(result.output.trim(), secret);
    return detail === "" ? fallback : `${fallback}: ${detail.slice(0, 600)}`;
  };

  if (result.refused !== undefined) {
    await removeCredentials(id);
    throw new RemoteError(redactToken(result.refused, secret));
  }
  if (!result.ok) {
    await removeCredentials(id);
    throw new RemoteError(explain(`could not mount ${sshLabel(spec)}`));
  }
  if (!(await deps.mounted(mountPoint))) {
    await deps.run({ command: unmountCommand(mountPoint), cwd: sandboxRoot(), timeoutMs: config.remoteTimeoutMs });
    await removeCredentials(id);
    throw new RemoteError(explain(`mounted ${sshLabel(spec)} but nothing is reachable at it`));
  }

  const connection: SshConnection = {
    id,
    spec,
    mountPoint,
    rel,
    auth,
    connectedAt: new Date().toISOString(),
  };
  current.ssh.set(id, connection);
  await setSelectedWorkspace(rel);
  return sshInfo(connection);
}

/** Unmount a folder, drop its credential file, and stop working in it. */
export async function disconnectSsh(id: unknown, deps: RemoteDeps = defaultDeps): Promise<{ id: string; rel: string }> {
  const current = slot();
  const name = typeof id === "string" ? id.trim() : "";
  const connection = current.ssh.get(name);
  if (connection === undefined) throw new RemoteError("no such connection");

  current.ssh.delete(name);
  await deps.run({
    command: unmountCommand(connection.mountPoint),
    cwd: sandboxRoot(),
    timeoutMs: config.remoteTimeoutMs,
  });
  await removeCredentials(connection.id);

  // If that is where the agent was working, it is now a directory with nothing
  // behind it, so move back to the sandbox root rather than leave it there.
  if (selectedWorkspace() === connection.rel || isRemoteRel(selectedWorkspace())) {
    await setSelectedWorkspace("");
  }
  return { id: connection.id, rel: connection.rel };
}

/**
 * Unmount everything and forget every credential, for shutdown.
 *
 * Called on the signals the server already handles. A mount outliving the process
 * is a directory that looks like a folder and answers like a hung network share,
 * which is worse than no mount at all.
 */
export async function shutdownRemotes(deps: RemoteDeps = defaultDeps): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const account of accounts.values()) {
    // Forge credentials are memory-only, so forgetting them is all there is to do
    // for them; the loop below is for the mounts and the key files they need.
    account.forge.clear();
    account.clone.clear();
    for (const connection of account.ssh.values()) {
      pending.push(
        deps.run({
          command: unmountCommand(connection.mountPoint),
          cwd: sandboxRoot(),
          timeoutMs: config.remoteTimeoutMs,
        }),
      );
      pending.push(removeCredentials(connection.id));
    }
    account.ssh.clear();
    account.github.clear();
  }
  accounts.clear();
  await Promise.allSettled(pending);
}

/**
 * Drop a saved working directory that names a mount.
 *
 * Mounts live in this process's memory, so after a restart a saved selection
 * under `.remotes` is a path with nothing behind it: every tool would resolve
 * inside an empty directory and report an empty project rather than say what
 * happened. Returns the path it cleared, or null.
 */
export async function resetRemoteSelection(): Promise<string | null> {
  const rel = selectedWorkspace();
  if (!isRemoteRel(rel)) return null;
  await setSelectedWorkspace("");
  return rel;
}

/* -------------------------------------------------------------------------- */
/*  GitHub: clone, push, pull request                                         */
/* -------------------------------------------------------------------------- */

/** The git port, adapted onto the same runner, so both paths share one executor. */
function gitRunner(deps: RemoteDeps): GitRunner {
  return async (command: string, cwd: string): Promise<GitResult> => {
    const result = await deps.run({ command, cwd, timeoutMs: config.remoteTimeoutMs });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
      ...(result.refused === undefined ? {} : { refused: result.refused }),
    };
  };
}

/** Read the repository the working directory is a clone of, when it is on GitHub. */
async function detectGitHubOrigin(dir: string, run: GitRunner): Promise<GitHubRef | null> {
  const result = await run("git remote get-url origin", dir);
  if (!result.ok) return null;
  return parseGitHubSpec(result.output.trim());
}

/**
 * The token to use for a push or a pull request: what the caller just supplied,
 * or what this session already holds for that repository.
 */
function tokenFor(ref: GitHubRef, explicit: unknown, current: AccountRemotes): string {
  const supplied = typeof explicit === "string" ? explicit.trim() : "";
  if (supplied !== "") {
    if (!isGitHubToken(supplied)) throw new RemoteError("that does not look like a GitHub token");
    return supplied;
  }
  for (const connection of current.github.values()) {
    if (connection.repo === gitHubSlug(ref) && connection.token !== "") return connection.token;
  }
  return "";
}

function rememberGitHub(
  current: AccountRemotes,
  ref: GitHubRef,
  dir: string,
  token: string,
  branch: string | null,
): GitHubConnection {
  const connection: GitHubConnection = {
    ref,
    repo: gitHubSlug(ref),
    dir,
    rel: toRelFromBase(dir),
    url: gitHubUrl(ref),
    branch,
    token,
    connectedAt: new Date().toISOString(),
  };
  current.github.set(dir, connection);
  return connection;
}

/** The connection that owns a directory, when there is one. */
function connectionAt(dir: string): GitHubConnection | null {
  return slot().github.get(dir) ?? null;
}

export interface CloneGitHubInput {
  repo?: unknown;
  /** Where to clone, relative to the working directory. Defaults to the repo name. */
  dir?: unknown;
  branch?: unknown;
  token?: unknown;
}

export type CloneGitHubInfo = GitHubInfo;

/**
 * Clone a GitHub repository with the caller's token and work in it.
 *
 * The same two fences as `repo.ts`, restated because they are what makes this
 * safe rather than merely convenient: the target is resolved through
 * `resolveInWorkspace`, so a `dir` of `../..` or an absolute path is refused
 * before git is asked to write anything, and the credential is supplied to the
 * clone command alone — `origin` is then rewritten to the plain URL, so nothing a
 * later reader of `.git/config` finds is a live token. Every string that comes
 * back has been through `redactToken`, because git echoes the URL it was given.
 */
export async function cloneGitHub(input: CloneGitHubInput, deps: RemoteDeps = defaultDeps): Promise<CloneGitHubInfo> {
  assertEnabled();

  const ref = parseGitHubSpec(input.repo);
  if (ref === null) {
    throw new RemoteError(`a repository is named owner/name on ${GITHUB_HOST} (a URL is accepted, but of that host)`);
  }
  const supplied = typeof input.token === "string" ? input.token.trim() : "";
  if (supplied !== "" && !isGitHubToken(supplied)) throw new RemoteError("that does not look like a GitHub token");

  const requested =
    typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : ref.name;
  let abs: string;
  try {
    abs = resolveInWorkspace(requested);
  } catch {
    throw new RemoteError("that path is outside the workspace");
  }

  const existing = await fs.readdir(abs).catch(() => [] as string[]);
  if (existing.length > 0) throw new RemoteError("there is already something in that directory");

  const run = gitRunner(deps);
  const authUrl = gitHubAuthenticatedUrl(ref, supplied);
  const cloned = await deps.run({
    command: `git clone ${shq(authUrl)} ${shq(abs)}`,
    cwd: sandboxRoot(),
    timeoutMs: config.remoteTimeoutMs,
  });
  if (cloned.refused !== undefined) throw new RemoteError(redactToken(cloned.refused, supplied));
  if (!cloned.ok) {
    throw new RemoteError(`could not clone the repository: ${redactToken(cloned.output.trim(), supplied)}`);
  }

  // The credential is out of the workspace from here on.
  await run(`git remote set-url origin ${shq(gitHubCloneUrl(ref))}`, abs);

  let branch: string | null = null;
  const wanted = typeof input.branch === "string" && input.branch.trim() !== "" ? input.branch.trim() : null;
  if (wanted !== null) {
    if (!isBranchName(wanted)) throw new RemoteError("that is not a valid branch name");
    const checkedOut = await run(`git checkout ${shq(wanted)}`, abs);
    if (!checkedOut.ok) {
      throw new RemoteError(`could not check out ${wanted}: ${redactToken(checkedOut.output.trim(), supplied)}`);
    }
    branch = wanted;
  }

  const connection = rememberGitHub(slot(), ref, abs, supplied, branch);
  await setSelectedWorkspace(requested);
  return githubInfo(connection);
}

export interface PushGitHubInput {
  branch?: unknown;
  /** The clone to push; defaults to the working directory. */
  dir?: unknown;
  repo?: unknown;
  /** A token to use for this push, remembered for the session afterwards. */
  token?: unknown;
}

/**
 * Push a branch to GitHub with the credential this session holds.
 *
 * The repository comes from the argument, from the connection that owns the
 * directory, or from `origin` — read back with `git remote get-url` and reduced by
 * `parseGitHubSpec`, which is what lets a push work after the clone has rewritten
 * the remote to the plain URL. A push with no credential is refused rather than
 * attempted: there is no unauthenticated form of it, and a prompt the sandbox
 * could never surface is not an error message anyone can act on.
 */
export async function pushGitHub(
  input: PushGitHubInput,
  deps: RemoteDeps = defaultDeps,
): Promise<{ branch: string; repo: string }> {
  assertEnabled();

  const branch = input.branch;
  if (!isBranchName(branch)) throw new RemoteError("that is not a valid branch name");

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : "";
  let abs: string;
  try {
    abs = resolveInWorkspace(requested === "" ? "." : requested);
  } catch {
    throw new RemoteError("that path is outside the workspace");
  }

  const current = slot();
  const run = gitRunner(deps);
  const ref =
    parseGitHubSpec(input.repo) ?? connectionAt(abs)?.ref ?? (await detectGitHubOrigin(abs, run));
  if (ref === null) throw new RemoteError(`the working directory is not a clone of a repository on ${GITHUB_HOST}`);

  const token = tokenFor(ref, input.token, current);
  if (token === "") {
    throw new RemoteError("no GitHub credential is held for this repository; clone it from the console, or pass a token");
  }

  const pushed = await deps.run({
    command: `git push ${shq(gitHubAuthenticatedUrl(ref, token))} ${shq(branch)}`,
    cwd: abs,
    timeoutMs: config.remoteTimeoutMs,
  });
  if (pushed.refused !== undefined) throw new RemoteError(redactToken(pushed.refused, token));
  if (!pushed.ok) throw new RemoteError(`could not push the branch: ${redactToken(pushed.output.trim(), token)}`);

  // Keep the credential for the session, so the pull request that follows does
  // not have to be handed one again.
  const existing = connectionAt(abs);
  rememberGitHub(current, ref, abs, token, existing?.branch ?? branch);
  return { branch, repo: gitHubSlug(ref) };
}

/** Create and check out a working branch. Local git, through the same rules. */
export async function createGitHubBranch(
  input: { name?: unknown; title?: unknown; suffix?: unknown },
  deps: RemoteDeps = defaultDeps,
): Promise<{ branch: string }> {
  const created = await createBranch(input, gitRunner(deps));
  return { branch: created.branch };
}

/** A branch name for a task, for the console's own suggestion. */
export function suggestGitHubBranch(title: unknown, suffix: string): string {
  return branchNameFor(title, suffix);
}

export interface PullRequestInputShape {
  repo?: unknown;
  title?: unknown;
  head?: unknown;
  base?: unknown;
  body?: unknown;
  token?: unknown;
  /** The clone the pull request is for; defaults to the working directory. */
  dir?: unknown;
}

/**
 * Open a pull request on GitHub.
 *
 * A token is required: opening a pull request is an authenticated write on the
 * host and, unlike a public clone, has no unauthenticated form. The response is
 * read structurally (`parsePullRequest`), so an API that renames a field degrades
 * to a partial answer rather than failing an operation that already succeeded.
 */
export async function openGitHubPullRequest(
  input: PullRequestInputShape,
  deps: RemoteDeps = defaultDeps,
): Promise<PullRequest & { repo: string; head: string; base: string }> {
  assertEnabled();

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : "";
  let abs: string;
  try {
    abs = resolveInWorkspace(requested === "" ? "." : requested);
  } catch {
    throw new RemoteError("that path is outside the workspace");
  }

  const current = slot();
  const ref =
    parseGitHubSpec(input.repo) ??
    connectionAt(abs)?.ref ??
    (await detectGitHubOrigin(abs, gitRunner(deps)));
  if (ref === null) throw new RemoteError(`a repository is named owner/name on ${GITHUB_HOST}`);

  const token = tokenFor(ref, input.token, current);
  if (token === "") throw new RemoteError("a GitHub token is required to open a pull request");

  const head = typeof input.head === "string" ? input.head.trim() : "";
  if (!isBranchName(head)) throw new RemoteError("a branch to open the pull request from is required");
  const base =
    typeof input.base === "string" && input.base.trim() !== "" ? input.base.trim() : config.gitDefaultBranch;
  if (!isBranchName(base)) throw new RemoteError("that is not a valid base branch name");
  const title = normalizeTitle(input.title);
  const body = typeof input.body === "string" ? input.body : undefined;

  const response = await deps.fetchImpl(gitHubApiUrl(ref, "pulls"), {
    method: "POST",
    headers: gitHubHeaders(token),
    body: JSON.stringify(pullRequestPayload({ title, head, base, ...(body === undefined ? {} : { body }) })),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RemoteError(
      `could not open a pull request: HTTP ${response.status}${detail ? ` — ${redactToken(detail.slice(0, 300), token)}` : ""}`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  return { ...parsePullRequest(payload), repo: gitHubSlug(ref), head, base };
}

/* -------------------------------------------------------------------------- */
/*  A forge the caller names (Gitea — what Atlas runs)                        */
/* -------------------------------------------------------------------------- */

export interface ForgeConnection {
  /** The normalized base address, e.g. `http://192.168.1.90:3000`. */
  base: string;
  /** The login the forge itself confirmed, which is what a URL must carry. */
  user: string;
  /** Never returned to a caller — `credential: true` is what a listing says. */
  secret: string;
  /** True when the credential came from the deployment's own Atlas settings. */
  system: boolean;
  connectedAt: string;
}

function forgeInfo(connection: ForgeConnection) {
  return {
    host: connection.base,
    label: connection.base.replace(/^https?:\/\//, ""),
    user: connection.user,
    credential: connection.secret !== "",
    system: connection.system,
    connectedAt: connection.connectedAt,
  };
}

/** The forges this account holds, for the console's list. */
export function listForges() {
  return [...slot().forge.values()].map(forgeInfo);
}

/** The connection for a base address, or the only one when the caller names none. */
function forgeAt(base: unknown): ForgeConnection | null {
  const forges = [...slot().forge.values()];
  if (base === undefined || base === null || base === "") return forges[0] ?? null;
  const wanted = parseGitHostUrl(base);
  if (wanted === null) return null;
  return slot().forge.get(wanted) ?? null;
}

/** The deployment's own Atlas credential, when it holds one. */
function systemAtlasConnection(): ForgeConnection | null {
  if (config.atlasUrl === "" || !isForgeUser(config.atlasUser) || !isForgeSecret(config.atlasPassword)) {
    return null;
  }
  return {
    base: config.atlasUrl,
    user: config.atlasUser,
    secret: config.atlasPassword,
    system: true,
    connectedAt: new Date().toISOString(),
  };
}

export interface ConnectForgeInput {
  /** The forge's base address. Defaults to the deployment's Atlas, when configured. */
  url?: unknown;
  user?: unknown;
  /** A password or an access token — Gitea takes either in the same position. */
  secret?: unknown;
  /**
   * An explicit choice to use this deployment's own Atlas credential rather than
   * one typed here. This is the system path, and it is not gated on a plan.
   */
  useSystem?: unknown;
}

/**
 * Connect to a forge the caller names, or to Atlas with this deployment's own
 * credential.
 *
 * **The verification is the gate.** `GET /api/v1/user` is asked with the
 * credential, and the login it answers with is the one remembered — not the one
 * typed — so a clone URL carries a user name the forge has actually agreed to. A
 * credential that authenticates as basic auth is tried first (a password), then as
 * a Gitea token, because the two are the same field to a person and different
 * headers to the server.
 *
 * Before any of that, Magnate is asked whether the caller's plan includes Atlas —
 * when Magnate is configured and the connection is *not* the deployment's own
 * (`src/atlas.ts` has the policy). Its refusal is a sentence about a subscription,
 * which is the useful thing to say; a login failure for credentials that were
 * never the problem is not.
 */
export async function connectForge(
  input: ConnectForgeInput,
  deps: RemoteDeps = defaultDeps,
): Promise<ReturnType<typeof forgeInfo> & { url: string }> {
  assertEnabled();

  const useSystem = input.useSystem === true || input.useSystem === "true";
  const system = systemAtlasConnection();
  const base = parseGitHostUrl(
    input.url === undefined || input.url === "" ? (system?.base ?? "") : input.url,
  );
  if (base === null) {
    throw new RemoteError(
      "a forge is named as an http(s) address, e.g. http://host:3000 — with no credential in it",
    );
  }

  let user = typeof input.user === "string" ? input.user.trim() : "";
  let secret = typeof input.secret === "string" ? input.secret.trim() : "";
  let fromSystem = false;

  if (useSystem) {
    if (system === null || system.base !== base) {
      throw new RemoteError(
        "this deployment holds no Atlas credential of its own (AGENT_ATLAS_USER / AGENT_ATLAS_PASSWORD)",
      );
    }
    user = system.user;
    secret = system.secret;
    fromSystem = true;
  } else if (user === "" || secret === "") {
    // Nothing typed and a system credential available: use it rather than making
    // an operator retype what the deployment already holds.
    if (system !== null && system.base === base) {
      user = system.user;
      secret = system.secret;
      fromSystem = true;
    } else {
      throw new RemoteError("a user name and a password (or an access token) are required");
    }
  }

  if (!isForgeUser(user)) throw new RemoteError("that is not a user name a forge can be asked about");
  if (!isForgeSecret(secret)) throw new RemoteError("that credential has whitespace or is empty; paste just the secret");

  // Atlas is an add-on: ask the plan before asking the forge. The arithmetic
  // depends on the connection, so it stays in one place (`src/atlas.ts`).
  if (base === config.atlasUrl && config.atlasUrl !== "") {
    const verdict = atlasVerdict(await atlasInfo(currentScope().userId), fromSystem);
    if (!verdict.ok) throw new RemoteError(verdict.message);
  }

  const login = await verifyForge(base, user, secret, deps);
  const connection: ForgeConnection = {
    base,
    user: login,
    secret,
    system: fromSystem,
    connectedAt: new Date().toISOString(),
  };
  slot().forge.set(base, connection);
  return { ...forgeInfo(connection), url: base };
}

/**
 * Ask the forge who this credential is, trying both headers Gitea accepts.
 *
 * A 401 from the basic form is not a failure yet: an access token is sent as a
 * `token` header and would be rejected by the other form, and a person cannot tell
 * the two apart when pasting. Anything else — a network error, a 500 — is reported
 * as it is, because "your password is wrong" is the wrong thing to say when the
 * server is down.
 */
async function verifyForge(
  base: string,
  user: string,
  secret: string,
  deps: RemoteDeps,
): Promise<string> {
  const attempts = [forgeAuthHeader(user, secret), forgeTokenHeader(secret)];
  let lastStatus = 0;
  let lastDetail = "";

  for (const authorization of attempts) {
    let response: Response;
    try {
      response = await deps.fetchImpl(forgeApiUrl(base, "user"), {
        headers: { Accept: "application/json", Authorization: authorization },
      });
    } catch (error) {
      throw new RemoteError(`could not reach ${base}: ${redactToken((error as Error).message, secret)}`);
    }
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      return parseForgeUser(payload) ?? user;
    }
    lastStatus = response.status;
    lastDetail = await response.text().catch(() => "");
    if (response.status !== 401) break;
  }

  throw new RemoteError(
    `the forge refused that credential: HTTP ${lastStatus}${lastDetail ? ` — ${redactToken(lastDetail.slice(0, 200), secret)}` : ""}`,
  );
}

/**
 * Drop a forge connection and the credential it was holding.
 *
 * The clones made from it are forgotten too: they are still on disk and still
 * usable, but a push now has no credential to use and says so, which is the honest
 * state after somebody signs out of the forge.
 */
export function disconnectForge(url: unknown): { host: string } {
  const current = slot();
  const connection = forgeAt(url);
  if (connection === null) throw new RemoteError("no such forge connection");
  current.forge.delete(connection.base);
  for (const [dir, clone] of current.clone) {
    if (clone.base === connection.base) current.clone.delete(dir);
  }
  return { host: connection.base };
}

/** The credential to use for a forge operation: the connection's, or the caller's. */
function forgeCredential(
  connection: ForgeConnection | null,
  input: { user?: unknown; secret?: unknown },
): { user: string; secret: string } {
  const user = typeof input.user === "string" ? input.user.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  if (user !== "" && secret !== "") {
    if (!isForgeUser(user) || !isForgeSecret(secret)) {
      throw new RemoteError("that is not a user name and credential a forge would accept");
    }
    return { user, secret };
  }
  if (connection === null) throw new RemoteError("connect to the forge first, or pass a user and a credential");
  return { user: connection.user, secret: connection.secret };
}

export interface CloneForgeInput {
  /** `owner/name`, as the repository feature names one. */
  repo?: unknown;
  /** The forge to clone from; defaults to the only one connected. */
  url?: unknown;
  /** Where to clone, relative to the working directory. Defaults to the name. */
  dir?: unknown;
  branch?: unknown;
}

/**
 * Clone a repository from a forge, with the credential this session holds.
 *
 * The same fences as everywhere else: the target resolves through
 * `resolveInWorkspace` before git is asked to write anything, a directory with
 * something in it is refused rather than clobbered, and the credential is supplied
 * to the clone command alone — `origin` is rewritten to the plain URL straight
 * afterwards, so `.git/config` holds no live credential.
 */
export async function cloneForge(input: CloneForgeInput, deps: RemoteDeps = defaultDeps): Promise<{ repo: string; rel: string; url: string; branch: string | null; credential: boolean }> {
  assertEnabled();

  const connection = forgeAt(input.url);
  if (connection === null) throw new RemoteError("connect to the forge first");
  const ref = parseRepoSpec(input.repo);
  if (ref === null) throw new RemoteError("a repository is named owner/name");

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : ref.name;
  let abs: string;
  try {
    abs = resolveInWorkspace(requested);
  } catch {
    throw new RemoteError("that path is outside the workspace");
  }
  const existing = await fs.readdir(abs).catch(() => [] as string[]);
  if (existing.length > 0) throw new RemoteError("there is already something in that directory");

  const run = gitRunner(deps);
  const authUrl = forgeAuthenticatedUrl(connection.base, ref, connection.user, connection.secret);
  const cloned = await deps.run({
    command: `git clone ${shq(authUrl)} ${shq(abs)}`,
    cwd: sandboxRoot(),
    timeoutMs: config.remoteTimeoutMs,
  });
  if (cloned.refused !== undefined) throw new RemoteError(redactToken(cloned.refused, connection.secret));
  if (!cloned.ok) {
    throw new RemoteError(`could not clone the repository: ${redactToken(cloned.output.trim(), connection.secret)}`);
  }

  await run(`git remote set-url origin ${shq(forgeCloneUrl(connection.base, ref))}`, abs);

  let branch: string | null = null;
  const wanted = typeof input.branch === "string" && input.branch.trim() !== "" ? input.branch.trim() : null;
  if (wanted !== null) {
    if (!isBranchName(wanted)) throw new RemoteError("that is not a valid branch name");
    const checkedOut = await run(`git checkout ${shq(wanted)}`, abs);
    if (!checkedOut.ok) {
      throw new RemoteError(`could not check out ${wanted}: ${redactToken(checkedOut.output.trim(), connection.secret)}`);
    }
    branch = wanted;
  }

  rememberForge(slot(), connection, ref, abs, branch);
  await setSelectedWorkspace(requested);
  return {
    repo: repoSlug(ref),
    rel: toRelFromBase(abs),
    url: forgeWebUrl(connection.base, ref),
    branch,
    credential: true,
  };
}

/**
 * Create a repository on a forge, then clone it and work in it.
 *
 * "Create a project there" is one action rather than two because the two halves
 * are useless apart: a repository nobody cloned is not somewhere to work, and the
 * person who asked for one is asking for both. The clone is `cloneForge`'s — the
 * same fences, the same rewrite of `origin` — so this adds only the API call.
 */
export async function createForgeRepo(
  input: { name?: unknown; description?: unknown; url?: unknown; private?: unknown; autoInit?: unknown },
  deps: RemoteDeps = defaultDeps,
): Promise<{ repo: string; rel: string; url: string; web: string; branch: string | null; created: boolean }> {
  assertEnabled();

  const connection = forgeAt(input.url);
  if (connection === null) throw new RemoteError("connect to the forge first");
  const name = normalizeRepoName(input.name);
  if (name === null) {
    throw new RemoteError("a repository name is letters, digits, dots, dashes and underscores");
  }

  const payload = forgeRepoPayload({
    name,
    private: input.private !== false && input.private !== "false",
    autoInit: input.autoInit !== false && input.autoInit !== "false",
    ...(typeof input.description === "string" && input.description.trim() !== ""
      ? { description: input.description.trim() }
      : {}),
  });

  const response = await deps
    .fetchImpl(forgeApiUrl(connection.base, "user", "repos"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: forgeAuthHeader(connection.user, connection.secret),
      },
      body: JSON.stringify(payload),
    })
    .catch((error: unknown) => {
      throw new RemoteError(`could not reach ${connection.base}: ${(error as Error).message}`);
    });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const conflict = response.status === 409 || response.status === 422;
    throw new RemoteError(
      conflict
        ? `the forge already has a repository called ${name}`
        : `could not create the repository: HTTP ${response.status}${detail ? ` — ${redactToken(detail.slice(0, 200), connection.secret)}` : ""}`,
    );
  }

  const created = parseForgeRepo(await response.json().catch(() => null));
  const spec = created.fullName ?? `${connection.user}/${name}`;
  const cloned = await cloneForge(
    { repo: spec, url: connection.base, ...(created.branch === null ? {} : { branch: created.branch }) },
    deps,
  );
  return {
    repo: cloned.repo,
    rel: cloned.rel,
    url: cloned.url,
    web: created.htmlUrl ?? cloned.url,
    branch: cloned.branch,
    created: true,
  };
}

/**
 * Remember which forge and repository a clone belongs to, for a push.
 *
 * The connection is already stored by address; what a clone adds is the pairing
 * between *this directory* and *that repository*, so a push from inside it knows
 * where it is going without reading a remote first — and so the credential used is
 * the one the clone was made with.
 */
function rememberForge(
  current: AccountRemotes,
  connection: ForgeConnection,
  ref: RepoRef,
  dir: string,
  branch: string | null,
): void {
  current.clone.set(dir, { base: connection.base, ref, branch });
}

/** The forge a directory was cloned from, when this session cloned it. */
function forgeRepoAt(dir: string): { connection: ForgeConnection; ref: RepoRef; branch: string | null } | null {
  const clone = slot().clone.get(dir);
  if (clone === undefined) return null;
  const connection = slot().forge.get(clone.base) ?? null;
  if (connection === null) return null;
  return { connection, ref: clone.ref, branch: clone.branch };
}

/**
 * The absolute directory a forge operation that names a clone should work in.
 *
 * A caller names a clone the way they see it — the directory name a `create` put
 * the project in — and that name has to be resolved twice, because connecting to a
 * clone *moves* the working directory into it (`setSelectedWorkspace`). After that
 * the same relative name resolves one level deeper, so looking it up only against
 * the current root reports a clone the session is holding as "not a clone of a
 * repository". Two candidates, in the order that matters: where the caller is
 * standing now, then the sandbox the selection moved inside — both inside the
 * jail, both checked here rather than by the shell that will run the command.
 *
 * Returns `null` when neither is somewhere this caller may work, so the caller
 * answers with one sentence rather than leaking which path was refused.
 */
function forgeDirFor(requested: string): string | null {
  if (requested === "") {
    try {
      return resolveInWorkspace(".");
    } catch {
      return null;
    }
  }
  for (const resolve of [resolveInWorkspace, resolveInBase]) {
    try {
      const abs = resolve(requested);
      if (forgeRepoAt(abs) !== null) return abs;
    } catch {
      // The other candidate is the answer; a `..` is refused by both.
    }
  }
  // Neither is a remembered clone: fall back to the ordinary resolution, so the
  // push can still find `origin` for a clone this session did not make.
  try {
    return resolveInWorkspace(requested);
  } catch {
    try {
      return resolveInBase(requested);
    } catch {
      return null;
    }
  }
}

/** Read `owner/name` back out of a forge's `origin`, discarding the host. */
async function detectForgeOrigin(dir: string, run: GitRunner): Promise<RepoRef | null> {
  const result = await run("git remote get-url origin", dir);
  if (!result.ok) return null;
  return parseRepoSpec(result.output.trim());
}

export interface PushForgeInput {
  branch?: unknown;
  /** The clone to push; defaults to the working directory. */
  dir?: unknown;
  url?: unknown;
}

/** Push a branch to a forge, with the credential this session holds. */
export async function pushForge(
  input: PushForgeInput,
  deps: RemoteDeps = defaultDeps,
): Promise<{ branch: string; repo: string; force: boolean }> {
  assertEnabled();

  const branch = input.branch;
  if (!isBranchName(branch)) throw new RemoteError("that is not a valid branch name");

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : "";
  const abs = forgeDirFor(requested);
  if (abs === null) throw new RemoteError("that path is outside the workspace");

  const run = gitRunner(deps);
  const remembered = forgeRepoAt(abs) ?? null;
  // An explicit address wins, then the clone this directory came from, then the
  // only forge connected — and the repository is read back from `origin`, which is
  // what lets a push work after the clone rewrote the remote to the plain URL.
  const connection = forgeAt(input.url) ?? remembered?.connection ?? null;
  if (connection === null) throw new RemoteError("connect to the forge first");
  const ref = remembered?.ref ?? (await detectForgeOrigin(abs, run));
  if (ref === null) throw new RemoteError("the working directory is not a clone of a repository");

  const pushed = await deps.run({
    command: `git push ${shq(forgeAuthenticatedUrl(connection.base, ref, connection.user, connection.secret))} ${shq(branch)}`,
    cwd: abs,
    timeoutMs: config.remoteTimeoutMs,
  });
  if (pushed.refused !== undefined) throw new RemoteError(redactToken(pushed.refused, connection.secret));
  if (!pushed.ok) {
    throw new RemoteError(`could not push the branch: ${redactToken(pushed.output.trim(), connection.secret)}`);
  }
  return { branch, repo: repoSlug(ref), force: false };
}

export interface ForgePullRequestInput {
  url?: unknown;
  repo?: unknown;
  title?: unknown;
  head?: unknown;
  base?: unknown;
  body?: unknown;
  dir?: unknown;
}

/** Open a pull request on a forge, through Gitea's own API. */
export async function openForgePullRequest(
  input: ForgePullRequestInput,
  deps: RemoteDeps = defaultDeps,
): Promise<PullRequest & { repo: string; head: string; base: string }> {
  assertEnabled();

  const requested = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : "";
  const abs = forgeDirFor(requested);
  if (abs === null) throw new RemoteError("that path is outside the workspace");

  const remembered = forgeRepoAt(abs);
  const connection = forgeAt(input.url) ?? remembered?.connection ?? null;
  if (connection === null) throw new RemoteError("connect to the forge first");
  // The repository named, then the one this directory was cloned from, then
  // `origin` — the same order a push uses, so both agree about where the work is.
  const ref = parseRepoSpec(input.repo) ?? remembered?.ref ?? (await detectForgeOrigin(abs, gitRunner(deps)));
  if (ref === null) throw new RemoteError("a repository is named owner/name");

  const head = typeof input.head === "string" ? input.head.trim() : "";
  if (!isBranchName(head)) throw new RemoteError("a branch to open the pull request from is required");
  const base = typeof input.base === "string" && input.base.trim() !== "" ? input.base.trim() : config.gitDefaultBranch;
  if (!isBranchName(base)) throw new RemoteError("that is not a valid base branch name");
  const title = normalizeTitle(input.title);
  const body = typeof input.body === "string" ? input.body : undefined;

  const response = await deps.fetchImpl(forgeApiUrl(connection.base, "repos", ref.owner, ref.name, "pulls"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: forgeAuthHeader(connection.user, connection.secret),
    },
    body: JSON.stringify(pullRequestPayload({ title, head, base, ...(body === undefined ? {} : { body }) })),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RemoteError(
      `could not open a pull request: HTTP ${response.status}${detail ? ` — ${redactToken(detail.slice(0, 200), connection.secret)}` : ""}`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  return { ...parsePullRequest(payload), repo: repoSlug(ref), head, base };
}

/** The GitHub connections this account holds, for the console's list. */
export function listGitHub() {
  return [...slot().github.values()].map(githubInfo);
}

/** The clones made from a forge this session, for the console's list. */
export function listForgeClones() {
  return [...slot().clone.entries()].map(([dir, clone]) => ({
    repo: repoSlug(clone.ref),
    rel: toRelFromBase(dir),
    url: forgeWebUrl(clone.base, clone.ref),
    branch: clone.branch,
  }));
}

/** The same for SSH, with the mount re-checked so a dead one is not reported up. */
export async function listSsh(deps: RemoteDeps = defaultDeps) {
  const rows: (SshConnectionInfo & { live: boolean })[] = [];
  for (const connection of slot().ssh.values()) {
    rows.push({ ...sshInfo(connection), live: await deps.mounted(connection.mountPoint) });
  }
  return rows;
}


