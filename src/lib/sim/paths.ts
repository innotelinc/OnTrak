/**
 * Path handling shared by every driver.
 *
 * Internally all paths are canonical: forward slashes, absolute, and — on
 * Windows — a lower-cased drive prefix (`/c:/users/student`).  Drivers convert
 * to and from the platform's native presentation when echoing to the user so a
 * Windows student still sees `C:\Users\student`.
 */

import type { Platform } from "./types";

export const LINUX_HOME = "/home/student";
/**
 * Canonical paths keep a natural casing so `display()` can show Windows users
 * `C:\Users\student`. Lookups go through `toKey()`, which lower-cases on
 * Windows, so the filesystem stays case-insensitive regardless.
 */
export const WINDOWS_HOME = "/c:/Users/student";
export const WINDOWS_DRIVE = "/c:";

export function homeFor(platform: Platform): string {
  if (platform === "WINDOWS") return WINDOWS_HOME;
  if (platform === "OFFICE") return "/Documents";
  return LINUX_HOME;
}

function isWindows(platform: Platform) {
  return platform === "WINDOWS";
}

/** Turn any input path into canonical form, resolved against `cwd`. */
export function normalize(platform: Platform, cwd: string, input: string): string {
  if (isWindows(platform)) return normalizeWindows(cwd, input);
  return normalizePosix(cwd, input);
}

function normalizePosix(cwd: string, input: string): string {
  let raw = (input ?? "").trim();
  if (raw === "" || raw === ".") return cwd;
  if (raw === "~") return LINUX_HOME;
  if (raw.startsWith("~/")) raw = `${LINUX_HOME}/${raw.slice(2)}`;

  const base = raw.startsWith("/") ? "" : cwd;
  const segments = `${base}/${raw}`.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

function normalizeWindows(cwd: string, input: string): string {
  let raw = (input ?? "").trim();
  if (raw === "" || raw === ".") return cwd;
  if (raw === "~") return WINDOWS_HOME;
  raw = raw.replace(/\\/g, "/");
  if (raw === "~" || raw.toLowerCase().startsWith("~/")) raw = `${WINDOWS_HOME}/${raw.slice(2)}`;

  const cwdDrive = /^\/([a-z]):/.exec(cwd.toLowerCase())?.[1] ?? "c";
  const cwdRest = cwd.slice(3); // strip "/c:"

  let drive = cwdDrive;
  let rest: string;
  // Already-canonical input (`/c:/Users/...`) must not have its drive segment
  // pushed back onto the path, or resolution never terminates.
  const canonicalMatch = /^\/([a-zA-Z]):(\/.*|$)/.exec(raw);
  const driveMatch = /^([a-zA-Z]):(\/.*|$)?$/.exec(raw);
  if (canonicalMatch) {
    drive = canonicalMatch[1].toLowerCase();
    rest = canonicalMatch[2] || "/";
  } else if (driveMatch) {
    drive = driveMatch[1].toLowerCase();
    rest = driveMatch[2] ?? "/";
  } else if (raw.startsWith("/")) {
    rest = raw;
  } else {
    rest = `${cwdRest}/${raw}`;
  }

  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${drive}:${out.length ? `/${out.join("/")}` : ""}`;
}

/** The canonical path segments of `path`. */
export function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Last segment, e.g. `/home/student/a.txt` -> `a.txt`. */
export function baseName(path: string): string {
  if (path === "/" || /^\/[a-z]:$/.test(path)) return path;
  const parts = segments(path);
  return parts[parts.length - 1] ?? path;
}

/** Everything above `path`, e.g. `/a/b/c` -> `/a/b`. */
export function dirName(platform: Platform, path: string): string {
  if (path === "/") return "/";
  if (/^\/[a-z]:$/.test(path)) return "/";
  const parts = segments(path);
  parts.pop();
  if (isWindows(platform)) {
    const drive = /^\/([a-z]):/.exec(path.toLowerCase())?.[1] ?? "c";
    const inner = parts.slice(1); // drop the drive segment
    return `/${drive}:${inner.length ? `/${inner.join("/")}` : ""}`;
  }
  return `/${parts.join("/")}`;
}

export function joinPath(platform: Platform, a: string, b: string): string {
  if (isWindows(platform)) {
    const sep = a === "/" || /^\/[a-z]:\/?$/.test(a) ? "" : "/";
    return normalize(platform, "/", `${a}${sep}/${b}`);
  }
  const sep = a === "/" ? "" : "/";
  return normalize(platform, "/", `${a}${sep}/${b}`);
}

/** Case-insensitive lookup key. Linux and Office stay case sensitive. */
export function toKey(platform: Platform, path: string): string {
  return isWindows(platform) ? path.toLowerCase() : path;
}

/** Canonical -> what the user sees. */
export function display(platform: Platform, path: string): string {
  if (isWindows(platform)) {
    if (path === "/") return "C:\\";
    // Match case-insensitively but keep the casing the file was created with,
    // so `C:\Users\student` does not come back as `C:\users\student`.
    const m = /^\/([a-zA-Z]):(.*)$/.exec(path);
    if (!m) return path.replace(/\//g, "\\");
    const rest = m[2].replace(/\//g, "\\").replace(/^\\+/, "");
    return `${m[1].toUpperCase()}:\\${rest}`;
  }
  return path;
}

/** What the user types -> canonical. */
export function parse(platform: Platform, input: string): string {
  return normalize(platform, isWindows(platform) ? WINDOWS_HOME : LINUX_HOME, input);
}

/* -------------------------------------------------------------------------- */
/*  Permissions                                                               */
/* -------------------------------------------------------------------------- */

/** "644" / "0755" / "rw-r--r--" -> numeric bits. */
export function parseMode(input: string | number | undefined, fallback = 0o644): number {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input === "number") return input;
  const value = input.trim();
  if (/^-?[0-7]{3,4}$/.test(value)) return parseInt(value.replace(/^-/, ""), 8);
  if (/^[rwx-]{9}$/.test(value)) {
    let bits = 0;
    const table = [
      [0o400, 0o200, 0o100],
      [0o040, 0o020, 0o010],
      [0o004, 0o002, 0o001],
    ];
    for (let i = 0; i < 9; i += 1) {
      if (value[i] !== "-") bits |= table[Math.floor(i / 3)][i % 3];
    }
    return bits;
  }
  return fallback;
}

export function formatMode(mode: number): string {
  const chars = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i += 1) {
    out += mode & (1 << (8 - i)) ? chars[i] : "-";
  }
  return out;
}

/** Long listing used by `ls -l` / `Get-ChildItem`. */
export function describeMode(mode: number, type: "dir" | "file" | "link"): string {
  const prefix = type === "dir" ? "d" : type === "link" ? "l" : "-";
  return prefix + formatMode(mode);
}

/** Does `who` have `permission` on an entry?  `root` may do anything. */
export function canAccess(entry: { mode: number; owner: string }, who: string, permission: "r" | "w" | "x", inGroup = false): boolean {
  if (who === "root") return true;
  const shift = entry.owner === who ? 6 : inGroup ? 3 : 0;
  const bit = permission === "r" ? 4 : permission === "w" ? 2 : 1;
  return (entry.mode >> shift & bit) !== 0;
}

/* -------------------------------------------------------------------------- */
/*  Globbing                                                                  */
/* -------------------------------------------------------------------------- */

export function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out, caseInsensitive ? "i" : "");
}

/** Does a single path segment match a `*`/`?` pattern? */
export function matchSegment(pattern: string, name: string, caseInsensitive: boolean): boolean {
  return globToRegExp(pattern, caseInsensitive).test(name);
}

export function isGlob(value: string): boolean {
  return /[*?]/.test(value);
}
