import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";

/**
 * Whose slice of this deployment a request is running in.
 *
 * Tenancy attributed and gated turns, and stopped there: two people signing in
 * to one deployment were billed separately and still shared one workspace, one
 * session library and one set of file snapshots. That is not a policy anyone
 * chose — it is what one `AGENT_WORKSPACE` means — and it produces the two
 * failures worth naming. One person's chat list is another's, and a file
 * written for one account can be read, diffed and deleted by the next account
 * to sign in.
 *
 * So the console's disk is now keyed on the account, and this module is the one
 * place that decides where "the workspace" is. Everything downstream —
 * `resolveInWorkspace`, the session store, the snapshot store, the container
 * mount, the search root — asks here instead of reading `config.workspace`, so
 * a new call site cannot accidentally reach the shared root.
 *
 * The context travels in an `AsyncLocalStorage` rather than in a parameter
 * because the alternative is threading an argument through forty-odd tool
 * handlers and route helpers for a value that is fixed for the whole request.
 * It is entered once per request (`server.ts`) and once per turn's tools are
 * reached, and it deliberately does **not** outlive the request that set it.
 *
 * **Single-operator mode is unchanged.** With no control plane configured there
 * is no account to key on, `defaultScope()` applies, and every path resolves
 * exactly as it did before this module existed — the shipped default of a
 * laptop with one workspace and no sign-in.
 */

export type Scope = {
  /** The control-plane account, or null when this deployment has no tenancy. */
  userId: string | null;
  /**
   * The sandbox: the whole tree this slice may ever reach. A chosen working
   * directory is inside this and can never be outside it, which is what keeps
   * "pick a folder" from becoming "pick any folder on the host".
   */
  base: string;
  /**
   * The directory the agent works in: `base`, or a directory chosen inside it.
   * Everything the tools read and write resolves here, and never escapes it.
   */
  root: string;
  /** Where this request's chats live. */
  sessions: string;
  /** Where this request's file history lives. */
  snapshots: string;
};

/**
 * The chosen working directory, as a path relative to the sandbox root.
 *
 * Empty means "the sandbox itself", which is where a fresh deployment starts
 * and what every existing install keeps getting until somebody picks a folder.
 * It is deployment-wide rather than per-account because the browser window that
 * picks it is the operator's, and a second person signing in to the same console
 * should land where the operator put the work, not back at the sandbox root.
 */
let selected = "";

/** The chosen directory as it is stored: relative, forward-slashed, or "". */
export function selectedWorkspace(): string {
  return selected;
}

const SELECTION_FILE = (): string => path.join(config.dataDir, "workspace.json");

/**
 * Read the saved choice, if there is one.
 *
 * A missing or unreadable file is not an error: it is the state every install
 * starts in, and refusing to boot because a preference could not be read would
 * trade a working console for a nicer error message.
 */
export async function loadSelectedWorkspace(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(SELECTION_FILE(), "utf8")) as { dir?: unknown };
    selected = typeof raw.dir === "string" ? raw.dir : "";
  } catch {
    selected = "";
  }
}

/**
 * Remember the chosen directory. The caller validates it against the sandbox
 * first (`resolveInBase`), so this only has to store what it was handed.
 */
export async function setSelectedWorkspace(rel: string): Promise<void> {
  selected = rel;
  await fs.mkdir(path.dirname(SELECTION_FILE()), { recursive: true });
  await fs.writeFile(SELECTION_FILE(), `${JSON.stringify({ dir: rel }, null, 2)}\n`, "utf8");
}

/** Where a chosen directory is joined onto the sandbox it must stay inside. */
function rootUnder(base: string): string {
  return selected === "" ? base : path.join(base, selected);
}

/** The single-operator slice: the configured workspace, shared by everyone. */
export function defaultScope(): Scope {
  const base = config.workspace;
  return {
    userId: null,
    base,
    root: rootUnder(base),
    sessions: path.join(config.dataDir, "sessions"),
    snapshots: path.join(config.dataDir, "snapshots"),
  };
}

const ACCOUNTS = "accounts";

/**
 * A directory name for an account id.
 *
 * The id comes from the control plane, so it is data rather than a path, and it
 * must not be able to become one. The rules: anything outside `[A-Za-z0-9._-]`
 * becomes `-`, runs of dots are squashed so `..` cannot survive, a leading or
 * trailing dot or dash is trimmed (`.`, `..` and `-` are all refused that way),
 * and the name is capped — all followed by eight hex digits of the id's own
 * digest.
 *
 * The digest is what makes it *correct* rather than merely *safe*: two ids that
 * sanitize to the same stem (`a/b` and `a-b`) still get different directories,
 * because merging two accounts' workspaces would be a quieter bug than any
 * traversal.
 */
export function accountDirName(userId: string): string {
  const squashed = userId
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  const stem = squashed.slice(0, 48) === "" ? "account" : squashed.slice(0, 48);
  const digest = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `${stem}-${digest}`;
}

/**
 * The slice an account gets: its own workspace, its own chats, its own file
 * history, all under the deployment's configured roots.
 *
 * Deliberately *under* `AGENT_WORKSPACE` rather than somewhere else, so an
 * operator who backs up or mounts one directory still has everything, and can
 * see who owns what without asking this program.
 */
export function accountScope(userId: string): Scope {
  const name = accountDirName(userId);
  const base = path.join(config.workspace, ACCOUNTS, name);
  return {
    userId,
    base,
    root: rootUnder(base),
    sessions: path.join(config.dataDir, ACCOUNTS, name, "sessions"),
    snapshots: path.join(config.dataDir, ACCOUNTS, name, "snapshots"),
  };
}

const context = new AsyncLocalStorage<Scope>();

/** The active slice, or the single-operator one when nothing entered a scope. */
export function currentScope(): Scope {
  return context.getStore() ?? defaultScope();
}

/** The sandbox root: the whole tree this slice may reach, chosen directory included. */
export function sandboxRoot(): string {
  return currentScope().base;
}

export function workspaceRoot(): string {
  return currentScope().root;
}

export function sessionsDir(): string {
  return currentScope().sessions;
}

export function snapshotsDir(): string {
  return currentScope().snapshots;
}

/**
 * Directories already created, so a request does not repeat three `mkdir`s for
 * a scope the process has used many times. Keyed on the root, which is unique
 * per scope either way.
 */
const prepared = new Set<string>();

export async function ensureScopeDirs(scope: Scope): Promise<void> {
  if (prepared.has(scope.root)) return;
  await fs.mkdir(scope.root, { recursive: true });
  await fs.mkdir(scope.sessions, { recursive: true });
  await fs.mkdir(scope.snapshots, { recursive: true });
  prepared.add(scope.root);
}

/**
 * Run `fn` as that account: every path resolved inside it lands in that
 * account's slice, and nothing outside the callback is affected.
 */
export async function runInScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  await ensureScopeDirs(scope);
  return await context.run(scope, fn);
}

/** Only for tests: forget which directories have been created. */
export function resetScopeCache(): void {
  prepared.clear();
}
