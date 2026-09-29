import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { buildFileDiff, type FileDiff } from "./diff.js";
import { removeContainer, sandboxInfo, sandboxInvocation } from "./sandbox.js";
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
      { cwd: config.workspace, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
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

/**
 * Patterns the agent is not allowed to run. The agent is a coding assistant,
 * not a system administrator: it never needs root, and an unattended model
 * should not be able to reformat a disk or wipe a home directory by accident
 * (or because something it read told it to).
 */
const BLOCKED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b|\bdoas\b|\bsu\s+-/, reason: "privilege escalation is not available to the agent" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "formatting filesystems is destructive" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: "writing to block devices is destructive" },
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /(^|[;&|]\s*)\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, reason: "shutting down the host" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, reason: "recursive forced delete" },
  { pattern: /\brm\s+[^\n]*\s(\/|\/\*|~|\$HOME|\$\{HOME\})\s*$/, reason: "deleting outside the workspace" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)[a-z0-9]*/, reason: "raw block device writes" },
  { pattern: /\b(userdel|groupdel|passwd)\b/, reason: "modifying host accounts" },
  { pattern: /\bchown\b|\bchmod\s+-R\b/, reason: "changing ownership or permissions recursively" },
  { pattern: /\b(crontab|systemctl|service)\b/, reason: "changing host services or schedules" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|k)?sh\b/, reason: "piping a download straight into a shell" },
];

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
    const timeoutMs = Math.max(
      1000,
      Math.min(argNumber(args, "timeoutMs") ?? config.commandTimeoutMs, 600_000),
    );

    for (const rule of BLOCKED_COMMANDS) {
      if (rule.pattern.test(command)) {
        return {
          ok: false,
          content: `Refused to run this command: ${rule.reason}. The agent is restricted to the workspace and has no host privileges.`,
        };
      }
    }

    // Commands run in a throwaway container by default. This is the second lock,
    // after the command guard above: even something the guard misses stays inside
    // a namespaced, network-less container instead of running on the host.
    const sandbox = await sandboxInfo();
    if (sandbox.backend === "host" && config.sandbox === "docker") {
      return {
        ok: false,
        content:
          "Refused to run this command: run_command is configured to execute only inside a container " +
          `(AGENT_SANDBOX=docker), but no sandbox is available. ${sandbox.detail}`,
      };
    }

    const containerName =
      sandbox.backend === "docker"
        ? `agent-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : "";
    const invocation =
      sandbox.backend === "docker"
        ? sandboxInvocation(command, cwd, containerName)
        : { command: "bash", args: ["-lc", command], backend: "host" as const };

    const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>(
      (resolve) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: sandbox.backend === "docker" ? config.workspace : cwd,
          env: { ...process.env, AGENT_WORKSPACE: config.workspace },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        const append = (chunk: Buffer): void => {
          if (output.length < 200_000) output += chunk.toString("utf8");
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid !== undefined && process.platform !== "win32") {
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            child.kill("SIGKILL");
          }
          // Killing the CLI does not stop the container it started.
          if (containerName !== "") removeContainer(containerName);
        }, timeoutMs);

        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: null, output: `${output}\n${error.message}`, timedOut });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output, timedOut });
        });
      },
    );

    const where = sandbox.backend === "docker" ? `container ${config.sandboxImage}` : "this host";
    const header = result.timedOut
      ? `Timed out after ${timeoutMs}ms (process killed) [ran in ${where}]. Output so far:\n`
      : `Exit code: ${result.code ?? "unknown"} [ran in ${where}]\n`;
    const body = result.output.trim() === "" ? "(no output)" : result.output.trim();

    return { ok: result.code === 0 && !result.timedOut, content: clamp(header + body) };
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
];

/** Tool schemas in the OpenAI `tools` envelope. */
export function toolSchemas(): unknown[] {
  return tools.map((tool) => ({
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
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      content: `Unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(", ")}`,
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
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool?.inspect) return null;

  const parsed = parseToolArguments(name, rawArguments);
  if (!parsed.ok) return null;

  try {
    return await tool.inspect(parsed.args);
  } catch {
    return null;
  }
}
