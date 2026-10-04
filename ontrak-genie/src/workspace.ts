import fs from "node:fs/promises";
import path from "node:path";

import { defaultScope, loadSelectedWorkspace, sandboxRoot, workspaceRoot } from "./scope.js";

export class WorkspaceError extends Error {}

/**
 * Resolve a caller-supplied relative path against the workspace root and refuse
 * anything that escapes it. Every filesystem tool goes through here, so the
 * agent cannot read or write outside its sandbox via `..` or an absolute path.
 */
export function resolveInWorkspace(rel: string): string {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw new WorkspaceError("a path is required");
  }
  if (path.isAbsolute(rel)) {
    throw new WorkspaceError(`paths must be relative to the workspace root, got: ${rel}`);
  }

  // The active scope's root, not the deployment's: with tenancy configured this
  // is the signed-in account's own directory, so one account cannot name a path
  // that reaches another's files even if it knows the name.
  const root = workspaceRoot();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new WorkspaceError(`path escapes the workspace: ${rel}`);
  }
  return abs;
}

/**
 * Resolve a caller-supplied relative path against the **sandbox** and refuse
 * anything that escapes it.
 *
 * The sibling of `resolveInWorkspace`, and the difference between them is the
 * whole of the folder picker: the agent works in the chosen directory, so its
 * tools go through `resolveInWorkspace`; the operator choosing that directory is
 * looking at the sandbox around it, so the picker goes through here. Both refuse
 * absolute paths and `..`, which is what makes a picker unable to leave the
 * mount no matter what it is asked for.
 */
export function resolveInBase(rel: string): string {
  const root = sandboxRoot();
  const fence = root.endsWith(path.sep) ? root : root + path.sep;
  const cleaned = String(rel ?? "").trim();
  if (cleaned === "" || cleaned === ".") return root;
  if (path.isAbsolute(cleaned)) {
    throw new WorkspaceError(`paths must be relative to the workspace root, got: ${rel}`);
  }
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(fence)) {
    throw new WorkspaceError(`path escapes the workspace: ${rel}`);
  }
  return abs;
}

/** Workspace-relative, forward-slashed, for display and for the model. */
export function toRel(abs: string): string {
  const rel = path.relative(workspaceRoot(), abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/** Sandbox-relative, forward-slashed, for the folder picker. */
export function toRelFromBase(abs: string): string {
  const rel = path.relative(sandboxRoot(), abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/**
 * Create the deployment's own roots at boot.
 *
 * An account's directories are made when its first request enters that
 * account's scope (`runInScope`), because the set of accounts is not knowable
 * here: the control plane creates one per sign-in, and pre-creating them would
 * be a listing that grows for nobody's benefit.
 */
export async function ensureWorkspace(): Promise<void> {
  // The chosen directory has to be read before the first scope is built, because
  // the scope root is derived from it.
  await loadSelectedWorkspace();
  const shared = defaultScope();
  await fs.mkdir(shared.base, { recursive: true });
  await fs.mkdir(shared.root, { recursive: true });
  await fs.mkdir(shared.sessions, { recursive: true });
}

/**
 * Every directory the operator may choose, sandbox-relative and sorted.
 *
 * Depth-limited and ignoring the same directories the tree ignores (`.git`,
 * `node_modules`, build output), because this is a picker rather than an
 * inventory: a walk that descends into `node_modules` to offer fifteen thousand
 * folders is one nobody can use. "." is always present, so the sandbox itself is
 * always a choice you can go back to.
 */
export async function listWorkspaceDirs(maxDepth = 3): Promise<string[]> {
  const found: string[] = ["."];

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || isIgnoredDir(dirent.name) || dirent.name.startsWith(".")) continue;
      const childRel = rel === "." ? dirent.name : `${rel}/${dirent.name}`;
      found.push(childRel);
      await walk(path.join(abs, dirent.name), childRel, depth + 1);
    }
  };

  await walk(sandboxRoot(), ".", 1);
  found.sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  return found;
}

export type DirEntry = { name: string; path: string; type: "file" | "dir"; size: number };

const IGNORED_DIRS = new Set([".git", "node_modules", ".agent", "dist", "__pycache__", ".venv"]);

export async function listDirectory(abs: string): Promise<DirEntry[]> {
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];

  for (const dirent of dirents) {
    const child = path.join(abs, dirent.name);
    const type = dirent.isDirectory() ? "dir" : "file";
    let size = 0;
    if (type === "file") {
      try {
        size = (await fs.stat(child)).size;
      } catch {
        size = 0;
      }
    }
    entries.push({ name: dirent.name, path: toRel(child), type, size });
  }

  // Directories first, then alphabetical.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

export type FileRead = { content: string; truncated: boolean; bytes: number };

const BINARY_SNIFF_BYTES = 8000;

export async function readTextFile(abs: string, maxBytes = 400_000): Promise<FileRead> {
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new WorkspaceError("that path is a directory, use list_dir");
  if (!stat.isFile()) throw new WorkspaceError("that path is not a regular file");

  const handle = await fs.open(abs, "r");
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, Math.max(stat.size, 1)));
    const { bytesRead } = await handle.read(sniff, 0, sniff.length, 0);
    if (sniff.subarray(0, bytesRead).includes(0)) {
      throw new WorkspaceError("this looks like a binary file; refusing to read it as text");
    }
  } finally {
    await handle.close();
  }

  const truncated = stat.size > maxBytes;
  const length = truncated ? maxBytes : stat.size;
  const buffer = Buffer.alloc(length);
  const handle2 = await fs.open(abs, "r");
  try {
    await handle2.read(buffer, 0, length, 0);
  } finally {
    await handle2.close();
  }

  return { content: buffer.toString("utf8"), truncated, bytes: stat.size };
}

/** Write text, creating parent directories as needed. */
export async function writeTextFile(abs: string, content: string): Promise<number> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return Buffer.byteLength(content, "utf8");
}

/**
 * Remove a file from the workspace, and report how many bytes it held.
 *
 * Files only. A directory is refused instead of walked, so one call can never
 * take out a subtree, and the workspace root is never a target even when it is
 * somehow reached. Mirrors `readTextFile`'s refusals so a caller cannot delete
 * something it would not have been allowed to read.
 */
export async function deleteWorkspaceEntry(abs: string): Promise<number> {
  if (abs === workspaceRoot()) throw new WorkspaceError("refusing to delete the workspace root");

  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    throw new WorkspaceError("that path is a directory; delete its files one at a time");
  }
  if (!stat.isFile()) throw new WorkspaceError("that path is not a regular file");

  await fs.unlink(abs);
  return stat.size;
}

export type ClearResult = { removed: number; kept: string[] };

/**
 * Empty a directory inside the workspace, keeping the directory itself.
 *
 * "Start this folder over" is not "delete this folder". The folder is the thing a
 * project, a running preview and the agent's working directory all point at, so
 * removing it would leave every one of them naming something that is gone; what a
 * person means is that the *contents* go, and this does exactly that.
 *
 * Dot-entries are kept on purpose. `.git`, `.env`, `.agent` — the entries that
 * carry identity and configuration rather than work — are what a fresh start most
 * often means to preserve, and the rule is stated as "keep anything whose name
 * starts with a dot" rather than a list, so a tool the deployment has never heard
 * of is kept for the same reason `.git` is.
 *
 * The fence is the workspace root: `abs` must be the root or inside it, which is
 * the same fence every tool call passes through, so clearing can never reach
 * further than the agent could.
 */
export async function clearDirectory(abs: string): Promise<ClearResult> {
  const root = workspaceRoot();
  const fence = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(fence)) {
    throw new WorkspaceError(`path escapes the workspace: ${abs}`);
  }
  if (!(await isDirectory(abs))) throw new WorkspaceError("that is not a directory");

  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const kept: string[] = [];
  let removed = 0;
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) {
      kept.push(dirent.name);
      continue;
    }
    await fs.rm(path.join(abs, dirent.name), { recursive: true, force: true });
    removed += 1;
  }
  return { removed, kept };
}

export async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}
