import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createProject, listProjects, MAX_PROJECT_NAME, type ProjectView } from "./projects.js";
import { isDirectory, isIgnoredDir, resolveInBase } from "./workspace.js";

/**
 * Project bundles — exporting a project to one file, and loading it back.
 *
 * A saved project (`src/projects.ts`) is a named directory inside the sandbox.
 * That is enough to come back to your own work, but it is not movable: the
 * directory lives in one deployment's workspace and belongs to one account, so
 * there was no way to hand a project to a colleague, take it to another
 * machine, or keep a copy of it somewhere the sandbox is not.
 *
 * This module is the portable form. A bundle is one JSON document holding the
 * project's name, its note, and every file beneath it — text kept as text and
 * anything binary carried as base64, so a bundle is a document a person can
 * read, diff and keep in version control, rather than an opaque archive.
 *
 * Two decisions are worth stating, because they are where a bundle could lie:
 *
 *   - The directory is the whole of a project, so it is the whole of a bundle.
 *     There is no second store to keep in step; a file that is not in the
 *     directory is not in the bundle, which is why an export that skips
 *     something *says so* (`skipped`) rather than quietly leaving it out.
 *   - The paths inside a bundle are data, not trusted. They are re-checked on
 *     the way in (`safeArchivePath`) and again, per file, against the sandbox
 *     fence (`resolveInBase`), so a hand-edited bundle cannot write outside the
 *     project however its paths are spelled.
 *
 * The heavy directories the rest of the app already ignores (`.git`,
 * `node_modules`, build output) are skipped on the way out by the same rule the
 * file tree and the folder picker use, so "export this project" means the work
 * rather than the dependencies.
 */

export class ProjectArchiveError extends Error {}

export const PROJECT_ARCHIVE_FORMAT = "genie.project";
export const PROJECT_ARCHIVE_VERSION = 1;

/** The most one bundle may hold, uncompressed. Generous for a project, and a
 * ceiling that keeps a runaway walk from exhausting memory. The server reads a
 * posted bundle with a larger body limit, so a text file full of characters JSON
 * has to escape still fits on the way in. */
export const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 20_000;

const MAX_DESCRIPTION = 200;

export interface ArchiveFile {
  /** Project-relative, forward-slashed. Never absolute, never climbs out. */
  path: string;
  encoding: "utf8" | "base64";
  content: string;
}

export interface ProjectArchive {
  format: string;
  version: number;
  /** What the project was called where it was exported. */
  name: string;
  description: string;
  exportedAt: string;
  files: ArchiveFile[];
  /** Relative paths deliberately left out (ignored and symlinked entries). */
  skipped: string[];
}

/** Normalize a caller-supplied path down to a safe, project-relative one. */
export function safeArchivePath(raw: unknown): string {
  if (typeof raw !== "string") throw new ProjectArchiveError("a file entry has no path");
  // A bundle written on one machine should load on another, so a backslash is
  // read as the separator it meant rather than as a character in a name.
  const cleaned = raw.replace(/\\/g, "/").trim();
  if (cleaned === "") throw new ProjectArchiveError("a file entry has no path");
  if (cleaned.startsWith("/")) throw new ProjectArchiveError(`that path is absolute: ${raw}`);
  if (/^[a-zA-Z]:/.test(cleaned)) throw new ProjectArchiveError(`that path is absolute: ${raw}`);

  const parts = cleaned.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") {
      throw new ProjectArchiveError(`that path is not a plain file path: ${raw}`);
    }
    if (part === "..") throw new ProjectArchiveError(`that path climbs out of the project: ${raw}`);
    if (part.includes("\0")) throw new ProjectArchiveError("a path cannot contain a null byte");
  }
  return parts.join("/");
}

function normalizeArchiveName(raw: unknown): string {
  const flat = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (flat === "") return "imported project";
  return flat.length > MAX_PROJECT_NAME ? flat.slice(0, MAX_PROJECT_NAME).trim() : flat;
}

/** A download filename for a project's name: a slug, never a traversal. */
export function archiveFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug === "" ? "project" : slug}.genie-project.json`;
}

/** Serialize a bundle. Sorted keys are not needed; deterministic fields are. */
export function encodeArchive(archive: ProjectArchive): string {
  const document: ProjectArchive = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    name: archive.name,
    description: archive.description,
    exportedAt: archive.exportedAt,
    files: archive.files,
    skipped: archive.skipped,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Read a bundle back, refusing anything that is not one.
 *
 * Accepts the parsed object or the raw text, because the console parses the
 * file it was handed and a test can pass either. Every field is re-derived
 * rather than trusted, so a bundle from an older or a hand-edited copy loads
 * with its shape normalized and its worst mistakes named, not silently kept.
 */
export function parseArchive(input: unknown): ProjectArchive {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new ProjectArchiveError(`that file is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectArchiveError("that file is not a project bundle");
  }

  const value = raw as Record<string, unknown>;
  if (value.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new ProjectArchiveError("that file is not a Genie project bundle");
  }
  const version = typeof value.version === "number" ? value.version : 0;
  if (version < 1 || version > PROJECT_ARCHIVE_VERSION) {
    throw new ProjectArchiveError(`this bundle is version ${version}; this deployment reads 1`);
  }

  const listed = value.files;
  if (!Array.isArray(listed)) throw new ProjectArchiveError("this bundle lists no files");
  if (listed.length > MAX_ARCHIVE_FILES) {
    throw new ProjectArchiveError(`this bundle has ${listed.length} files, more than the ${MAX_ARCHIVE_FILES} limit`);
  }

  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of listed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProjectArchiveError("a file entry in this bundle is malformed");
    }
    const file = entry as Record<string, unknown>;
    const rel = safeArchivePath(file.path);
    if (seen.has(rel)) throw new ProjectArchiveError(`this bundle lists “${rel}” twice`);
    seen.add(rel);
    if (typeof file.content !== "string") throw new ProjectArchiveError(`“${rel}” has no contents`);
    const encoding = file.encoding === "base64" ? "base64" : "utf8";
    bytes +=
      encoding === "base64"
        ? Math.floor(file.content.length * 0.75)
        : Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_ARCHIVE_BYTES) {
      throw new ProjectArchiveError("this bundle is larger than this deployment will load");
    }
    files.push({ path: rel, encoding, content: file.content });
  }

  const skipped = Array.isArray(value.skipped)
    ? value.skipped.filter((item): item is string => typeof item === "string")
    : [];

  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    name: normalizeArchiveName(value.name),
    description:
      typeof value.description === "string"
        ? value.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION)
        : "",
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    files,
    skipped,
  };
}

/* ------------------------------------------------------------------- io ---- */

/**
 * Text or bytes, decided the same way `readTextFile` decides: a NUL in the
 * opening bytes, or a body that will not survive a UTF-8 round trip, is binary.
 * The round trip is what keeps a stray invalid sequence from being written back
 * as replacement characters.
 */
function isText(buffer: Buffer): boolean {
  const sniff = buffer.subarray(0, Math.min(8000, buffer.length));
  if (sniff.includes(0)) return false;
  return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

async function collectFiles(rootAbs: string): Promise<{ files: ArchiveFile[]; skipped: string[] }> {
  const files: ArchiveFile[] = [];
  const skipped: string[] = [];
  let bytes = 0;

  const walk = async (abs: string, rel: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted, so two exports of an unchanged project are the same bytes.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        // A link can point outside the project, and a bundle should carry the
        // files, not a promise about where they are. Say so and move on.
        skipped.push(childRel);
        continue;
      }
      if (dirent.isDirectory()) {
        if (isIgnoredDir(dirent.name)) {
          skipped.push(childRel);
          continue;
        }
        await walk(path.join(abs, dirent.name), childRel);
        continue;
      }
      if (!dirent.isFile()) {
        skipped.push(childRel);
        continue;
      }
      if (files.length >= MAX_ARCHIVE_FILES) {
        throw new ProjectArchiveError(`this project has more than ${MAX_ARCHIVE_FILES} files`);
      }
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(path.join(abs, dirent.name));
      } catch {
        skipped.push(childRel);
        continue;
      }
      bytes += buffer.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        throw new ProjectArchiveError("this project is too large to export as one bundle");
      }
      files.push(
        isText(buffer)
          ? { path: childRel, encoding: "utf8", content: buffer.toString("utf8") }
          : { path: childRel, encoding: "base64", content: buffer.toString("base64") },
      );
    }
  };

  await walk(rootAbs, "");
  return { files, skipped };
}

export interface ProjectExport {
  filename: string;
  /** The encoded bundle, ready to write to a file. */
  content: string;
  archive: ProjectArchive;
}

export async function exportProject(project: {
  name: string;
  description: string;
  dir: string;
}): Promise<ProjectExport> {
  const dirAbs = resolveInBase(project.dir);
  if (!(await isDirectory(dirAbs))) {
    throw new ProjectArchiveError("this project's folder is gone, so there is nothing to export");
  }

  const { files, skipped } = await collectFiles(dirAbs);
  const archive: ProjectArchive = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    name: project.name,
    description: project.description,
    exportedAt: new Date().toISOString(),
    files,
    skipped,
  };
  return { filename: archiveFileName(project.name), content: encodeArchive(archive), archive };
}

export interface ImportProjectOptions {
  /** Override the bundled name. Otherwise the bundle's own name is used. */
  name?: string;
  description?: string;
  /** Open it (make it the working directory) once it exists. */
  open?: boolean;
}

export interface ProjectImport {
  project: ProjectView;
  files: number;
  skipped: string[];
}

/** A name that is not already taken, by appending a count. */
async function uniqueProjectName(base: string): Promise<string> {
  const wanted = base.trim().slice(0, MAX_PROJECT_NAME).trim() || "imported project";
  const taken = new Set((await listProjects()).map((row) => row.name.trim().toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;

  for (let count = 2; count < 1000; count += 1) {
    const suffix = ` (${count})`;
    const candidate = `${wanted.slice(0, MAX_PROJECT_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  const suffix = `-${crypto.randomBytes(3).toString("hex")}`;
  return `${wanted.slice(0, MAX_PROJECT_NAME - suffix.length)}${suffix}`;
}

/**
 * Load a bundle as a new project.
 *
 * The directory is created through `projects.ts`, so the id, the slugged
 * directory name and the per-account registry are the same as a project made by
 * hand; the files are then written beneath it, each one resolved through the
 * sandbox fence so a bundle can never name a path outside its own project. An
 * existing project is never overwritten: a name in the way gets a count, which
 * is why loading the same bundle twice leaves you with two projects rather than
 * one project quietly replaced.
 */
export async function importProject(
  archive: ProjectArchive,
  options: ImportProjectOptions = {},
): Promise<ProjectImport> {
  const name = await uniqueProjectName(options.name !== undefined && options.name.trim() !== "" ? options.name : archive.name);
  const project = await createProject({
    name,
    description: options.description ?? archive.description,
    open: options.open === true,
  });

  for (const file of archive.files) {
    const abs = resolveInBase(`${project.dir}/${file.path}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (file.encoding === "base64") await fs.writeFile(abs, Buffer.from(file.content, "base64"));
    else await fs.writeFile(abs, file.content, "utf8");
  }

  return { project, files: archive.files.length, skipped: archive.skipped };
}

