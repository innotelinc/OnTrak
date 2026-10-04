import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sandboxRoot, sessionsDir, setSelectedWorkspace } from "./scope.js";
import { isDirectory, resolveInBase } from "./workspace.js";

/**
 * Saved workspace projects.
 *
 * The workspace has always been one tree with a folder picker: the agent works
 * in a directory, and the picker moves that directory inside the sandbox. What it
 * did not have is a *named* thing you keep — a workspace you can come back to, put
 * a chat against, and recognise in a list a week later. This module is that
 * missing noun.
 *
 * A project is deliberately shallow: an id, a name, and a directory inside the
 * sandbox. The directory is the whole of its contents (there is no second store to
 * keep in step with the filesystem), and the registry only records *which*
 * directories are projects rather than what is in them — so a project can never
 * describe a file that is not there, and deleting a directory out from under the
 * tree leaves a project that says so instead of one that lies.
 *
 * The registry is per account, written beside that account's sessions
 * (`projects.json` in the account's data directory), for the same reason the
 * chats are: two people signing in to one deployment must not read each other's
 * project names, let alone switch each other's working directory.
 *
 * Opening a project is not a new mechanism — it stores the directory as the
 * account's chosen workspace, exactly as the folder picker does. That is the
 * point: a project is a *saved* choice, not a parallel one, so the agent, the
 * file tree, the preview and the publish flow all follow it without knowing this
 * module exists.
 */

export class ProjectError extends Error {}

export interface Project {
  id: string;
  /** What the owner called it. Unique per account, case-insensitively. */
  name: string;
  /** Sandbox-relative directory, forward-slashed. Never "", never escapes. */
  dir: string;
  /** Optional one-line note, for the list. */
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Last time it was opened, so the list can order by recency. */
  openedAt: string;
}

export const MAX_PROJECT_NAME = 64;
const MAX_DESCRIPTION = 200;
const MAX_PROJECTS = 200;

/**
 * Where the registry lives.
 *
 * `sessionsDir()` is already the account's own data directory joined with
 * `sessions`, so its parent is the account's data directory — `dataDir` itself in
 * single-operator mode, `dataDir/accounts/<name>` with tenancy. Deriving it here
 * means this module inherits the per-account split without `scope.ts` having to
 * grow a fourth path.
 */
function registryPath(): string {
  return path.join(path.dirname(sessionsDir()), "projects.json");
}

function coerceProject(row: unknown): Project | null {
  if (row === null || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (typeof value.name !== "string" || value.name.trim() === "") return null;
  if (typeof value.dir !== "string" || value.dir === "" || value.dir === ".") return null;
  const now = new Date().toISOString();
  return {
    id: value.id,
    name: value.name,
    dir: value.dir,
    description: typeof value.description === "string" ? value.description : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    openedAt: typeof value.openedAt === "string" ? value.openedAt : now,
  };
}

async function readRegistry(): Promise<Project[]> {
  try {
    const raw = JSON.parse(await fs.readFile(registryPath(), "utf8")) as unknown;
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(coerceProject).filter((row): row is Project => row !== null);
  } catch {
    // No registry is the ordinary state of a fresh account, not an error.
    return [];
  }
}

async function writeRegistry(rows: Project[]): Promise<void> {
  const file = registryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

/**
 * A directory name for a project name.
 *
 * The name is the owner's text; the directory is derived from it so the two agree
 * when the tree is read by a person, and separated by a short digest of the id so
 * two names that slugify the same (`"My App"` twice, or `"a b"` and `"a-b"`) still
 * get different directories. The slug is what a person sees in the picker; the
 * digest is what keeps it correct.
 */
export function projectDirName(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stem = slug === "" ? "project" : slug;
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `${stem}-${digest}`;
}

/** Clean a caller-supplied project name, or throw with the reason. */
export function normalizeProjectName(raw: unknown): string {
  if (typeof raw !== "string") throw new ProjectError("a project name is required");
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") throw new ProjectError("a project name is required");
  if (flat.length > MAX_PROJECT_NAME) {
    throw new ProjectError(`a project name may be at most ${MAX_PROJECT_NAME} characters`);
  }
  return flat;
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? flat.slice(0, MAX_DESCRIPTION) : flat;
}

/** Every project, newest-opened first. Directories that no longer exist are flagged. */
export interface ProjectView extends Project {
  /** Absolute path the agent would work in when this project is open. */
  path: string;
  /** False when the directory has been removed from under the registry. */
  exists: boolean;
  /** True when this project is the account's current working directory. */
  active: boolean;
}

export async function listProjects(activeDir = ""): Promise<ProjectView[]> {
  const rows = await readRegistry();
  const base = sandboxRoot();
  const activeNorm = activeDir.replace(/^\/+|\/+$/g, "");

  const views: ProjectView[] = [];
  for (const row of rows) {
    const abs = path.join(base, row.dir);
    views.push({
      ...row,
      path: abs,
      exists: await isDirectory(abs),
      active: row.dir === activeNorm,
    });
  }
  views.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return views;
}

export async function getProject(id: string): Promise<Project | null> {
  const rows = await readRegistry();
  return rows.find((row) => row.id === id) ?? null;
}

/** Case-insensitive name lookup, so two projects cannot share a name by case. */
function nameTaken(rows: Project[], name: string, exceptId = ""): boolean {
  const wanted = name.trim().toLowerCase();
  return rows.some((row) => row.id !== exceptId && row.name.trim().toLowerCase() === wanted);
}

export interface CreateProjectOptions {
  /** Normalized here, so a caller's JSON value is validated in one place. */
  name: unknown;
  description?: string;
  /** Open the project (make it the working directory) once it exists. */
  open?: boolean;
}

export async function createProject(options: CreateProjectOptions): Promise<ProjectView> {
  const name = normalizeProjectName(options.name);
  const rows = await readRegistry();
  if (rows.length >= MAX_PROJECTS) {
    throw new ProjectError(`this account already has ${MAX_PROJECTS} projects`);
  }
  if (nameTaken(rows, name)) throw new ProjectError(`a project named "${name}" already exists`);

  const id = crypto.randomUUID();
  const dir = projectDirName(name, id);
  // Belt and braces: `projectDirName` cannot produce "." or "..", but the fence is
  // what actually guarantees the directory is inside the sandbox.
  const abs = resolveInBase(dir);
  await fs.mkdir(abs, { recursive: true });

  const now = new Date().toISOString();
  const project: Project = {
    id,
    name,
    dir,
    description: normalizeDescription(options.description),
    createdAt: now,
    updatedAt: now,
    openedAt: now,
  };
  rows.push(project);
  await writeRegistry(rows);

  if (options.open === true) await setSelectedWorkspace(project.dir);
  return { ...project, path: abs, exists: true, active: options.open === true };
}

export interface UpdateProjectOptions {
  name?: string;
  description?: string;
}

export async function updateProject(id: string, options: UpdateProjectOptions): Promise<ProjectView | null> {
  const rows = await readRegistry();
  const project = rows.find((row) => row.id === id);
  if (project === undefined) return null;

  if (options.name !== undefined) {
    const name = normalizeProjectName(options.name);
    if (nameTaken(rows, name, id)) throw new ProjectError(`a project named "${name}" already exists`);
    project.name = name;
  }
  if (options.description !== undefined) project.description = normalizeDescription(options.description);
  project.updatedAt = new Date().toISOString();

  await writeRegistry(rows);
  return {
    ...project,
    path: path.join(sandboxRoot(), project.dir),
    exists: await isDirectory(path.join(sandboxRoot(), project.dir)),
    active: false,
  };
}

/** Make a project the account's working directory. */
export async function openProject(id: string): Promise<ProjectView | null> {
  const rows = await readRegistry();
  const project = rows.find((row) => row.id === id);
  if (project === undefined) return null;

  project.openedAt = new Date().toISOString();
  await writeRegistry(rows);
  await setSelectedWorkspace(project.dir);

  return {
    ...project,
    path: path.join(sandboxRoot(), project.dir),
    exists: await isDirectory(path.join(sandboxRoot(), project.dir)),
    active: true,
  };
}

/**
 * Forget a project, and — when asked — remove its directory.
 *
 * The two are separate because they are separate decisions: a project you no
 * longer want listed is not necessarily work you want deleted. The directory is
 * only removed when the caller asks, and only when it resolves inside the
 * sandbox, so this can never be talked into deleting something else.
 */
export async function deleteProject(id: string, removeDirectory = false): Promise<boolean> {
  const rows = await readRegistry();
  const project = rows.find((row) => row.id === id);
  if (project === undefined) return false;

  if (removeDirectory) {
    const abs = resolveInBase(project.dir);
    await fs.rm(abs, { recursive: true, force: true });
  }

  await writeRegistry(rows.filter((row) => row.id !== id));
  return true;
}

/** Only for tests: read the registry fresh, with no cache to reset. */
export async function resetProjectsForTests(): Promise<void> {
  await writeRegistry([]);
}
