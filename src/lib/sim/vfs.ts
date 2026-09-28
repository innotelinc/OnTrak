/**
 * The virtual filesystem.
 *
 * A flat `Record<key, VfsEntry>` keyed by canonical path keeps serialization
 * trivial (the whole disk is one JSON object), makes globbing a single scan,
 * and means a container-backed driver can export a real directory tree into
 * exactly this shape.
 */

import {
  baseName,
  dirName,
  display,
  isGlob,
  matchSegment,
  normalize,
  parseMode,
  segments,
  toKey,
} from "./paths";
import type { Platform, SeedNode, Vfs, VfsEntry } from "./types";

export const DEFAULT_DIR_MODE = 0o755;
export const DEFAULT_FILE_MODE = 0o644;

export interface MakeEntryOptions {
  type?: "dir" | "file" | "link";
  content?: string;
  target?: string;
  mode?: number;
  owner?: string;
  group?: string;
  mtime?: number;
}

export function makeEntry(path: string, opts: MakeEntryOptions = {}): VfsEntry {
  const type = opts.type ?? "file";
  const content = opts.content ?? "";
  return {
    path,
    type,
    content: type === "file" ? content : undefined,
    target: type === "link" ? opts.target : undefined,
    mode: opts.mode ?? (type === "dir" ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE),
    owner: opts.owner ?? (path.startsWith("/c:") ? "Administrator" : "root"),
    group: opts.group ?? (path.startsWith("/c:") ? "Administrators" : "root"),
    mtime: opts.mtime ?? Date.now(),
    size: type === "file" ? content.length : 0,
  };
}

export function emptyVfs(platform: Platform = "LINUX"): Vfs {
  const vfs: Vfs = {};
  const rootPath = platform === "WINDOWS" ? "/c:" : "/";
  vfs[toKey(platform, rootPath)] = makeEntry(rootPath, { type: "dir", mode: 0o755 });
  return vfs;
}

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                    */
/* -------------------------------------------------------------------------- */

export function get(platform: Platform, vfs: Vfs, path: string): VfsEntry | undefined {
  return vfs[toKey(platform, path)];
}

export function exists(platform: Platform, vfs: Vfs, path: string): boolean {
  return Boolean(get(platform, vfs, path));
}

export function isDir(platform: Platform, vfs: Vfs, path: string): boolean {
  return get(platform, vfs, path)?.type === "dir";
}

export function isFile(platform: Platform, vfs: Vfs, path: string): boolean {
  return get(platform, vfs, path)?.type === "file";
}

/** Direct children of a directory, sorted the way a shell would sort them. */
export function listDir(platform: Platform, vfs: Vfs, dir: string): VfsEntry[] {
  const key = toKey(platform, dir);
  const children = Object.entries(vfs)
    .filter(([entryKey, entry]) => {
      if (entryKey === key) return false;
      return toKey(platform, dirName(platform, entry.path)) === key;
    })
    .map(([, entry]) => entry);
  const caseInsensitive = platform === "WINDOWS";
  return children.sort((a, b) => {
    const an = baseName(a.path);
    const bn = baseName(b.path);
    return caseInsensitive ? an.toLowerCase().localeCompare(bn.toLowerCase()) : an.localeCompare(bn);
  });
}

/** Recursively list everything under `dir`, depth first. */
export function listTree(platform: Platform, vfs: Vfs, dir: string): VfsEntry[] {
  const out: VfsEntry[] = [];
  const walk = (current: string) => {
    for (const child of listDir(platform, vfs, current)) {
      out.push(child);
      if (child.type === "dir") walk(child.path);
    }
  };
  walk(dir);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Mutation                                                                  */
/* -------------------------------------------------------------------------- */

export function mkdirp(
  platform: Platform,
  vfs: Vfs,
  path: string,
  opts: MakeEntryOptions = {},
): VfsEntry {
  const canonical = normalize(platform, "/", path);
  const walk = (p: string): VfsEntry => {
    const key = toKey(platform, p);
    const found = vfs[key];
    if (found) return found;
    if (p !== "/") mkdirp(platform, vfs, dirName(platform, p), opts);
    const entry = makeEntry(p, { ...opts, type: "dir", mode: opts.mode ?? DEFAULT_DIR_MODE });
    vfs[toKey(platform, p)] = entry;
    return entry;
  };
  return walk(canonical);
}

export function writeFile(
  platform: Platform,
  vfs: Vfs,
  path: string,
  content: string,
  opts: MakeEntryOptions = {},
): VfsEntry {
  const canonical = normalize(platform, "/", path);
  const parent = dirName(platform, canonical);
  if (parent !== canonical) mkdirp(platform, vfs, parent, { owner: opts.owner, group: opts.group });
  const key = toKey(platform, canonical);
  const previous = vfs[key];
  const entry: VfsEntry = {
    ...makeEntry(canonical, { ...opts, content }),
    path: previous?.path ?? canonical,
    mode: opts.mode ?? previous?.mode ?? DEFAULT_FILE_MODE,
    owner: opts.owner ?? previous?.owner ?? makeEntry(canonical).owner,
    group: opts.group ?? previous?.group ?? makeEntry(canonical).group,
    mtime: opts.mtime ?? Date.now(),
    size: content.length,
  };
  vfs[key] = entry;
  return entry;
}

/**
 * Save a text editor's buffer back to the disk.
 *
 * An existing file is updated in place (keeping its mode); a path that does not
 * exist yet is created, which is how a scenario asks for a brand-new config or
 * note. Both the attempt runner's editor and the tests go through here, so the
 * round-trip a lesson depends on is covered by `npm test`.
 */
export function writeEditedFile(
  platform: Platform,
  vfs: Vfs,
  path: string,
  content: string,
  owner?: string,
): VfsEntry {
  return writeFile(platform, vfs, path, content, owner ? { owner, group: owner } : {});
}

export function appendFile(platform: Platform, vfs: Vfs, path: string, content: string): VfsEntry {
  const existing = get(platform, vfs, path);
  const prefix = existing?.content ?? "";
  const separator = prefix && !prefix.endsWith("\n") ? "\n" : "";
  return writeFile(platform, vfs, path, `${prefix}${separator}${content}`);
}

export function makeLink(
  platform: Platform,
  vfs: Vfs,
  path: string,
  target: string,
  opts: MakeEntryOptions = {},
): VfsEntry {
  const canonical = normalize(platform, "/", path);
  mkdirp(platform, vfs, dirName(platform, canonical));
  const entry = makeEntry(canonical, { ...opts, type: "link", target });
  vfs[toKey(platform, canonical)] = entry;
  return entry;
}

export function remove(platform: Platform, vfs: Vfs, path: string, recursive = false): number {
  const entry = get(platform, vfs, path);
  if (!entry) return -1;
  if (entry.type === "dir") {
    const children = listDir(platform, vfs, entry.path);
    if (children.length > 0 && !recursive) return -2;
    for (const child of listTree(platform, vfs, entry.path)) {
      delete vfs[toKey(platform, child.path)];
    }
  }
  delete vfs[toKey(platform, entry.path)];
  return 0;
}

export function copy(
  platform: Platform,
  vfs: Vfs,
  from: string,
  to: string,
  recursive = false,
): { ok: boolean; error?: string } {
  const src = get(platform, vfs, from);
  if (!src) return { ok: false, error: `cannot stat '${display(platform, normalize(platform, "/", from))}'` };
  if (src.type === "dir" && !recursive) {
    return { ok: false, error: `-r not specified; omitting directory '${display(platform, src.path)}'` };
  }

  const destEntry = get(platform, vfs, to);
  const destPath =
    destEntry?.type === "dir" ? `${destEntry.path}/${baseName(src.path)}` : normalize(platform, "/", to);

  if (src.type === "dir") {
    mkdirp(platform, vfs, destPath, { owner: src.owner, group: src.group, mode: src.mode });
    for (const child of listTree(platform, vfs, src.path)) {
      const relative = child.path.slice(src.path.length);
      const next = `${destPath}${relative}`;
      if (child.type === "dir") mkdirp(platform, vfs, next, { owner: child.owner, group: child.group, mode: child.mode });
      else writeFile(platform, vfs, next, child.content ?? "", { mode: child.mode, owner: child.owner, group: child.group });
    }
    return { ok: true };
  }

  writeFile(platform, vfs, destPath, src.content ?? "", {
    mode: src.mode,
    owner: src.owner,
    group: src.group,
    mtime: Date.now(),
  });
  return { ok: true };
}

export function move(
  platform: Platform,
  vfs: Vfs,
  from: string,
  to: string,
): { ok: boolean; error?: string } {
  const src = get(platform, vfs, from);
  if (!src) return { ok: false, error: `cannot stat '${display(platform, normalize(platform, "/", from))}'` };
  const destEntry = get(platform, vfs, to);
  const destPath =
    destEntry?.type === "dir" ? `${destEntry.path}/${baseName(src.path)}` : normalize(platform, "/", to);

  /*
   * Landing on the item itself is a no-op. Without this guard the copy/remove
   * below would delete the file — and `Rename-Item a.txt -NewName a.txt` is a
   * legal, harmless thing for a student to do.
   */
  if (destPath === src.path) return { ok: true };

  if (src.type === "dir" && destPath.startsWith(`${src.path}/`)) {
    return { ok: false, error: "cannot move a directory into itself" };
  }

  const result = copy(platform, vfs, from, destPath, true);
  if (!result.ok) return result;
  remove(platform, vfs, src.path, true);
  return { ok: true };
}

export function rename(platform: Platform, vfs: Vfs, path: string, newName: string): boolean {
  if (newName.includes("/") || newName.includes("\\")) return false;
  const next = `${dirName(platform, path)}/${newName}`;
  return move(platform, vfs, path, next).ok;
}

export function chmod(platform: Platform, vfs: Vfs, path: string, mode: number): boolean {
  const entry = get(platform, vfs, path);
  if (!entry) return false;
  entry.mode = mode;
  entry.mtime = Date.now();
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Globbing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Expand a possibly-globby path into concrete canonical paths.
 * Mirrors bash's behavior closely enough for teaching purposes: a pattern with
 * no match resolves to itself so the caller can raise the usual "No such file"
 * error.
 */
export function expand(platform: Platform, vfs: Vfs, cwd: string, raw: string): string[] {
  if (!isGlob(raw)) return [normalize(platform, cwd, raw)];
  const caseInsensitive = platform === "WINDOWS";
  const pattern = normalize(platform, cwd, raw);
  const patternSegments = segments(pattern);
  let candidates: string[] = pattern.startsWith("/") || /^[a-zA-Z]:/.test(raw) ? ["/"] : [cwd];

  for (const seg of patternSegments) {
    const next: string[] = [];
    for (const base of candidates) {
      const walk = seg === "**";
      const pool = walk ? listTree(platform, vfs, base) : listDir(platform, vfs, base);
      for (const entry of pool) {
        const name = baseName(entry.path);
        if (walk || matchSegment(seg, name, caseInsensitive)) next.push(entry.path);
      }
    }
    candidates = next;
  }

  return candidates.length > 0 ? candidates.sort() : [pattern];
}

/* -------------------------------------------------------------------------- */
/*  Seeding & snapshots                                                       */
/* -------------------------------------------------------------------------- */

/** Build a Vfs from a scenario's `files` array. */
export function seedVfs(platform: Platform, nodes: SeedNode[] | undefined, base: Vfs = {}): Vfs {
  const vfs: Vfs = { ...base };
  const rootPath = platform === "WINDOWS" ? "/c:" : "/";
  if (!vfs[toKey(platform, rootPath)]) vfs[toKey(platform, rootPath)] = makeEntry(rootPath, { type: "dir" });

  for (const node of nodes ?? []) {
    const canonical = normalize(platform, rootPath, node.path);
    const type = node.type ?? (canonical.endsWith("/") || node.content === undefined ? "dir" : "file");
    const mode = parseMode(node.mode, type === "dir" ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE);
    if (type === "dir") {
      mkdirp(platform, vfs, canonical, { mode });
    } else if (type === "link") {
      makeLink(platform, vfs, canonical, node.target ?? "", { mode });
    } else {
      writeFile(platform, vfs, canonical, node.content ?? "", { mode });
    }
  }
  return vfs;
}

/** `find`-style search by name pattern. */
export function findByGlob(
  platform: Platform,
  vfs: Vfs,
  root: string,
  pattern: string,
): VfsEntry[] {
  const caseInsensitive = platform === "WINDOWS";
  return listTree(platform, vfs, root).filter((entry) =>
    matchSegment(pattern, baseName(entry.path), caseInsensitive),
  );
}

/** A stable, human-readable rendering of the tree — used by `tree` and by admin tooling. */
export function renderTree(platform: Platform, vfs: Vfs, root: string, prefix = ""): string {
  const children = listDir(platform, vfs, root);
  return children
    .map((child, i) => {
      const last = i === children.length - 1;
      const branch = `${prefix}${last ? "└── " : "├── "}${baseName(child.path)}${child.type === "dir" ? "/" : ""}`;
      const nested = child.type === "dir" ? renderTree(platform, vfs, child.path, `${prefix}${last ? "    " : "│   "}`) : "";
      return nested ? `${branch}\n${nested}` : branch;
    })
    .join("\n");
}

/** Convenience: absolute canonical path for a display path (used by graders). */
export function resolveExistingPath(platform: Platform, vfs: Vfs, displayPath: string): VfsEntry | undefined {
  const candidates = [displayPath, normalize(platform, "/", displayPath), `/home/student/${displayPath}`, `/c:/users/student/${displayPath}`];
  for (const candidate of candidates) {
    const found = get(platform, vfs, candidate);
    if (found) return found;
  }
  return undefined;
}

/** Guard used by drivers before touching a node. */
export function childOf(platform: Platform, parent: string, child: string): boolean {
  return toKey(platform, dirName(platform, child)) === toKey(platform, parent);
}
