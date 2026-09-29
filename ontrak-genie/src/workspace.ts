import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";

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

  const abs = path.resolve(config.workspace, rel);
  const root = config.workspace;
  if (abs !== root && !abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new WorkspaceError(`path escapes the workspace: ${rel}`);
  }
  return abs;
}

/** Workspace-relative, forward-slashed, for display and for the model. */
export function toRel(abs: string): string {
  const rel = path.relative(config.workspace, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(config.workspace, { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "sessions"), { recursive: true });
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
  if (abs === config.workspace) throw new WorkspaceError("refusing to delete the workspace root");

  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    throw new WorkspaceError("that path is a directory; delete its files one at a time");
  }
  if (!stat.isFile()) throw new WorkspaceError("that path is not a regular file");

  await fs.unlink(abs);
  return stat.size;
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
