/**
 * The Windows driver: a PowerShell-flavoured shell over the same virtual
 * filesystem and machine state used by the Linux driver.
 *
 * PowerShell conventions are respected where they matter for training:
 * verb-noun cmdlets, `-Parameter value` binding, common aliases (`gci`, `ls`,
 * `cd`, `gc`, `gsv`, …), and real error text that names the failing cmdlet.
 * The classic `net user` / `net localgroup` builtins are included too, because
 * help-desk work leans on them constantly.
 */

import { baseName, display, dirName, homeFor } from "../paths";
import { simulatedPasswordHash } from "../password";
import { createRegistry, createShell, formatRows, type CommandContext, type CommandSpec } from "../shell";
import { copy, get, listDir, listTree, mkdirp, move, remove, writeFile } from "../vfs";
import type { CommandResult, EngineState, FirewallRule, LocalUser, RegistryValue, ShellDriver } from "../types";

/* -------------------------------------------------------------------------- */
/*  PowerShell argument binding                                               */
/* -------------------------------------------------------------------------- */

/** Switches that never consume a following token. */
const BOOLEAN_SWITCHES = new Set([
  "force",
  "recurse",
  "whatif",
  "confirm",
  "verbose",
  "debug",
  "all",
  "hidden",
  "passthru",
  "wait",
  "asjob",
  "noop",
  "enabled",
  "disabled",
  "readonly",
  "system",
  "dynamic",
  "strict",
  "unique",
]);

export interface BoundArgs {
  /** Named parameters, lower-cased, including the leading dash removed. */
  named: Map<string, string>;
  /** Boolean switches that were present. */
  switches: Set<string>;
  positional: string[];
  /** Was `-X` given at all (switch or parameter)? */
  has(name: string): boolean;
  value(name: string, fallback?: string): string | undefined;
  bool(name: string): boolean;
}

export function bindArgs(args: string[]): BoundArgs {
  const named = new Map<string, string>();
  const switches = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }
    const raw = token.replace(/^--?/, "");
    const [key, inline] = raw.split(":", 2);
    const name = key.toLowerCase();
    if (inline !== undefined) {
      named.set(name, inline);
      continue;
    }
    const next = args[i + 1];
    if (BOOLEAN_SWITCHES.has(name) || next === undefined || next.startsWith("-")) {
      switches.add(name);
      continue;
    }
    named.set(name, next);
    i += 1;
  }

  return {
    named,
    switches,
    positional,
    has: (name) => named.has(name.toLowerCase()) || switches.has(name.toLowerCase()),
    value: (name, fallback) => named.get(name.toLowerCase()) ?? fallback,
    bool: (name) => switches.has(name.toLowerCase()) || /^(true|\$true|1)$/i.test(named.get(name.toLowerCase()) ?? ""),
  };
}

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function bad(stderr: string, code = 1): CommandResult {
  return { stdout: "", stderr, exitCode: code };
}

function isAdmin(ctx: CommandContext): boolean {
  return ctx.user === "Administrator" || ctx.state.machine.users.find((u) => u.name === ctx.user)?.groups.includes("Administrators") === true;
}

function requireAdmin(ctx: CommandContext, cmdlet: string): CommandResult | null {
  if (isAdmin(ctx)) return null;
  return bad(
    `${cmdlet} : Access to the registry key or operation is denied.\nAt line:1 char:1\n+ ${cmdlet}\n+ ~~~~~~~~\n    + CategoryInfo          : PermissionDenied\n    + FullyQualifiedErrorId : UnauthorizedAccessException`,
    1,
  );
}

function findUser(state: EngineState, name: string): LocalUser | undefined {
  return state.machine.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
}

/** Canonical registry path from either `HKLM:\X\Y`, `HKEY_LOCAL_MACHINE\X\Y`. */
function normalizeRegistryPath(input: string): string {
  return input
    .replace(/^HKLM:/i, "HKLM")
    .replace(/^HKCU:/i, "HKCU")
    .replace(/^HKCR:/i, "HKCR")
    .replace(/^HKEY_LOCAL_MACHINE/i, "HKLM")
    .replace(/^HKEY_CURRENT_USER/i, "HKCU")
    .replace(/^HKEY_CLASSES_ROOT/i, "HKCR")
    .replace(/^HKLM\\?/i, "HKLM\\")
    .replace(/^HKCU\\?/i, "HKCU\\")
    .replace(/^HKCR\\?/i, "HKCR\\")
    .replace(/\\+$/, "");
}

function registryEntries(state: EngineState, path: string): RegistryValue[] {
  const normal = normalizeRegistryPath(path);
  return state.machine.registry.filter((entry) => entry.path.toLowerCase() === normal.toLowerCase());
}

function psPath(ctx: CommandContext, value: string | undefined): string {
  if (!value) return ctx.state.machine.cwd;
  return ctx.resolve(value);
}

/* -------------------------------------------------------------------------- */
/*  Filesystem cmdlets                                                        */
/* -------------------------------------------------------------------------- */

const GetChildItem: CommandSpec = {
  name: "Get-ChildItem",
  aliases: ["gci", "ls", "dir"],
  summary: "list the items in a location",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const targets = args.positional.length > 0 ? args.positional : [ctx.state.machine.cwd];
    const recursive = args.bool("recurse");
    const force = args.bool("force");
    const filter = args.value("filter") ?? args.value("include");
    const outs: string[] = [];

    for (const target of targets) {
      const canonical = psPath(ctx, target);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        return bad(
          `Get-ChildItem : Cannot find path '${display(ctx.platform, canonical)}' because it does not exist.\nAt line:1 char:1\n+ Get-ChildItem\n    + CategoryInfo          : ObjectNotFound: (${display(ctx.platform, canonical)}:String) [Get-ChildItem], ItemNotFoundException`,
          1,
        );
      }
      if (entry.type !== "dir") {
        outs.push(row(ctx, entry.path));
        continue;
      }
      const children = recursive
        ? listTree(ctx.platform, ctx.state.vfs, canonical)
        : listDir(ctx.platform, ctx.state.vfs, canonical);
      for (const child of children) {
        if (!force && baseName(child.path).startsWith("$")) continue;
        if (filter && !baseName(child.path).toLowerCase().includes(filter.replace(/[*?]/g, "").toLowerCase())) continue;
        outs.push(row(ctx, child.path));
      }
    }

    if (outs.length === 0) return ok("");
    return ok(
      [
        "    Directory: " + display(ctx.platform, ctx.state.machine.cwd),
        "",
        "Mode                 LastWriteTime         Length Name",
        "----                 -------------         ------ ----",
        ...outs,
      ].join("\n"),
    );
  },
};

function row(ctx: CommandContext, canonical: string): string {
  const entry = get(ctx.platform, ctx.state.vfs, canonical);
  if (!entry) return "";
  const mode = entry.type === "dir" ? "d-----" : "------";
  const stamp = new Date(entry.mtime).toISOString().slice(0, 16).replace("T", " ");
  const length = entry.type === "dir" ? "" : String(entry.size);
  return `${mode.padEnd(21)}${stamp.padEnd(21)}${length.padStart(7)} ${baseName(canonical)}`;
}

const SetLocation: CommandSpec = {
  name: "Set-Location",
  aliases: ["cd", "sl", "chdir"],
  summary: "change the working location",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path") ?? (ctx.state.machine.env.USERPROFILE ?? homeFor("WINDOWS"));
    const canonical = target === "-" ? ctx.state.machine.env.OLDPWD ?? ctx.state.machine.cwd : ctx.resolve(target);
    const entry = get(ctx.platform, ctx.state.vfs, canonical);
    if (!entry) {
      return bad(`Set-Location : Cannot find path '${display(ctx.platform, canonical)}' because it does not exist.`, 1);
    }
    if (entry.type !== "dir") return bad(`Set-Location : Cannot find path '${target}' because it does not exist.`, 1);
    ctx.state.machine.env.OLDPWD = ctx.state.machine.cwd;
    ctx.state.machine.cwd = entry.path;
    return ok("");
  },
};

const GetLocation: CommandSpec = {
  name: "Get-Location",
  aliases: ["pwd", "gl"],
  summary: "show the current location",
  run(ctx) {
    return ok(
      [
        "",
        `Path`,
        `----`,
        display(ctx.platform, ctx.state.machine.cwd),
        "",
      ].join("\n"),
    );
  },
};

const GetContent: CommandSpec = {
  name: "Get-Content",
  aliases: ["gc", "cat", "type"],
  summary: "read the contents of a file",
  run(ctx) {
    const args = bindArgs(ctx.args);
    if (args.positional.length === 0 && !ctx.stdin) return bad("Get-Content : Cannot bind argument to parameter 'Path' because it is null.");
    if (args.positional.length === 0) return ok(ctx.stdin);
    const outs: string[] = [];
    for (const target of args.positional) {
      const canonical = ctx.resolve(target);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        return bad(
          `Get-Content : Cannot find path '${display(ctx.platform, canonical)}' because it does not exist.\n    + CategoryInfo          : ObjectNotFound: (${target}:String) [Get-Content], ItemNotFoundException`,
          1,
        );
      }
      if (entry.type === "dir") return bad(`Get-Content : Access to the path '${display(ctx.platform, canonical)}' is denied.`, 1);
      outs.push(entry.content ?? "");
    }
    return ok(outs.join("\n"));
  },
};

const SetContent: CommandSpec = {
  name: "Set-Content",
  aliases: ["sc"],
  summary: "write content to a file",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path");
    if (!target) return bad("Set-Content : Cannot bind argument to parameter 'Path' because it is null.");
    const value = args.positional.length > 1 ? args.positional.slice(1).join(" ") : args.value("value") ?? ctx.stdin;
    const canonical = ctx.resolve(target);
    const parent = dirName(ctx.platform, canonical);
    if (!get(ctx.platform, ctx.state.vfs, parent)) {
      return bad(`Set-Content : Could not find a part of the path '${display(ctx.platform, canonical)}'.`, 1);
    }
    writeFile(ctx.platform, ctx.state.vfs, canonical, value, { owner: ctx.user, group: ctx.user });
    return ok("");
  },
};

const AddContent: CommandSpec = {
  name: "Add-Content",
  aliases: ["ac"],
  summary: "append content to a file",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path");
    if (!target) return bad("Add-Content : Cannot bind argument to parameter 'Path' because it is null.");
    const value = args.positional.length > 1 ? args.positional.slice(1).join(" ") : args.value("value") ?? ctx.stdin;
    const canonical = ctx.resolve(target);
    const existing = get(ctx.platform, ctx.state.vfs, canonical);
    const prior = existing?.content ?? "";
    const separator = prior && !prior.endsWith("\n") ? "\n" : "";
    writeFile(ctx.platform, ctx.state.vfs, canonical, `${prior}${separator}${value}`, {
      owner: ctx.user,
      group: ctx.user,
      mode: existing?.mode,
    });
    return ok("");
  },
};

const OutFile: CommandSpec = {
  name: "Out-File",
  summary: "send output to a file",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("filepath");
    if (!target) return bad("Out-File : Cannot bind argument to parameter 'FilePath' because it is null.");
    const append = args.bool("append");
    const canonical = ctx.resolve(target);
    const existing = get(ctx.platform, ctx.state.vfs, canonical);
    const prior = append ? existing?.content ?? "" : "";
    const separator = prior && !prior.endsWith("\n") && ctx.stdin ? "\n" : "";
    writeFile(ctx.platform, ctx.state.vfs, canonical, `${prior}${separator}${ctx.stdin}`, { owner: ctx.user, group: ctx.user });
    return ok("");
  },
};

const NewItem: CommandSpec = {
  name: "New-Item",
  aliases: ["ni"],
  summary: "create a new item",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path");
    if (!target) return bad("New-Item : Cannot bind argument to parameter 'Path' because it is null.");
    const itemType = (args.value("itemtype") ?? (target.endsWith("\\") || target.endsWith("/") ? "directory" : "file")).toLowerCase();
    const canonical = ctx.resolve(target);
    const existing = get(ctx.platform, ctx.state.vfs, canonical);
    if (existing) {
      if (itemType === "directory") return ok("");
      return bad(`New-Item : The file '${display(ctx.platform, canonical)}' already exists.`, 1);
    }
    const parent = dirName(ctx.platform, canonical);
    if (!get(ctx.platform, ctx.state.vfs, parent)) {
      if (!args.bool("force")) {
        return bad(`New-Item : Could not find a part of the path '${display(ctx.platform, canonical)}'.`, 1);
      }
      mkdirp(ctx.platform, ctx.state.vfs, parent, { owner: ctx.user, group: ctx.user });
    }
    if (itemType.startsWith("dir")) {
      mkdirp(ctx.platform, ctx.state.vfs, canonical, { owner: ctx.user, group: ctx.user });
    } else {
      const value = args.value("value") ?? "";
      writeFile(ctx.platform, ctx.state.vfs, canonical, value, { owner: ctx.user, group: ctx.user });
    }
    return ok(
      [
        "",
        `    Directory: ${display(ctx.platform, parent)}`,
        "",
        "Mode                 LastWriteTime         Length Name",
        "----                 -------------         ------ ----",
        row(ctx, canonical),
        "",
      ].join("\n"),
    );
  },
};

const RemoveItem: CommandSpec = {
  name: "Remove-Item",
  aliases: ["ri", "rm", "del", "erase", "rd"],
  summary: "delete an item",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const recursive = args.bool("recurse") || /^(rm|del|erase|rd)$/i.test(ctx.raw.split(/\s+/)[0]);
    const outs: string[] = [];
    const errs: string[] = [];
    for (const target of args.positional) {
      const canonical = ctx.resolve(target);
      const entry = get(ctx.platform, ctx.state.vfs, canonical);
      if (!entry) {
        if (args.bool("erroraction")) continue;
        errs.push(`Remove-Item : Cannot find path '${display(ctx.platform, canonical)}' because it does not exist.`);
        continue;
      }
      const result = remove(ctx.platform, ctx.state.vfs, canonical, recursive || entry.type === "dir");
      if (result === -2) {
        errs.push(`Remove-Item : Cannot remove item ${display(ctx.platform, canonical)}: The directory is not empty.`);
        continue;
      }
      outs.push(`Removed ${display(ctx.platform, canonical)}`);
    }
    return { stdout: args.bool("passthru") ? outs.join("\n") : "", stderr: errs.join("\n"), exitCode: errs.length > 0 && outs.length === 0 ? 1 : 0 };
  },
};

const CopyItem: CommandSpec = {
  name: "Copy-Item",
  aliases: ["cp", "copy", "cpi"],
  summary: "copy an item",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const positional = args.positional;
    const from = positional[0] ?? args.value("path");
    const to = positional[1] ?? args.value("destination");
    if (!from || !to) return bad("Copy-Item : Cannot bind argument to parameter 'Path' because it is null.");
    const recursive = args.bool("recurse");
    const result = copy(ctx.platform, ctx.state.vfs, ctx.resolve(from), ctx.resolve(to), recursive);
    if (!result.ok) return bad(`Copy-Item : ${result.error}`, 1);
    return ok("");
  },
};

const MoveItem: CommandSpec = {
  name: "Move-Item",
  aliases: ["mv", "move", "mi"],
  summary: "move an item",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const from = args.positional[0] ?? args.value("path");
    const to = args.positional[1] ?? args.value("destination");
    if (!from || !to) return bad("Move-Item : Cannot bind argument to parameter 'Path' because it is null.");
    const result = move(ctx.platform, ctx.state.vfs, ctx.resolve(from), ctx.resolve(to));
    if (!result.ok) return bad(`Move-Item : ${result.error}`, 1);
    return ok("");
  },
};

const RenameItem: CommandSpec = {
  name: "Rename-Item",
  aliases: ["ren", "rni"],
  summary: "rename an item",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const from = args.positional[0] ?? args.value("path");
    const newName = args.positional[1] ?? args.value("newname");
    if (!from || !newName) return bad("Rename-Item : Cannot bind argument to parameter 'NewName' because it is null.");
    const canonical = ctx.resolve(from);
    if (!get(ctx.platform, ctx.state.vfs, canonical)) {
      return bad(`Rename-Item : Cannot rename because item at '${display(ctx.platform, canonical)}' does not exist.`, 1);
    }
    const target = `${dirName(ctx.platform, canonical)}/${newName}`;
    const result = move(ctx.platform, ctx.state.vfs, canonical, target);
    if (!result.ok) return bad(`Rename-Item : ${result.error}`, 1);
    return ok("");
  },
};

const TestPath: CommandSpec = {
  name: "Test-Path",
  summary: "test whether a path exists",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path");
    if (!target) return bad("Test-Path : Cannot bind argument to parameter 'Path' because it is null.");
    return ok(get(ctx.platform, ctx.state.vfs, ctx.resolve(target)) ? "True" : "False");
  },
};

const SelectString: CommandSpec = {
  name: "Select-String",
  aliases: ["sls", "findstr"],
  summary: "search text in files or input",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const pattern = args.positional[0] ?? args.value("pattern");
    if (!pattern) return bad("Select-String : Cannot bind argument to parameter 'Pattern' because it is null.");
    const rest = args.positional.slice(1);
    const paths = rest.length > 0 ? rest : args.value("path") ? [args.value("path") as string] : [];
    const caseSensitive = args.bool("casesensitive");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "" : "i");
    } catch {
      return bad(`Select-String : The string '${pattern}' is not a valid regular expression.`, 1);
    }

    const sources: { label: string; text: string }[] = [];
    if (paths.length === 0) {
      sources.push({ label: "(Pipeline input)", text: ctx.stdin });
    } else {
      for (const target of paths) {
        const canonical = ctx.resolve(target);
        const entry = get(ctx.platform, ctx.state.vfs, canonical);
        if (!entry) {
          // Fall back to glob expansion so `Select-String -Path *.log` works.
          for (const expanded of listDir(ctx.platform, ctx.state.vfs, ctx.state.machine.cwd)) {
            if (baseName(expanded.path).toLowerCase().includes(target.replace(/[*?]/g, "").toLowerCase())) {
              sources.push({ label: display(ctx.platform, expanded.path), text: expanded.content ?? "" });
            }
          }
          continue;
        }
        if (entry.type === "dir") {
          for (const child of listTree(ctx.platform, ctx.state.vfs, canonical)) {
            if (child.type === "file") sources.push({ label: display(ctx.platform, child.path), text: child.content ?? "" });
          }
          continue;
        }
        sources.push({ label: display(ctx.platform, entry.path), text: entry.content ?? "" });
      }
    }

    const lines: string[] = [];
    for (const source of sources) {
      source.text.split("\n").forEach((text, index) => {
        if (regex.test(text)) lines.push(`${source.label}:${index + 1}:${text}`);
      });
    }
    return { stdout: lines.join("\n"), stderr: "", exitCode: lines.length > 0 ? 0 : 1 };
  },
};

const MeasureObject: CommandSpec = {
  name: "Measure-Object",
  aliases: ["measure"],
  summary: "measure objects",
  run(ctx) {
    const lines = ctx.stdin.split("\n").filter((l) => l !== "");
    const numbers = lines.map(Number).filter((n) => !Number.isNaN(n));
    const parts = [
      "",
      "Count    : " + lines.length,
    ];
    if (numbers.length > 0) {
      parts.push(
        "Average  : " + (numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(4),
        "Sum      : " + numbers.reduce((a, b) => a + b, 0),
        "Maximum  : " + Math.max(...numbers),
        "Minimum  : " + Math.min(...numbers),
      );
    }
    return ok([...parts, ""].join("\n"));
  },
};

const SortObject: CommandSpec = {
  name: "Sort-Object",
  aliases: ["sort"],
  summary: "sort input",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const descending = args.bool("descending") || args.has("desc");
    const property = args.value("property");
    let lines = ctx.stdin.split("\n").filter((l) => l !== "");
    if (property) {
      const index = Number(property.replace(/\D/g, "")) || 1;
      lines = [...lines].sort((a, b) => {
        const left = a.split(/\s{2,}|\t/)[index - 1] ?? a;
        const right = b.split(/\s{2,}|\t/)[index - 1] ?? b;
        const ln = Number(left);
        const rn = Number(right);
        if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln - rn;
        return left.localeCompare(right);
      });
    } else {
      lines = [...lines].sort();
    }
    if (descending) lines.reverse();
    return ok(lines.join("\n"));
  },
};

const SelectObject: CommandSpec = {
  name: "Select-Object",
  aliases: ["select"],
  summary: "select properties",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const first = args.value("first");
    const last = args.value("last");
    let lines = ctx.stdin.split("\n");
    if (first) lines = lines.slice(0, Number(first));
    if (last) lines = lines.slice(-Number(last));
    return ok(lines.join("\n"));
  },
};

const WhereObject: CommandSpec = {
  name: "Where-Object",
  aliases: ["where", "?"],
  summary: "filter input",
  run(ctx) {
    const pattern = ctx.args.join(" ");
    const match = /-?(Match|Like|Contains|Eq|Ne)\s+['"]?(.+?)['"]?$/i.exec(pattern);
    const lines = ctx.stdin.split("\n").filter((line) => line !== "");
    if (!match) return ok(lines.join("\n"));
    const [, operator, needle] = match;
    const filtered = lines.filter((line) => {
      switch (operator.toLowerCase()) {
        case "eq":
          return line.trim() === needle;
        case "ne":
          return line.trim() !== needle;
        case "contains":
          return line.toLowerCase().includes(needle.toLowerCase());
        default: {
          const regex = new RegExp(needle.replace(/\*/g, ".*").replace(/\?/g, "."), "i");
          return regex.test(line);
        }
      }
    });
    return ok(filtered.join("\n"));
  },
};

const GetItemProperty: CommandSpec = {
  name: "Get-ItemProperty",
  aliases: ["gp"],
  summary: "read registry values",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const path = args.positional[0] ?? args.value("path");
    if (!path) return bad("Get-ItemProperty : Cannot bind argument to parameter 'Path' because it is null.");
    const entries = registryEntries(ctx.state, path);
    if (entries.length === 0) {
      return bad(`Get-ItemProperty : Cannot find path '${path}' because it does not exist.`, 1);
    }
    const nameFilter = args.value("name");
    const selected = nameFilter ? entries.filter((e) => e.name.toLowerCase() === nameFilter.toLowerCase()) : entries;
    if (nameFilter && selected.length === 0) {
      return bad(`Get-ItemProperty : Property ${nameFilter} does not exist at path ${path}.`, 1);
    }
    return ok(
      [
        "",
        `    Hive: ${normalizeRegistryPath(path)}`,
        "",
        ...selected.map((entry) => `${entry.name.padEnd(20)} : ${Array.isArray(entry.value) ? entry.value.join(" ") : entry.value}`),
        "",
      ].join("\n"),
    );
  },
};

const SetItemProperty: CommandSpec = {
  name: "Set-ItemProperty",
  aliases: ["sp"],
  summary: "write a registry value",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Set-ItemProperty");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const path = args.positional[0] ?? args.value("path");
    const name = args.positional[1] ?? args.value("name");
    const value = args.positional[2] ?? args.value("value");
    if (!path || !name) return bad("Set-ItemProperty : Cannot bind argument to parameter 'Name' because it is null.");
    const normal = normalizeRegistryPath(path);
    const existing = registryEntries(ctx.state, path).find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    const numeric = Number(value);
    if (existing) {
      existing.value = value !== undefined && !Number.isNaN(numeric) ? numeric : value ?? "";
    } else {
      ctx.state.machine.registry.push({
        path: normal,
        name,
        type: Number.isNaN(numeric) ? "String" : "DWord",
        value: Number.isNaN(numeric) ? value ?? "" : numeric,
      });
    }
    return ok("");
  },
};

const NewItemProperty: CommandSpec = {
  name: "New-ItemProperty",
  aliases: ["np"],
  summary: "create a registry value",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "New-ItemProperty");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const path = args.positional[0] ?? args.value("path");
    const name = args.value("name");
    const value = args.value("value") ?? "";
    if (!path || !name) return bad("New-ItemProperty : Cannot bind argument to parameter 'Name' because it is null.");
    const numeric = Number(value);
    ctx.state.machine.registry.push({
      path: normalizeRegistryPath(path),
      name,
      type: (args.value("propertytype") as RegistryValue["type"]) ?? (Number.isNaN(numeric) ? "String" : "DWord"),
      value: Number.isNaN(numeric) ? value : numeric,
    });
    return ok("");
  },
};

const RemoveItemProperty: CommandSpec = {
  name: "Remove-ItemProperty",
  aliases: ["rp"],
  summary: "delete a registry value",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Remove-ItemProperty");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const path = args.value("path") ?? args.positional[0];
    const name = args.value("name") ?? args.positional[1];
    if (!path || !name) return bad("Remove-ItemProperty : Cannot bind argument to parameter 'Name' because it is null.");
    const normal = normalizeRegistryPath(path);
    const before = ctx.state.machine.registry.length;
    ctx.state.machine.registry = ctx.state.machine.registry.filter(
      (entry) => !(entry.path.toLowerCase() === normal.toLowerCase() && entry.name.toLowerCase() === name.toLowerCase()),
    );
    if (ctx.state.machine.registry.length === before) {
      return bad(`Remove-ItemProperty : Property ${name} does not exist at path ${path}.`, 1);
    }
    return ok("");
  },
};

/* -------------------------------------------------------------------------- */
/*  Services & processes                                                      */
/* -------------------------------------------------------------------------- */

const GetService: CommandSpec = {
  name: "Get-Service",
  aliases: ["gsv"],
  summary: "list services",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const filter = args.positional[0];
    const services = ctx.state.machine.services.filter((service) => {
      if (!filter) return true;
      const needle = filter.replace(/[*?]/g, "").toLowerCase();
      return service.name.toLowerCase().includes(needle) || (service.displayName ?? "").toLowerCase().includes(needle);
    });
    if (services.length === 0) {
      return bad(`Get-Service : Cannot find any service with service name '${filter}'.`, 1);
    }
    const rows: string[][] = [["Status", "Name", "DisplayName"], ["------", "----", "-----------"]];
    for (const service of services) {
      rows.push([service.active ? "Running" : "Stopped", service.name, service.displayName ?? service.name]);
    }
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

function serviceAction(ctx: CommandContext, cmdlet: string, action: "start" | "stop" | "restart" | "pause"): CommandResult {
  const adminCheck = requireAdmin(ctx, cmdlet);
  if (adminCheck) return adminCheck;
  const args = bindArgs(ctx.args);
  const names = args.positional.length > 0 ? args.positional : [args.value("name") ?? ""];
  const outs: string[] = [];
  for (const raw of names) {
    if (!raw) return bad(`${cmdlet} : Cannot bind argument to parameter 'Name' because it is null.`);
    const service = ctx.state.machine.services.find((s) => s.name.toLowerCase() === raw.toLowerCase() || (s.displayName ?? "").toLowerCase() === raw.toLowerCase());
    if (!service) {
      return bad(
        `${cmdlet} : Cannot find any service with service name '${raw}'.\n    + CategoryInfo          : ObjectNotFound: (${raw}:String) [${cmdlet}], ServiceCommandException`,
        1,
      );
    }
    if (action === "start" || action === "restart") {
      service.active = true;
      service.startupType = service.startupType === "Disabled" ? "Manual" : service.startupType;
      ctx.state.machine.notices.push(`${service.name} service started.`);
    } else {
      service.active = false;
    }
    outs.push(`Status   Name               DisplayName\n------   ----               -----------\n${service.active ? "Running" : "Stopped"}  ${service.name.padEnd(18)} ${service.displayName ?? service.name}`);
  }
  return ok(outs.join("\n"));
}

const StartService: CommandSpec = {
  name: "Start-Service",
  aliases: ["sasv"],
  summary: "start a service",
  run: (ctx) => serviceAction(ctx, "Start-Service", "start"),
};

const StopService: CommandSpec = {
  name: "Stop-Service",
  aliases: ["spsv"],
  summary: "stop a service",
  run: (ctx) => serviceAction(ctx, "Stop-Service", "stop"),
};

const RestartService: CommandSpec = {
  name: "Restart-Service",
  aliases: ["srsv"],
  summary: "restart a service",
  run: (ctx) => serviceAction(ctx, "Restart-Service", "restart"),
};

const SetService: CommandSpec = {
  name: "Set-Service",
  summary: "change a service's startup type",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Set-Service");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.positional[0] ?? args.value("name");
    const startup = args.value("startuptype");
    const status = args.value("status");
    if (!name) return bad("Set-Service : Cannot bind argument to parameter 'Name' because it is null.");
    const service = ctx.state.machine.services.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!service) return bad(`Set-Service : Service '${name}' was not found.`, 1);
    if (startup) {
      service.startupType = (startup[0].toUpperCase() + startup.slice(1).toLowerCase()) as "Automatic" | "Manual" | "Disabled";
      service.enabled = startup.toLowerCase() !== "disabled";
      if (service.startupType === "Disabled") service.active = false;
    }
    if (status) {
      if (status.toLowerCase() === "running") service.active = true;
      if (status.toLowerCase() === "stopped") service.active = false;
    }
    return ok("");
  },
};

const GetProcess: CommandSpec = {
  name: "Get-Process",
  aliases: ["gps", "ps"],
  summary: "list running processes",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const filter = args.positional[0];
    const rows: string[][] = [["Handles", "NPM(K)", "PM(K)", "WS(K)", "CPU(s)", "Id", "ProcessName"], ["-------", "------", "-----", "-----", "------", "--", "-----------"]];
    for (const process of ctx.state.machine.processes) {
      const name = baseName(process.command.split(" ")[0]).replace(/\.exe$/i, "");
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
      rows.push([
        String(120 + process.pid % 400),
        String(Math.round(process.mem * 12)),
        String(Math.round(process.mem * 2048)),
        String(Math.round(process.mem * 4096)),
        process.cpu.toFixed(2),
        String(process.pid),
        name,
      ]);
    }
    if (rows.length === 2) return bad(`Get-Process : Cannot find a process with the name "${filter}". Verify the process name and call the cmdlet again.`, 1);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const StopProcess: CommandSpec = {
  name: "Stop-Process",
  aliases: ["spps", "kill"],
  summary: "stop a process",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const names = args.positional.length > 0 ? args.positional : [args.value("name") ?? args.value("id") ?? ""];
    for (const raw of names) {
      const index = ctx.state.machine.processes.findIndex(
        (p) => String(p.pid) === raw || baseName(p.command.split(" ")[0]).toLowerCase() === `${raw.toLowerCase()}.exe`,
      );
      if (index < 0) return bad(`Stop-Process : Cannot find a process with the name "${raw}". Verify the process name and call the cmdlet again.`, 1);
      const [removed] = ctx.state.machine.processes.splice(index, 1);
      ctx.state.machine.notices.push(`Process ${removed.pid} (${removed.command}) stopped.`);
    }
    return ok("");
  },
};

/* -------------------------------------------------------------------------- */
/*  Accounts                                                                  */
/* -------------------------------------------------------------------------- */

const GetLocalUser: CommandSpec = {
  name: "Get-LocalUser",
  aliases: ["glu"],
  summary: "list local accounts",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const filter = args.positional[0];
    const users = ctx.state.machine.users.filter((user) => !filter || user.name.toLowerCase().includes(filter.replace(/\*/g, "").toLowerCase()));
    if (users.length === 0) return bad(`Get-LocalUser : User ${filter} was not found.`, 1);
    const rows: string[][] = [["Name", "Enabled", "Description"], ["----", "-------", "-----------"]];
    for (const user of users) {
      rows.push([user.name, user.enabled === false ? "False" : "True", user.description ?? user.fullName ?? ""]);
    }
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const NewLocalUser: CommandSpec = {
  name: "New-LocalUser",
  aliases: ["nlu"],
  summary: "create a local account",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "New-LocalUser");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.positional[0] ?? args.value("name");
    if (!name) return bad("New-LocalUser : Cannot bind argument to parameter 'Name' because it is null.");
    if (findUser(ctx.state, name)) {
      return bad(`New-LocalUser : Cannot create a user with the name ${name} because it already exists.`, 1);
    }
    const password = args.value("password");
    ctx.state.machine.users.push({
      name,
      uid: 1001 + ctx.state.machine.users.length,
      gid: 545,
      groups: ["Users"],
      shell: "cmd.exe",
      home: `/c:/users/${name.toLowerCase()}`,
      description: args.value("description") ?? "Created by the student in this simulation",
      passwordHash: password ? simulatedPasswordHash() : null,
      locked: false,
      enabled: true,
    });
    ctx.state.machine.notices.push(`Local user ${name} created.`);
    return ok(
      [
        "",
        `Name            Enabled Description`,
        `----            ------- -----------`,
        `${name.padEnd(16)}True    ${args.value("description") ?? ""}`,
        "",
      ].join("\n"),
    );
  },
};

const SetLocalUser: CommandSpec = {
  name: "Set-LocalUser",
  summary: "modify a local account",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Set-LocalUser");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.positional[0] ?? args.value("name");
    const user = findUser(ctx.state, name ?? "");
    if (!user) return bad(`Set-LocalUser : User ${name} was not found.`, 1);
    if (args.has("password")) user.passwordHash = simulatedPasswordHash();
    if (args.has("description")) user.description = args.value("description");
    if (args.has("fullname")) user.fullName = args.value("fullname");
    return ok("");
  },
};

const EnableLocalUser: CommandSpec = {
  name: "Enable-LocalUser",
  summary: "enable a local account",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Enable-LocalUser");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const user = findUser(ctx.state, args.positional[0] ?? args.value("name") ?? "");
    if (!user) return bad(`Enable-LocalUser : User ${args.positional[0]} was not found.`, 1);
    user.enabled = true;
    user.locked = false;
    return ok("");
  },
};

const DisableLocalUser: CommandSpec = {
  name: "Disable-LocalUser",
  summary: "disable a local account",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Disable-LocalUser");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const user = findUser(ctx.state, args.positional[0] ?? args.value("name") ?? "");
    if (!user) return bad(`Disable-LocalUser : User ${args.positional[0]} was not found.`, 1);
    user.enabled = false;
    user.locked = true;
    return ok("");
  },
};

const RemoveLocalUser: CommandSpec = {
  name: "Remove-LocalUser",
  summary: "delete a local account",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Remove-LocalUser");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.positional[0] ?? args.value("name") ?? "";
    if (!findUser(ctx.state, name)) return bad(`Remove-LocalUser : User ${name} was not found.`, 1);
    ctx.state.machine.users = ctx.state.machine.users.filter((u) => u.name.toLowerCase() !== name.toLowerCase());
    return ok("");
  },
};

const AddLocalGroupMember: CommandSpec = {
  name: "Add-LocalGroupMember",
  summary: "add an account to a local group",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Add-LocalGroupMember");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const group = args.value("group") ?? args.positional[0];
    const members = (args.value("member") ?? args.positional.slice(1).join(",")).split(",");
    if (!group || members.length === 0) return bad("Add-LocalGroupMember : Cannot bind argument to parameter 'Member' because it is null.");
    for (const member of members) {
      const name = member.includes("\\") ? member.split("\\").pop() ?? member : member;
      const user = findUser(ctx.state, name);
      if (!user) return bad(`Add-LocalGroupMember : Principal ${member} was not found.`, 1);
      if (!user.groups.some((g) => g.toLowerCase() === group.toLowerCase())) user.groups.push(group);
    }
    ctx.state.machine.notices.push(`Added ${members.join(", ")} to ${group}.`);
    return ok("");
  },
};

const RemoveLocalGroupMember: CommandSpec = {
  name: "Remove-LocalGroupMember",
  summary: "remove an account from a local group",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Remove-LocalGroupMember");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const group = args.value("group") ?? args.positional[0];
    const members = (args.value("member") ?? args.positional.slice(1).join(",")).split(",");
    for (const member of members) {
      const name = member.includes("\\") ? member.split("\\").pop() ?? member : member;
      const user = findUser(ctx.state, name);
      if (!user) return bad(`Remove-LocalGroupMember : Principal ${member} was not found.`, 1);
      user.groups = user.groups.filter((g) => g.toLowerCase() !== group.toLowerCase());
    }
    return ok("");
  },
};

const GetLocalGroupMember: CommandSpec = {
  name: "Get-LocalGroupMember",
  summary: "list members of a local group",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const group = args.value("group") ?? args.positional[0];
    if (!group) return bad("Get-LocalGroupMember : Cannot bind argument to parameter 'Group' because it is null.");
    const members = ctx.state.machine.users.filter((user) => user.groups.some((g) => g.toLowerCase() === group.toLowerCase()));
    if (members.length === 0) {
      return bad(`Get-LocalGroupMember : Group ${group} not found or has no members.`, 1);
    }
    const rows: string[][] = [["ObjectClass", "Name", "PrincipalSource"], ["-----------", "----", "---------------"]];
    for (const member of members) rows.push(["User", `${ctx.state.machine.hostname}\\${member.name}`, "Local"]);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const net: CommandSpec = {
  name: "net",
  summary: "manage users, groups and shares",
  run(ctx) {
    const [object, action, ...rest] = ctx.args;

    if (object === "user") {
      if (!action) return ok(netUserTable(ctx));
      if (action === "/add") {
        const name = rest[0];
        if (!name) return bad("The syntax of this command is:\n\nNET USER [username [password | *] [options]] [/DOMAIN]", 2);
        const adminCheck = requireAdmin(ctx, "net user");
        if (adminCheck) return adminCheck;
        if (findUser(ctx.state, name)) return bad(`The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.`, 2);
        ctx.state.machine.users.push({
          name,
          uid: 1001 + ctx.state.machine.users.length,
          gid: 545,
          groups: ["Users"],
          shell: "cmd.exe",
          home: `/c:/users/${name.toLowerCase()}`,
          passwordHash: simulatedPasswordHash(),
          locked: false,
          enabled: true,
        });
        return ok("The command completed successfully.");
      }
      if (action === "/delete") {
        const adminCheck = requireAdmin(ctx, "net user");
        if (adminCheck) return adminCheck;
        ctx.state.machine.users = ctx.state.machine.users.filter((u) => u.name.toLowerCase() !== (rest[0] ?? "").toLowerCase());
        return ok("The command completed successfully.");
      }
      const user = findUser(ctx.state, action);
      if (!user) return bad(`The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.`, 2);
      const lines = [
        `User name                    ${user.name}`,
        `Full Name                    ${user.fullName ?? ""}`,
        `Comment                      ${user.description ?? ""}`,
        `User's comment`,
        `Country/region code          000 (System Default)`,
        `Account active               ${user.enabled === false ? "No" : "Yes"}`,
        `Account expires              Never`,
        ``,
        `Password required            Yes`,
        `Local Group Memberships      ${user.groups.join(" *")}`,
        `Global Group memberships     *None`,
        `The command completed successfully.`,
      ];
      return ok(lines.join("\n"));
    }

    if (object === "localgroup") {
      if (!action) {
        return ok(
          [
            "Aliases for \\\\" + ctx.state.machine.hostname,
            "",
            "-------------------------------------------------------------------------------",
            "*Administrators",
            "*Backup Operators",
            "*Guests",
            "*Remote Desktop Users",
            "*Users",
            "The command completed successfully.",
          ].join("\n"),
        );
      }
      if (action === "/add" || action === "/delete") {
        const adminCheck = requireAdmin(ctx, "net localgroup");
        if (adminCheck) return adminCheck;
        const group = rest[0];
        const member = rest[1];
        if (action === "/add" && group && member === undefined) {
          ctx.state.machine.notices.push(`Local group ${group} created.`);
          return ok("The command completed successfully.");
        }
        const user = findUser(ctx.state, member?.split("\\").pop() ?? "");
        if (!user) return bad("The specified account name is not a member of the group.", 2);
        if (action === "/add") {
          if (!user.groups.some((g) => g.toLowerCase() === group.toLowerCase())) user.groups.push(group);
        } else {
          user.groups = user.groups.filter((g) => g.toLowerCase() !== group.toLowerCase());
        }
        return ok("The command completed successfully.");
      }
      const members = ctx.state.machine.users.filter((user) => user.groups.some((g) => g.toLowerCase() === action.toLowerCase()));
      return ok(
        [
          `Alias name     ${action}`,
          `Comment        ${action === "Administrators" ? "Administrators have complete and unrestricted access" : ""}`,
          "",
          "Members",
          "",
          "-------------------------------------------------------------------------------",
          ...members.map((m) => m.name),
          "The command completed successfully.",
        ].join("\n"),
      );
    }

    if (object === "share") {
      if (!action) {
        return ok(
          [
            "Share name   Resource                        Remark",
            "",
            "-------------------------------------------------------------------------------",
            ...ctx.state.machine.shares.map((share) => `${share.name.padEnd(13)}${share.path.padEnd(32)}${share.description ?? ""}`),
            "The command completed successfully.",
          ].join("\n"),
        );
      }
      return bad("The syntax of this command is:\n\nNET SHARE\nsharename [=path] [/REMARK:\"text\"] [/GRANT:user,[READ|CHANGE|FULL]]", 2);
    }

    if (object === "stop" || object === "start") {
      const serviceName = rest[0];
      const service = ctx.state.machine.services.find((s) => s.name.toLowerCase() === (serviceName ?? "").toLowerCase());
      if (!service) return bad(`The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.`, 2);
      service.active = object === "start";
      return ok(`The ${service.displayName ?? service.name} service was ${object === "start" ? "started" : "stopped"} successfully.`);
    }

    if (object === "accounts") {
      return ok("Force user logoff how long after time expires?:       Never\nMinimum password age (days):                          0\nMaximum password age (days):                          42\nMinimum password length:                              0\nLength of password history maintained:                None\nThe command completed successfully.");
    }

    if (object === "view") {
      return ok("There are no entries in the list.");
    }

    return bad("The syntax of this command is:\n\nNET [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]", 2);
  },
};

function netUserTable(ctx: CommandContext): string {
  const rows: string[][] = [];
  const names = ctx.state.machine.users.map((u) => u.name);
  for (let i = 0; i < names.length; i += 3) {
    rows.push(names.slice(i, i + 3).map((n) => n.padEnd(22)));
  }
  return [
    "User accounts for \\\\" + ctx.state.machine.hostname,
    "",
    "-------------------------------------------------------------------------------",
    formatRows(rows),
    "The command completed successfully.",
  ].join("\n");
}

const GetAdUser: CommandSpec = {
  name: "Get-ADUser",
  aliases: ["gau"],
  summary: "read Active Directory accounts",
  run(ctx) {
    if (!ctx.state.machine.env.DOMAIN) {
      return bad(
        "Get-ADUser : The term 'Get-ADUser' is not recognized as the name of a cmdlet, function, script file, or operable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.",
        1,
      );
    }
    const args = bindArgs(ctx.args);
    const identity = args.value("identity") ?? args.positional[0];
    const filter = args.value("filter");
    const users = identity
      ? ctx.state.machine.users.filter((u) => u.name.toLowerCase() === identity.toLowerCase())
      : ctx.state.machine.users;
    if (identity && users.length === 0) {
      return bad(`Get-ADUser : Cannot find an object with identity: '${identity}' under: 'DC=${(ctx.state.machine.env.DOMAIN ?? "").toLowerCase()},DC=local'.`, 1);
    }
    const rows: string[][] = [["DistinguishedName", "Enabled", "Name", "SamAccountName"], ["-----------------", "-------", "----", "--------------"]];
    for (const user of users) {
      rows.push([
        `CN=${user.fullName ?? user.name},CN=Users,DC=${(ctx.state.machine.env.DOMAIN ?? "").toLowerCase()},DC=local`,
        user.enabled === false ? "False" : "True",
        user.fullName ?? user.name,
        user.name,
      ]);
    }
    void filter;
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Networking                                                                */
/* -------------------------------------------------------------------------- */

const ipconfig: CommandSpec = {
  name: "ipconfig",
  summary: "display IP configuration",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const detail = args.has("all");
    const lines = [
      "",
      "Windows IP Configuration",
      "",
      `   Host Name . . . . . . . . . . . . : ${ctx.state.machine.hostname}`,
      `   Primary Dns Suffix  . . . . . . . : ${ctx.state.machine.env.DOMAIN ?? ""}`,
      `   Node Type . . . . . . . . . . . . : Hybrid`,
      `   IP Routing Enabled. . . . . . . . : No`,
      `   WINS Proxy Enabled. . . . . . . . : No`,
      "",
      "Ethernet adapter Ethernet0:",
      "",
      `   Connection-specific DNS Suffix  . : ${ctx.state.machine.env.DOMAIN ?? "local"}`,
      `   Description . . . . . . . . . . . : Microsoft Hyper-V Network Adapter`,
      `   Physical Address. . . . . . . . . : 00-15-5D-8F-2A-1C`,
      `   DHCP Enabled. . . . . . . . . . . : Yes`,
      `   Autoconfiguration Enabled . . . . : Yes`,
      `   IPv4 Address. . . . . . . . . . . : 10.10.10.42(Preferred)`,
      `   Subnet Mask . . . . . . . . . . . : 255.255.255.0`,
      `   Default Gateway . . . . . . . . . : 10.10.10.1`,
      `   DNS Servers . . . . . . . . . . . : 10.10.10.1`,
    ];
    if (detail) {
      lines.push(
        `   NetBIOS over Tcpip. . . . . . . . : Enabled`,
        `   Lease Obtained. . . . . . . . . . : ${new Date().toDateString()} ${new Date().toTimeString().slice(0, 5)}`,
      );
    }
    return ok(lines.join("\n"));
  },
};

const GetNetIPAddress: CommandSpec = {
  name: "Get-NetIPAddress",
  aliases: ["Get-NetIPConfiguration"],
  summary: "read IP addresses",
  run() {
    const rows: string[][] = [
      ["IPAddress", "InterfaceAlias", "PrefixLength", "AddressFamily"],
      ["---------", "--------------", "------------", "-------------"],
      ["10.10.10.42", "Ethernet0", "24", "IPv4"],
      ["127.0.0.1", "Loopback Pseudo-Interface 1", "8", "IPv4"],
    ];
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const TestConnection: CommandSpec = {
  name: "Test-Connection",
  aliases: ["ping"],
  summary: "send ICMP echo requests",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("computername") ?? "127.0.0.1";
    const count = Number(args.value("count") ?? 4);
    const quiet = args.bool("quiet");
    const rows: string[][] = [["Source", "Destination", "IPV4Address", "Bytes", "Time(ms)"], ["------", "-----------", "-----------", "-----", "---------"]];
    for (let i = 0; i < count; i += 1) {
      rows.push([ctx.state.machine.hostname, target, "10.10.10.1", "32", String(1 + i)]);
    }
    if (quiet) return ok("True");
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const ResolveDnsName: CommandSpec = {
  name: "Resolve-DnsName",
  aliases: ["nslookup"],
  summary: "resolve a DNS name",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const name = args.positional[0] ?? args.value("name");
    if (!name) return bad("Resolve-DnsName : Cannot bind argument to parameter 'Name' because it is null.");
    const zone: Record<string, string> = {
      "ontrak.local": "10.10.10.24",
      "mail.ontrak.local": "10.10.10.24",
      "localhost": "127.0.0.1",
    };
    const address = zone[name] ?? "10.10.10.1";
    const rows: string[][] = [
      ["Name", "Type", "TTL", "Section", "IPAddress"],
      ["----", "----", "---", "-------", "---------"],
      [name, "A", "600", "Answer", address],
    ];
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const GetNetFirewallRule: CommandSpec = {
  name: "Get-NetFirewallRule",
  aliases: ["Get-NetFirewallProfile"],
  summary: "list firewall rules",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const filter = args.value("displayname");
    const rules = ctx.state.machine.firewall.filter((rule) => !filter || rule.name.toLowerCase().includes(filter.replace(/\*/g, "").toLowerCase()));
    if (rules.length === 0) return ok("");
    const rows: string[][] = [["Name", "DisplayName", "Enabled", "Direction", "Action"], ["----", "-----------", "-------", "---------", "------"]];
    for (const rule of rules) {
      rows.push([rule.name, rule.name, rule.enabled ? "True" : "False", rule.direction === "in" ? "Inbound" : "Outbound", rule.action === "allow" ? "Allow" : "Block"]);
    }
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const NewNetFirewallRule: CommandSpec = {
  name: "New-NetFirewallRule",
  summary: "create a firewall rule",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "New-NetFirewallRule");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const displayName = args.value("displayname") ?? args.value("name");
    if (!displayName) return bad("New-NetFirewallRule : Cannot bind argument to parameter 'DisplayName' because it is null.");
    const localPort = args.value("localport");
    const direction = (args.value("direction") ?? "inbound").toLowerCase().startsWith("out") ? "out" : "in";
    const action = (args.value("action") ?? "allow").toLowerCase().startsWith("block") ? "deny" : "allow";
    const protocol = (args.value("protocol") ?? "tcp").toLowerCase() as FirewallRule["protocol"];
    const existing = ctx.state.machine.firewall.find((rule) => rule.name.toLowerCase() === displayName.toLowerCase());
    if (existing) {
      existing.action = action;
      existing.enabled = true;
      existing.port = localPort ?? existing.port;
      existing.direction = direction;
    } else {
      ctx.state.machine.firewall.push({
        name: displayName,
        direction,
        action,
        protocol: ["tcp", "udp", "icmp"].includes(protocol) ? protocol : "any",
        port: localPort,
        enabled: true,
      });
    }
    ctx.state.machine.notices.push(`Firewall rule "${displayName}" created.`);
    return ok("");
  },
};

const firewallToggle = (cmdlet: string, enabled: boolean): CommandSpec => ({
  name: cmdlet,
  summary: enabled ? "enable firewall rules" : "disable firewall rules",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, cmdlet);
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const filter = args.value("displayname") ?? args.value("name");
    const targets = ctx.state.machine.firewall.filter((rule) => !filter || rule.name.toLowerCase().includes(filter.replace(/\*/g, "").toLowerCase()));
    if (targets.length === 0 && filter) {
      return bad(`${cmdlet} : No MSFT_NetFirewallRule objects found with property 'DisplayName' equal to '${filter}'.`, 1);
    }
    for (const rule of targets) rule.enabled = enabled;
    ctx.state.machine.notices.push(`${targets.length} firewall rule(s) ${enabled ? "enabled" : "disabled"}.`);
    return ok("");
  },
});

const GetSmbShare: CommandSpec = {
  name: "Get-SmbShare",
  summary: "list SMB shares",
  run(ctx) {
    const rows: string[][] = [["Name", "ScopeName", "Path", "Description"], ["----", "---------", "----", "-----------"]];
    for (const share of ctx.state.machine.shares) rows.push([share.name, "*", share.path, share.description ?? ""]);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const NewSmbShare: CommandSpec = {
  name: "New-SmbShare",
  summary: "create an SMB share",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "New-SmbShare");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.value("name") ?? args.positional[0];
    const path = args.value("path") ?? args.positional[1];
    if (!name || !path) return bad("New-SmbShare : Cannot bind argument to parameter 'Name' because it is null.");
    if (ctx.state.machine.shares.some((share) => share.name.toLowerCase() === name.toLowerCase())) {
      return bad(`New-SmbShare : The share name '${name}' is already in use.`, 1);
    }
    if (!get(ctx.platform, ctx.state.vfs, ctx.resolve(path))) {
      return bad(`New-SmbShare : The path '${path}' does not exist.`, 1);
    }
    ctx.state.machine.shares.push({
      name,
      path: display(ctx.platform, ctx.resolve(path)),
      description: args.value("description") ?? args.value("fullaccess") ?? "",
      access: args.value("fullaccess") ?? "Everyone:Full",
    });
    ctx.state.machine.notices.push(`SMB share "${name}" created.`);
    return ok("");
  },
};

const RemoveSmbShare: CommandSpec = {
  name: "Remove-SmbShare",
  summary: "delete an SMB share",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Remove-SmbShare");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.value("name") ?? args.positional[0];
    const before = ctx.state.machine.shares.length;
    ctx.state.machine.shares = ctx.state.machine.shares.filter((share) => share.name.toLowerCase() !== (name ?? "").toLowerCase());
    if (before === ctx.state.machine.shares.length) return bad(`Remove-SmbShare : No MSFT_SmbShare objects found with property 'Name' equal to '${name}'.`, 1);
    return ok("");
  },
};

/* -------------------------------------------------------------------------- */
/*  System information                                                        */
/* -------------------------------------------------------------------------- */

const GetComputerInfo: CommandSpec = {
  name: "Get-ComputerInfo",
  summary: "read system information",
  run(ctx) {
    const os = ctx.state.machine.os;
    return ok(
      [
        "",
        `WindowsBuildLabEx                                       : ${os.build}`,
        `WindowsEditionId                                       : Professional`,
        `WindowsProductName                                     : ${os.name}`,
        `WindowsVersion                                         : ${os.version}`,
        `CsDNSHostName                                          : ${ctx.state.machine.hostname}.${ctx.state.machine.env.DOMAIN ?? "local"}`,
        `CsDomain                                               : ${ctx.state.machine.env.DOMAIN ?? "WORKGROUP"}`,
        `CsName                                                 : ${ctx.state.machine.hostname}`,
        `CsProcessors                                           : {AMD64 Family 25 Model 1 Stepping 1, AuthenticAMD}`,
        `CsTotalPhysicalMemory                                  : 8589934592`,
        `OsArchitecture                                         : ${os.arch}`,
        `OsHardwareAbstractionLayer                             : 10.0.22621.2506`,
        "",
      ].join("\n"),
    );
  },
};

const GetCimInstance: CommandSpec = {
  name: "Get-CimInstance",
  aliases: ["gwmi"],
  summary: "query WMI/CIM",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const className = (args.value("classname") ?? args.positional[0] ?? "Win32_OperatingSystem").toLowerCase();
    const os = ctx.state.machine.os;
    if (className.includes("operatingsystem")) {
      return ok(
        [
          "",
          `SystemDirectory : C:\\Windows\\system32`,
          `Organization    : `,
          `BuildNumber     : ${os.build?.split(".")[1] ?? "22631"}`,
          `RegisteredUser  : student`,
          `SerialNumber    : 00330-80000-00000-AA123`,
          `Version         : ${os.version}`,
          `Caption         : ${os.name}`,
          "",
        ].join("\n"),
      );
    }
    if (className.includes("bios")) {
      return ok("\nSMBIOSBIOSVersion : Hyper-V UEFI Release v4.1\nSerialNumber      : 0000-0000-0000-0000-0000-0000-00\n");
    }
    if (className.includes("service")) {
      const rows: string[][] = [["Name", "State", "StartMode", "DisplayName"]];
      for (const service of ctx.state.machine.services) {
        rows.push([service.name, service.active ? "Running" : "Stopped", service.startupType ?? "Manual", service.displayName ?? service.name]);
      }
      return ok([...formatRows(rows).split("\n"), ""].join("\n"));
    }
    return bad(`Get-CimInstance : Invalid class "${args.positional[0] ?? ""}"`, 1);
  },
};

const GetEventLog: CommandSpec = {
  name: "Get-EventLog",
  aliases: ["Get-WinEvent"],
  summary: "read the event log",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const newest = Number(args.value("newest") ?? 5);
    const events = ctx.state.machine.events.slice(-newest);
    if (events.length === 0) return ok("");
    return ok(
      [
        "",
        ...events.map((event) =>
          [
            `   Index              : ${event.id}`,
            `   EntryType          : ${event.level === "error" ? "Error" : event.level === "warning" ? "Warning" : "Information"}`,
            `   Source             : ${event.source}`,
            `   TimeGenerated      : ${new Date(event.at).toString()}`,
            `   Message            : ${event.message}`,
            "",
          ].join("\n"),
        ),
      ].join("\n"),
    );
  },
};

const GetVolume: CommandSpec = {
  name: "Get-Volume",
  aliases: ["Get-PSDrive", "Get-Disk"],
  summary: "list volumes",
  run() {
    const rows: string[][] = [
      ["DriveLetter", "FileSystemLabel", "FileSystem", "Size", "SizeRemaining", "HealthStatus"],
      ["-----------", "---------------", "----------", "----", "-------------", "------------"],
      ["C", "Windows", "NTFS", "126.5 GB", "61.2 GB", "Healthy"],
    ];
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const GetDate: CommandSpec = {
  name: "Get-Date",
  summary: "show the current date and time",
  run() {
    return ok(new Date().toString());
  },
};

const SetExecutionPolicy: CommandSpec = {
  name: "Set-ExecutionPolicy",
  summary: "change the script execution policy",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Set-ExecutionPolicy");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const policy = args.positional[0] ?? args.value("executionpolicy");
    if (!policy) return bad("Set-ExecutionPolicy : Cannot bind argument to parameter 'ExecutionPolicy' because it is null.");
    ctx.state.machine.env.EXECUTION_POLICY = policy;
    return ok(
      [
        "Execution Policy Change",
        "The execution policy helps protect you from scripts that you do not trust. Changing the execution",
        "policy might expose you to the security risks described in the about_Execution_Policies help topic.",
        "",
        `The execution policy has been set to ${policy}.`,
      ].join("\n"),
    );
  },
};

const GetExecutionPolicy: CommandSpec = {
  name: "Get-ExecutionPolicy",
  summary: "read the script execution policy",
  run(ctx) {
    return ok(ctx.state.machine.env.EXECUTION_POLICY ?? "Restricted");
  },
};

const StartProcess: CommandSpec = {
  name: "Start-Process",
  aliases: ["saps"],
  summary: "start a program",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const filePath = args.positional[0] ?? args.value("filepath");
    if (!filePath) return bad("Start-Process : Cannot bind argument to parameter 'FilePath' because it is null.");
    const name = baseName(filePath.replace(/\\/g, "/"));
    ctx.state.machine.processes.push({
      pid: 4000 + ctx.state.machine.processes.length,
      user: ctx.user,
      cpu: 0.4,
      mem: 0.7,
      command: filePath,
    });
    ctx.state.machine.notices.push(`Started ${name}.`);
    return ok("");
  },
};

const StopComputer: CommandSpec = {
  name: "Restart-Computer",
  aliases: ["Stop-Computer"],
  summary: "restart the computer",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Restart-Computer");
    if (adminCheck) return adminCheck;
    ctx.state.machine.notices.push(
      "The machine would now restart. Services set to Automatic would start again automatically — that is what the grader checks.",
    );
    return ok("Restarting the computer in 5 seconds. Save your work.");
  },
};

const ClearHost: CommandSpec = {
  name: "Clear-Host",
  aliases: ["cls", "clear"],
  summary: "clear the console",
  run() {
    return { stdout: "", stderr: "", exitCode: 0, clear: true };
  },
};

const WriteOutput: CommandSpec = {
  name: "Write-Output",
  aliases: ["write", "echo"],
  summary: "write to the output stream",
  run(ctx) {
    return ok(ctx.args.join(" ").replace(/^["']|["']$/g, ""));
  },
};

const WriteHost: CommandSpec = {
  name: "Write-Host",
  summary: "write to the host",
  run(ctx) {
    return ok(ctx.args.join(" ").replace(/^["']|["']$/g, ""));
  },
};

const GetHelp: CommandSpec = {
  name: "Get-Help",
  aliases: ["help", "man"],
  summary: "show help for a cmdlet",
  run(ctx, registry) {
    const name = ctx.args.find((a) => !a.startsWith("-"));
    if (!name) {
      const names = registry.all().map((spec) => spec.name);
      const rows: string[][] = [];
      for (let i = 0; i < names.length; i += 3) rows.push(names.slice(i, i + 3).map((n) => n.padEnd(24)));
      return ok(["", "OnTrak IT Support Training Windows simulator — available cmdlets:", "", formatRows(rows), ""].join("\n"));
    }
    const spec = registry.get(name);
    if (!spec) {
      return bad(`Get-Help : Get-Help could not find ${name} in a help file in this session.`, 1);
    }
    return ok(
      [
        "",
        "NAME",
        `    ${spec.name}`,
        "",
        "SYNOPSIS",
        `    ${spec.summary ?? "No synopsis available."}`,
        "",
        "DESCRIPTION",
        "    Simulated cmdlet provided by the OnTrak IT Support Training engine.",
        "",
        "REMARKS",
        "    Check the scenario briefing for the exact requirements.",
        "",
      ].join("\n"),
    );
  },
};

const GetCommand: CommandSpec = {
  name: "Get-Command",
  aliases: ["gcm"],
  summary: "list available commands",
  run(ctx, registry) {
    const filter = ctx.args.find((a) => !a.startsWith("-"));
    const specs = registry.all().filter((spec) => {
      if (!filter) return true;
      const needle = filter.replace(/[*?]/g, "").toLowerCase();
      return spec.name.toLowerCase().includes(needle) || (spec.aliases ?? []).some((a) => a.includes(needle));
    });
    if (specs.length === 0) return bad(`Get-Command : The term '${filter}' is not recognized as a name of a cmdlet, function, script file, or executable program.`, 1);
    const rows: string[][] = [["CommandType", "Name", "Version", "Source"], ["-----------", "----", "-------", "------"]];
    for (const spec of specs) rows.push(["Cmdlet", spec.name, "3.1.0.0", "Microsoft.PowerShell.Management"]);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const GetModule: CommandSpec = {
  name: "Get-Module",
  aliases: ["Import-Module"],
  summary: "list loaded modules",
  run(ctx) {
    const rows: string[][] = [["ModuleType", "Version", "Name", "ExportedCommands"], ["----------", "-------", "----", "----------------"]];
    rows.push(["Manifest", "3.1.0.0", "Microsoft.PowerShell.Management", "{Add-Content, Clear-Content...}"]);
    rows.push(["Manifest", "3.0.0.0", "Microsoft.PowerShell.Security", "{Get-Acl, Set-Acl...}"]);
    if (ctx.state.machine.env.DOMAIN) rows.push(["Manifest", "1.0.1.0", "ActiveDirectory", "{Get-ADUser, Get-ADGroup...}"]);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const gpupdate: CommandSpec = {
  name: "gpupdate",
  run(ctx) {
    if (!isAdmin(ctx)) return bad("Updating policy...\n\nComputer Policy update has not been applied successfully.", 1);
    return ok("Updating policy...\n\nComputer Policy update has completed successfully.\nUser Policy update has completed successfully.");
  },
};

const gpresult: CommandSpec = {
  name: "gpresult",
  summary: "display applied group policy",
  run(ctx) {
    return ok(
      [
        "",
        "Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0",
        "",
        "OS Configuration:          Member Workstation",
        `OS Version:                ${ctx.state.machine.os.version}`,
        `Site Name:                 Default-First-Site-Name`,
        `Applied Group Policy Objects`,
        `-----------------------------`,
        `    Default Domain Policy`,
        `    Local Group Policy`,
        "",
      ].join("\n"),
    );
  },
};

const winget: CommandSpec = {
  name: "winget",
  summary: "Windows Package Manager",
  run(ctx) {
    const [action, ...rest] = ctx.args.filter((a) => !a.startsWith("-"));
    if (action === "install") {
      const id = rest[0];
      if (!id) return bad("winget: no package specified", 1);
      const pkg = ctx.state.machine.packages.find((p) => p.name.toLowerCase() === id.toLowerCase());
      if (pkg) pkg.installed = true;
      else ctx.state.machine.packages.push({ name: id, version: "latest", installed: true, description: `${id} installed via winget` });
      ctx.state.machine.notices.push(`Installed ${id}.`);
      return ok(`Found ${id} [winget]\nDownloading...\n  ██████████████████████████████  25.4 MB / 25.4 MB\nSuccessfully installed`);
    }
    if (action === "list" || !action) {
      const rows: string[][] = [["Name", "Id", "Version", "Source"], ["----", "--", "-------", "------"]];
      for (const pkg of ctx.state.machine.packages.filter((p) => p.installed)) rows.push([pkg.name, pkg.name, pkg.version, "winget"]);
      return ok([...formatRows(rows).split("\n"), ""].join("\n"));
    }
    if (action === "search") {
      const term = rest[0] ?? "";
      const rows: string[][] = [["Name", "Id", "Version"], ["----", "--", "-------"], [`${term}`, term, "latest"]];
      return ok([...formatRows(rows).split("\n"), ""].join("\n"));
    }
    return bad(`winget: unknown command "${action}"`, 1);
  },
};

const GetScheduledTask: CommandSpec = {
  name: "Get-ScheduledTask",
  aliases: ["Get-ScheduledTaskInfo"],
  summary: "list scheduled tasks",
  run(ctx) {
    const rows: string[][] = [["TaskPath", "TaskName", "State"], ["--------", "--------", "-----"]];
    rows.push(["\\", "BackupUsers", "Ready"]);
    for (const entry of ctx.state.machine.cron) rows.push(["\\OnTrak\\", entry.command.slice(0, 24), "Ready"]);
    rows.push(["\\Microsoft\\Windows\\UpdateOrchestrator\\", "Schedule Scan", "Ready"]);
    return ok([...formatRows(rows).split("\n"), ""].join("\n"));
  },
};

const RegisterScheduledTask: CommandSpec = {
  name: "Register-ScheduledTask",
  summary: "create a scheduled task",
  run(ctx) {
    const adminCheck = requireAdmin(ctx, "Register-ScheduledTask");
    if (adminCheck) return adminCheck;
    const args = bindArgs(ctx.args);
    const name = args.value("taskname") ?? args.positional[0];
    const action = args.value("action") ?? "";
    const trigger = args.value("trigger") ?? args.value("at") ?? "Daily";
    if (!name) return bad("Register-ScheduledTask : Cannot bind argument to parameter 'TaskName' because it is null.");
    ctx.state.machine.cron.push({ user: ctx.user, schedule: String(trigger), command: `${name}: ${action}`.trim() });
    ctx.state.machine.notices.push(`Scheduled task "${name}" registered.`);
    return ok(
      [
        "",
        `TaskPath                                       TaskName                          State`,
        `--------                                       --------                          -----`,
        `\\                                              ${name.padEnd(34)}Ready`,
        "",
      ].join("\n"),
    );
  },
};

const FormatTable: CommandSpec = {
  name: "Format-Table",
  aliases: ["ft", "Format-List", "fl"],
  summary: "format pipeline output",
  run(ctx) {
    return ok(ctx.stdin);
  },
};

const OutString: CommandSpec = {
  name: "Out-String",
  summary: "pass pipeline output through",
  run(ctx) {
    return ok(ctx.stdin);
  },
};

const GetAcl: CommandSpec = {
  name: "Get-Acl",
  summary: "read file permissions",
  run(ctx) {
    const target = ctx.args.find((a) => !a.startsWith("-"));
    const canonical = ctx.resolve(target ?? ctx.state.machine.cwd);
    const entry = get(ctx.platform, ctx.state.vfs, canonical);
    if (!entry) return bad(`Get-Acl : Cannot find path '${display(ctx.platform, canonical)}' because it does not exist.`, 1);
    return ok(
      [
        "",
        `    Directory: ${display(ctx.platform, dirName(ctx.platform, entry.path))}`,
        "",
        `Path Owner                  Access`,
        `---- -----                  ------`,
        `${display(ctx.platform, entry.path).padEnd(28)}${entry.owner}`,
        "",
      ].join("\n"),
    );
  },
};

const GetFileHash: CommandSpec = {
  name: "Get-FileHash",
  summary: "compute a file hash",
  run(ctx) {
    const args = bindArgs(ctx.args);
    const target = args.positional[0] ?? args.value("path");
    if (!target) return bad("Get-FileHash : Cannot bind argument to parameter 'Path' because it is null.");
    const entry = get(ctx.platform, ctx.state.vfs, ctx.resolve(target));
    if (!entry) return bad(`Get-FileHash : Cannot find path '${target}' because it does not exist.`, 1);
    const seed = (entry.content ?? "").split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 0xffffffff, 7);
    const hash = Array.from({ length: 8 }, (_, i) => (((seed * (i + 3)) >>> 0) % 0xffffff).toString(16).padStart(6, "0")).join("").slice(0, 64);
    return ok([`Algorithm       Hash                                                              Path`, `---------       ----                                                              ----`, `SHA256          ${hash.padEnd(64)} ${display(ctx.platform, entry.path)}`].join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Case notes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `note_matches` grading reads `machine.notes`, and Windows scenarios use it as
 * well as Linux and Office ones, so PowerShell exposes the same built-ins. The
 * Verb-Noun aliases keep them discoverable for anyone who types `Get-Note`.
 */
const noteCmd: CommandSpec = {
  name: "note",
  aliases: ["Add-Note"],
  summary: "record a finding in your case notes",
  run(ctx) {
    const text = ctx.args.join(" ").trim();
    if (!text) return bad("note: write something, e.g. `note Root cause: spooler start type was Manual`");
    ctx.state.machine.notes.push(text);
    return ok(`Noted (${ctx.state.machine.notes.length} entries).`);
  },
};

const notesCmd: CommandSpec = {
  name: "notes",
  aliases: ["Get-Note"],
  summary: "review your case notes",
  run(ctx) {
    if (ctx.state.machine.notes.length === 0) return ok("No notes yet. Use `note <text>` to record a finding.");
    return ok(ctx.state.machine.notes.map((note, index) => `${index + 1}. ${note}`).join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Registry of cmdlets                                                       */
/* -------------------------------------------------------------------------- */

export const powershellCommands: CommandSpec[] = [
  GetChildItem,
  SetLocation,
  GetLocation,
  GetContent,
  SetContent,
  AddContent,
  OutFile,
  NewItem,
  RemoveItem,
  CopyItem,
  MoveItem,
  RenameItem,
  TestPath,
  SelectString,
  MeasureObject,
  SortObject,
  SelectObject,
  WhereObject,
  GetItemProperty,
  SetItemProperty,
  NewItemProperty,
  RemoveItemProperty,
  GetService,
  StartService,
  StopService,
  RestartService,
  SetService,
  GetProcess,
  StopProcess,
  GetLocalUser,
  NewLocalUser,
  SetLocalUser,
  EnableLocalUser,
  DisableLocalUser,
  RemoveLocalUser,
  AddLocalGroupMember,
  RemoveLocalGroupMember,
  GetLocalGroupMember,
  net,
  GetAdUser,
  ipconfig,
  GetNetIPAddress,
  TestConnection,
  ResolveDnsName,
  GetNetFirewallRule,
  NewNetFirewallRule,
  firewallToggle("Enable-NetFirewallRule", true),
  firewallToggle("Disable-NetFirewallRule", false),
  GetSmbShare,
  NewSmbShare,
  RemoveSmbShare,
  GetComputerInfo,
  GetCimInstance,
  GetEventLog,
  GetVolume,
  GetDate,
  SetExecutionPolicy,
  GetExecutionPolicy,
  StartProcess,
  StopComputer,
  ClearHost,
  WriteOutput,
  WriteHost,
  GetHelp,
  GetCommand,
  GetModule,
  gpupdate,
  gpresult,
  winget,
  GetScheduledTask,
  RegisterScheduledTask,
  FormatTable,
  OutString,
  GetAcl,
  GetFileHash,
  noteCmd,
  notesCmd,
];

/* -------------------------------------------------------------------------- */
/*  Driver                                                                    */
/* -------------------------------------------------------------------------- */

export interface PowerShellDriverOptions {
  user?: string;
}

export function createPowerShellDriver(options: PowerShellDriverOptions = {}): ShellDriver {
  const registry = createRegistry(powershellCommands);
  let cachedState: EngineState | undefined;
  let shell: ReturnType<typeof createShell> | undefined;
  const defaultUser = options.user ?? "student";

  const shellFor = (state: EngineState) => {
    if (!shell || cachedState !== state) {
      cachedState = state;
      shell = createShell({ platform: "WINDOWS", state, commands: registry, user: defaultUser });
    }
    return shell;
  };

  return {
    id: "powershell",
    platform: "WINDOWS",
    banner(state) {
      return [
        `Windows PowerShell`,
        `Copyright (C) Microsoft Corporation. All rights reserved.`,
        "",
        `Host:   ConsoleHost  ${state.machine.os.name}`,
        `Build:  ${state.machine.os.build}`,
        "",
        "Install the latest PowerShell for new features and improvements!",
      ].join("\n");
    },
    prompt(state) {
      const shown = display("WINDOWS", state.machine.cwd);
      return `PS ${shown}>`;
    },
    run(input, state) {
      return shellFor(state).run(input);
    },
    completions() {
      return powershellCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])]).sort();
    },
  };
}

export const powershellRegistry = () => createRegistry(powershellCommands);

export function powershellCommandNames(): string[] {
  return powershellCommands.map((c) => c.name);
}
