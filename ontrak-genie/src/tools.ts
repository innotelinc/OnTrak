import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { changeSetSummary } from "./change-set.js";
import { claudeMemEnabled, searchMemory } from "./claude-mem.js";
import { mcpToolSnapshot } from "./mcp-tools.js";
import { config } from "./config.js";
import { MEMORY_FILE, appendMemory, readMemory, remember } from "./memory.js";
import { loadSkillsForScope } from "./skill-roots.js";
import { composeSkillMessage, describeSkills, findSkill } from "./skills.js";
import { buildFileDiff, type FileDiff } from "./diff.js";
import { stageChange } from "./proposals.js";
import { workspaceRoot } from "./scope.js";
import { backendLabel, effectiveTimeoutMs, runShellCommand } from "./shell.js";
import { WEB_MAX_BYTES, fetchPage, searchEnabled, searchWeb } from "./web.js";
import { saveSnapshot } from "./snapshots.js";
import {
  isIgnoredDir,
  listDirectory,
  pathExists,
  readTextFile,
  resolveInWorkspace,
  toRel,
  WorkspaceError,
  writeTextFile,
} from "./workspace.js";

/** Thrown for bad arguments and other recoverable, model-visible problems. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
  /**
   * Present for tools that change a file. The model never sees this - it is for
   * the UI's before/after view - and it is stripped before the transcript is
   * sent back to the gateway.
   */
  diff?: FileDiff;
}

/** What a tool *would* do, computed without doing it, for the approval prompt. */
export interface ToolPreview {
  summary: string;
  diff?: FileDiff;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * Describe the pending change. Tools that only read have no `inspect`, and
   * therefore never need approval. Anything thrown here is ignored: the same
   * problem will be reported properly by `run`.
   */
  inspect?: (args: Record<string, unknown>) => Promise<ToolPreview>;
  run: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}

// --- argument helpers -------------------------------------------------------

function argString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (value === undefined || value === null) {
    if (allowEmpty) return "";
    throw new ToolError(`missing required argument "${key}"`);
  }
  if (typeof value !== "string") throw new ToolError(`argument "${key}" must be a string`);
  if (!allowEmpty && value.trim() === "") throw new ToolError(`argument "${key}" must not be empty`);
  return value;
}

function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new ToolError(`argument "${key}" must be a number`);
  return parsed;
}

function argBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

// --- output helpers ---------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(text: string, limit = config.toolResultLimit): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... [truncated ${text.length - limit} more characters]`;
}

// --- read_file --------------------------------------------------------------

const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Lines are numbered so you can reference exact line numbers in later edits. Use offset and limit to page through large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path, e.g. src/server.ts" },
      offset: { type: "integer", description: "1-based line to start at. Defaults to 1." },
      limit: { type: "integer", description: "Maximum lines to return. Defaults to 400." },
    },
    required: ["path"],
  },
  async run(args) {
    const abs = resolveInWorkspace(argString(args, "path"));
    const { content, truncated, bytes } = await readTextFile(abs);
    const lines = content.split("\n");
    const offset = Math.max(1, argNumber(args, "offset") ?? 1);
    const limit = Math.max(1, Math.min(argNumber(args, "limit") ?? 400, 5000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + Math.max(slice.length - 1, 0)).length;

    const body = slice
      .map((line, index) => `${String(offset + index).padStart(width, " ")}| ${line}`)
      .join("\n");

    const notes: string[] = [];
    if (offset > 1 || offset - 1 + limit < lines.length) {
      notes.push(`lines ${offset}-${offset + Math.max(slice.length - 1, 0)} of ${lines.length}`);
    }
    if (truncated) notes.push(`file is ${formatSize(bytes)}; only the leading part was read`);

    const header = notes.length > 0 ? `// ${notes.join("; ")}\n` : "";
    return { ok: true, content: clamp(header + body) };
  },
};

// --- list_dir ---------------------------------------------------------------

const listDirTool: ToolDefinition = {
  name: "list_dir",
  description: "List the entries of a workspace directory. Directories come first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory. Defaults to the workspace root." },
    },
  },
  async run(args) {
    const rel = argString(args, "path", true) || ".";
    const abs = resolveInWorkspace(rel);
    const entries = await listDirectory(abs);
    if (entries.length === 0) return { ok: true, content: `${rel} is empty` };

    const body = entries
      .map((entry) =>
        entry.type === "dir" ? `dir   ${entry.name}/` : `file  ${entry.name}  (${formatSize(entry.size)})`,
      )
      .join("\n");
    return { ok: true, content: clamp(`${rel}:\n${body}`) };
  },
};

// --- write_file -------------------------------------------------------------

/**
 * Work out what a write_file call would do, without touching anything. Used both
 * to build the approval prompt and to execute, so the two can never disagree
 * about what is being changed.
 */
async function planWrite(args: Record<string, unknown>) {
  const rel = argString(args, "path");
  const abs = resolveInWorkspace(rel);
  const content = argString(args, "content", true);
  const existed = await pathExists(abs);

  // Capture the previous contents so the UI can show a before/after diff. A
  // binary or oversized file is written as before, just without the diff.
  let before = "";
  let diffable = true;
  if (existed) {
    try {
      const previous = await readTextFile(abs);
      if (previous.truncated) diffable = false;
      else before = previous.content;
    } catch {
      diffable = false;
    }
  }

  const diff = diffable ? buildFileDiff(rel, before, content, { created: !existed }) : undefined;
  const lines = content === "" ? 0 : content.split("\n").length;
  return { rel, abs, content, existed, before, lines, diff };
}

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Create a file or replace its entire contents. Parent directories are created as needed. Prefer edit_file for small changes to an existing file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "The complete file contents." },
    },
    required: ["path", "content"],
  },
  async inspect(args) {
    const plan = await planWrite(args);
    const counts = plan.diff ? ` (+${plan.diff.added} −${plan.diff.removed} lines)` : "";
    return {
      summary: `${plan.existed ? "Overwrite" : "Create"} ${plan.rel}${counts}`,
      ...(plan.diff ? { diff: plan.diff } : {}),
    };
  },
  async run(args) {
    const plan = await planWrite(args);
    // Propose mode: stage instead of write, so a reviewer commits the set. The
    // model is told plainly that nothing landed, or it would assume its edit
    // took effect and read a stale file next.
    if (config.writeMode === "propose") {
      const set = stageChange({
        path: plan.rel,
        kind: plan.existed ? "overwrite" : "create",
        content: plan.content,
        added: plan.diff?.added ?? 0,
        removed: plan.diff?.removed ?? 0,
      });
      return {
        ok: true,
        content: `Proposed ${plan.existed ? "overwrite of" : "creation of"} ${plan.rel}; staged for review (${changeSetSummary(set)}). Nothing has been written yet — the change lands when the set is applied.`,
        ...(plan.diff ? { diff: plan.diff } : {}),
      };
    }
    // Keep the "before" for the viewer's diff, but never fail a write over it.
    await saveSnapshot(plan.rel, plan.before).catch(() => {});
    const bytes = await writeTextFile(plan.abs, plan.content);
    return {
      ok: true,
      content: `${plan.existed ? "Updated" : "Created"} ${plan.rel} (${plan.lines} lines, ${formatSize(bytes)})`,
      ...(plan.diff ? { diff: plan.diff } : {}),
    };
  },
};

// --- edit_file --------------------------------------------------------------

/** Validate an edit and compute its result without writing it. */
async function planEdit(args: Record<string, unknown>) {
  const rel = argString(args, "path");
  const abs = resolveInWorkspace(rel);
  const oldString = argString(args, "oldString");
  const newString = argString(args, "newString", true);
  const replaceAll = argBoolean(args, "replaceAll");

  if (oldString === newString) throw new ToolError("oldString and newString are identical; nothing to change");

  const { content } = await readTextFile(abs);
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new ToolError(
      `oldString was not found in ${rel}. Read the file and match the existing text exactly, including whitespace.`,
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new ToolError(
      `oldString appears ${occurrences} times in ${rel}. Include more surrounding context to make it unique, or pass replaceAll: true.`,
    );
  }

  const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  const count = replaceAll ? occurrences : 1;
  return { rel, abs, content, updated, count, diff: buildFileDiff(rel, content, updated) };
}

const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact substring in a file. oldString must match the file byte-for-byte, including indentation. Fails if the string is absent, or ambiguous unless replaceAll is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      oldString: { type: "string", description: "Exact text to replace." },
      newString: { type: "string", description: "Replacement text. May be empty to delete." },
      replaceAll: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
    },
    required: ["path", "oldString", "newString"],
  },
  async inspect(args) {
    const plan = await planEdit(args);
    const { diff } = plan;
    return {
      summary: `Edit ${plan.rel} (${plan.count} replacement${plan.count === 1 ? "" : "s"}, +${diff.added} −${diff.removed} lines)`,
      diff,
    };
  },
  async run(args) {
    const plan = await planEdit(args);
    // Propose mode: the edit is computed against the file *as it is now*, so a set
    // of edits to the same file composes in order and the last one wins (see
    // `addEntry`). Nothing is written until the set is applied.
    if (config.writeMode === "propose") {
      const set = stageChange({
        path: plan.rel,
        kind: "edit",
        content: plan.updated,
        added: plan.diff.added,
        removed: plan.diff.removed,
      });
      return {
        ok: true,
        content: `Proposed edit to ${plan.rel} (${plan.count} replacement${plan.count === 1 ? "" : "s"}); staged for review (${changeSetSummary(set)}). Nothing has been written yet.`,
        diff: plan.diff,
      };
    }
    await saveSnapshot(plan.rel, plan.content).catch(() => {});
    await writeTextFile(plan.abs, plan.updated);
    return {
      ok: true,
      content: `Edited ${plan.rel} (${plan.count} replacement${plan.count === 1 ? "" : "s"})`,
      diff: plan.diff,
    };
  },
};

// --- search_code ------------------------------------------------------------

class RipgrepUnavailable extends Error {}

async function runRipgrep(pattern: string, rel: string, glob: string, maxResults: number): Promise<string> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
    "--max-columns",
    "300",
    "--max-columns-preview",
    "--glob",
    "!node_modules",
    "--glob",
    "!.git",
  ];
  if (glob) args.push("--glob", glob);
  args.push("--", pattern, rel);

  return await new Promise<string>((resolve, reject) => {
    execFile(
      "rg",
      args,
      { cwd: workspaceRoot(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        // execFile surfaces the exit status as `code`, and spawn failures as an errno string.
        const code = (error as unknown as { code?: number | string }).code;
        if (code === 1) return resolve(""); // No matches is a normal outcome.
        if (code === "ENOENT") return reject(new RipgrepUnavailable("rg is not installed"));
        return reject(new Error(`ripgrep failed: ${error.message}`));
      },
    );
  });
}

/** Pure-Node fallback so search_code works even without ripgrep installed. */
async function fallbackSearch(pattern: string, rootAbs: string, maxResults: number): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new ToolError(`invalid regular expression: ${(error as Error).message}`);
  }

  const results: string[] = [];
  const queue: string[] = [rootAbs];

  while (queue.length > 0 && results.length < maxResults) {
    const current = queue.shift();
    if (current === undefined) break;

    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (results.length >= maxResults) break;
      if (dirent.isDirectory()) {
        if (!isIgnoredDir(dirent.name)) queue.push(path.join(current, dirent.name));
        continue;
      }
      const child = path.join(current, dirent.name);
      try {
        const stat = await fs.stat(child);
        if (stat.size > 1_000_000) continue;
        const text = await fs.readFile(child, "utf8");
        if (text.includes("\u0000")) continue;
        text.split("\n").forEach((line, index) => {
          if (results.length < maxResults && regex.test(line)) {
            results.push(`${toRel(child)}:${index + 1}:${line.trim().slice(0, 300)}`);
          }
        });
      } catch {
        continue;
      }
    }
  }
  return results.join("\n");
}

const searchCodeTool: ToolDefinition = {
  name: "search_code",
  description:
    "Search file contents with a regular expression and return matching lines with line numbers. Use this to locate code instead of reading whole trees. Backed by ripgrep when available.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search. Defaults to the workspace root." },
      glob: { type: "string", description: "Optional ripgrep glob filter, e.g. *.ts" },
      maxResults: { type: "integer", description: "Maximum matching lines. Defaults to 100." },
    },
    required: ["pattern"],
  },
  async run(args) {
    const pattern = argString(args, "pattern");
    const rel = argString(args, "path", true) || ".";
    const abs = resolveInWorkspace(rel);
    const glob = args.glob === undefined || args.glob === null ? "" : argString(args, "glob", true);
    const maxResults = Math.max(1, Math.min(argNumber(args, "maxResults") ?? 100, 500));

    try {
      const output = await runRipgrep(pattern, rel, glob, maxResults);
      return { ok: true, content: clamp(output.trim() || "no matches") };
    } catch (error) {
      if (error instanceof RipgrepUnavailable) {
        const output = await fallbackSearch(pattern, abs, maxResults);
        return { ok: true, content: clamp(output || "no matches") };
      }
      throw error;
    }
  },
};

// --- run_command ------------------------------------------------------------

const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    "Run a shell command inside the workspace and return its combined stdout/stderr. Use it for builds, tests, typechecks, package managers and git. Working directory defaults to the workspace root.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      cwd: { type: "string", description: "Workspace-relative directory to run in." },
      timeoutMs: { type: "integer", description: "Override the default timeout." },
    },
    required: ["command"],
  },
  async inspect(args) {
    const command = argString(args, "command");
    const relCwd = argString(args, "cwd", true) || ".";
    return { summary: `Run in ${relCwd}: ${command}` };
  },
  async run(args) {
    const command = argString(args, "command");
    const relCwd = argString(args, "cwd", true) || ".";
    const cwd = resolveInWorkspace(relCwd);
    const requested = argNumber(args, "timeoutMs");

    // One executor, shared with the console's terminal (`src/shell.ts`): the
    // guard list, the sandbox decision and the process-group kill are the same
    // for the model and for a person, so they cannot drift apart.
    const result = await runShellCommand({ command, cwd, timeoutMs: requested });
    if (result.refused !== undefined) return { ok: false, content: result.refused };

    const where = backendLabel(result.backend);
    const header = result.timedOut
      ? `Timed out after ${effectiveTimeoutMs(requested)}ms (process killed) [ran in ${where}]. Output so far:\n`
      : `Exit code: ${result.exitCode ?? "unknown"} [ran in ${where}]\n`;
    const body = result.output.trim() === "" ? "(no output)" : result.output.trim();

    return { ok: result.ok, content: clamp(header + body) };
  },
};


// --- write_journal (persistent learning) ------------------------------------
const writeJournalTool: ToolDefinition = {
  name: "write_journal",
  description: "Append an entry to the persistent learning journal (AGENT_LEARNINGS.md) in the workspace.",
  parameters: { type: "object", properties: { entry: { type: "string" }, category: { type: "string" } }, required: ["entry"] },
  async run(args) {
    const entry = argString(args, "entry");
    const category = (args.category as string) || "note";
    const journalPath = resolveInWorkspace("AGENT_LEARNINGS.md");
    const timestamp = new Date().toISOString();
    const formatted = `\n\n### [${timestamp}] ${category}\n\n${entry}\n`;
    try {
      const existing = await fs.readFile(journalPath, "utf8");
      await writeTextFile(journalPath, existing + formatted);
    } catch {
      await writeTextFile(journalPath, `# Agent Learning Journal\n\n*This file persists across agent sessions.*\n\n### [${timestamp}] ${category}\n\n${entry}\n`);
    }
    return { ok: true, content: `Appended to AGENT_LEARNINGS.md` };
  },
};
const workspaceStateTool: ToolDefinition = {
  name: "workspace_state",
  description: "Get or set persistent state (state.json) in workspace.",
  parameters: { type: "object", properties: { action: { type: "string" }, key: { type: "string" }, value: { type: "object" } }, required: ["action"] },
  async run(args) {
    const action = argString(args, "action");
    const statePath = resolveInWorkspace("state.json");
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch {}
    if (action === "get") return { ok: true, content: JSON.stringify(state, null, 2) };
    if (action === "set") {
      const key = argString(args, "key");
      state[key] = args.value;
      await writeTextFile(statePath, JSON.stringify(state, null, 2));
      return { ok: true, content: `State updated: ${key}` };
    }
    throw new ToolError("action must be 'get' or 'set'");
  },
};
const pluginDiscoverTool: ToolDefinition = {
  name: "plugin_discover",
  description: "Discover and track plugins in workspace. Updates state.json with discovered plugins.",
  parameters: { type: "object", properties: {} },
  async run() {
    const plugins: any[] = [];
    try {
      const pdir = resolveInWorkspace("plugins");
      const entries = await fs.readdir(pdir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          plugins.push({ name: e.name, path: `plugins/${e.name}`, discovered: new Date().toISOString() });
        }
      }
    } catch {}
    try {
      const statePath = resolveInWorkspace("state.json");
      let state: any = {};
      try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch {}
      state.discovered_plugins = plugins;
      await writeTextFile(statePath, JSON.stringify(state, null, 2));
    } catch {}
    try {
      const journalPath = resolveInWorkspace("AGENT_LEARNINGS.md");
      const ts = new Date().toISOString();
      const entry = `\n\n### [${ts}] discovery\n\nDiscovered ${plugins.length} plugin(s): ${plugins.map(p=>p.name).join(', ')}\n`;
      const existing = await fs.readFile(journalPath, "utf8").catch(() => "# Agent Learning Journal\n\n");
      await writeTextFile(journalPath, existing + entry);
    } catch {}
    return { ok: true, content: JSON.stringify(plugins, null, 2) };
  },
};
const pluginLoadTool: ToolDefinition = {
  name: "plugin_load",
  description: "Load a plugin by path.",
  parameters: { type: "object", properties: { pluginPath: { type: "string" } }, required: ["pluginPath"] },
  async run(args) {
    const rel = argString(args, "pluginPath");
    const abs = resolveInWorkspace(rel);
    let target = abs;
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        for (const f of ["index.mjs", "index.js", "index.cjs"]) {
          const p = path.join(abs, f);
          try { await fs.access(p); target = p; break; } catch {}
        }
      }
    } catch {}
    const res = await new Promise<string>((r) => {
      execFile("node", [target], { timeout: 5000 }, (e, out, err) => r(e ? `ERR:${e.message}` : (out||err||"ok")));
    });
    return { ok: true, content: res };
  },
};
const packageInstallTool: ToolDefinition = {
  name: "package_install",
  description: "Install system packages with sandbox awareness. Respects AGENT_SANDBOX mode (host/docker/auto). Logs to persistent journal on success.",
  parameters: { type: "object", properties: { packages: { type: "string" }, manager: { type: "string", description: "npm|pip|apt|yarn|pnpm" } }, required: ["packages"] },
  async run(args) {
    const pkgs = argString(args, "packages");
    const mgr = ((args.manager as string)||"npm").toLowerCase();
    let cmd = mgr==="npm"?`npm install ${pkgs}` : mgr==="pip"?`pip install ${pkgs}` : mgr==="apt"?`apt-get update && apt-get install -y ${pkgs}` : mgr==="pnpm"?`pnpm add ${pkgs}` : mgr==="yarn"?`yarn add ${pkgs}` : `npm install ${pkgs}`;
    const res = await runShellCommand({ command: cmd, cwd: workspaceRoot(), timeoutMs: 120000 });
    const sandbox = process.env.AGENT_SANDBOX || "auto";
    const content = `Sandbox: ${sandbox}\n${res.output || (res.refused||"")}`;
    if (res.ok) {
      try {
        const journalPath = resolveInWorkspace("AGENT_LEARNINGS.md");
        const ts = new Date().toISOString();
        const entry = `\n\n### [${ts}] install\n\nInstalled packages: ${pkgs} (manager: ${mgr}, sandbox: ${sandbox})\n`;
        const existing = await fs.readFile(journalPath, "utf8").catch(() => "# Agent Learning Journal\n\n");
        await writeTextFile(journalPath, existing + entry);
      } catch {}
    }
    return { ok: res.ok, content };
  },
};
const macroRunTool: ToolDefinition = {
  name: "macro_run",
  description: "Run stored macro.",
  parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "string" } }, required: ["name"] },
  async run(args) {
    const name = argString(args, "name");
    const margs = argString(args, "args", true);
    const cands = [resolveInWorkspace(`macros/${name}.sh`), resolveInWorkspace(`macros/${name}.js`), resolveInWorkspace(name)];
    let t: string|null = null;
    for (const c of cands) { try { await fs.access(c); t=c; break; } catch {} }
    if (!t) throw new ToolError("macro not found");
    const ext = path.extname(t);
    const cmd = ext===".sh" ? `bash ${t} ${margs}` : `node ${t} ${margs}`;
    const res = await runShellCommand({ command: cmd, cwd: path.dirname(t), timeoutMs: 60000 });
    return { ok: res.ok, content: res.output || "" };
  },
};

// --- remember (the project's memory) ----------------------------------------

/**
 * Write one durable fact into the project's memory.
 *
 * A file the agent edits, not a side channel it talks into: the write goes through
 * the same snapshot, diff and approval path as `write_file`, so it shows up in the
 * change list and can be reviewed, reverted or corrected like anything else. That
 * is the point of putting memory *in the workspace* — the prompt gets the file's
 * contents every turn (`agent.ts`), and this is how they grow.
 */
const rememberTool: ToolDefinition = {
  name: "remember",
  description:
    `Append one durable fact about this project to ${MEMORY_FILE}, its persistent memory. Use it for things that stay true: how the project is built, a convention, a trap, a decision and its reason. Not for progress notes within a task — those belong in the reply.`,
  parameters: {
    type: "object",
    properties: {
      entry: { type: "string", description: "The fact, one or two sentences, written for a reader who was not here." },
      section: { type: "string", description: 'Which heading it belongs under, e.g. "Build", "Conventions", "Traps". Defaults to "Notes".' },
    },
    required: ["entry"],
  },
  async inspect(args) {
    const entry = argString(args, "entry");
    const before = await readMemory();
    const content = appendMemory(before, { entry, ...(sectionArg(args) === undefined ? {} : { section: sectionArg(args) }) });
    return {
      summary: `Add to ${MEMORY_FILE}`,
      diff: buildFileDiff(MEMORY_FILE, before, content),
    };
  },
  async run(args) {
    const entry = argString(args, "entry");
    const section = sectionArg(args);
    const input = { entry, ...(section === undefined ? {} : { section }) };

    if (config.writeMode === "propose") {
      const before = await readMemory();
      const content = appendMemory(before, input);
      const diff = buildFileDiff(MEMORY_FILE, before, content);
      const set = stageChange({
        path: MEMORY_FILE,
        kind: before.trim() === "" ? "create" : "overwrite",
        content,
        added: diff.added,
        removed: diff.removed,
      });
      return {
        ok: true,
        content: `Proposed adding to ${MEMORY_FILE}; staged for review (${changeSetSummary(set)}). Nothing has been written yet.`,
        diff,
      };
    }

    const outcome = await remember(input);
    return {
      ok: true,
      content: `${outcome.created ? "Created" : "Updated"} ${outcome.rel} under "${outcome.section}" (${formatSize(outcome.bytes)}).`,
      diff: outcome.diff,
    };
  },
};

function sectionArg(args: Record<string, unknown>): string | undefined {
  const value = args.section;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// --- skills -----------------------------------------------------------------

/** What the caller can use, as the menu the prompt carries. */
const listSkillsTool: ToolDefinition = {
  name: "list_skills",
  description:
    "List the skills available here — markdown playbooks for how this project or team does something. Load one with use_skill.",
  parameters: { type: "object", properties: {} },
  async run() {
    const skills = loadSkillsForScope();
    if (skills.length === 0) {
      return {
        ok: true,
        content: "No skills are installed. A skill is a markdown playbook (SKILL.md) in .genie/skills of this workspace, the account's skills directory, or the deployment's.",
      };
    }
    return { ok: true, content: clamp(describeSkills(skills).join("\n")) };
  },
};

/**
 * Load one skill's playbook into the conversation.
 *
 * The body is fetched, not injected up front, because a skill is a whole method —
 * the design one is twenty thousand characters and twenty reference files — and a
 * turn that pays for every playbook to use none of them is a turn the user waits
 * on for nothing. What the prompt carries is the menu; this is the click.
 */
const useSkillTool: ToolDefinition = {
  name: "use_skill",
  description:
    "Load a skill's playbook and follow it for the current task. Use when a listed skill matches what the user asked for, or when they name one.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill to load, as list_skills spells it." },
      task: { type: "string", description: "What to apply it to. Omit only when the request is already clear." },
    },
    required: ["name"],
  },
  async run(args) {
    const name = argString(args, "name");
    const skills = loadSkillsForScope();
    const skill = findSkill(skills, name);
    if (skill === undefined) {
      throw new ToolError(
        skills.length === 0
          ? `no skills are installed, so there is nothing called "${name}"`
          : `no skill matches "${name}". Available: ${skills.map((entry) => entry.name).join(", ")}`,
      );
    }
    const task = argString(args, "task", true);
    return { ok: true, content: clamp(composeSkillMessage(skill, task)) };
  },
};

// --- recall (memory shared across every interface) --------------------------

/**
 * Search what earlier sessions in this deployment learned.
 *
 * The history is larger than a prompt can hold, so the prompt gets the recent
 * context and this tool is how the model goes looking for the rest — a title, a
 * date, the file it touched and an observation id, not full bodies. That is what
 * makes a memory from the console usable in the CLI, and one from G0DM0D3 usable
 * here, without paying for all of it on every turn.
 */
const recallMemoryTool: ToolDefinition = {
  name: "recall_memory",
  description:
    "Search the persistent memory shared by this deployment's interfaces (console, CLI, G0DM0D3, Engineer) for work done in earlier sessions. Returns an index of observation ids, dates, titles and files. Use it when the request refers to prior work, a past decision or a bug fix you do not see in this chat.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in the words a person would use." },
      limit: { type: "number", description: "How many results to return. Defaults to 10, at most 25." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = argString(args, "query");
    const requested = argNumber(args, "limit") ?? 10;
    const limit = Math.max(1, Math.min(25, requested));
    const found = await searchMemory(query, limit);
    if (found === null) {
      return {
        ok: true,
        content: "The memory service answered nothing for that query. It may hold no matching work, or may be unreachable right now.",
      };
    }
    return { ok: true, content: clamp(found) };
  },
};

// --- web research -----------------------------------------------------------

const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information, docs, error messages or a library you do not know. Returns titles, URLs and snippets. Follow up with web_fetch on a result you need in full. The request leaves this host, so the approval gate asks first.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in the words a person would use." },
      limit: { type: "number", description: "How many results to return. Defaults to 8, at most 10." },
    },
    required: ["query"],
  },
  async inspect(args) {
    return { summary: `Search the web for “${argString(args, "query")}”` };
  },
  async run(args) {
    const query = argString(args, "query");
    const limit = Math.max(1, Math.min(10, argNumber(args, "limit") ?? 8));
    const results = await searchWeb(query, limit);
    if (results.length === 0) return { ok: true, content: `No results for “${query}”.` };
    const text = results
      .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
      .join("\n\n");
    return { ok: true, content: clamp(text) };
  },
};

const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Read one public web page as text. Scripts, styles and markup are stripped and the body is capped, so a long page or a binary is reported rather than dumped. Only http(s) on public addresses is reachable — loopback, private and link-local addresses are refused. The request leaves this host, so the approval gate asks first.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to read." },
    },
    required: ["url"],
  },
  async inspect(args) {
    return { summary: `Fetch ${argString(args, "url")}` };
  },
  async run(args) {
    const url = argString(args, "url");
    const page = await fetchPage(url);
    const note = page.truncated ? `\n\n... [page truncated at ${Math.round(WEB_MAX_BYTES / 1024)} KB]` : "";
    return {
      ok: true,
      content: clamp(`URL: ${page.url}\nContent-Type: ${page.contentType || "unknown"}\n\n${page.text}${note}`),
    };
  },
};

// --- registry ---------------------------------------------------------------

export const tools: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  searchCodeTool,
  runCommandTool,
  writeJournalTool,
  workspaceStateTool,
  pluginDiscoverTool,
  pluginLoadTool,
  packageInstallTool,
  macroRunTool,
  rememberTool,
  recallMemoryTool,
  listSkillsTool,
  useSkillTool,
  webFetchTool,
  webSearchTool,
];

/**
 * Every tool a turn may call: the console's own, then anything the MCP servers offer.
 *
 * The MCP half is read from a snapshot rather than discovered here, because this
 * function is synchronous and discovery is not — a turn awaits `primeMcpTools()`
 * before its tool list is built. Keeping the two apart is what lets a bridge
 * failure degrade to "the console's own tools still work".
 */
export function allTools(): ToolDefinition[] {
  // A tool whose service is not configured is not offered: asking the model to
  // choose between two memories, one of which is always empty, is worse than
  // not mentioning the second at all. Search is the same argument — without a
  // provider it can only fail — while `web_fetch` needs no key.
  const own = tools.filter(
    (tool) =>
      (tool.name !== "recall_memory" || claudeMemEnabled()) &&
      (tool.name !== "web_search" || searchEnabled()),
  );
  return [...own, ...mcpToolSnapshot()];
}

/** Tool schemas in the OpenAI `tools` envelope. */
export function toolSchemas(): unknown[] {
  return allTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

type ParsedArgs = { ok: true; args: Record<string, unknown> } | { ok: false; content: string };

function parseToolArguments(name: string, rawArguments: string): ParsedArgs {
  if (rawArguments.trim() === "") return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, content: `Arguments for ${name} must be a JSON object.` };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      content: `Arguments for ${name} were not valid JSON: ${(error as Error).message}. Received: ${rawArguments.slice(0, 400)}`,
    };
  }
}

/** Execute a tool by name, turning every failure into a message for the model. */
export async function runTool(name: string, rawArguments: string): Promise<ToolOutcome> {
  const available = allTools();
  const tool = available.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      content: `Unknown tool "${name}". Available tools: ${available.map((t) => t.name).join(", ")}`,
    };
  }

  const parsed = parseToolArguments(name, rawArguments);
  if (!parsed.ok) return { ok: false, content: parsed.content };

  try {
    return await tool.run(parsed.args);
  } catch (error) {
    if (error instanceof ToolError || error instanceof WorkspaceError) {
      return { ok: false, content: error.message };
    }
    return { ok: false, content: `Tool ${name} failed: ${(error as Error).message}` };
  }
}

/**
 * Describe what a call would change, for the approval prompt. Returns null when
 * the tool changes nothing, or when the arguments are bad — either way the
 * caller should let `runTool` produce the real result (and the real error).
 */
export async function previewTool(name: string, rawArguments: string): Promise<ToolPreview | null> {
  const tool = allTools().find((candidate) => candidate.name === name);
  if (!tool?.inspect) return null;

  const parsed = parseToolArguments(name, rawArguments);
  if (!parsed.ok) return null;

  try {
    return await tool.inspect(parsed.args);
  } catch {
    return null;
  }
}
