/**
 * The shared shell interpreter.
 *
 * One implementation serves both `bash` and `powershell`: only the command
 * registry, the path flavour and the prompt differ.  It handles, in order:
 *
 *   quote-aware operator splitting (`;` `&&` `||`)
 *   pipes (`|`)
 *   redirection (`>` `>>` `2>` `2>>` `&>`)
 *   variable expansion (`$VAR`, `${VAR}`, `$?`, `~`)
 *   glob expansion (`*`, `?`)
 *
 * Unsupported constructs degrade gracefully rather than throwing, because a
 * student typo should never crash the simulator.
 */

import { baseName, display, homeFor, normalize } from "./paths";
import { expand as expandGlob } from "./vfs";
import type { CommandResult, EngineState, Platform } from "./types";

export interface CommandContext {
  platform: Platform;
  state: EngineState;
  /** Arguments after the command name, expanded and dequoted. */
  args: string[];
  /** The full original command string for this pipeline stage. */
  raw: string;
  /** Output of the previous stage in the pipeline. */
  stdin: string;
  /** True when the platform is Windows (drives case sensitivity etc.). */
  isWindows: boolean;
  /** Effective user for this command (after any `sudo` / `RunAs`). */
  user: string;
  /** Resolve a user-supplied path to a canonical path. */
  resolve(path: string): string;
  /** Expand a possibly-globby path into concrete canonical paths. */
  glob(path: string): string[];
  /** Render a canonical path the way the user's platform shows it. */
  show(path: string): string;
  /** Helper used by drivers to print "No such file or directory". */
  fail(message: string, code?: number): CommandResult;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  /** One-line help used by the built-in `help` command. */
  summary?: string;
  run(ctx: CommandContext, cmd: CommandRegistry): CommandResult;
}

export interface CommandRegistry {
  get(name: string): CommandSpec | undefined;
  all(): CommandSpec[];
  register(spec: CommandSpec): void;
  registerAll(specs: CommandSpec[]): void;
}

export function createRegistry(specs: CommandSpec[] = []): CommandRegistry {
  const map = new Map<string, CommandSpec>();
  const registry: CommandRegistry = {
    register(spec) {
      map.set(spec.name.toLowerCase(), spec);
      for (const alias of spec.aliases ?? []) map.set(alias.toLowerCase(), spec);
    },
    registerAll(list) {
      for (const spec of list) registry.register(spec);
    },
    get(name) {
      return map.get(name.toLowerCase());
    },
    all() {
      return [...new Set(map.values())].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
  registry.registerAll(specs);
  return registry;
}

/* -------------------------------------------------------------------------- */
/*  Lexing                                                                    */
/* -------------------------------------------------------------------------- */

interface Token {
  value: string;
  /** Quoted tokens never undergo glob or `*` expansion. */
  quoted: boolean;
  /** Raw source text, used when writing redirection targets back out. */
  raw: string;
}

export function tokenize(input: string, escapeBackslash = true): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  const push = () => {
    if (started) tokens.push({ value: current, quoted, raw: current });
    current = "";
    quoted = false;
    started = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    // POSIX shells use `\` as an escape; PowerShell treats it as an ordinary
    // character, which is essential for paths like C:\Users\student.
    if (escapeBackslash && ch === "\\" && i + 1 < input.length && input[i + 1] !== "\n") {
      current += input[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = true;
      started = true;
      for (i += 1; i < input.length; i += 1) {
        if (escapeBackslash && input[i] === "\\" && ch === '"' && i + 1 < input.length) {
          current += input[i + 1];
          i += 1;
          continue;
        }
        if (input[i] === ch) break;
        current += input[i];
      }
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    current += ch;
    started = true;
  }
  push();
  return tokens;
}

/** Split on top-level operators, ignoring anything inside quotes. */
export function splitOperators(input: string): { segment: string; next: ";" | "&&" | "||" | null }[] {
  const parts: { segment: string; next: ";" | "&&" | "||" | null }[] = [];
  let current = "";
  let quote: string | null = null;

  const flush = (next: ";" | "&&" | "||" | null) => {
    const trimmed = current.trim();
    if (trimmed) parts.push({ segment: trimmed, next });
    current = "";
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        current += input[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      flush(";");
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      flush("&&");
      i += 1;
      continue;
    }
    if (ch === "|" && input[i + 1] === "|") {
      flush("||");
      i += 1;
      continue;
    }
    current += ch;
  }
  flush(null);
  return parts;
}

/** Split a single segment on unquoted `|`. */
export function splitPipes(segment: string): string[] {
  const stages: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        current += segment[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|") {
      stages.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  stages.push(current.trim());
  return stages.filter((stage) => stage.length > 0);
}

export interface Redirects {
  stdout?: { path: string; append: boolean };
  stderr?: { path: string; append: boolean };
  stdin?: string;
  /** Remaining tokens once redirection has been stripped. */
  rest: string;
}

const REDIRECT_PATTERN = /(^|\s)(\d)?(>>?|&>)(\s*)/g;

export function extractRedirects(segment: string): Redirects {
  const redirects: Redirects = { rest: segment };
  const matches = [...segment.matchAll(REDIRECT_PATTERN)];
  if (matches.length === 0) return redirects;

  let rest = segment;
  for (const match of matches) {
    const [full, lead, fd, operator] = match;
    const start = match.index ?? 0;
    // `full` already includes any whitespace after the operator, so the target
    // token begins immediately after it.
    const after = segment.slice(start + full.length);
    const targetMatch = /^(\"[^\"]*\"|'[^']*'|\S+)/.exec(after);
    if (!targetMatch) continue;
    const target = targetMatch[1].replace(/^['"]|['"]$/g, "");
    if (operator === "&>") {
      redirects.stdout = { path: target, append: false };
      redirects.stderr = { path: target, append: false };
    } else if (fd === "2") {
      redirects.stderr = { path: target, append: operator === ">>" };
    } else {
      redirects.stdout = { path: target, append: operator === ">>" };
    }
    const consumed = full.length + targetMatch[0].length;
    rest = `${rest.slice(0, start)}${lead}${" ".repeat(consumed - lead.length)}${rest.slice(start + consumed)}`;
  }
  redirects.rest = rest.trim();
  return redirects;
}

/* -------------------------------------------------------------------------- */
/*  Expansion                                                                 */
/* -------------------------------------------------------------------------- */

export function expandVars(input: string, state: EngineState, platform: Platform, user: string): string {
  const specials: Record<string, string> = {
    HOME: homeFor(platform),
    USER: user,
    USERNAME: user,
    PWD: state.machine.cwd,
    HOSTNAME: state.machine.hostname,
    SHELL: platform === "WINDOWS" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/bash",
    "?": String(state.machine.exitCode),
    "0": state.machine.env.SHELL ?? "sh",
    COMPUTERNAME: state.machine.hostname.toUpperCase(),
    OS: state.machine.os.name,
  };
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*|\?)\}|\$([A-Za-z_][A-Za-z0-9_]*|\?)/g, (_m, braced, bare) => {
    const key = braced ?? bare;
    if (key in specials) return specials[key];
    return state.machine.env[key] ?? "";
  });
}

/* -------------------------------------------------------------------------- */
/*  Runtime                                                                   */
/* -------------------------------------------------------------------------- */

export interface ShellOptions {
  platform: Platform;
  state: EngineState;
  commands: CommandRegistry;
  /** Effective user name, e.g. "student" or "Administrator". */
  user: string;
  /** Command name -> spec map that should receive `sudo` treatment. */
  sudoCommands?: Set<string>;
}

export interface ShellRunOptions {
  /** Skip history recording (used when replaying a scenario's seed script). */
  silent?: boolean;
}

export interface Shell {
  run(input: string, opts?: ShellRunOptions): CommandResult;
  contextFor(user: string): Pick<CommandContext, "resolve" | "glob" | "show" | "fail">;
}

export function createShell(options: ShellOptions): Shell {
  const { platform, state, commands } = options;
  const isWindows = platform === "WINDOWS";

  const resolve = (path: string) => normalize(platform, state.machine.cwd, path);
  const glob = (path: string) => expandGlob(platform, state.vfs, state.machine.cwd, path);
  const show = (path: string) => display(platform, path);
  const fail = (message: string, code = 1): CommandResult => ({ stdout: "", stderr: message, exitCode: code });

  const contextFor = (user: string): Pick<CommandContext, "resolve" | "glob" | "show" | "fail"> => ({
    resolve,
    glob,
    show,
    fail,
  });

  function instantiate(argv: Token[], raw: string, stdin: string, user: string): CommandContext {
    const name = argv[0]?.value ?? "";
    const expanded: string[] = [];
    for (const token of argv.slice(1)) {
      let value = token.value;
      const hasVar = !token.quoted && /\$/.test(value);
      if (hasVar) value = expandVars(value, state, platform, user);
      if (value.startsWith("~") && !token.quoted) {
        value = homeFor(platform) + value.slice(1);
      }
      expanded.push(value);
    }
    return {
      platform,
      state,
      args: expanded,
      raw: raw || name,
      stdin,
      isWindows,
      user,
      resolve,
      glob: (p: string) => expandGlob(platform, state.vfs, state.machine.cwd, p),
      show,
      fail,
    };
  }

  function runStage(stage: string, stdin: string, user: string): CommandResult {
    const tokens = tokenize(stage, !isWindows);
    if (tokens.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

    const head = tokens[0];
    const nameValue = !head.quoted ? expandVars(head.value, state, platform, user) : head.value;
    const name = baseName(nameValue.replace(/\\/g, "/"));

    let effectiveUser = user;
    let rest = tokens;
    if (name === "sudo" && !isWindows) {
      const nextIndex = tokens.findIndex((t, i) => i > 0 && !t.value.startsWith("-"));
      if (nextIndex > 0) {
        effectiveUser = tokens[nextIndex].value === "-u" ? tokens[nextIndex + 1]?.value ?? "root" : "root";
        const skip = tokens[nextIndex].value === "-u" ? nextIndex + 2 : nextIndex;
        rest = [tokens[skip], ...tokens.slice(skip + 1)];
      }
    }

    const spec = commands.get(baseName(rest[0]?.value ?? ""));
    if (!spec) {
      return isWindows
        ? fail(`${baseName(rest[0]?.value ?? name)} : The term '${baseName(rest[0]?.value ?? name)}' is not recognized as the name of a cmdlet, function, script file, or operable program.`, 1)
        : fail(`${baseName(rest[0]?.value ?? name)}: command not found`, 127);
    }

    const ctx = instantiate(rest, stage, stdin, effectiveUser);
    try {
      const result = spec.run(ctx, commands);
      return { stdout: "", stderr: "", exitCode: 0, ...result };
    } catch (error) {
      return fail(`${spec.name}: ${(error as Error).message}`, 1);
    }
  }

  function applyRedirects(redirects: Redirects, result: CommandResult, user: string): CommandResult {
    let { stdout, stderr } = result;
    const writeTarget = (target: string, append: boolean, text: string) => {
      const path = resolve(target);
      const existing = state.vfs[path.toLowerCase?.() === path ? path : path];
      const prior = append ? existing?.content ?? "" : "";
      const separator = prior && !prior.endsWith("\n") && text ? "\n" : "";
      const entry = {
        path,
        type: "file" as const,
        content: `${prior}${separator}${text}`,
        mode: 0o644,
        owner: user,
        group: user,
        mtime: Date.now(),
        size: 0,
      };
      entry.size = entry.content.length;
      state.vfs[isWindows ? path.toLowerCase() : path] = entry;
      // Ensure parent directories exist so redirection never fails silently.
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!state.vfs[isWindows ? parent.toLowerCase() : parent]) {
        state.vfs[isWindows ? parent.toLowerCase() : parent] = {
          path: parent,
          type: "dir",
          mode: 0o755,
          owner: user,
          group: user,
          mtime: Date.now(),
          size: 0,
        };
      }
    };
    if (redirects.stdout && stdout !== undefined) {
      writeTarget(redirects.stdout.path, redirects.stdout.append, stdout);
      stdout = "";
    }
    if (redirects.stderr && stderr !== undefined) {
      writeTarget(redirects.stderr.path, redirects.stderr.append, stderr);
      stderr = "";
    }
    return { ...result, stdout, stderr };
  }

  function runSegment(segment: string, stdin: string, user: string): CommandResult {
    const redirects = extractRedirects(segment);
    const stages = splitPipes(redirects.rest);
    if (stages.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

    let result: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
    let pipeInput = stdin;
    for (let i = 0; i < stages.length; i += 1) {
      const stageResult = runStage(stages[i], pipeInput, user);
      if (stageResult.clear || stageResult.openEditor) return stageResult;
      if (stageResult.exitCode !== 0 && stageResult.exitCode !== 1) {
        result = stageResult;
        if (i < stages.length - 1) break;
      } else {
        result = stageResult;
      }
      pipeInput = stageResult.stdout ?? "";
    }
    return applyRedirects(redirects, result, user);
  }

  function run(input: string, opts: ShellRunOptions = {}): CommandResult {
    const trimmed = input.trim();
    if (trimmed === "") return { stdout: "", stderr: "", exitCode: state.machine.exitCode };

    const segments = splitOperators(trimmed);
    const outs: string[] = [];
    const errs: string[] = [];
    let lastCode = state.machine.exitCode;

    for (let i = 0; i < segments.length; i += 1) {
      const { segment } = segments[i];
      const connector = i === 0 ? null : segments[i - 1].next;

      // Honour `&&` / `||` short-circuiting against the previous exit status.
      if (connector === "&&" && lastCode !== 0) continue;
      if (connector === "||" && lastCode === 0) continue;

      const result = runSegment(segment, "", options.user);
      if (result.clear || result.openEditor) {
        if (!opts.silent) recordHistory(trimmed, result, state);
        return result;
      }
      if (result.stdout) outs.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) errs.push(result.stderr.replace(/\n$/, ""));
      lastCode = result.exitCode ?? 0;
      state.machine.exitCode = lastCode;
    }


    const combined: CommandResult = {
      stdout: outs.join("\n"),
      stderr: errs.join("\n"),
      exitCode: lastCode,
      refresh: true,
    };
    if (!opts.silent) recordHistory(trimmed, combined, state);
    return combined;
  }

  return { run, contextFor };
}

function recordHistory(input: string, result: CommandResult, state: EngineState) {
  state.machine.history.push({
    index: state.machine.history.length + 1,
    input,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
    cwd: state.machine.cwd,
    at: Date.now(),
  });
}

/** Read piped input, falling back to reading files named in the arguments. */
export function inputOrFiles(ctx: CommandContext, paths: string[]): { text: string; error?: string } {
  if (ctx.stdin && paths.length === 0) return { text: ctx.stdin };
  const chunks: string[] = [];
  if (ctx.stdin) chunks.push(ctx.stdin);
  for (const p of paths) {
    const resolved = ctx.resolve(p);
    const entry = ctx.state.vfs[ctx.isWindows ? resolved.toLowerCase() : resolved];
    if (!entry) return { text: "", error: `${ctx.show(resolved)}: No such file or directory` };
    if (entry.type === "dir") return { text: "", error: `${ctx.show(resolved)}: Is a directory` };
    chunks.push(entry.content ?? "");
  }
  return { text: chunks.join("\n") };
}

export function formatRows(rows: string[][], opts: { pad?: boolean } = {}): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (opts.pad === false || i === row.length - 1 ? cell : cell.padEnd(widths[i])))
        .join(" ")
        .replace(/\s+$/, ""),
    )
    .join("\n");
}

/** Parse `ls -la`-style short options into a set of flags plus the operands. */
export function parseFlags(args: string[]): { flags: Set<string>; operands: string[]; long: Map<string, string> } {
  const flags = new Set<string>();
  const operands: string[] = [];
  const long = new Map<string, string>();
  let stop = false;
  for (const arg of args) {
    if (stop) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      stop = true;
      continue;
    }
    if (/^--[a-zA-Z][\w-]*(=.*)?$/.test(arg)) {
      const [key, value = ""] = arg.slice(2).split("=");
      long.set(key.toLowerCase(), value);
      continue;
    }
    if (/^-[a-zA-Z0-9]+$/.test(arg)) {
      for (const ch of arg.slice(1)) flags.add(ch);
      continue;
    }
    operands.push(arg);
  }
  return { flags, operands, long };
}
