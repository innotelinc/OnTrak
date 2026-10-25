/**
 * Ghidra headless analysis.
 *
 * Ghidra runs a JVM and carries a few hundred megabytes of analysers, so it
 * cannot live inside the agent process. Instead this module drives the
 * `analyzeHeadless` launcher that ships with a Ghidra install, runs a small
 * post-script that dumps a compact JSON summary, and parses that summary back
 * into something a model can reason about.
 *
 * Everything except `runGhidraAnalysis` is pure, so detection, argument
 * construction and parsing are testable on a machine with no Ghidra at all.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GhidraInstall {
  /** Ghidra root (the directory that contains `support`). */
  home: string;
  /** Absolute path to analyzeHeadless (.bat on Windows, shell script elsewhere). */
  launcher: string;
  /** Directory holding ExportSummary.java. */
  scriptDir: string;
}

export interface GhidraSummary {
  program: string;
  languageId: string;
  architecture: string;
  endian: string;
  compiler: string | null;
  entryPoints: string[];
  functionCount: number;
  functions: string[];
  imports: string[];
  exports: string[];
  strings: string[];
  /** Interesting strings the analyser found: URLs, paths, commands, IPs. */
  indicators: string[];
  analyzedAt: string;
  durationMs: number;
}

export interface GhidraRunOptions {
  binaryPath: string;
  install: GhidraInstall;
  /** Where the JSON summary and the Ghidra project are written. */
  workDir: string;
  /** Per-file analysis budget handed to analyzeHeadless. */
  timeoutSeconds?: number;
  /** Hard cap on the whole process, in milliseconds. */
  processTimeoutMs?: number;
  exec?: typeof execFile;
}

/** Common places a Ghidra install ends up when nobody set GHIDRA_HOME. */
export function ghidraHomeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const homes: string[] = [];
  if (env.GHIDRA_HOME) homes.push(env.GHIDRA_HOME);
  if (env.GHIDRA_INSTALL_DIR) homes.push(env.GHIDRA_INSTALL_DIR);
  if (platform === "win32") {
    // The official Windows installer drops Ghidra in the per-user programs
    // folder, version in the name, which is why the parents below are scanned.
    for (const drive of ["C:", "D:"]) {
      homes.push(`${drive}\\ghidra`, `${drive}\\Program Files\\ghidra`, `${drive}\\Program Files (x86)\\ghidra`);
      homes.push(`${drive}\\Program Files\\Ghidra`, `${drive}\\tools\\ghidra`);
    }
    if (env.LOCALAPPDATA) homes.push(`${env.LOCALAPPDATA}\\Programs\\ghidra`);
  } else if (platform === "darwin") {
    homes.push("/opt/homebrew/opt/ghidra", "/usr/local/opt/ghidra", `${env.HOME ?? ""}/ghidra`);
  } else {
    homes.push("/opt/ghidra", "/usr/share/ghidra", `/usr/local/ghidra`, `${env.HOME ?? ""}/ghidra`);
  }
  return homes.filter((home) => home.trim().length > 0);
}

async function defaultExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultList(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

/**
 * Find a usable install. `scriptDir` is passed in by the caller because the
 * post-script lives in this repository, not in the Ghidra install.
 */
export async function locateGhidra(options: {
  scriptDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (target: string) => Promise<boolean>;
  listDir?: (directory: string) => Promise<string[]>;
}): Promise<GhidraInstall | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? defaultExists;
  const listDir = options.listDir ?? defaultList;
  // Joining has to follow the platform being probed, not the host: the tests
  // resolve a Linux install from Windows, and the result must still be a path.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const launcherName = platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless";

  const candidates = ghidraHomeCandidates(env, platform);

  // Versioned installs ("ghidra_12.1.4_PUBLIC") are found by scanning the
  // folder the installer uses rather than by guessing version strings.
  const parents = platform === "win32" && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs")] : [];
  for (const parent of parents) {
    for (const entry of await listDir(parent)) {
      if (/^ghidra/i.test(entry)) candidates.push(join(parent, entry));
    }
  }

  for (const home of candidates) {
    const launcher = join(home, "support", launcherName);
    if (await exists(launcher)) return { home, launcher, scriptDir: options.scriptDir };
  }
  return null;
}

/** True when a JVM is reachable, which analyzeHeadless requires. */
export async function javaAvailable(options: {
  env?: NodeJS.ProcessEnv;
  exists?: (target: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? defaultExists;

  if (env.JAVA_HOME) {
    const java = path.join(env.JAVA_HOME, "bin", platform === "win32" ? "java.exe" : "java");
    if (await exists(java)) return true;
  }

  const pathEntries = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const java = path.join(entry, platform === "win32" ? "java.exe" : "java");
    if (await exists(java)) return true;
  }
  return false;
}

/**
 * The analyzeHeadless command line.
 *
 * `-deleteProject` keeps the workspace clean; the JSON summary is the only
 * artefact that survives a run.
 */
export function buildAnalyzeArgs(options: {
  projectDir: string;
  projectName: string;
  binaryPath: string;
  scriptDir: string;
  summaryPath: string;
  timeoutSeconds: number;
}): string[] {
  return [
    options.projectDir,
    options.projectName,
    "-import",
    options.binaryPath,
    "-scriptPath",
    options.scriptDir,
    "-postScript",
    "ExportSummary.java",
    options.summaryPath,
    "-analysisTimeoutPerFile",
    String(options.timeoutSeconds),
    "-deleteProject",
    "-overwrite"
  ];
}

function asStringArray(value: unknown, limit = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, limit);
}

/** Validate and normalise what the post-script wrote. */
export function parseSummary(raw: string): GhidraSummary {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  return {
    program: text(parsed.program),
    languageId: text(parsed.languageId),
    architecture: text(parsed.architecture),
    endian: text(parsed.endian),
    compiler: typeof parsed.compiler === "string" ? parsed.compiler : null,
    entryPoints: asStringArray(parsed.entryPoints, 20),
    functionCount: number(parsed.functionCount),
    functions: asStringArray(parsed.functions, 200),
    imports: asStringArray(parsed.imports, 200),
    exports: asStringArray(parsed.exports, 200),
    strings: asStringArray(parsed.strings, 200),
    indicators: asStringArray(parsed.indicators, 200),
    analyzedAt: text(parsed.analyzedAt) || new Date().toISOString(),
    durationMs: number(parsed.durationMs)
  };
}

/**
 * Strings worth a human's attention: embedded URLs, IP addresses, shell
 * commands and absolute paths are the fastest way to characterise an unknown
 * binary, so they are promoted out of the general string list.
 */
export function extractIndicators(strings: string[], limit = 25): string[] {
  const patterns = [
    /https?:\/\/[^\s"'<>]{4,}/i,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
    /(?:\/bin\/|\/usr\/|\/etc\/|C:\\|cmd\.exe|powershell|curl\s|wget\s)/i,
    /\b(?:vssadmin|bcdedit|netsh|schtasks|reg\s+add|mimikatz|cobalt|beacon)\b/i
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of strings) {
    const value = entry.trim();
    if (value.length < 4 || seen.has(value)) continue;
    if (!patterns.some((pattern) => pattern.test(value))) continue;
    seen.add(value);
    out.push(value.length > 160 ? `${value.slice(0, 157)}...` : value);
    if (out.length >= limit) break;
  }
  return out;
}

/** Render a summary for the model: stable, compact, no raw JSON wall. */
export function formatSummary(summary: GhidraSummary, sourceName: string): string {
  const lines: string[] = [
    `Ghidra analysed ${sourceName} in ${summary.durationMs} ms`,
    `language: ${summary.languageId || "unknown"} (${summary.architecture || "?"}, ${summary.endian || "?"} endian)`,
    `compiler: ${summary.compiler ?? "unrecognised"}`,
    `functions: ${summary.functionCount}`,
    `entry points: ${summary.entryPoints.join(", ") || "none reported"}`,
    `imports: ${summary.imports.length ? summary.imports.join(", ") : "none"}`,
    `exports: ${summary.exports.length ? summary.exports.join(", ") : "none"}`
  ];

  if (summary.indicators.length) {
    lines.push("", "Indicators:");
    for (const indicator of summary.indicators) lines.push(`  - ${indicator}`);
  }
  if (summary.strings.length) {
    lines.push("", "Sample strings:");
    for (const entry of summary.strings.slice(0, 15)) lines.push(`  - ${entry}`);
  }
  if (summary.functions.length) {
    lines.push("", "Function sample:");
    for (const entry of summary.functions.slice(0, 20)) lines.push(`  - ${entry}`);
  }
  return lines.join("\n");
}

function runProcess(
  launcher: string,
  args: string[],
  timeoutMs: number,
  exec: typeof execFile
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  // Windows cannot execute a .bat through CreateProcess directly; it has to go
  // through the command interpreter. Ghidra's launcher is exactly such a file.
  const batch = process.platform === "win32" && /\.(bat|cmd)$/i.test(launcher);
  const file = batch ? process.env.ComSpec ?? "cmd.exe" : launcher;
  const argv = batch ? ["/c", launcher, ...args] : args;

  return new Promise((resolve) => {
    const child = exec(
      file,
      argv,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed)
        });
      }
    );
    child.on("error", () => resolve({ code: 1, stdout: "", stderr: "failed to launch analyzeHeadless", timedOut: false }));
  });
}

/**
 * Where the post-script lives. It ships with this package rather than with the
 * Ghidra install, and the lookup has to work both from `src/` (tsx) and from
 * `dist/` (the built server).
 */
export function ghidraScriptDir(here = path.dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [path.join(here, "..", "ghidra"), path.join(here, "..", "..", "ghidra")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "ExportSummary.java"))) return candidate;
  }
  return path.join(process.cwd(), "ghidra");
}

let cachedInstall: GhidraInstall | null | undefined;

/**
 * Resolve the install once, before a turn builds its tool list, so a tool that
 * cannot work is never offered to the model.
 */
export async function primeGhidra(): Promise<void> {
  if (cachedInstall !== undefined) return;
  cachedInstall = await locateGhidra({ scriptDir: ghidraScriptDir() });
}

export function ghidraInstall(): GhidraInstall | null {
  return cachedInstall ?? null;
}

/** Test seam: forget the cached install. */
export function resetGhidraCache(): void {
  cachedInstall = undefined;
}

/** Run a headless analysis and return both the summary and the raw log. */
export async function runGhidraAnalysis(
  options: GhidraRunOptions
): Promise<{ summary: GhidraSummary; log: string }> {
  const timeoutSeconds = Math.min(3600, Math.max(30, options.timeoutSeconds ?? 600));
  const processTimeoutMs = options.processTimeoutMs ?? (timeoutSeconds + 60) * 1000;
  const exec = options.exec ?? execFile;

  await fs.mkdir(options.workDir, { recursive: true });
  const projectDir = path.join(options.workDir, "project");
  const summaryPath = path.join(options.workDir, "summary.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.rm(summaryPath, { force: true });

  // Ghidra refuses any path with a `.`-prefixed element, which a checkout under
  // `~/.config/...` or a hidden workspace hits immediately. Working from a copy
  // staged in the temp project sidesteps that and also means a binary cannot
  // change underneath the analyser.
  const staging = path.join(options.workDir, "binary");
  const scripts = path.join(options.workDir, "scripts");
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(scripts, { recursive: true });

  const stagedBinary = path.join(staging, path.basename(options.binaryPath).replace(/[^\w.-]+/g, "-"));
  await fs.copyFile(options.binaryPath, stagedBinary);

  const scriptSource = path.join(options.install.scriptDir, "ExportSummary.java");
  const scriptTarget = path.join(scripts, "ExportSummary.java");
  await fs.copyFile(scriptSource, scriptTarget);

  const started = Date.now();
  const args = buildAnalyzeArgs({
    projectDir,
    projectName: `genie-${Date.now()}`,
    binaryPath: stagedBinary,
    scriptDir: scripts,
    summaryPath,
    timeoutSeconds
  });

  const result = await runProcess(options.install.launcher, args, processTimeoutMs, exec);
  const log = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

  let raw: string;
  try {
    raw = await fs.readFile(summaryPath, "utf8");
  } catch {
    const tail = log.split("\n").slice(-12).join("\n");
    throw new Error(
      `analyzeHeadless produced no summary (exit ${result.code}${result.timedOut ? ", timed out" : ""}).\n${tail}`
    );
  }

  const summary = parseSummary(raw);
  if (!summary.durationMs) summary.durationMs = Date.now() - started;
  if (!summary.indicators.length) summary.indicators = extractIndicators(summary.strings);
  return { summary, log };
}
