import fs from "node:fs/promises";
import path from "node:path";

import { uniqueProjectName } from "./project-archive.js";
import { createProject, type ProjectView } from "./projects.js";
import { isIgnoredDir, resolveInBase } from "./workspace.js";
import { readZipArchive, ZipError, type ZipArchive } from "./zip.js";

/**
 * A zip somebody uploaded, as a project you can work in.
 *
 * The reader (`src/zip.ts`) is the format; this is the *product* decision about
 * what an uploaded archive means. Four of them are worth stating, because each is
 * a place where a launch could quietly do the wrong thing:
 *
 *   * **The wrapping folder is stripped.** A "Download ZIP" of a repository — the
 *     commonest arrival — holds one directory (`widgets-main/`) and everything
 *     else inside it. Unpacked literally, the project's real root would be one
 *     level below where the agent stands: no `package.json` where the tools look,
 *     no install, no build, and a person left to work out why. So a single common
 *     top-level folder is removed, and only when *every* file shares it — a zip of
 *     two projects side by side keeps both, because choosing one for the user is
 *     not this function's business. Which folder was stripped is reported rather
 *     than remembered silently (`root`), and it names the project when nobody
 *     chose a name.
 *   * **The directories the whole app already ignores are skipped, and named.**
 *     `node_modules`, `.git`, `dist`, `__pycache__` and friends arrive inside
 *     plenty of hand-made zips. Unpacking them would be: a project whose file tree
 *     the console hides, a git history whose `origin` is somebody else's, and — for
 *     dependencies — time spent writing files that the install step is about to
 *     replace. They are dropped *and listed* (`skipped`), in the same shape the
 *     bundle exporter reports them, because silently dropping a `.git` directory is
 *     a thing a person needs to be told.
 *   * **Operating-system litter is not the project.** `__MACOSX/`, `.DS_Store`,
 *     `Thumbs.db` and `desktop.ini` are dropped without being listed: they are not
 *     files the author has, so "we skipped these" would be a report about the
 *     uploader's laptop rather than about their project.
 *   * **Nothing is overwritten.** The archive becomes a *new* project, through the
 *     same `projects.ts` every other project is made by — same ids, same slugged
 *     directory, same per-account registry — and a name already in use gets a count
 *     (`uniqueProjectName`), exactly as a loaded bundle does. Loading the same zip
 *     twice leaves two projects rather than one project replaced.
 *
 * Every file is written through `resolveInBase`, per file, so the fence holds even
 * though the reader has already checked the names: one path check is a promise,
 * two is a demonstration. What this function does *not* do is install the
 * dependencies — that is `src/project-install.ts`, run by the caller as a separate,
 * visible step, so a slow `npm install` is something a person can watch rather
 * than a hang in an upload.
 */

/** Entries that belong to the uploading machine's filesystem, not to the project. */
const ARCHIVE_NOISE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface ZipPlan {
  /** Files to write, project-relative, with the wrapping folder already stripped. */
  files: { path: string; content: Buffer }[];
  /**
   * The single top-level folder that was removed, or `null` when there was none.
   */
  root: string | null;
  /** Directory entries that survived, project-relative. Empty directories only. */
  directories: string[];
  /** Entries deliberately left out. */
  skipped: SkippedEntry[];
}

/**
 * Decide what an unpacked archive becomes — no filesystem, no project.
 *
 * Pure on purpose: the choices above are all decisions about *names*, and a
 * function that cannot touch disk is one a test can pin exactly (see
 * `src/test/project-zip.test.ts`).
 */
export function planZipImport(archive: ZipArchive): ZipPlan {
  const skipped: SkippedEntry[] = [];

  const usable = archive.files.filter((file) => {
    if (ARCHIVE_NOISE.test(file.path)) return false;
    const segments = file.path.split("/");
    if (segments.some((segment) => isIgnoredDir(segment))) {
      skipped.push({ path: file.path, reason: "a directory this console does not work in" });
      return false;
    }
    return true;
  });

  const directories = archive.directories.filter((dir) => {
    if (ARCHIVE_NOISE.test(dir)) return false;
    const segments = dir.split("/");
    return !segments.some((segment) => isIgnoredDir(segment));
  });

  // A wrapping folder is stripped only when *every* file lives under it and every
  // path has something after it — otherwise the first segment is a file name, or
  // two projects side by side, and neither is this function's to choose.
  let root: string | null = null;
  if (usable.length > 0 && usable.every((file) => file.path.includes("/"))) {
    const firsts = new Set(usable.map((file) => file.path.slice(0, file.path.indexOf("/"))));
    if (firsts.size === 1) root = [...firsts][0] ?? null;
  }

  const strip = (rel: string): string => (root === null ? rel : rel.slice(root.length + 1));

  return {
    files: usable.map((file) => ({ path: strip(file.path), content: file.content })),
    root,
    directories: directories.map(strip),
    skipped,
  };
}

export interface ZipImportOptions {
  /** Override the archive's own name. Otherwise the stripped folder names it. */
  name?: string;
  description?: string;
  /** Open it (make it the working directory) once it exists. */
  open?: boolean;
}

export interface ZipImport {
  project: ProjectView;
  /** How many files were written. */
  files: number;
  /** Entries left out, with the reason. */
  skipped: SkippedEntry[];
  /** The wrapping folder that was stripped, when there was one. */
  root: string | null;
  /** Project-relative paths, for the install plan to read the stack off. */
  paths: string[];
}

/** A name for a project that arrived as a zip: chosen, else the folder, else generic. */
export function zipProjectName(options: { name?: string; root: string | null }): string {
  const chosen = typeof options.name === "string" ? options.name.trim() : "";
  if (chosen !== "") return chosen;
  return options.root !== null && options.root.trim() !== "" ? options.root.trim() : "imported project";
}

/**
 * Unpack an uploaded archive into a new project.
 *
 * The order is deliberate: read, plan, create, write. Nothing on disk is touched
 * until the whole archive has been parsed and checked, so a corrupt or hostile zip
 * fails before it has made a directory — a partial import that then errored would
 * leave a project nobody asked for, and the person would have to work out whether
 * the leftovers matter.
 */
export async function importZipProject(
  buffer: Buffer,
  options: ZipImportOptions = {},
): Promise<ZipImport> {
  const archive = readZipArchive(buffer);
  const plan = planZipImport(archive);

  if (plan.files.length === 0) {
    throw new ZipError(
      plan.skipped.length > 0
        ? "this zip holds no files this console can work in (everything in it was a directory the console ignores)"
        : "this zip holds no files",
    );
  }

  const name = await uniqueProjectName(zipProjectName({ name: options.name, root: plan.root }));
  const project = await createProject({
    name,
    description: options.description ?? "",
    open: options.open === true,
  });

  for (const file of plan.files) {
    const abs = resolveInBase(`${project.dir}/${file.path}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content);
  }

  return {
    project,
    files: plan.files.length,
    skipped: plan.skipped,
    root: plan.root,
    paths: plan.files.map((file) => file.path),
  };
}
