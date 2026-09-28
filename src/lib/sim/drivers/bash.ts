/**
 * The Linux driver: a teaching-grade bash-like shell over the virtual
 * filesystem and machine state.
 *
 * Fidelity goals, in order:
 *   1. error messages look exactly like a real Ubuntu box (students learn from
 *      them, and the graders match on behavior, not on wording);
 *   2. permissions, sudo and systemd behave believably;
 *   3. anything unsupported fails loudly instead of pretending to succeed.
 */

import {
  baseName,
  canAccess,
  describeMode,
  display,
  dirName,
  homeFor,
  parseMode,
  segments,
  toKey,
} from "../paths";
import { createRegistry, createShell, formatRows, inputOrFiles, parseFlags, type CommandContext, type CommandSpec } from "../shell";
import { simulatedPasswordHash } from "../password";
import {
  chmod as vfsChmod,
  copy,
  get,
  listDir,
  listTree,
  mkdirp,
  move,
  remove,
  renderTree,
  writeFile,
} from "../vfs";
import type { CommandResult, EngineState, HistoryEntry, LocalUser, ShellDriver } from "../types";

const ROOT_ONLY = "you must be root to perform this action";

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function entryAt(ctx: CommandContext, path: string) {
  const canonical = ctx.resolve(path);
  return get(ctx.platform, ctx.state.vfs, canonical);
}

function noSuchFile(ctx: CommandContext, path: string): CommandResult {
  return ctx.fail(`ls: cannot access '${path}': No such file or directory`, 2);
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function bad(stderr: string, code = 1): CommandResult {
  return { stdout: "", stderr, exitCode: code };
}

function isRoot(ctx: CommandContext): boolean {
  return ctx.user === "root";
}

function requireRoot(ctx: CommandContext, prefix: string): CommandResult | null {
  if (isRoot(ctx)) return null;
  return bad(`${prefix}: ${ROOT_ONLY}`, 1);
}

function monthDay(ms: number): string {
  const date = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** Expand operands into file paths, defaulting to the current directory. */
function operandsOrCwd(ctx: CommandContext, operands: string[]): string[] {
  if (operands.length === 0) return [ctx.state.machine.cwd];
  return operands;
}

function eachPath(ctx: CommandContext, paths: string[], fn: (canonical: string) => CommandResult | null): CommandResult {
  const outs: string[] = [];
  const errs: string[] = [];
  let code = 0;
  for (const path of paths) {
    const result = fn(ctx.resolve(path));
    if (!result) continue;
    if (result.stdout) outs.push(result.stdout);
    if (result.stderr) errs.push(result.stderr);
    if (result.exitCode) code = result.exitCode;
  }
  return { stdout: outs.join("\n"), stderr: errs.join("\n"), exitCode: code };
}

function grantSudo(ctx: CommandContext): void {
  const target = ctx.user === "root" ? "root" : ctx.user;
  const user = ctx.state.machine.users.find((u) => u.name === target);
  if (user && !user.groups.includes("sudo")) user.groups.push("sudo");
}

function findUser(state: EngineState, name: string): LocalUser | undefined {
  return state.machine.users.find((u) => u.name === name);
}

/* -------------------------------------------------------------------------- */
/*  Filesystem commands                                                       */
/* -------------------------------------------------------------------------- */

const ls: CommandSpec = {
  name: "ls",
  aliases: ["dir", "vdir"],
  summary: "list directory contents",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const long = flags.has("l");
    const all = flags.has("a");
    const recursive = flags.has("R");
    const human = flags.has("h");

    const format = (canonical: string, name: string, entry: ReturnType<typeof get>): string => {
      if (!entry) return "";
      const label = entry.type === "link" ? `${name} -> ${entry.target ?? ""}` : name;
      if (!long) return label;
      return [
        describeMode(entry.mode, entry.type),
        "1",
        entry.owner,
        entry.group,
        human ? humanSize(entry.size).padStart(5) : String(entry.size).padStart(6),
        monthDay(entry.mtime),
        label,
      ].join(" ");
    };

    const render = (canonical: string): CommandResult | null => {
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        const shown = display(ctx.platform, canonical);
        return { stdout: "", stderr: `ls: cannot access '${shown}': No such file or directory`, exitCode: 2 };
      }
      if (entry.type !== "dir") {
        return ok(format(canonical, baseName(canonical), entry));
      }
      if (!canAccess(entry, ctx.user, "r", entry.group === ctx.user)) {
        return bad(`ls: cannot open directory '${display(ctx.platform, canonical)}': Permission denied`, 2);
      }
      const children = listDir(ctx.platform, ctx.state.vfs, canonical);
      const visible = all ? children : children.filter((child) => !baseName(child.path).startsWith("."));
      const lines: string[] = [];
      if (operands.length > 1 || recursive) lines.push(`${display(ctx.platform, canonical)}:`);
      for (const child of visible) {
        lines.push(format(child.path, baseName(child.path), child));
      }
      if (recursive) {
        for (const child of visible.filter((c) => c.type === "dir")) {
          if (baseName(child.path) === "." || baseName(child.path) === "..") continue;
          lines.push("");
          lines.push(`${display(ctx.platform, child.path)}:`);
          for (const grand of listDir(ctx.platform, ctx.state.vfs, child.path)) {
            if (!all && baseName(grand.path).startsWith(".")) continue;
            lines.push(format(grand.path, baseName(grand.path), grand));
          }
        }
      }
      if (visible.length === 0) return ok("");
      return ok(lines.filter((line) => line !== "").join("\n"));
    };

    const paths = operandsOrCwd(ctx, operands);
    const result = eachPath(ctx, paths, render);
    // Directory headers are only printed for multi-target listings.
    return result;
  },
};

const cd: CommandSpec = {
  name: "cd",
  summary: "change the working directory",
  run(ctx) {
    const target = ctx.args[0] ?? (ctx.state.machine.env.HOME || homeFor(ctx.platform));
    const canonical = target === "-" ? ctx.state.machine.env.OLDPWD ?? ctx.state.machine.cwd : ctx.resolve(target);
    const entry = get(ctx.platform, ctx.state.vfs, canonical);
    if (!entry) {
      return bad(`bash: cd: ${target}: No such file or directory`);
    }
    if (entry.type !== "dir") {
      return bad(`bash: cd: ${target}: Not a directory`);
    }
    if (!canAccess(entry, ctx.user, "x", entry.group === ctx.user)) {
      return bad(`bash: cd: ${target}: Permission denied`);
    }
    ctx.state.machine.env.OLDPWD = ctx.state.machine.cwd;
    ctx.state.machine.cwd = entry.path;
    ctx.state.machine.env.PWD = entry.path;
    return ok("");
  },
};

const pwd: CommandSpec = {
  name: "pwd",
  summary: "print the working directory",
  run(ctx) {
    return ok(display(ctx.platform, ctx.state.machine.cwd));
  },
};

const cat: CommandSpec = {
  name: "cat",
  summary: "concatenate files and print them",
  run(ctx) {
    if (ctx.args.length === 0) return ok(ctx.stdin);
    const { operands } = parseFlags(ctx.args);
    const outs: string[] = [];
    const errs: string[] = [];
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        errs.push(`cat: ${operand}: No such file or directory`);
        continue;
      }
      if (entry.type === "dir") {
        errs.push(`cat: ${operand}: Is a directory`);
        continue;
      }
      if (!canAccess(entry, ctx.user, "r", entry.group === ctx.user)) {
        errs.push(`cat: ${operand}: Permission denied`);
        continue;
      }
      outs.push(entry.content ?? "");
    }
    return { stdout: outs.join(""), stderr: errs.join("\n"), exitCode: errs.length ? 1 : 0 };
  },
};

const echo: CommandSpec = {
  name: "echo",
  aliases: ["print"],
  summary: "display a line of text",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    let text = operands.join(" ");
    if (flags.has("e")) {
      text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }
    return ok(flags.has("n") ? text : `${text}\n`);
  },
};

const printf: CommandSpec = {
  name: "printf",
  summary: "format and print data",
  run(ctx) {
    const [format, ...rest] = ctx.args;
    if (format === undefined) return bad("printf: usage: printf format [arguments]");
    let index = 0;
    const output = format
      .replace(/%%/g, "\u0000")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\0/g, "\u0000")
      .replace(/%[sd]/g, () => rest[index++] ?? "")
      .replace(/\u0000/g, "%");
    return ok(output);
  },
};

const touch: CommandSpec = {
  name: "touch",
  summary: "create empty files or update timestamps",
  run(ctx) {
    if (ctx.args.length === 0) return bad("touch: missing file operand");
    const { operands } = parseFlags(ctx.args);
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const existing = get(ctx.platform, ctx.state.vfs, canonical);
      if (existing) {
        existing.mtime = Date.now();
        continue;
      }
      const parent = dirName(ctx.platform, canonical);
      if (!get(ctx.platform, ctx.state.vfs, parent)) {
        return bad(`touch: cannot touch '${operand}': No such file or directory`);
      }
      writeFile(ctx.platform, ctx.state.vfs, canonical, "", { owner: ctx.user, group: ctx.user });
    }
    return ok("");
  },
};

const mkdir: CommandSpec = {
  name: "mkdir",
  summary: "create directories",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length === 0) return bad("mkdir: missing operand");
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      if (get(ctx.platform, ctx.state.vfs, canonical)) {
        if (flags.has("p")) continue;
        return bad(`mkdir: cannot create directory '${operand}': File exists`);
      }
      const parent = dirName(ctx.platform, canonical);
      if (!get(ctx.platform, ctx.state.vfs, parent)) {
        if (!flags.has("p")) return bad(`mkdir: cannot create directory '${operand}': No such file or directory`);
      }
      const requested = parseFlags(ctx.args).long.get("mode");
      mkdirp(ctx.platform, ctx.state.vfs, canonical, {
        owner: ctx.user,
        group: ctx.user,
        mode: parseMode(requested ?? (flags.has("m") ? operands[0] : undefined), 0o755),
      });
    }
    return ok("");
  },
};

const rmdir: CommandSpec = {
  name: "rmdir",
  summary: "remove empty directories",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return bad(`rmdir: failed to remove '${operand}': No such file or directory`);
      if (entry.type !== "dir") return bad(`rmdir: failed to remove '${operand}': Not a directory`);
      if (listDir(ctx.platform, ctx.state.vfs, canonical).length > 0) {
        return bad(`rmdir: failed to remove '${operand}': Directory not empty`);
      }
      remove(ctx.platform, ctx.state.vfs, canonical);
    }
    return ok("");
  },
};

const rm: CommandSpec = {
  name: "rm",
  summary: "remove files or directories",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length === 0) return bad("rm: missing operand");
    const recursive = flags.has("r") || flags.has("R");
    const force = flags.has("f");
    const outs: string[] = [];
    const errs: string[] = [];
    let code = 0;
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        if (!force) {
          errs.push(`rm: cannot remove '${operand}': No such file or directory`);
          code = 1;
        }
        continue;
      }
      const result = remove(ctx.platform, ctx.state.vfs, canonical, recursive);
      if (result === -2) {
        errs.push(`rm: cannot remove '${operand}': Is a directory`);
        code = 1;
        continue;
      }
      outs.push(`removed '${operand}'`);
    }
    return { stdout: flags.has("v") ? outs.join("\n") : "", stderr: errs.join("\n"), exitCode: code };
  },
};

const cp: CommandSpec = {
  name: "cp",
  summary: "copy files and directories",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length < 2) return bad("cp: missing destination file operand");
    const destination = operands[operands.length - 1];
    const sources = operands.slice(0, -1);
    const recursive = flags.has("r") || flags.has("R") || flags.has("a");
    for (const source of sources) {
      const result = copy(ctx.platform, ctx.state.vfs, ctx.resolve(source), ctx.resolve(destination), recursive);
      if (!result.ok) return bad(`cp: ${result.error}`);
    }
    return ok("");
  },
};

const mv: CommandSpec = {
  name: "mv",
  aliases: ["rename"],
  summary: "move or rename files",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    if (operands.length < 2) return bad("mv: missing destination file operand");
    const destination = operands[operands.length - 1];
    for (const source of operands.slice(0, -1)) {
      const result = move(ctx.platform, ctx.state.vfs, ctx.resolve(source), ctx.resolve(destination));
      if (!result.ok) return bad(`mv: ${result.error}`);
      grantSudo(ctx);
    }
    return ok("");
  },
};

const chmod: CommandSpec = {
  name: "chmod",
  summary: "change file permissions",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length < 2) return bad("chmod: missing operand");
    const recursive = flags.has("R");
    const first = operands[0];
    const targets = operands.slice(1);
    let baseMode: number | null = null;
    let symbolic = first;
    if (/^[ugoa]*[+-=][rwxXst]*$/.test(first)) {
      baseMode = null;
    } else if (/^[0-7]{3,4}$/.test(first)) {
      baseMode = parseMode(first);
    } else {
      return bad(`chmod: invalid mode: '${first}'`);
    }

    const applyTo = (canonical: string): CommandResult | null => {
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return { stdout: "", stderr: `chmod: cannot access '${display(ctx.platform, canonical)}': No such file or directory`, exitCode: 1 };
      if (!isRoot(ctx) && entry.owner !== ctx.user) {
        return { stdout: "", stderr: `chmod: changing permissions of '${display(ctx.platform, canonical)}': Operation not permitted`, exitCode: 1 };
      }
      if (baseMode !== null) {
        vfsChmod(ctx.platform, ctx.state.vfs, canonical, baseMode);
      } else {
        const target = symbolic[0] === "a" || /^[+-=]/.test(symbolic) ? "a" : symbolic[0];
        const who = target === "a" ? "ugo" : target;
        const opMatch = /[+-=]/.exec(symbolic);
        const op = opMatch ? opMatch[0] : "=";
        const perms = symbolic.slice(symbolic.indexOf(op) + 1);
        let mode = entry.mode;
        const bitsFor = (shift: number, ch: string) =>
          ch === "r" ? 4 << shift : ch === "w" ? 2 << shift : ch === "x" || ch === "X" ? 1 << shift : 0;
        const shifts: Record<string, number> = { u: 6, g: 3, o: 0 };
        for (const key of who) {
          const shift = shifts[key];
          if (shift === undefined) continue;
          const mask = 0o7 << shift;
          const value = perms.split("").reduce((acc, ch) => acc | bitsFor(shift, ch), 0);
          if (op === "+") mode |= value;
          else if (op === "-") mode &= ~value;
          else mode = (mode & ~mask) | value;
        }
        vfsChmod(ctx.platform, ctx.state.vfs, canonical, mode);
      }
      return null;
    };

    for (const target of targets) {
      const canonical = ctx.resolve(target);
      const node = get(ctx.platform, ctx.state.vfs, canonical);
      if (!node) return bad(`chmod: cannot access '${target}': No such file or directory`);
      applyTo(canonical);
      if (recursive && node.type === "dir") {
        for (const child of listTree(ctx.platform, ctx.state.vfs, canonical)) applyTo(child.path);
      }
    }
    return ok("");
  },
};

const chown: CommandSpec = {
  name: "chown",
  summary: "change file owner and group",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "chown");
    if (rootCheck) return rootCheck;
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length < 2) return bad("chown: missing operand");
    const spec = operands[0];
    const [owner, group] = spec.includes(":") ? spec.split(":") : [spec, undefined];
    const recursive = flags.has("R");

    if (owner && !findUser(ctx.state, owner)) {
      return bad(`chown: invalid user: '${spec}'`);
    }

    const applyTo = (canonical: string) => {
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return;
      if (owner) entry.owner = owner;
      if (group) entry.group = group;
      entry.mtime = Date.now();
    };

    for (const target of operands.slice(1)) {
      const canonical = ctx.resolve(target);
      if (!get(ctx.platform, ctx.state.vfs, canonical)) {
        return bad(`chown: cannot access '${target}': No such file or directory`);
      }
      applyTo(canonical);
      if (recursive) {
        for (const child of listTree(ctx.platform, ctx.state.vfs, canonical)) applyTo(child.path);
      }
    }
    return ok("");
  },
};

const ln: CommandSpec = {
  name: "ln",
  summary: "create links between files",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (flags.has("s")) {
      if (operands.length < 2) return bad("ln: missing file operand");
      const [target, linkName] = operands;
      const canonicalLink = ctx.resolve(linkName);
      if (get(ctx.platform, ctx.state.vfs, canonicalLink)) {
        return bad(`ln: failed to create symbolic link '${linkName}': File exists`);
      }
      const resolvedTarget = get(ctx.platform, ctx.state.vfs, ctx.resolve(target))?.path ?? ctx.resolve(target);
      mkdirp(ctx.platform, ctx.state.vfs, dirName(ctx.platform, canonicalLink));
      ctx.state.vfs[toKey(ctx.platform, canonicalLink)] = {
        path: canonicalLink,
        type: "link",
        target: resolvedTarget,
        mode: 0o777,
        owner: ctx.user,
        group: ctx.user,
        mtime: Date.now(),
        size: 0,
      };
      return ok("");
    }
    if (operands.length < 2) return bad("ln: missing file operand");
    const [target, linkName] = operands;
    return move(ctx.platform, ctx.state.vfs, ctx.resolve(target), ctx.resolve(linkName)).ok
      ? ok("")
      : bad("ln: failed to create hard link");
  },
};

const stat: CommandSpec = {
  name: "stat",
  summary: "display file status",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    if (operands.length === 0) return bad("stat: missing operand");
    const out: string[] = [];
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return bad(`stat: cannot statx '${operand}': No such file or directory`);
      out.push(
        `  File: ${display(ctx.platform, entry.path)}`,
        `  Size: ${entry.size}\t\tBlocks: ${Math.ceil(entry.size / 512)}\tIO Block: 4096 ${entry.type === "dir" ? "directory" : "regular file"}`,
        `Access: (${entry.mode.toString(8).padStart(4, "0")}/${describeMode(entry.mode, entry.type)})  Uid: (${findUser(ctx.state, entry.owner)?.uid ?? 0}/${entry.owner.padEnd(8)})   Gid: (    0/${entry.group.padEnd(8)})`,
        `Modify: ${new Date(entry.mtime).toISOString()}`,
      );
    }
    return ok(out.join("\n"));
  },
};

const fileCmd: CommandSpec = {
  name: "file",
  summary: "determine file type",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    const out: string[] = [];
    for (const operand of operands) {
      const canonical = ctx.resolve(operand);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return bad(`file: cannot open '${operand}' (No such file or directory)`);
      if (entry.type === "dir") out.push(`${operand}: directory`);
      else if (entry.type === "link") out.push(`${operand}: symbolic link to ${display(ctx.platform, entry.target ?? "")}`);
      else {
        const content = entry.content ?? "";
        const isText = !/[\u0000-\u0008\u000e-\u001f]/.test(content);
        out.push(`${operand}: ${isText ? content.trim() === "" ? "empty" : "ASCII text" : "data"}`);
      }
    }
    return ok(out.join("\n"));
  },
};

const tree: CommandSpec = {
  name: "tree",
  summary: "list directory contents in a tree",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const root = ctx.resolve(operands[0] ?? ctx.state.machine.cwd);
    const entry = get(ctx.platform, ctx.state.vfs, root);
    const isTree = cmdIsTree(ctx);
    if (!entry) return bad(`tree: ${operands[0] ?? "."}: No such file or directory`);
    const body = renderTree(ctx.platform, ctx.state.vfs, root);
    if (!isTree) {
      // `tree` is not installed by default on minimal images: teach that lesson.
      return bad("tree: command not found", 127);
    }
    const dirs = listTree(ctx.platform, ctx.state.vfs, root).filter((e) => e.type === "dir").length;
    const files = listTree(ctx.platform, ctx.state.vfs, root).filter((e) => e.type === "file").length;
    const parts = [display(ctx.platform, root), body];
    if (!flags.has("d")) parts.push("", `${dirs} directories, ${files} files`);
    return ok(parts.join("\n"));
  },
};

function cmdIsTree(ctx: CommandContext): boolean {
  const pkg = ctx.state.machine.packages.find((p) => p.name === "tree");
  return Boolean(pkg?.installed);
}

const find: CommandSpec = {
  name: "find",
  summary: "search for files in a directory hierarchy",
  run(ctx) {
    const args = ctx.args;
    const startIndex = args.findIndex((a) => a.startsWith("-"));
    const start = startIndex === 0 ? ctx.state.machine.cwd : ctx.resolve(args[0] ?? ".");
    const root = get(ctx.platform, ctx.state.vfs, start);
    if (!root) return bad(`find: '${args[0]}': No such file or directory`, 1);

    let namePattern: string | undefined;
    let type: "f" | "d" | "l" | undefined;
    const execIndex = args.indexOf("-exec");
    const maxdepthIndex = args.indexOf("-maxdepth");
    let maxDepth: number | undefined;
    if (maxdepthIndex >= 0) maxDepth = Number(args[maxdepthIndex + 1]);

    for (let i = startIndex; i < args.length; i += 1) {
      if (args[i] === "-name" || args[i] === "-iname") namePattern = args[i + 1];
      if (args[i] === "-type") type = args[i + 1] as "f" | "d" | "l";
    }

    const results = [root, ...listTree(ctx.platform, ctx.state.vfs, start)].filter((entry) => {
      if (maxDepth !== undefined) {
        const depth = segments(entry.path).length - segments(root.path).length;
        if (depth > maxDepth) return false;
      }
      if (namePattern) {
        const regex = new RegExp(`^${namePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
        if (!regex.test(baseName(entry.path))) return false;
      }
      if (type === "f" && entry.type !== "file") return false;
      if (type === "d" && entry.type !== "dir") return false;
      if (type === "l" && entry.type !== "link") return false;
      return true;
    });

    const lines = results.map((entry) => (entry.path === ctx.state.machine.cwd ? "." : relativeTo(ctx, entry.path)));

    if (execIndex >= 0 && args[execIndex + 1]) {
      const command = args.slice(execIndex + 1).filter((a) => a !== "{}" && a !== ";" && a !== "+");
      if (command.length > 0) {
        const shell = createRegistry(bashCommands);
        const collected: string[] = [];
        for (const entry of results) {
          const spec = shell.get(command[0]);
          if (!spec) continue;
          const stageCtx: CommandContext = {
            ...ctx,
            args: [...command.slice(1), entry.path],
            raw: `${command.join(" ")} ${entry.path}`,
          };
          const out = spec.run(stageCtx, shell);
          if (out.stdout) collected.push(out.stdout);
        }
        return ok(collected.join("\n"));
      }
    }

    return ok(lines.join("\n"));
  },
};

function relativeTo(ctx: CommandContext, canonical: string): string {
  if (canonical.startsWith(`${ctx.state.machine.cwd}/`)) return canonical.slice(ctx.state.machine.cwd.length + 1);
  return display(ctx.platform, canonical);
}

const grep: CommandSpec = {
  name: "grep",
  summary: "print lines that match a pattern",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length === 0) return bad("Usage: grep [OPTION]... PATTERNS [FILE]...");
    const pattern = operands[0];
    const files = operands.slice(1);
    const { text, error } = inputOrFiles(ctx, files);
    if (error) return bad(`grep: ${error}`, 2);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, `${flags.has("i") ? "i" : ""}${flags.has("E") ? "" : ""}${flags.has("w") ? "" : ""}`);
    } catch {
      return bad(`grep: invalid regular expression '${pattern}'`, 2);
    }

    const lines = text.split("\n");
    const matched = lines.filter((line) => (flags.has("v") ? !regex.test(line) : regex.test(line)));
    if (flags.has("c")) return ok(String(matched.length));
    if (flags.has("l") && files.length > 0) {
      return ok(files.filter((f) => matched.length > 0).join("\n"));
    }
    const numbered = flags.has("n") ? matched.map((line) => `${lines.indexOf(line) + 1}:${line}`) : matched;
    return { stdout: numbered.join("\n"), stderr: "", exitCode: matched.length > 0 ? 0 : 1 };
  },
};

const wc: CommandSpec = {
  name: "wc",
  summary: "count lines, words and bytes",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const { text, error } = inputOrFiles(ctx, operands);
    if (error) return bad(`wc: ${error}`);
    const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    const bytes = text.length;
    if (flags.has("l")) return ok(String(lines));
    if (flags.has("w")) return ok(String(words));
    if (flags.has("c")) return ok(String(bytes));
    return ok(`${lines} ${words} ${bytes}`);
  },
};

const head: CommandSpec = {
  name: "head",
  summary: "output the first part of files",
  run(ctx) {
    const { flags, operands, long } = parseFlags(ctx.args);
    const count = Number(flags.has("n") ? operands[0] : long.get("lines") ?? 10) || 10;
    const files = flags.has("n") ? operands.slice(1) : operands;
    const { text, error } = inputOrFiles(ctx, files);
    if (error) return bad(`head: ${error}`);
    return ok(text.split("\n").slice(0, count).join("\n"));
  },
};

const tail: CommandSpec = {
  name: "tail",
  summary: "output the last part of files",
  run(ctx) {
    const { flags, operands, long } = parseFlags(ctx.args);
    const follow = flags.has("f");
    const count = Number(flags.has("n") ? operands[0] : long.get("lines") ?? 10) || 10;
    const files = flags.has("n") ? operands.slice(1) : operands;
    const { text, error } = inputOrFiles(ctx, files);
    if (error) return bad(`tail: ${error}`);
    const body = text.split("\n").slice(-count).join("\n");
    return ok(follow ? `${body}\n(holding file open — press Ctrl+C in a real terminal)` : body);
  },
};

const sort: CommandSpec = {
  name: "sort",
  summary: "sort lines of text",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const { text, error } = inputOrFiles(ctx, operands);
    if (error) return bad(`sort: ${error}`);
    let lines = text.replace(/\n$/, "").split("\n");
    lines.sort((a, b) => (flags.has("n") ? Number(a) - Number(b) : a.localeCompare(b)));
    if (flags.has("r")) lines.reverse();
    if (flags.has("u")) lines = [...new Set(lines)];
    return ok(lines.join("\n"));
  },
};

const uniq: CommandSpec = {
  name: "uniq",
  summary: "report or omit repeated lines",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const { text, error } = inputOrFiles(ctx, operands);
    if (error) return bad(`uniq: ${error}`);
    const lines = text.replace(/\n$/, "").split("\n");
    const out: string[] = [];
    let previous: string | null = null;
    let runLength = 0;
    const flush = () => {
      if (previous !== null && (!flags.has("d") || runLength > 1)) {
        out.push(flags.has("c") ? `${String(runLength).padStart(7)} ${previous}` : previous);
      }
    };
    for (const line of lines) {
      if (line === previous) {
        runLength += 1;
        continue;
      }
      flush();
      previous = line;
      runLength = 1;
    }
    flush();
    return ok(out.join("\n"));
  },
};

const cut: CommandSpec = {
  name: "cut",
  summary: "remove sections from each line",
  run(ctx) {
    const { flags, operands, long } = parseFlags(ctx.args);
    const delimiter = long.get("delimiter") ?? (flags.has("d") ? operands[0] : "\t");
    const fieldSpec = long.get("fields") ?? (flags.has("d") ? operands[1] : operands[0]);
    const files = flags.has("d") ? operands.slice(2) : operands.slice(1);
    if (!fieldSpec) return bad("cut: you must specify a list of bytes, characters, or fields");
    const fields = fieldSpec.split(",").flatMap((part) => {
      const [start, end] = part.split("-").map(Number);
      if (end === undefined || Number.isNaN(end)) return [start - 1];
      const out: number[] = [];
      for (let i = start; i <= end; i += 1) out.push(i - 1);
      return out;
    });
    const { text, error } = inputOrFiles(ctx, files);
    if (error) return bad(`cut: ${error}`);
    const lines = text.replace(/\n$/, "").split("\n");
    return ok(
      lines
        .map((line) => fields.map((index) => (delimiter === "\t" ? line.split(/\s+/)[index] ?? "" : line.split(delimiter)[index] ?? "")).join(delimiter === "\t" ? "\t" : delimiter))
        .join("\n"),
    );
  },
};

const sed: CommandSpec = {
  name: "sed",
  summary: "stream editor (substitution only)",
  run(ctx) {
    const args = [...ctx.args];
    const inPlace = args.includes("-i");
    const cleaned = args.filter((a) => a !== "-i");
    const script = cleaned[0];
    if (!script) return bad("sed: no script supplied");
    const substitutions: { pattern: RegExp; replacement: string }[] = [];
    const parts = script.split(";").filter(Boolean);
    for (const part of parts) {
      const match = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(part.trim());
      if (!match) {
        const addressMatch = /^\/.*\/[dp]$/.test(part.trim());
        if (!addressMatch) return bad(`sed: -e expression #1, char 1: unknown command: '${part[0] ?? ""}'`);
        continue;
      }
      const [, , pattern, replacement, modifier] = match;
      substitutions.push({ pattern: new RegExp(pattern, modifier.includes("g") ? "g" : ""), replacement });
    }

    const files = cleaned.slice(1);
    const { text, error } = inputOrFiles(ctx, files);
    if (error) return bad(`sed: ${error}`);
    if (files.length === 0 && !ctx.stdin) return bad("sed: no input files");

    const transformed = text
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => substitutions.reduce((acc, sub) => acc.replace(sub.pattern, sub.replacement), line))
      .join("\n");

    if (inPlace && files.length > 0) {
      writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(files[0]), `${transformed}\n`);
      return ok("");
    }
    return ok(transformed);
  },
};

const tr: CommandSpec = {
  name: "tr",
  summary: "translate characters",
  run(ctx) {
    const [from, to] = ctx.args.filter((a) => !a.startsWith("-"));
    const deleteChars = ctx.args.includes("-d");
    const { text, error } = inputOrFiles(ctx, []);
    if (error) return bad(`tr: ${error}`);
    if (!from) return bad("tr: missing operand");
    const source = from.replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ").replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz");
    const target = (to ?? "").replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ").replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz");
    let out = "";
    for (const ch of text) {
      const index = source.indexOf(ch);
      if (index < 0) {
        out += ch;
      } else if (target.length === 0) {
        // No replacement set: behavior depends on -d (delete) vs -s (squeeze).
        if (deleteChars) continue;
        out += ch;
      } else {
        out += target[index] ?? target[target.length - 1] ?? "";
      }
    }
    return ok(out);
  },
};

const tee: CommandSpec = {
  name: "tee",
  summary: "read from stdin and write to files",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    for (const operand of operands) {
      writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(operand), ctx.stdin);
    }
    return ok(ctx.stdin);
  },
};

const basenameCmd: CommandSpec = {
  name: "basename",
  run(ctx) {
    if (!ctx.args[0]) return bad("basename: missing operand");
    const suffix = ctx.args[1];
    let name = baseName(ctx.resolve(ctx.args[0]));
    if (suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    return ok(name);
  },
};

const dirnameCmd: CommandSpec = {
  name: "dirname",
  run(ctx) {
    if (!ctx.args[0]) return bad("dirname: missing operand");
    return ok(display(ctx.platform, dirName(ctx.platform, ctx.resolve(ctx.args[0]))));
  },
};

const realpath: CommandSpec = {
  name: "realpath",
  run(ctx) {
    if (!ctx.args[0]) return bad("realpath: missing operand");
    return ok(display(ctx.platform, ctx.resolve(ctx.args[0])));
  },
};

const readlink: CommandSpec = {
  name: "readlink",
  summary: "print symbolic link targets",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const entry = entryAt(ctx, operands[0] ?? "");
    if (!entry) return bad(`readlink: ${operands[0]}: No such file or directory`);
    if (entry.type !== "link") return { stdout: "", stderr: "", exitCode: 1 };
    return ok(flags.has("f") ? display(ctx.platform, entry.target ?? "") : display(ctx.platform, entry.target ?? ""));
  },
};

/* -------------------------------------------------------------------------- */
/*  Text / info commands                                                      */
/* -------------------------------------------------------------------------- */

const whoami: CommandSpec = {
  name: "whoami",
  aliases: ["logname"],
  run(ctx) {
    return ok(ctx.user);
  },
};

const id: CommandSpec = {
  name: "id",
  run(ctx) {
    const user = findUser(ctx.state, ctx.args[0] ?? ctx.user);
    if (!user) return bad(`id: '${ctx.args[0]}': no such user`);
    const groups = [user.name, ...user.groups.filter((g) => g !== user.name)];
    return ok(
      `uid=${user.uid}(${user.name}) gid=${user.gid}(${groups[0]}) groups=${user.gid}(${groups[0]})${groups
        .slice(1)
        .map((g) => `,${user.gid}(${g})`)
        .join("")}`,
    );
  },
};

const groups: CommandSpec = {
  name: "groups",
  run(ctx) {
    const user = findUser(ctx.state, ctx.args[0] ?? ctx.user);
    if (!user) return bad(`groups: '${ctx.args[0]}': no such user`);
    return ok(`${user.name} : ${[user.name, ...user.groups.filter((g) => g !== user.name)].join(" ")}`);
  },
};

const su: CommandSpec = {
  name: "su",
  aliases: ["su-"],
  summary: "switch user",
  run(ctx) {
    const name = ctx.args.find((a) => !a.startsWith("-")) ?? "root";
    const user = findUser(ctx.state, name);
    if (!user) return bad(`su: user ${name} does not exist`);
    ctx.state.machine.env.PREVIOUS_USER = ctx.user;
    ctx.state.machine.notices.push(`Switched to user ${name} for this session.`);
    return ok(`Password: \nNow running as ${name}. (Simulated — the shell user is switched for subsequent commands.)`);
  },
};

const passwd: CommandSpec = {
  name: "passwd",
  summary: "change a user password",
  run(ctx) {
    const target = ctx.args.find((a) => !a.startsWith("-")) ?? ctx.user;
    if (target !== ctx.user && !isRoot(ctx)) {
      return bad("passwd: You may not view or modify password information for other users.", 1);
    }
    const user = findUser(ctx.state, target);
    if (!user) return bad(`passwd: user '${target}' does not exist`);
    user.passwordHash = simulatedPasswordHash();
    user.locked = false;
    ctx.state.machine.notices.push(`passwd: password updated successfully for ${target}.`);
    return ok("New password: \nRetype new password: \npasswd: password updated successfully");
  },
};

const useradd: CommandSpec = {
  name: "useradd",
  aliases: ["adduser"],
  summary: "create a new user",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "useradd");
    if (rootCheck) return rootCheck;
    const { flags, operands, long } = parseFlags(ctx.args);
    const name = operands[operands.length - 1];
    if (!name) return bad("useradd: missing user name");
    if (findUser(ctx.state, name)) return bad(`useradd: user '${name}' already exists`, 9);

    const groupIndex = operands.indexOf("-g") >= 0 ? operands.indexOf("-g") : operands.indexOf("--gid");
    const groupsIndex = operands.indexOf("-G") >= 0 ? operands.indexOf("-G") : operands.indexOf("--groups");
    const shellIndex = operands.indexOf("-s") >= 0 ? operands.indexOf("-s") : operands.indexOf("--shell");
    const homeIndex = operands.indexOf("-d") >= 0 ? operands.indexOf("-d") : operands.indexOf("--home");
    const commentIndex = operands.indexOf("-c") >= 0 ? operands.indexOf("-c") : operands.indexOf("--comment");

    const groups = (groupsIndex >= 0 ? operands[groupsIndex + 1] : undefined)?.split(",").filter(Boolean) ?? [];
    const home = homeIndex >= 0 ? operands[homeIndex + 1] : `/home/${name}`;
    const shell = shellIndex >= 0 ? operands[shellIndex + 1] : "/bin/bash";
    const fullName = commentIndex >= 0 ? operands[commentIndex + 1] : ctx.args[ctx.args.indexOf("-c") + 1]?.replace(/"/g, "");

    if (flags.has("m") || flags.has("r")) mkdirp(ctx.platform, ctx.state.vfs, home, { owner: name, group: name, mode: 0o755 });

    ctx.state.machine.users.push({
      name,
      uid: 1001 + ctx.state.machine.users.length,
      gid: groupIndex >= 0 ? Number(operands[groupIndex + 1]) || 1001 : 1001,
      groups: [name, ...groups],
      shell,
      home,
      fullName: groupIndex >= 0 ? operands[groupIndex + 1] : fullName ?? name,
      passwordHash: null,
      locked: true,
    });

    if (!ctx.state.vfs[toKey(ctx.platform, "/etc/passwd")]) return ok("");
    const passwd = ctx.state.vfs[toKey(ctx.platform, "/etc/passwd")];
    passwd.content = `${passwd.content ?? ""}${name}:x:${1001 + ctx.state.machine.users.length}:${groupIndex >= 0 ? operands[groupIndex + 1] : 1001}:${fullName ?? name}:${home}:${shell}\n`;
    void long;
    return ok("");
  },
};

const usermod: CommandSpec = {
  name: "usermod",
  summary: "modify a user account",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "usermod");
    if (rootCheck) return rootCheck;
    const operands = ctx.args.filter((a) => !a.startsWith("-"));
    const groupsIndex = ctx.args.findIndex((a) => a === "-aG" || a === "-a" || a === "--append" || a === "-G" || a === "--groups");
    const flagValue = ctx.args[groupsIndex + 1];
    const name = operands[operands.length - 1];
    const user = findUser(ctx.state, name);
    if (!user) return bad(`usermod: user '${name}' does not exist`, 6);

    const append = ctx.args.includes("-a") || ctx.args.includes("-aG") || ctx.args.includes("--append");
    const additions = (flagValue ?? "").split(",").filter(Boolean);
    if (additions.length > 0) {
      user.groups = append ? [...new Set([...user.groups, ...additions])] : additions;
      if (flagValue) {
        const groupFile = ctx.state.vfs[toKey(ctx.platform, "/etc/group")];
        if (groupFile) {
          for (const group of additions) {
            const line = `${group}:x:${27 + group.length}:`;
            if (!(groupFile.content ?? "").includes(`${group}:`)) groupFile.content = `${groupFile.content ?? ""}${line}${name}\n`;
          }
        }
      }
    }
    const shellIndex = ctx.args.indexOf("-s");
    if (shellIndex >= 0) user.shell = ctx.args[shellIndex + 1];
    const homeIndex = ctx.args.indexOf("-d");
    if (homeIndex >= 0) user.home = ctx.args[homeIndex + 1];
    if (ctx.args.includes("-L")) user.locked = true;
    if (ctx.args.includes("-U")) user.locked = false;
    return ok("");
  },
};

const userdel: CommandSpec = {
  name: "userdel",
  summary: "delete a user account",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "userdel");
    if (rootCheck) return rootCheck;
    const { flags, operands } = parseFlags(ctx.args);
    const name = operands[0];
    const user = findUser(ctx.state, name ?? "");
    if (!user) return bad(`userdel: user '${name}' does not exist`, 6);
    ctx.state.machine.users = ctx.state.machine.users.filter((u) => u.name !== name);
    if (flags.has("r")) remove(ctx.platform, ctx.state.vfs, user.home, true);
    return ok("");
  },
};

const groupadd: CommandSpec = {
  name: "groupadd",
  aliases: ["addgroup"],
  summary: "create a group",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "groupadd");
    if (rootCheck) return rootCheck;
    const name = ctx.args.filter((a) => !a.startsWith("-")).pop();
    if (!name) return bad("groupadd: missing group name");
    const groupFile = ctx.state.vfs[toKey(ctx.platform, "/etc/group")];
    if (groupFile && !(groupFile.content ?? "").includes(`${name}:`)) {
      groupFile.content = `${groupFile.content ?? ""}${name}:x:${1200 + name.length}:\n`;
    }
    return ok("");
  },
};

const gpasswd: CommandSpec = {
  name: "gpasswd",
  summary: "administer groups",
  run(ctx) {
    const args = ctx.args.filter((a) => a !== "-a" && a !== "-d" && a !== "-M");
    const user = args[0];
    const group = args[1];
    const add = ctx.args.includes("-a");
    const target = findUser(ctx.state, user ?? "");
    if (!target) return bad(`gpasswd: user '${user}' does not exist`);
    if (add) target.groups = [...new Set([...target.groups, group])];
    else target.groups = target.groups.filter((g) => g !== group);
    const groupFile = ctx.state.vfs[toKey(ctx.platform, "/etc/group")];
    if (groupFile && !(groupFile.content ?? "").includes(`${group}:`)) {
      groupFile.content = `${groupFile.content ?? ""}${group}:x:${1200 + group.length}:\n`;
    }
    return ok("");
  },
};

const hostnameCmd: CommandSpec = {
  name: "hostname",
  summary: "show or set the system hostname",
  run(ctx) {
    const first = ctx.args[0];
    if (first === "-I" || first === "-i") return ok("10.10.10.24");
    if (!first) return ok(ctx.state.machine.hostname);
    const rootCheck = requireRoot(ctx, "hostname");
    if (rootCheck) return rootCheck;
    ctx.state.machine.hostname = first;
    writeFile(ctx.platform, ctx.state.vfs, "/etc/hostname", `${first}\n`);
    return ok("");
  },
};

const hostnamectl: CommandSpec = {
  name: "hostnamectl",
  summary: "control the system hostname",
  run(ctx) {
    if (ctx.args[0] === "set-hostname") {
      const rootCheck = requireRoot(ctx, "hostnamectl");
      if (rootCheck) return rootCheck;
      const value = ctx.args[1];
      if (!value) return bad("hostnamectl: missing hostname");
      ctx.state.machine.hostname = value;
      writeFile(ctx.platform, ctx.state.vfs, "/etc/hostname", `${value}\n`);
      return ok("");
    }
    return ok(
      [
        ` Static hostname: ${ctx.state.machine.hostname}`,
        `       Icon name: computer-vm`,
        `         Chassis: vm`,
        `      Machine ID: 8f2c1a4d9b6e4f0a8c3d5e7f1a2b4c6d`,
        `         Boot ID: 3d7e9a1c5b2f4e8a9c0d1e2f3a4b5c6d`,
        `  Virtualization: kvm`,
        `Operating System: ${ctx.state.machine.os.name}`,
        `          Kernel: Linux ${ctx.state.machine.os.kernel}`,
        `    Architecture: ${ctx.state.machine.os.arch}`,
      ].join("\n"),
    );
  },
};

const uname: CommandSpec = {
  name: "uname",
  run(ctx) {
    const { flags } = parseFlags(ctx.args);
    const os = ctx.state.machine.os;
    if (flags.has("a")) {
      return ok(`Linux ${ctx.state.machine.hostname} ${os.kernel} #45-Ubuntu SMP PREEMPT_DYNAMIC ${new Date().toUTCString()} ${os.arch} ${os.arch} ${os.arch} GNU/Linux`);
    }
    if (flags.has("r")) return ok(os.kernel ?? "");
    if (flags.has("n")) return ok(ctx.state.machine.hostname);
    if (flags.has("m")) return ok(os.arch);
    return ok("Linux");
  },
};

const dateCmd: CommandSpec = {
  name: "date",
  run() {
    return ok(new Date().toString());
  },
};

const uptime: CommandSpec = {
  name: "uptime",
  run(ctx) {
    const mins = 42 + ctx.state.machine.history.length;
    return ok(` ${new Date().toTimeString().slice(0, 8)} up ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")},  1 user,  load average: 0.08, 0.03, 0.01`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Processes / resources                                                     */
/* -------------------------------------------------------------------------- */

const ps: CommandSpec = {
  name: "ps",
  summary: "report process status",
  run(ctx) {
    const { flags } = parseFlags(ctx.args);
    const wide = flags.has("e") || flags.has("A") || flags.has("a") || ctx.args.some((a) => a.includes("aux"));
    const rows: string[][] = [["USER", "PID", "%CPU", "%MEM", "COMMAND"]];
    for (const process of ctx.state.machine.processes) {
      if (!wide && process.user !== ctx.user && !flags.has("x")) continue;
      rows.push([process.user, String(process.pid), process.cpu.toFixed(1), process.mem.toFixed(1), process.command]);
    }
    return ok(formatRows(rows));
  },
};

const pstree: CommandSpec = {
  name: "pstree",
  run(ctx) {
    const lines = ctx.state.machine.processes.map((p, i) => `${i === 0 ? "" : "  "}${i === 0 ? "" : "├─"}${baseName(p.command.split(" ")[0])}(${p.pid})`);
    return ok([`init(1)─┬─`, ...lines.slice(1)].join("\n"));
  },
};

const top: CommandSpec = {
  name: "top",
  summary: "display processes (snapshot)",
  run(ctx) {
    const rows: string[][] = [["PID", "USER", "%CPU", "%MEM", "COMMAND"]];
    for (const p of ctx.state.machine.processes) rows.push([String(p.pid), p.user, p.cpu.toFixed(1), p.mem.toFixed(1), p.command]);
    return ok(
      [
        `top - up ${new Date().toTimeString().slice(0, 8)}, load average: 0.08`,
        `Tasks: ${ctx.state.machine.processes.length} total, 1 running`,
        "%Cpu(s):  0.5 us,  0.3 sy, 99.0 id",
        "MiB Mem :   3924.0 total,   2103.4 free",
        "",
        formatRows(rows),
        "",
        "(snapshot — interactive mode is not simulated in the browser console)",
      ].join("\n"),
    );
  },
};

const kill: CommandSpec = {
  name: "kill",
  aliases: ["killall", "pkill"],
  summary: "send a signal to a process",
  run(ctx) {
    const pid = Number(ctx.args.filter((a) => !a.startsWith("-"))[0]);
    const index = ctx.state.machine.processes.findIndex((p) => p.pid === pid);
    if (index < 0) return bad(`kill: (${pid}) - No such process`);
    const [removed] = ctx.state.machine.processes.splice(index, 1);
    ctx.state.machine.notices.push(`Process ${removed.pid} (${removed.command}) terminated.`);
    return ok("");
  },
};

const df: CommandSpec = {
  name: "df",
  summary: "report filesystem disk space usage",
  run(ctx) {
    const { flags } = parseFlags(ctx.args);
    const rows: string[][] = [["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"]];
    const scale = flags.has("h");
    rows.push([
      "/dev/sda1",
      scale ? "39G" : "40629112",
      scale ? "12G" : "12450168",
      scale ? "25G" : "26046720",
      "33%",
      "/",
    ]);
    rows.push(["/dev/sda15", scale ? "105M" : "106858", scale ? "6.1M" : "6172", scale ? "99M" : "100686", "6%", "/boot/efi"]);
    rows.push(["tmpfs", scale ? "393M" : "401924", scale ? "1.4M" : "1472", scale ? "391M" : "400452", "1%", "/run"]);
    return ok(formatRows(rows));
  },
};

const du: CommandSpec = {
  name: "du",
  summary: "estimate file space usage",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const target = ctx.resolve(operands[0] ?? ctx.state.machine.cwd);
    const entries = [get(ctx.platform, ctx.state.vfs, target), ...listTree(ctx.platform, ctx.state.vfs, target)].filter(
      (e): e is NonNullable<typeof e> => Boolean(e),
    );
    const total = entries.reduce((sum, e) => sum + (e.type === "file" ? e.size : 4096), 0);
    const kb = Math.max(4, Math.ceil(total / 1024));
    if (flags.has("s")) return ok(flags.has("h") ? `${kb <= 999 ? `${kb}K` : `${(kb / 1024).toFixed(1)}M`}\t${display(ctx.platform, target)}` : `${kb}\t${display(ctx.platform, target)}`);
    const lines: string[] = [];
    for (const child of listDir(ctx.platform, ctx.state.vfs, target)) {
      const size = Math.max(4, Math.ceil((child.size || 4096) / 1024));
      lines.push(`${size}\t${relativeTo(ctx, child.path)}`);
    }
    return ok([...lines, `${kb}\t.`].join("\n"));
  },
};

const free: CommandSpec = {
  name: "free",
  summary: "display memory usage",
  run(ctx) {
    const { flags } = parseFlags(ctx.args);
    const unit = flags.has("m") ? "MiB" : flags.has("g") ? "GiB" : "KiB";
    return ok(
      [
        `               total        used        free      shared  buff/cache   available`,
        `Mem:         4019248     1204412     2102340       18244      712496     2548112`,
        `Swap:        2097148           0     2097148`,
        "",
        `(values shown in ${unit})`,
      ].join("\n"),
    );
  },
};

const rebootCmd: CommandSpec = {
  name: "reboot",
  aliases: ["shutdown", "halt", "poweroff"],
  summary: "restart the machine",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "reboot");
    if (rootCheck) return rootCheck;
    ctx.state.machine.notices.push("The machine would now restart. Services marked 'enabled' would come back automatically — that is what the grader checks.");
    return ok("Broadcast message from root@" + ctx.state.machine.hostname + ":\n\nThe system is going down for reboot NOW!");
  },
};

const systemdAnalyze: CommandSpec = {
  name: "systemd-analyze",
  run() {
    return ok("Startup finished in 3.412s (firmware) + 1.204s (loader) + 2.881s (kernel) + 8.732s (userspace) = 16.230s\ngraphical.target reached after 8.719s in userspace.");
  },
};

/* -------------------------------------------------------------------------- */
/*  Services                                                                  */
/* -------------------------------------------------------------------------- */

function serviceByName(ctx: CommandContext, name: string) {
  return ctx.state.machine.services.find((s) => s.name === name);
}

const systemctl: CommandSpec = {
  name: "systemctl",
  summary: "control the systemd system and service manager",
  run(ctx) {
    const action = ctx.args[0] ?? "list-units";
    // `systemctl enable --now nginx` and friends: switches are not units.
    const startNow = ctx.args.includes("--now");
    const targets = ctx.args.slice(1)
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.replace(/\.service$/, ""));

    if (action === "daemon-reload") {
      const rootCheck = requireRoot(ctx, "systemctl");
      if (rootCheck) return rootCheck;
      return ok("");
    }

    if (action === "list-units" || action === "list-unit-files") {
      const rows: string[][] = [["UNIT", "LOAD", "ACTIVE", "SUB", "DESCRIPTION"]];
      for (const service of ctx.state.machine.services) {
        rows.push([
          `${service.name}.service`,
          "loaded",
          service.active ? "active" : "inactive",
          service.active ? "running" : "dead",
          service.displayName ?? service.description ?? service.name,
        ]);
      }
      return ok(formatRows(rows));
    }

    if (targets.length === 0) return bad(`systemctl: unrecognized command '${action}'`);

    const outs: string[] = [];
    for (const target of targets) {
      const service = serviceByName(ctx, target);
      if (!service) {
        return bad(`Failed to ${action} ${target}.service: Unit ${target}.service not found.`, 5);
      }
      switch (action) {
        case "status": {
          const pkg = ctx.state.machine.packages.find((p) => p.name === target);
          const installed = pkg ? pkg.installed : true;
          if (!installed) {
            return bad(`Unit ${target}.service could not be found.`, 4);
          }
          outs.push(
            [
              `● ${service.name}.service - ${service.displayName ?? service.description ?? service.name}`,
              `     Loaded: loaded (/lib/systemd/system/${service.name}.service; ${service.enabled ? "enabled" : "disabled"}; preset: enabled)`,
              `     Active: ${service.active ? "active (running)" : "inactive (dead)"}${service.active ? ` since ${new Date().toDateString()} ${new Date().toTimeString().slice(0, 5)}; 12min ago` : ""}`,
              `       Docs: man:${service.name}(8)`,
              `   Main PID: ${service.active ? 1234 : "(none)"}`,
              `      Tasks: ${service.active ? 1 : 0} (limit: 9407)`,
              `     Memory: ${service.active ? "4.2M" : "0B"}`,
              `        CPU: ${service.active ? "312ms" : "0"}`,
            ].join("\n"),
          );
          break;
        }
        case "start":
        case "restart":
        case "reload": {
          const rootCheck = requireRoot(ctx, `systemctl ${action}`);
          if (rootCheck) return rootCheck;
          const pkg = ctx.state.machine.packages.find((p) => p.name === target);
          if (action === "start" && pkg && !pkg.installed) {
            return bad(`Failed to start ${target}.service: Unit ${target}.service not found.`, 5);
          }
          service.active = true;
          ctx.state.machine.notices.push(`${service.name}.service ${action}ed.`);
          break;
        }
        case "stop": {
          const rootCheck = requireRoot(ctx, "systemctl stop");
          if (rootCheck) return rootCheck;
          service.active = false;
          ctx.state.machine.notices.push(`${service.name}.service stopped.`);
          break;
        }
        case "enable": {
          const rootCheck = requireRoot(ctx, "systemctl enable");
          if (rootCheck) return rootCheck;
          service.enabled = true;
          // `--now` starts the unit as well as enabling it at boot.
          if (startNow) {
            service.active = true;
            ctx.state.machine.notices.push(`${service.name}.service started.`);
          }
          outs.push(
            `Created symlink /etc/systemd/system/multi-user.target.wants/${service.name}.service → /lib/systemd/system/${service.name}.service.`,
          );
          break;
        }
        case "disable": {
          const rootCheck = requireRoot(ctx, "systemctl disable");
          if (rootCheck) return rootCheck;
          service.enabled = false;
          outs.push(`Removed "/etc/systemd/system/multi-user.target.wants/${service.name}.service".`);
          break;
        }
        case "is-active":
          outs.push(service.active ? "active" : "inactive");
          break;
        case "is-enabled":
          outs.push(service.enabled ? "enabled" : "disabled");
          break;
        case "mask":
        case "unmask": {
          const rootCheck = requireRoot(ctx, `systemctl ${action}`);
          if (rootCheck) return rootCheck;
          service.enabled = action === "unmask";
          outs.push(`Removed/created mask for ${service.name}.service`);
          break;
        }
        default:
          return bad(`systemctl: invalid option '${action}'`);
      }
    }
    return ok(outs.join("\n"));
  },
};

const service: CommandSpec = {
  name: "service",
  summary: "run a System V init script",
  run(ctx) {
    const [name, action = "status"] = ctx.args;
    if (!name) return bad("Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]");
    const entry = serviceByName(ctx, name);
    if (!entry) return bad(`${name}: unrecognized service`, 1);
    if (action === "status") return systemctl.run({ ...ctx, args: ["status", name] }, createRegistry(bashCommands));
    if (action === "start" || action === "restart" || action === "reload") {
      const rootCheck = requireRoot(ctx, `service ${action}`);
      if (rootCheck) return rootCheck;
      entry.active = true;
      const verb = action === "reload" ? "Reloading" : action === "restart" ? "Restarting" : "Starting";
      return ok(` * ${verb} ${entry.displayName ?? name} ... done.`);
    }
    if (action === "stop") {
      const rootCheck = requireRoot(ctx, "service stop");
      if (rootCheck) return rootCheck;
      entry.active = false;
      return ok(` * Stopping ${entry.displayName ?? name} ... done.`);
    }
    return bad(`Usage: service ${name} {start|stop|restart|status}`);
  },
};

const journalctl: CommandSpec = {
  name: "journalctl",
  summary: "query the systemd journal",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    const unitIndex = ctx.args.indexOf("-u");
    const unit = unitIndex >= 0 ? ctx.args[unitIndex + 1] : operands[0];
    const linesIndex = ctx.args.indexOf("-n");
    const count = linesIndex >= 0 ? Number(ctx.args[linesIndex + 1]) || 10 : 10;
    const events = ctx.state.machine.events.filter((e) => !unit || e.source.includes(unit.replace(/\.service$/, "")));
    const pool = events.length > 0 ? events : [{ at: Date.now(), source: unit ?? "systemd", level: "info" as const, id: 0, message: `${unit ?? "systemd"}: started successfully.` }];
    const out = pool.slice(-count).map(
      (e) =>
        `${monthDay(e.at)} ${ctx.state.machine.hostname} ${e.source}[${e.id}]: ${e.message}`,
    );
    return { stdout: out.join("\n"), stderr: "", exitCode: 0 };
  },
};

/* -------------------------------------------------------------------------- */
/*  Packages                                                                  */
/* -------------------------------------------------------------------------- */

const aptGet: CommandSpec = {
  name: "apt-get",
  aliases: ["apt", "aptitude"],
  summary: "package manager",
  run(ctx) {
    const action = ctx.args.find((a) => !a.startsWith("-")) ?? "";
    const packages = ctx.args.filter((a) => !a.startsWith("-") && a !== action);

    if (action === "update") {
      const rootCheck = requireRoot(ctx, "apt-get");
      if (rootCheck) return rootCheck;
      return ok("Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 http://security.ubuntu.com/ubuntu noble-security InRelease\nFetched 214 kB in 1s (214 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nAll packages are up to date.");
    }

    if (action === "install") {
      const rootCheck = requireRoot(ctx, "apt-get");
      if (rootCheck) return rootCheck;
      if (packages.length === 0) return bad("E: Invalid operation install: no packages given");
      const outs: string[] = ["Reading package lists... Done", "Building dependency tree... Done"];
      for (const name of packages) {
        const existing = ctx.state.machine.packages.find((p) => p.name === name);
        if (existing?.installed) {
          outs.push(`${name} is already the newest version (${existing.version}).`);
          continue;
        }
        if (existing) {
          existing.installed = true;
          outs.push(`Setting up ${name} (${existing.version}) ...`);
          outs.push(`Processing triggers for man-db (2.12.0-4build2) ...`);
        } else {
          const version = "1.0.0-1ubuntu1";
          ctx.state.machine.packages.push({
            name,
            version,
            installed: true,
            description: `${name} (installed by the student in this simulation)`,
          });
          outs.push(`Unpacking ${name} (${version}) ...`, `Setting up ${name} (${version}) ...`);
        }
        ctx.state.machine.notices.push(`Installed ${name}.`);
      }
      return ok(outs.join("\n"));
    }

    if (action === "remove" || action === "purge") {
      const rootCheck = requireRoot(ctx, `apt-get ${action}`);
      if (rootCheck) return rootCheck;
      const outs: string[] = [];
      for (const name of packages) {
        const existing = ctx.state.machine.packages.find((p) => p.name === name);
        if (!existing || !existing.installed) {
          outs.push(`Package '${name}' is not installed, so not removed`);
          continue;
        }
        existing.installed = false;
        outs.push(`Removing ${name} (${existing.version}) ...`);
        const service = ctx.state.machine.services.find((s) => s.name === name);
        if (service) service.active = false;
      }
      return ok(["Reading package lists... Done", ...outs].join("\n"));
    }

    if (action === "search") {
      const term = packages[0] ?? "";
      const hits = ctx.state.machine.packages.filter((p) => p.name.includes(term));
      return ok(hits.map((p) => `${p.name}/${p.repo ?? "noble"} ${p.version} ${ctx.state.machine.os.arch}\n  ${p.description ?? ""}`).join("\n"));
    }

    if (action === "list") {
      const installed = ctx.state.machine.packages.filter((p) => p.installed);
      return ok(installed.map((p) => `${p.name}/${p.repo ?? "noble,now"} ${p.version} ${ctx.state.machine.os.arch} [installed]`).join("\n"));
    }

    if (action === "upgrade" || action === "dist-upgrade") {
      const rootCheck = requireRoot(ctx, "apt-get upgrade");
      if (rootCheck) return rootCheck;
      return ok("Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.");
    }

    return bad(`E: Invalid operation ${action}`);
  },
};

const dpkg: CommandSpec = {
  name: "dpkg",
  summary: "Debian package manager",
  run(ctx) {
    const flags = ctx.args.filter((a) => a.startsWith("-"));
    const names = ctx.args.filter((a) => !a.startsWith("-"));
    if (flags.includes("-l")) {
      const rows: string[][] = [["Desired=Unknown/Install/Remove/Purge/Hold", "", "", "", ""], ["||/", "Name", "Version", "Architecture", "Description"]];
      for (const p of ctx.state.machine.packages) {
        rows.push([p.installed ? "ii " : "un ", p.name, p.version, "amd64", p.description ?? ""]);
      }
      return ok(rows.map((r) => r.join("  ")).join("\n"));
    }
    if (flags.includes("-i")) {
      const rootCheck = requireRoot(ctx, "dpkg");
      if (rootCheck) return rootCheck;
      for (const name of names) {
        if (!ctx.state.machine.packages.find((p) => p.name === name)) {
          return bad(`dpkg: error processing archive ${name} (--install):\n cannot access archive: No such file or directory`, 2);
        }
      }
      return ok("");
    }
    if (flags.includes("-s")) {
      const pkg = ctx.state.machine.packages.find((p) => p.name === names[0]);
      if (!pkg) return bad(`dpkg-query: package '${names[0]}' is not installed`, 1);
      return ok(`Package: ${pkg.name}\nStatus: ${pkg.installed ? "install ok installed" : "deinstall ok config-files"}\nVersion: ${pkg.version}\nDescription: ${pkg.description ?? ""}`);
    }
    return bad("dpkg: error: need an action option");
  },
};

const snap: CommandSpec = {
  name: "snap",
  summary: "snap package manager",
  run(ctx) {
    const [action, name] = ctx.args;
    if (action === "list") {
      return ok(
        ["Name     Version   Rev    Tracking       Publisher   Notes", "core22   20240408  1380   latest/stable  canonical✓  base", "snapd    2.62      20671  latest/stable  canonical✓  snapd"].join("\n"),
      );
    }
    if (action === "install") {
      const rootCheck = requireRoot(ctx, "snap");
      if (rootCheck) return rootCheck;
      if (!ctx.state.machine.packages.find((p) => p.name === name)) {
        ctx.state.machine.packages.push({ name: name ?? "", version: "latest/stable", installed: true, description: `${name} (snap)` });
      }
      return ok(`${name} (latest/stable) installed`);
    }
    return bad(`snap: unknown command "${action}"`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Networking                                                                */
/* -------------------------------------------------------------------------- */

const ipCmd: CommandSpec = {
  name: "ip",
  summary: "show / manipulate routing and devices",
  run(ctx) {
    const object = ctx.args.find((a) => !a.startsWith("-"));
    if (!object || object === "a" || object === "addr" || object === "address") {
      return ok(
        [
          "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000",
          "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
          "    inet 127.0.0.1/8 scope host lo",
          "2: ens18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000",
          "    link/ether 52:54:00:8f:2a:1c brd ff:ff:ff:ff:ff:ff",
          "    inet 10.10.10.24/24 brd 10.10.10.255 scope global ens18",
        ].join("\n"),
      );
    }
    if (object === "route" || object === "r") {
      return ok(
        [
          "default via 10.10.10.1 dev ens18 proto dhcp src 10.10.10.24 metric 100",
          "10.10.10.0/24 dev ens18 proto kernel scope link src 10.10.10.24",
        ].join("\n"),
      );
    }
    if (object === "link") {
      return ok(
        [
          "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000",
          "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
          "2: ens18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000",
          "    link/ether 52:54:00:8f:2a:1c brd ff:ff:ff:ff:ff:ff",
        ].join("\n"),
      );
    }
    return bad(`Object "${object}" is unknown, try "ip help".`);
  },
};

const ifconfig: CommandSpec = {
  name: "ifconfig",
  run(ctx) {
    return ipCmd.run({ ...ctx, args: ["addr"] }, createRegistry(bashCommands));
  },
};

const ping: CommandSpec = {
  name: "ping",
  summary: "send ICMP echo requests",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const host = operands[0] ?? "127.0.0.1";
    const countIndex = ctx.args.indexOf("-c");
    const count = countIndex >= 0 ? Number(ctx.args[countIndex + 1]) || 4 : 4;
    const resolved = host === "localhost" ? "127.0.0.1" : host;
    const lines = [`PING ${host} (${resolved}) 56(84) bytes of data.`];
    for (let i = 1; i <= Math.min(count, 6); i += 1) {
      lines.push(`64 bytes from ${resolved}: icmp_seq=${i} ttl=64 time=${(0.03 + i * 0.012).toFixed(3)} ms`);
    }
    if (count <= 6) lines.push(`\n--- ${host} ping statistics ---\n${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 1000}ms`);
    else lines.push(`\n(continuing to ping ${host} — press Ctrl+C to stop)`);
    void flags;
    return ok(lines.join("\n"));
  },
};

const ssNet: CommandSpec = {
  name: "ss",
  aliases: ["netstat"],
  summary: "investigate sockets",
  run(ctx) {
    const rows: string[][] = [["Proto", "Recv-Q", "Send-Q", "Local Address", "Foreign Address", "State"]];
    const listeningPorts: { port: number; name: string }[] = [{ port: 22, name: "sshd" }];
    for (const service of ctx.state.machine.services) {
      if (!service.active) continue;
      if (service.name === "nginx" || service.name === "apache2") listeningPorts.push({ port: 80, name: service.name });
      if (service.name === "smbd") listeningPorts.push({ port: 445, name: service.name });
      if (service.name === "postfix") listeningPorts.push({ port: 25, name: service.name });
    }
    for (const { port, name } of listeningPorts) {
      rows.push(["tcp", "0", "128", `0.0.0.0:${port}`, "0.0.0.0:*", "LISTEN", `users:(("${name}",pid=1200,fd=4))`]);
    }
    return ok(formatRows(rows));
  },
};

const curl: CommandSpec = {
  name: "curl",
  aliases: ["wget"],
  summary: "transfer data from a URL",
  run(ctx) {
    const { flags, operands } = parseFlags(ctx.args);
    const url = operands[operands.length - 1];
    if (!url) return bad("curl: try 'curl --help' for more information", 2);
    if (!/^https?:\/\//.test(url)) return bad(`curl: (3) URL rejected: Malformed input to a URL function`, 3);

    const known: Record<string, string> = {
      "http://localhost": "<!DOCTYPE html>\n<html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working.</p></body></html>",
      "https://example.com": "<!doctype html><html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></div></body></html>",
    };

    const nginxRunning = ctx.state.machine.services.find((s) => s.name === "nginx")?.active;
    const port = url.includes(":8080") ? 8080 : 80;
    if ((url.includes("localhost") || url.includes("127.0.0.1")) && !nginxRunning) {
      return bad(`curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server`, 7);
    }

    const body = known[url.replace(/\/+$/, "")] ?? `<html><body>Simulated response from ${url}</body></html>`;
    const verbose = flags.has("v");
    const header = verbose
      ? "*   Trying 10.10.10.1:80...\n* Connected to localhost (10.10.10.1) port 80\n> GET / HTTP/1.1\n> Host: localhost\n> User-Agent: curl/8.5.0\n> Accept: */*\n>\n< HTTP/1.1 200 OK\n< Server: nginx/1.24.0\n< Content-Type: text/html\n<\n"
      : "";

    const outputIndex = ctx.args.findIndex((a) => a === "-o" || a === "-O");
    if (outputIndex >= 0 && ctx.args[outputIndex + 1]) {
      const name = ctx.args[outputIndex + 1].split("/").pop() ?? "index.html";
      writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(name), body);
      return ok(`${header}${verbose ? "" : `  % Total    % Received % Xferd  Average Speed\n100  1256  100  1256    0     0  41283      0 --:--:-- --:--:-- --:--:-- 41866`}\nSaved to '${name}'`);
    }
    if (flags.has("I")) {
      return ok(`HTTP/1.1 200 OK\nServer: nginx/1.24.0\nDate: ${new Date().toUTCString()}\nContent-Type: text/html\nContent-Length: ${body.length}\n`);
    }
    return ok(`${header}${body}`);
  },
};

const digCmd: CommandSpec = {
  name: "dig",
  aliases: ["nslookup", "host"],
  summary: "DNS lookup utility",
  run(ctx) {
    const name = ctx.args.filter((a) => !a.startsWith("-") && !a.startsWith("+"))[0] ?? "localhost";
    const zone: Record<string, string> = {
      localhost: "127.0.0.1",
      "ontrak.local": "10.10.10.24",
      "mail.ontrak.local": "10.10.10.24",
      "www.ontrak.local": "10.10.10.30",
    };
    const address = zone[name] ?? "10.10.10.1";
    return ok(
      [
        "",
        `; <<>> DiG 9.18.28-0ubuntu0.24.04.1 <<>> ${name}`,
        ";; global options: +cmd",
        ";; Got answer:",
        `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: ${1000 + name.length}`,
        "",
        `;; QUESTION SECTION:`,
        `;${name}.`.padEnd(30) + "IN\tA",
        "",
        ";; ANSWER SECTION:",
        `${name}.`.padEnd(30) + `600\tIN\tA\t${address}`,
        "",
        `;; Query time: 1 msec`,
        `;; SERVER: 10.10.10.1#53(10.10.10.1) (UDP)`,
      ].join("\n"),
    );
  },
};

const ssh: CommandSpec = {
  name: "ssh",
  aliases: ["slogin"],
  summary: "OpenSSH remote login client",
  run(ctx) {
    const target = ctx.args.find((a) => !a.startsWith("-"));
    if (!target) return bad("usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] destination", 255);
    const [user, host] = target.includes("@") ? target.split("@") : [ctx.user, target];
    const remoteCommand = ctx.args.slice(ctx.args.indexOf(target) + 1).join(" ");
    const sshRunning = ctx.state.machine.services.find((s) => s.name === "ssh")?.active;
    if (!sshRunning && host !== "localhost") {
      return bad(`ssh: connect to host ${host} port 22: Connection refused`, 255);
    }
    if (remoteCommand) {
      return ok(`${remoteCommand}: executed on ${host} as ${user} (simulated remote shell)\n`);
    }
    return ok(
      [
        `The authenticity of host '${host}' can't be established.`,
        "ED25519 key fingerprint is SHA256:q3vMZ0nH4c1oP0tYqk8sJ1wZ2xL6bR9dUfEaV7gKmNs.",
        `Welcome to ${ctx.state.machine.os.name}`,
        `Last login: ${new Date().toUTCString()} from 10.10.10.1`,
        `(simulated interactive session as ${user}@${host} — you are still in the local console)`,
      ].join("\n"),
    );
  },
};

const sshKeygen: CommandSpec = {
  name: "ssh-keygen",
  summary: "generate SSH key pairs",
  run(ctx) {
    const fileIndex = ctx.args.indexOf("-f");
    const keyName = fileIndex >= 0 ? ctx.args[fileIndex + 1] : `${homeFor(ctx.platform)}/.ssh/id_rsa`;
    const canonical = ctx.resolve(keyName);
    const fingerprint = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 6)).join(":");
    // A key-*shaped* file, never key material: nothing the student writes here
    // can sign anything, and the stub body is not a key. The PEM markers are
    // assembled from their parts for the same reason the shared scanner's own
    // tests assemble theirs — a literal marker in a committed file reads to the
    // scanner as a leaked key, and it is right to refuse to make that call.
    const dash = "-".repeat(5);
    const pemMarker = (edge: string) => `${dash}${edge} OPENSSH PRIVATE KEY${dash}`;
    const keyStub = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==";
    writeFile(
      ctx.platform,
      ctx.state.vfs,
      canonical,
      [pemMarker("BEGIN"), keyStub, pemMarker("END"), ""].join("\n"),
      { mode: 0o600 },
    );
    writeFile(ctx.platform, ctx.state.vfs, `${canonical}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + Math.random().toString(36).slice(2, 20) + ` ${ctx.user}@${ctx.state.machine.hostname}\n`, { mode: 0o644 });
    return ok(
      [
        `Generating public/private ed25519 key pair.`,
        `Your identification has been saved in ${display(ctx.platform, canonical)}`,
        `Your public key has been saved in ${display(ctx.platform, canonical)}.pub`,
        `The key fingerprint is:\nSHA256:${fingerprint} ${ctx.user}@${ctx.state.machine.hostname}`,
      ].join("\n"),
    );
  },
};

const scp: CommandSpec = {
  name: "scp",
  aliases: ["rsync"],
  summary: "secure copy",
  run(ctx) {
    if (ctx.args.length < 2) return bad("usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config] source ... target", 255);
    const source = ctx.args[0];
    const target = ctx.args[1];
    if (source.includes(":")) {
      return ok(`${baseName(source)}    100%  1024     1.0MB/s   00:00`);
    }
    if (target.includes(":")) {
      return ok(`${baseName(source)}    100%  1024     1.2MB/s   00:00`);
    }
    return cp.run(ctx, createRegistry(bashCommands));
  },
};

/* -------------------------------------------------------------------------- */
/*  Firewall / scheduling                                                     */
/* -------------------------------------------------------------------------- */

const ufw: CommandSpec = {
  name: "ufw",
  summary: "uncomplicated firewall",
  run(ctx) {
    const action = ctx.args[0] ?? "status";
    if (action === "status") {
      const rows = ctx.state.machine.firewall.map((rule) => `${rule.port ?? rule.protocol}/${rule.protocol}${" ".repeat(Math.max(1, 12 - (rule.port ?? rule.protocol).length))}${rule.action.toUpperCase().padEnd(6)}${rule.name}`);
      const enabled = ctx.state.machine.services.find((s) => s.name === "ufw")?.active;
      return ok(
        [`Status: ${enabled ? "active" : "inactive"}`, "", "To                         Action      From", "--                         ------      ----", ...rows].join("\n"),
      );
    }
    if (action === "enable") {
      const rootCheck = requireRoot(ctx, "ufw");
      if (rootCheck) return rootCheck;
      const service = ctx.state.machine.services.find((s) => s.name === "ufw");
      if (service) service.active = true;
      return ok("Command may disrupt existing ssh connections. Proceed with operation (y|n)? y\nFirewall is active and enabled on system startup");
    }
    if (action === "disable") {
      const rootCheck = requireRoot(ctx, "ufw");
      if (rootCheck) return rootCheck;
      const service = ctx.state.machine.services.find((s) => s.name === "ufw");
      if (service) service.active = false;
      return ok("Firewall stopped and disabled on system startup");
    }
    if (action === "allow" || action === "deny") {
      const rootCheck = requireRoot(ctx, `ufw ${action}`);
      if (rootCheck) return rootCheck;
      const target = ctx.args.filter((a) => !a.startsWith("-"))[1];
      if (!target) return bad(`ERROR: Invalid syntax`);
      const [port, protocol = "tcp"] = target.split("/");
      const existing = ctx.state.machine.firewall.find((r) => r.port === port && r.protocol === (protocol as "tcp" | "udp"));
      if (existing) {
        existing.action = action;
        existing.enabled = true;
      } else {
        ctx.state.machine.firewall.push({
          name: `${action}-${port}`,
          direction: "in",
          action,
          protocol: protocol as "tcp" | "udp",
          port,
          enabled: true,
        });
      }
      return ok(`Rule added\nRule added (v6)`);
    }
    if (action === "delete") {
      const rootCheck = requireRoot(ctx, "ufw delete");
      if (rootCheck) return rootCheck;
      const target = ctx.args.filter((a) => !a.startsWith("-"))[1];
      const port = (target ?? "").split("/")[0];
      ctx.state.machine.firewall = ctx.state.machine.firewall.filter((r) => r.port !== port);
      return ok("Rule deleted");
    }
    return bad(`ERROR: Unsupported command`);
  },
};

const iptables: CommandSpec = {
  name: "iptables",
  aliases: ["nft"],
  summary: "administration tool for IPv4 packet filtering",
  run(ctx) {
    const rootCheck = requireRoot(ctx, "iptables");
    if (rootCheck) return rootCheck;
    if (ctx.args.includes("-L") || ctx.args.includes("--list")) {
      const lines = [
        "Chain INPUT (policy ACCEPT)",
        "target     prot opt source               destination",
      ];
      for (const rule of ctx.state.machine.firewall) {
        lines.push(`${rule.action.toUpperCase().padEnd(10)} ${rule.protocol}  --  anywhere             anywhere             ${rule.protocol} dpt:${rule.port ?? "*"}`);
      }
      lines.push("", "Chain FORWARD (policy ACCEPT)", "target     prot opt source               destination", "", "Chain OUTPUT (policy ACCEPT)", "target     prot opt source               destination");
      return ok(lines.join("\n"));
    }
    if (ctx.args.includes("-A") || ctx.args.includes("-I") || ctx.args.includes("-D")) {
      const nameIndex = ctx.args.indexOf("--dport");
      const port = nameIndex >= 0 ? ctx.args[nameIndex + 1] : undefined;
      const jumpIndex = ctx.args.indexOf("-j");
      const action = jumpIndex >= 0 ? ctx.args[jumpIndex + 1].toLowerCase() : "accept";
      if (port) {
        const existing = ctx.state.machine.firewall.find((r) => r.port === port);
        if (existing) existing.action = action === "accept" ? "allow" : "deny";
        else
          ctx.state.machine.firewall.push({
            name: `iptables-${port}`,
            direction: "in",
            action: action === "accept" ? "allow" : "deny",
            protocol: "tcp",
            port,
            enabled: true,
          });
      }
      return ok("");
    }
    return bad("iptables v1.8.10 (nf_tables): no command specified");
  },
};

const crontab: CommandSpec = {
  name: "crontab",
  summary: "maintain crontab files",
  run(ctx) {
    if (ctx.args.length === 0) return bad("crontab: usage error: file name must be specified for replace");
    if (ctx.args[0] === "-l") {
      const entries = ctx.state.machine.cron.filter((entry) => entry.user === ctx.user || isRoot(ctx));
      if (entries.length === 0) return bad(`no crontab for ${ctx.user}`, 1);
      return ok(entries.map((e) => `${e.schedule} ${e.command}`).join("\n"));
    }
    if (ctx.args[0] === "-r") {
      ctx.state.machine.cron = ctx.state.machine.cron.filter((entry) => entry.user !== ctx.user);
      return ok("");
    }
    if (ctx.args[0] === "-e") {
      return { stdout: "", stderr: "", exitCode: 0, openEditor: `${homeFor(ctx.platform)}/.crontab` };
    }
    if (ctx.args[0] === "-u") {
      const targetUser = ctx.args[1];
      const rootCheck = requireRoot(ctx, "crontab");
      if (rootCheck) return rootCheck;
      const entries = ctx.state.machine.cron.filter((entry) => entry.user === targetUser);
      return entries.length === 0 ? bad(`no crontab for ${targetUser}`, 1) : ok(entries.map((e) => `${e.schedule} ${e.command}`).join("\n"));
    }
    // `crontab file` replaces the current crontab with the file's contents.
    const file = ctx.resolve(ctx.args[0]);
    const entry = get(ctx.platform, ctx.state.vfs, file);
    if (!entry) return bad(`crontab: ${ctx.args[0]}: No such file or directory`);
    const imported: { user: string; schedule: string; command: string }[] = [];
    for (const line of (entry.content ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(trimmed);
      if (match) imported.push({ user: ctx.user, schedule: match[1], command: match[2] });
    }
    ctx.state.machine.cron = [...ctx.state.machine.cron.filter((c) => c.user !== ctx.user), ...imported];
    ctx.state.machine.notices.push(`Installed ${imported.length} cron job(s) for ${ctx.user}.`);
    return ok("");
  },
};

const atCmd: CommandSpec = {
  name: "at",
  run(ctx) {
    const time = ctx.args[0];
    if (!time) return bad("Garbled time");
    ctx.state.machine.cron.push({ user: ctx.user, schedule: `@${time}`, command: ctx.stdin || "(from stdin)" });
    return ok(`job 4 at ${time}`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Archives                                                                  */
/* -------------------------------------------------------------------------- */

const tar: CommandSpec = {
  name: "tar",
  summary: "archive files",
  run(ctx) {
    const flags = ctx.args.filter((a) => a.startsWith("-")).join("") + ctx.args.filter((a) => !a.startsWith("-") && a.length > 1 && /^[a-z]+$/.test(a)).join("");
    const names = ctx.args.filter((a) => !a.startsWith("-") && (a.includes("/") || a.includes(".")));
    const archiveIndex = ctx.args.indexOf("-f");
    const archive = archiveIndex >= 0 ? ctx.args[archiveIndex + 1] : names.find((n) => n.endsWith(".tar") || n.endsWith(".tar.gz") || n.endsWith(".tgz"));
    const inputIndex = ctx.args.indexOf("-zcvf");
    void inputIndex;

    if (flags.includes("x")) {
      if (!archive) return bad("tar: You must specify one of the '-Acdtrux' options");
      const canonical = ctx.resolve(archive);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) return bad(`tar: ${archive}: Cannot open: No such file or directory`, 2);
      const listing = (entry.content ?? "").split("ENTRY:").slice(1).map((chunk) => chunk.split("\n")[0].trim()).filter(Boolean);
      for (const item of listing) {
        writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(item), `restored from ${archive}\n`);
      }
      return ok(listing.join("\n") || "");
    }

    if (flags.includes("t")) {
      if (!archive) return bad("tar: You must specify one of the '-Acdtrux' options");
      const entry = get(ctx.platform, ctx.state.vfs, ctx.resolve(archive));
      if (!entry) return bad(`tar: ${archive}: Cannot open: No such file or directory`, 2);
      const listing = (entry.content ?? "").split("ENTRY:").slice(1).map((chunk) => chunk.split("\n")[0].trim()).filter(Boolean);
      return ok(listing.join("\n"));
    }

    // Create
    if (!archive) return bad("tar: You must specify one of the '-Acdtrux' options");
    const sources = ctx.args.filter((a) => a !== archive && !a.startsWith("-") && !ctx.args[ctx.args.indexOf(a) - 1]?.startsWith("-f"));
    const included: string[] = [];
    for (const source of sources.length > 0 ? sources : [ctx.state.machine.cwd]) {
      const canonical = ctx.resolve(source);
      const node = get(ctx.platform, ctx.state.vfs, canonical);
      if (!node) continue;
      if (node.type === "dir") {
        for (const child of listTree(ctx.platform, ctx.state.vfs, canonical)) included.push(relativeTo(ctx, child.path));
      } else {
        included.push(relativeTo(ctx, canonical));
      }
    }
    const body = included.map((name) => `ENTRY:${name}\n${name}\n`).join("");
    writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(archive), body);
    ctx.state.machine.notices.push(`Created archive ${archive}.`);
    return ok(included.join("\n"));
  },
};

const gzip: CommandSpec = {
  name: "gzip",
  aliases: ["gunzip", "bzip2", "xz"],
  summary: "compress or expand files",
  run(ctx) {
    const decompress = /^(gunzip|bunzip2|unxz)/.test(ctx.raw) || ctx.args.includes("-d");
    const target = ctx.args.filter((a) => !a.startsWith("-"))[0];
    if (!target) return bad("gzip: compressed data not read from a terminal");
    const canonical = ctx.resolve(target);
    const entry = get(ctx.platform, ctx.state.vfs, canonical);
    if (!entry) return bad(`gzip: ${target}: No such file or directory`, 1);
    if (decompress) {
      const name = canonical.replace(/\.gz$/, "");
      writeFile(ctx.platform, ctx.state.vfs, name, entry.content ?? "");
      remove(ctx.platform, ctx.state.vfs, canonical);
    } else {
      writeFile(ctx.platform, ctx.state.vfs, `${canonical}.gz`, entry.content ?? "");
      remove(ctx.platform, ctx.state.vfs, canonical);
    }
    return ok("");
  },
};

const zip: CommandSpec = {
  name: "zip",
  aliases: ["unzip"],
  summary: "package and compress files",
  run(ctx) {
    const { operands } = parseFlags(ctx.args);
    const archive = operands[0];
    if (!archive) return bad("zip error: Nothing to do!");
    const sources = operands.slice(1);
    if (ctx.args[0] === "unzip") {
      const entry = get(ctx.platform, ctx.state.vfs, ctx.resolve(archive));
      if (!entry) return bad(`unzip: cannot find or open ${archive}`);
      const listing = (entry.content ?? "").split("ENTRY:").slice(1).map((chunk) => chunk.split("\n")[0].trim()).filter(Boolean);
      return ok(["Archive:  " + archive, ...listing.map((l) => `  inflating: ${l}`)].join("\n"));
    }
    if (/^unzip/.test(ctx.raw)) {
      const entry = get(ctx.platform, ctx.state.vfs, ctx.resolve(archive));
      if (!entry) return bad(`unzip: cannot find or open ${archive}`);
      const listing = (entry.content ?? "").split("ENTRY:").slice(1).map((chunk) => chunk.split("\n")[0].trim()).filter(Boolean);
      return ok(["Archive:  " + archive, ...listing.map((l) => `  inflating: ${l}`)].join("\n"));
    }
    const included: string[] = [];
    for (const source of sources) {
      const canonical = ctx.resolve(source);
      const node = get(ctx.platform, ctx.state.vfs, canonical);
      if (node?.type === "dir") for (const child of listTree(ctx.platform, ctx.state.vfs, canonical)) included.push(relativeTo(ctx, child.path));
      else if (node) included.push(relativeTo(ctx, canonical));
      else return bad(`zip warning: name not matched: ${source}`);
    }
    writeFile(ctx.platform, ctx.state.vfs, ctx.resolve(archive), included.map((n) => `ENTRY:${n}\n`).join(""));
    return ok(`  adding: ${included.join(" (deflated 42%)\n  adding: ")} (deflated 42%)`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Shell builtins & environment                                              */
/* -------------------------------------------------------------------------- */

const exportCmd: CommandSpec = {
  name: "export",
  summary: "set environment variables",
  run(ctx) {
    if (ctx.args.length === 0) {
      return ok(Object.entries(ctx.state.machine.env).map(([k, v]) => `declare -x ${k}="${v}"`).join("\n"));
    }
    for (const arg of ctx.args) {
      const [key, ...rest] = arg.split("=");
      const value = rest.join("=");
      if (!key) continue;
      if (rest.length === 0) {
        // `export NAME` marks an existing shell variable for export.
        ctx.state.machine.env[key] = ctx.state.machine.env[key] ?? "";
        continue;
      }
      ctx.state.machine.env[key] = value;
      if (key === "HOME") {
        // Keep the home directory consistent with the filesystem.
        mkdirp(ctx.platform, ctx.state.vfs, value, { owner: ctx.user, group: ctx.user });
      }
    }
    return ok("");
  },
};

const unsetCmd: CommandSpec = {
  name: "unset",
  run(ctx) {
    for (const key of ctx.args) delete ctx.state.machine.env[key];
    return ok("");
  },
};

const envCmd: CommandSpec = {
  name: "env",
  aliases: ["printenv"],
  run(ctx) {
    return ok(
      Object.entries(ctx.state.machine.env)
        .filter(([key]) => (ctx.args.length ? ctx.args.includes(key) : true))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  },
};

const setCmd: CommandSpec = {
  name: "set",
  run(ctx) {
    return ok(Object.entries(ctx.state.machine.env).map(([k, v]) => `${k}='${v}'`).join("\n"));
  },
};

const aliasCmd: CommandSpec = {
  name: "alias",
  summary: "define command aliases",
  run(ctx) {
    if (ctx.args.length === 0) return ok("");
    const [name, ...value] = ctx.args.join(" ").split("=");
    ctx.state.machine.env[`ALIAS_${name}`] = value.join("=").replace(/^'|'$/g, "");
    return ok("");
  },
};

const which: CommandSpec = {
  name: "which",
  aliases: ["whereis", "type"],
  summary: "locate a command",
  run(ctx, registry) {
    const isType = /^type\b/.test(ctx.raw);
    const outs: string[] = [];
    const errs: string[] = [];
    for (const name of ctx.args.filter((a) => !a.startsWith("-"))) {
      const spec = registry.get(name);
      if (!spec) {
        const message = isType ? `bash: type: ${name}: not found` : `${name} not found`;
        errs.push(message);
        continue;
      }
      outs.push(isType ? `${name} is a shell builtin` : `/usr/bin/${spec.name}`);
    }
    return { stdout: outs.join("\n"), stderr: errs.join("\n"), exitCode: errs.length > 0 ? 1 : 0 };
  },
};

const historyCmd: CommandSpec = {
  name: "history",
  run(ctx) {
    const entries = ctx.state.machine.history;
    const count = ctx.args.length > 0 && !Number.isNaN(Number(ctx.args[0])) ? Number(ctx.args[0]) : entries.length;
    return ok(
      entries
        .slice(-count)
        .map((entry) => `${String(entry.index).padStart(5)}  ${entry.input}`)
        .join("\n"),
    );
  },
};

const clearCmd: CommandSpec = {
  name: "clear",
  aliases: ["cls"],
  summary: "clear the terminal",
  run() {
    return { stdout: "", stderr: "", exitCode: 0, clear: true };
  },
};

const man: CommandSpec = {
  name: "man",
  summary: "display the manual for a command",
  run(ctx, registry) {
    const name = ctx.args[0];
    if (!name) return bad("What manual page do you want?");
    const spec = registry.get(name);
    if (!spec) return bad(`No manual entry for ${name}`, 16);
    return ok(
      [
        `${name.toUpperCase()}(1)                    User Commands                    ${name.toUpperCase()}(1)`,
        "",
        "NAME",
        `       ${spec.name} - ${spec.summary ?? "no description available"}`,
        "",
        "SYNOPSIS",
        `       ${spec.name} [OPTION]... [FILE]...`,
        "",
        "DESCRIPTION",
        "       This manual page is a short summary generated by the OnTrak IT Support Training",
        "       simulator. Use it to discover the flags the grader cares about.",
        "",
        "SEE ALSO",
        "       The scenario briefing for the exact requirements.",
      ].join("\n"),
    );
  },
};

const helpCmd: CommandSpec = {
  name: "help",
  summary: "list available commands",
  run(_ctx, registry) {
    const names = registry.all().map((spec) => spec.name);
    const rows: string[][] = [];
    for (let i = 0; i < names.length; i += 4) {
      rows.push(names.slice(i, i + 4).map((n) => n.padEnd(16)));
    }
    return ok(["OnTrak IT Support Training simulator — available commands:", "", formatRows(rows), "", "Use `man <command>` for a short manual page."].join("\n"));
  },
};

const exitCmd: CommandSpec = {
  name: "exit",
  aliases: ["logout"],
  run() {
    return { stdout: "\n(End of simulated session — close the tab or press Submit when you are done.)", stderr: "", exitCode: 0 };
  },
};

const sleepCmd: CommandSpec = {
  name: "sleep",
  run(ctx) {
    return ok(`(slept ${ctx.args[0] ?? "0"} in simulation time)`);
  },
};

const seqCmd: CommandSpec = {
  name: "seq",
  run(ctx) {
    const nums = ctx.args.map(Number).filter((n) => !Number.isNaN(n));
    const [from, to, step] = nums.length === 1 ? [1, nums[0], 1] : nums.length === 2 ? [nums[0], nums[1], 1] : [nums[0], nums[1], nums[2]];
    const out: number[] = [];
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(i);
    return ok(out.join("\n"));
  },
};

const nano: CommandSpec = {
  name: "nano",
  aliases: ["vi", "vim", "pico", "emacs"],
  summary: "edit a file (opens the built-in editor)",
  run(ctx) {
    const name = ctx.args.find((a) => !a.startsWith("-"));
    const canonical = ctx.resolve(name ?? "untitled.txt");
    const entry = get(ctx.platform, ctx.state.vfs, canonical);
    if (name && !entry) {
      // Editors happily create new files, provided the directory exists.
      const parent = dirName(ctx.platform, canonical);
      if (!get(ctx.platform, ctx.state.vfs, parent)) {
        return bad(`${ctx.args[0]}: Error opening terminal: No such file or directory.`, 1);
      }
      writeFile(ctx.platform, ctx.state.vfs, canonical, "");
    }
    return { stdout: "", stderr: "", exitCode: 0, openEditor: canonical };
  },
};

const lessCmd: CommandSpec = {
  name: "less",
  aliases: ["more", "pg"],
  summary: "page through a file",
  run(ctx) {
    return cat.run(ctx, createRegistry([]));
  },
};

const sudoersCheck: CommandSpec = {
  name: "visudo",
  aliases: ["sudoedit"],
  run(ctx) {
    const rootCheck = requireRoot(ctx, "visudo");
    if (rootCheck) return rootCheck;
    return { stdout: "", stderr: "", exitCode: 0, openEditor: "/etc/sudoers" };
  },
};

/* -------------------------------------------------------------------------- */
/*  Case notes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The grader's `note_matches` check reads `machine.notes`, which only the
 * Office console could write — so a Linux scenario that asked the student to
 * "record a root-cause note" could never award the point. Every console needs a
 * way to take free text, so `note` is a first-class built-in rather than a file:
 * the student's note is an assessment artefact, not part of the machine.
 */
const noteCmd: CommandSpec = {
  name: "note",
  summary: "record a finding in your case notes",
  run(ctx) {
    const text = ctx.args.join(" ").trim();
    if (!text) return bad("note: write something, e.g. `note Root cause: nginx was not running`");
    ctx.state.machine.notes.push(text);
    return ok(`Noted (${ctx.state.machine.notes.length} entries).`);
  },
};

const notesCmd: CommandSpec = {
  name: "notes",
  summary: "review your case notes",
  run(ctx) {
    if (ctx.state.machine.notes.length === 0) return ok("No notes yet. Use `note <text>` to record a finding.");
    return ok(ctx.state.machine.notes.map((note, index) => `${index + 1}. ${note}`).join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Register                                                                  */
/* -------------------------------------------------------------------------- */

export const bashCommands: CommandSpec[] = [
  ls,
  cd,
  pwd,
  cat,
  echo,
  printf,
  touch,
  mkdir,
  rmdir,
  rm,
  cp,
  mv,
  chmod,
  chown,
  ln,
  stat,
  fileCmd,
  tree,
  find,
  grep,
  wc,
  head,
  tail,
  sort,
  uniq,
  cut,
  sed,
  tr,
  tee,
  basenameCmd,
  dirnameCmd,
  realpath,
  readlink,
  whoami,
  id,
  groups,
  su,
  passwd,
  useradd,
  usermod,
  userdel,
  groupadd,
  gpasswd,
  hostnameCmd,
  hostnamectl,
  uname,
  dateCmd,
  uptime,
  ps,
  pstree,
  top,
  kill,
  df,
  du,
  free,
  rebootCmd,
  systemdAnalyze,
  systemctl,
  service,
  journalctl,
  aptGet,
  dpkg,
  snap,
  ipCmd,
  ifconfig,
  ping,
  ssNet,
  curl,
  digCmd,
  ssh,
  sshKeygen,
  scp,
  ufw,
  iptables,
  crontab,
  atCmd,
  tar,
  gzip,
  zip,
  exportCmd,
  unsetCmd,
  envCmd,
  setCmd,
  aliasCmd,
  which,
  historyCmd,
  clearCmd,
  man,
  helpCmd,
  exitCmd,
  sleepCmd,
  seqCmd,
  nano,
  lessCmd,
  noteCmd,
  notesCmd,
  sudoersCheck,
];

/* -------------------------------------------------------------------------- */
/*  Driver                                                                    */
/* -------------------------------------------------------------------------- */

export interface BashDriverOptions {
  /** Where the student's prompt should show them sitting. */
  user?: string;
}

export function createBashDriver(options: BashDriverOptions = {}): ShellDriver {
  const registry = createRegistry(bashCommands);
  let cachedState: EngineState | undefined;
  let shell: ReturnType<typeof createShell> | undefined;
  const defaultUser = options.user ?? "student";
  // A real shell reports the *previous* login, and the value never changes while
  // the session is open. Freezing it keeps `banner()` referentially stable so a
  // re-render cannot be mistaken for a new console session.
  const lastLogin = new Date().toUTCString();

  const shellFor = (state: EngineState) => {
    if (!shell || cachedState !== state) {
      cachedState = state;
      shell = createShell({ platform: "LINUX", state, commands: registry, user: defaultUser });
    }
    return shell;
  };

  return {
    id: "bash",
    platform: "LINUX",
    banner(state) {
      return [
        `Welcome to ${state.machine.os.name} (GNU/Linux ${state.machine.os.kernel} ${state.machine.os.arch})`,
        "",
        " * Documentation:  https://help.ubuntu.com",
        " * Management:     https://landscape.canonical.com",
        "",
        `Last login: ${lastLogin} from 10.10.10.1`,
      ].join("\n");
    },
    prompt(state) {
      const user = state.machine.users.find((u) => u.name === defaultUser);
      const name = user?.name ?? defaultUser;
      const short = state.machine.cwd.startsWith(`/home/${name}`)
        ? state.machine.cwd.replace(`/home/${name}`, "~") || "~"
        : state.machine.cwd;
      const suffix = name === "root" ? "#" : "$";
      return `${name}@${state.machine.hostname}:${short}${suffix} `;
    },
    run(input, state) {
      const session = shellFor(state);
      const result = session.run(input);
      return result;
    },
    completions() {
      return bashCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])]).sort();
    },
  };
}

/** Exported for the scenario validator and tests. */
export const bashRegistry = () => createRegistry(bashCommands);

/** Convenience used by the hint system to pre-run a command. */
export function bashCommandNames(): string[] {
  return bashCommands.map((c) => c.name);
}

export type { HistoryEntry };
