import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { config } from "./config.js";
import { resolveInWorkspace } from "./workspace.js";
import { workspaceRoot } from "./scope.js";

/**
 * The running app, not the code that makes it.
 *
 * The pane showed the file being written and the change it made, and both are
 * about the *source*. What nobody could see was the thing the source is for: the
 * app, running, updating as it is edited. So this module keeps one development
 * server alive per workspace and hands the console a way to reach it.
 *
 * Three decisions worth stating.
 *
 * **The command is the project's, not this module's.** A dev server is
 * `npm run dev`, `python3 -m http.server`, `cargo watch`, or something nobody has
 * thought of yet — there is no list to enumerate. So the agent starts it (it has
 * just read the project) or the operator names one in `AGENT_PREVIEW_COMMAND`;
 * this module runs whatever it is handed and reports what happened.
 *
 * **One preview per workspace.** Two dev servers on one tree is not two
 * previews, it is a race over the same files and a second port nobody opened.
 * Starting again replaces what was running, and the promise is kept per account
 * because the key is the workspace root, which tenancy already made per-account.
 *
 * **The log is kept, the process is not resurrected.** A server that exits stays
 * exited: a crashed `npm run dev` is a fact about the project, and restarting it
 * silently would hide the error the user needs to read. The tail of its output is
 * the answer to "why is the preview blank", which is the question that follows.
 */

export interface PreviewStatus {
  /** Whether a dev server is running for this workspace right now. */
  running: boolean;
  /** The command that was started, or null if none ever was. */
  command: string | null;
  /** Workspace-relative directory it runs in. */
  cwd: string | null;
  /** The port it was told to listen on, or null. */
  port: number | null;
  /** Where the browser reaches it, relative to the console. */
  url: string;
  /** When it started, ISO-8601. */
  startedAt: string | null;
  /** Its exit code once it has stopped, or null while it runs or if it never started. */
  exitCode: number | null;
  /** Why the last start attempt failed, if it did. */
  error: string | null;
  /** The tail of its output, for "why is the preview blank?". */
  log: string;
  /**
   * True when `command` was worked out from the project rather than named by
   * anyone. The pane says so, because a guess the user did not make is one they
   * should be able to correct.
   */
  detected?: boolean;
}

interface PreviewProcess {
  child: ChildProcess;
  command: string;
  cwd: string;
  port: number;
  startedAt: string;
  exitCode: number | null;
  error: string | null;
  log: string;
}

const LOG_LIMIT = 8_000;
const START_GRACE_MS = 900;

/**
 * Ports a project's own dev server might listen on when it ignores `PORT`.
 *
 * Vite, Astro, Angular and friends take their port from a flag or a config file,
 * not from the environment, so a server told to use 5173 can end up on 3000. The
 * proxy has to follow it there, and these are the numbers worth checking.
 */
const COMMON_PORTS = [3000, 5173, 8080, 8000, 4200, 4321, 5000, 3001];

/** One per workspace root — which tenancy already made per-account. */
const running = new Map<string, PreviewProcess>();

function emptyStatus(command: string | null = null, cwd: string | null = null): PreviewStatus {
  return {
    running: false,
    command,
    cwd,
    port: null,
    url: "/preview/",
    startedAt: null,
    exitCode: null,
    error: null,
    log: "",
  };
}

function keyFor(root: string): string {
  return root;
}

/** The status of this workspace's preview. Never throws; an unknown scope is "never started". */
export function previewStatus(): PreviewStatus {
  const entry = running.get(keyFor(workspaceRoot()));
  if (entry === undefined) {
    // Never started is not the same as nothing to start: the pane needs to know
    // whether "run" would do something, and naming the command lets it say so.
    const suggestion = detectPreviewCommand();
    return suggestion === null
      ? emptyStatus()
      : { ...emptyStatus(suggestion.command, suggestion.cwd), detected: true };
  }
  return {
    running: entry.exitCode === null,
    command: entry.command,
    cwd: entry.cwd,
    port: entry.port,
    url: "/preview/",
    startedAt: entry.startedAt,
    exitCode: entry.exitCode,
    error: entry.error,
    log: entry.log,
  };
}

/**
 * The port the current workspace's preview listens on, or null.
 *
 * The proxy asks this. It is deliberately scope-aware: the answer for account A
 * must never be used to reach account B's process, which is why nothing here
 * caches a "current port" in module state.
 */
export function previewPort(): number | null {
  const entry = running.get(keyFor(workspaceRoot()));
  if (entry === undefined || entry.exitCode !== null) return null;
  return entry.port;
}

/** Is anything listening there yet? Used to report "started but not answering". */
export async function portAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (answer: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** A free port, preferring the configured one so a project's usual URL keeps working. */
export async function findFreePort(preferred: number): Promise<number> {
  const free = async (port: number): Promise<boolean> =>
    await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });

  // Zero or less is "no preference", not port zero: handing that number back
  // would ask the app to listen somewhere the proxy could never reach.
  if (preferred > 0 && (await free(preferred))) return preferred;
  // Ask the OS for one; the exact number does not matter, being reachable does.
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : preferred;
      server.close(() => resolve(port));
    });
  });
}

function appendLog(entry: PreviewProcess, chunk: Buffer): void {
  entry.log += chunk.toString("utf8");
  if (entry.log.length > LOG_LIMIT) entry.log = entry.log.slice(-LOG_LIMIT);
}

/* -------------------------------------------------------------- what to run */

/**
 * Guess how this workspace starts, so "run the app" needs no configuration.
 *
 * The operator can always name a command, and the agent usually can too, having
 * just read the project. But the common case is a person clicking "preview" on a
 * project nobody has configured — and an empty pane with "set a variable" is a
 * worse answer than a good guess that names itself in the log.
 *
 * The guesses are deliberately shallow: the project's own start script, a
 * Django manage.py, a directory with an index.html. Anything more clever would
 * be this module deciding what a project is, and it would be wrong often enough
 * to be worse than the guess it replaced.
 */
export interface PreviewSuggestion {
  command: string;
  /** Workspace-relative directory to run it in. */
  cwd: string;
}

/** Where a plain static site usually keeps its entry page, in preference order. */
const STATIC_DIRS = [".", "public", "www", "web", "site", "dist", "build", "html"];

/** Node scripts worth running, in the order a project usually means them. */
const NODE_SCRIPTS = ["dev", "start", "serve", "preview"];

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * What to run in this workspace, or null if nothing recognisable is there.
 *
 * `root` is an absolute path; the returned `cwd` is workspace-relative, because
 * that is what `startPreview` and the console speak in.
 */
export function detectPreviewCommand(root: string = workspaceRoot()): PreviewSuggestion | null {
  const rel = (abs: string): string => {
    const cut = path.relative(root, abs);
    return cut === "" ? "." : cut;
  };

  const manifest = readJsonFile(path.join(root, "package.json"));
  const scripts =
    manifest !== null && manifest.scripts !== null && typeof manifest.scripts === "object"
      ? (manifest.scripts as Record<string, unknown>)
      : null;
  if (scripts !== null) {
    for (const name of NODE_SCRIPTS) {
      if (typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "") {
        return { command: `npm run ${name}`, cwd: "." };
      }
    }
  }

  if (isFile(path.join(root, "manage.py"))) {
    return { command: "python3 manage.py runserver 127.0.0.1:$PORT", cwd: "." };
  }

  for (const dir of STATIC_DIRS) {
    const abs = dir === "." ? root : path.join(root, dir);
    if (isDir(abs) && isFile(path.join(abs, "index.html"))) {
      return { command: "python3 -m http.server $PORT --bind 127.0.0.1", cwd: rel(abs) };
    }
  }

  return null;
}

/**
 * Start (or replace) this workspace's dev server.
 *
 * The command runs through a shell because that is what a project's own start
 * script is written for. It inherits this process's environment plus `PORT` and
 * `HOST`, which is the one convention worth imposing: a server told where to
 * listen does not have to guess, and the proxy knows the same number.
 */
export async function startPreview(options: {
  command?: string;
  cwd?: string;
  port?: number;
}): Promise<PreviewStatus> {
  const root = workspaceRoot();
  const relCwd = (options.cwd ?? "").trim();
  // What is inspected is where the command will run, not the workspace root: a
  // project in `smoketest/` is a project, and looking for its package.json at the
  // top of the tree would report it as nothing to run.
  const searchRoot = relCwd === "" ? root : resolveInWorkspace(relCwd);
  const named = (options.command ?? config.previewCommand).trim();
  // A named command wins; otherwise work out what this project is. The guess is
  // reported in the status either way, so the pane can say what it is running
  // rather than leave the user guessing where the app came from.
  const suggestion = named === "" ? detectPreviewCommand(searchRoot) : null;
  const command = named !== "" ? named : (suggestion?.command ?? "");
  if (command === "") {
    return {
      ...emptyStatus(null, options.cwd ?? null),
      error:
        "No command to run, and nothing here looks like an app. Ask the agent to start it " +
        "(it knows how this project starts), or set AGENT_PREVIEW_COMMAND for this deployment.",
    };
  }

  // Replace, never accumulate: a second server on one tree is a race over the
  // same files, and the operator asked for "the app", singular.
  await stopPreview();

  // The detection's own directory is relative to the one it searched, so a static
  // site found inside a chosen directory has to carry that directory with it.
  const detectedCwd = suggestion === null || suggestion.cwd === "." ? "" : suggestion.cwd;
  const runCwd = [relCwd, detectedCwd].filter((part) => part !== "").join("/") || ".";
  const absCwd = resolveInWorkspace(runCwd);
  const port = await findFreePort(options.port ?? config.previewPort);

  // What is already listening, before this start. Only a port that was silent
  // and then answers can be this command's — a port that answered all along
  // belongs to somebody else, and adopting it would show one account another's
  // app. That distinction is the whole reason this snapshot is taken here.
  const before = await Promise.all(
    [port, ...COMMON_PORTS].map(async (candidate) => [candidate, await portAnswers(candidate, 250)] as const),
  );
  const wasQuiet = new Set(before.filter(([, answers]) => !answers).map(([candidate]) => candidate));

  const child = spawn("bash", ["-lc", command], {
    cwd: absCwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      BROWSER: "none",
      CI: "1",
      AGENT_WORKSPACE: root,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry: PreviewProcess = {
    child,
    command,
    cwd: runCwd,
    port,
    startedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
    log: "",
  };
  running.set(keyFor(root), entry);

  child.stdout?.on("data", (chunk: Buffer) => appendLog(entry, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(entry, chunk));
  child.on("error", (error) => {
    entry.error = error.message;
    entry.exitCode = entry.exitCode ?? -1;
  });
  child.on("close", (code) => {
    entry.exitCode = code ?? 0;
  });

  // Give it a moment, so "started" can be reported as "answering" or "not yet".
  await new Promise((resolve) => setTimeout(resolve, START_GRACE_MS));

  if (entry.exitCode === null && !(await portAnswers(port, 400))) {
    // It ignored PORT. Follow it to whichever quiet port it took instead.
    for (const candidate of COMMON_PORTS) {
      if (candidate === port || !wasQuiet.has(candidate)) continue;
      if (await portAnswers(candidate, 400)) {
        entry.port = candidate;
        appendLog(entry, Buffer.from(`\n[preview] the app ignored PORT and is listening on ${candidate}.\n`));
        break;
      }
    }
  }

  const status = previewStatus();
  if (!status.running) {
    status.error =
      status.error ??
      `The command exited immediately (code ${status.exitCode ?? "unknown"}). Its output is below.`;
  } else if (!(await portAnswers(port))) {
    status.error = `Started, but nothing is answering on port ${port} yet. It may still be building.`;
  }
  if (named === "") status.detected = true;
  return status;
}

/** Stop this workspace's dev server. Idempotent. */
export async function stopPreview(): Promise<PreviewStatus> {
  const root = workspaceRoot();
  const entry = running.get(keyFor(root));
  if (entry === undefined) return emptyStatus();

  if (entry.exitCode === null && entry.child.pid !== undefined) {
    const pid = entry.child.pid;
    try {
      // The whole group: a dev server spawns a compiler, a proxy, a watcher.
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else entry.child.kill("SIGTERM");
    } catch {
      entry.child.kill("SIGTERM");
    }
    // Give it a moment to go quietly, then insist.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (entry.exitCode === null) {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else entry.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  entry.exitCode = entry.exitCode ?? 0;
  running.delete(keyFor(root));
  return {
    ...emptyStatus(entry.command, entry.cwd),
    exitCode: entry.exitCode,
    log: entry.log,
  };
}

/* --------------------------------------------------------------- live reload */

/**
 * Change notification, so the preview reloads when the files do.
 *
 * A dev server with hot reloading already does this for itself, and a static
 * one does not at all — `python3 -m http.server` will happily serve yesterday's
 * page. Watching the workspace and telling the browser to reload covers both,
 * and costs nothing when the app's own HMR got there first.
 *
 * Recursive watching is used because the files that matter are rarely at the
 * root. It is deliberately coarse: any change under the workspace bumps a
 * counter, and the browser decides what to do with that.
 */
export interface PreviewEvents {
  on(event: "change", listener: () => void): void;
  off(event: "change", listener: () => void): void;
}

const emitters = new Map<string, { emitter: EventEmitter; watcher: fs.FSWatcher }>();

/** Directories that never mean "the app changed". */
const IGNORED = new Set([".git", "node_modules", ".agent", "dist", "build", ".next", "__pycache__"]);

function ignored(rel: string): boolean {
  return rel.split(path.sep).some((part) => IGNORED.has(part));
}

/**
 * Subscribe to changes in this workspace.
 *
 * One watcher per workspace, shared by every listener, and torn down when the
 * last one leaves — a watcher left behind is a file descriptor and a process
 * that never lets go of the tree.
 */
export function previewEvents(): PreviewEvents {
  const root = workspaceRoot();
  let entry = emitters.get(root);
  if (entry === undefined) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true });
    } catch {
      // No watcher available is not a failure of the preview: the iframe simply
      // reloads only when the user asks it to.
      watcher = fs.watch(root);
    }
    watcher.on("error", () => {
      /* A watch that dies is a lost convenience, not a lost preview. */
    });
    watcher.on("change", (_event, filename) => {
      const rel = typeof filename === "string" ? filename : "";
      if (rel !== "" && ignored(rel)) return;
      emitter.emit("change");
    });
    entry = { emitter, watcher };
    emitters.set(root, entry);
  }

  const current = entry;
  return {
    on(_event, listener) {
      current.emitter.on("change", listener);
    },
    off(_event, listener) {
      current.emitter.off("change", listener);
      if (current.emitter.listenerCount("change") === 0) {
        current.watcher.close();
        emitters.delete(root);
      }
    },
  };
}

/** Only for tests: forget every process and watcher. */
export async function resetPreview(): Promise<void> {
  await stopPreview();
  for (const [, entry] of emitters) entry.watcher.close();
  emitters.clear();
  running.clear();
}
