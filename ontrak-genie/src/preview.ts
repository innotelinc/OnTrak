import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { config } from "./config.js";
import { addressFor, lanAddress } from "./network.js";
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
  /**
   * The address the app is reachable at from the network, when the deployment
   * publishes it, or null.
   *
   * This is the difference between "the person at this console can see the app"
   * and "anything else on the network can call the app" — a gateway sending a
   * webhook, a phone checking the page, a provider redirecting a sign-in back.
   * Only a real LAN address is named here: inside a container the alternative is
   * the docker bridge address, which resolves for this host and refuses for
   * everybody the URL would be handed to.
   */
  address: string | null;
  /** When it started, ISO-8601. */
  startedAt: string | null;
  /** Its exit code once it has stopped, or null while it runs or if it never started. */
  exitCode: number | null;
  /** Why the last start attempt failed, if it did. */
  error: string | null;
  /** The tail of its output, for "why is the preview blank?". */
  log: string;
  /**
   * True while the process is up but nothing has answered on its port yet — a
   * framework still building, a debug reloader still starting. It is deliberately
   * not `error`: the app is about to prove the report wrong, and a pane that
   * painted "not reachable" over a server that was merely slow is the one thing
   * the person watching cannot tell from a real failure. The pane shows "starting"
   * and the status is asked again until this clears.
   */
  pending?: boolean;
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
  /** Set while the process is up but has not answered on its port yet. */
  pending: boolean;
  log: string;
}

const LOG_LIMIT = 8_000;
/**
 * How long a started app is given to answer on its port, before "started" is
 * reported as "not yet".
 *
 * The *boundary* is unchanged, deliberately: an app that has not answered within
 * it is `pending`, which is the flag that stops the pane showing "not reachable"
 * over a framework's first build (see the test of the same name). What changed is
 * how the boundary is *measured*. It used to be one sleep followed by a single
 * probe, which is a race: a server that binds a little late — always true under
 * load — was reported as not-answering the instant that one probe happened to
 * miss it. Polling asks the same question repeatedly until the boundary, so a
 * server that answers at 700 ms is reported the moment it does rather than
 * whenever the single probe was scheduled.
 */
const READY_GRACE_MS = 900;

/** How long one probe waits for a connection, while polling. */
const READY_PROBE_MS = 300;

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
    address: null,
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
  const live = entry.exitCode === null;
  const status: PreviewStatus = {
    running: live,
    command: entry.command,
    cwd: entry.cwd,
    port: entry.port,
    url: "/preview/",
    address: live ? publishedAddress(entry.port) : null,
    startedAt: entry.startedAt,
    exitCode: entry.exitCode,
    error: entry.error,
    log: entry.log,
  };
  // Only when it is true: a stopped preview has no "still starting", and leaving
  // the key off keeps `pending` a fact about a running app rather than a field
  // every answer has to carry.
  if (live && entry.pending) status.pending = true;
  return status;
}

/**
 * Take the "still starting" flag down once the app answers.
 *
 * `startPreview` reports a process that had not bound yet as `pending`, but that
 * answer is a snapshot. A framework that needs two seconds to build is not going
 * to say so again, so the caller — the pane, asking the status on a timer — checks
 * the port once more here. Clearing the flag is what lets the frame load the app
 * it was told to wait for.
 */
export async function recheckPreview(): Promise<void> {
  const entry = running.get(keyFor(workspaceRoot()));
  if (entry === undefined || entry.exitCode !== null || !entry.pending) return;
  if (await portAnswers(entry.port, 500)) entry.pending = false;
}

/**
 * The address this app answers at from the network, or null when it does not.
 *
 * Null is the honest answer in three cases, and each is a real one: nothing is
 * running; the deployment has not said the port is published
 * (`AGENT_PREVIEW_PUBLISH`), so a URL would be a promise nothing keeps; and the
 * app bound loopback, where the address would resolve to the app's own refusal.
 * The console proxy still reaches all of them — this is only about the network.
 */
function publishedAddress(port: number): string | null {
  if (!config.previewPublish) return null;
  if (config.previewHost === "127.0.0.1") return null;
  // Only the port the deployment published is reachable, and a project that
  // ignored `PORT` (Vite takes 3000, Astro takes 4321) landed somewhere else.
  // Advertising it would be naming a port nothing forwards, so it is not named.
  if (port !== config.previewPort) return null;
  const host = config.previewHost === "0.0.0.0" ? lanAddress() : config.previewHost;
  return addressFor(host, port);
}

/**
 * The address this process dials the app on.
 *
 * Not the advertised one: the app is usually on loopback, and even when it is
 * bound to every interface, `127.0.0.1` is the shortest way to the same socket.
 * A deployment that bound the app to one specific address is the case where they
 * differ, and then the bind address is the only one that answers.
 */
export function previewDialHost(): string {
  return config.previewHost === "0.0.0.0" ? "127.0.0.1" : config.previewHost;
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

/**
 * Poll a port until something answers or the deadline passes.
 *
 * The loop is what makes a slow start a *wait* rather than a wrong answer: the
 * first probe runs immediately, so a server already up is reported without delay,
 * and a server still compiling is given the rest of the deadline instead of being
 * called not-yet-answering the instant one probe happened to miss it.
 */
async function waitForAnswer(port: number, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await portAnswers(port, Math.min(READY_PROBE_MS, Math.max(50, until - Date.now())))) {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** Is anything listening there yet? Used to report "started but not answering". */
export async function portAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: previewDialHost(), port });
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

/**
 * Wait for a port to stop answering, so the next start can take it back.
 *
 * `stopPreview` signals the group and waits a moment, but the OS does not have to
 * have released the socket by the time it returns — a listening server closes
 * asynchronously, and a just-killed one can still accept for a beat. Probing
 * immediately then reports the port as taken and the restart lands on a *new*
 * one, which is exactly the "the replacement took the same port back" promise the
 * preview makes. Bounded, because a port somebody else owns should be left alone
 * rather than waited on.
 */
async function waitForPortFree(port: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portAnswers(port, 150))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A free port, preferring the configured one so a project's usual URL keeps working. */
export async function findFreePort(preferred: number): Promise<number> {
  const free = async (port: number): Promise<boolean> =>
    await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, previewDialHost());
    });

  // Zero or less is "no preference", not port zero: handing that number back
  // would ask the app to listen somewhere the proxy could never reach.
  if (preferred > 0 && (await free(preferred))) return preferred;
  // Ask the OS for one; the exact number does not matter, being reachable does.
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, previewDialHost(), () => {
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
    return { command: "python3 manage.py runserver ${HOST:-127.0.0.1}:$PORT", cwd: "." };
  }

  for (const dir of STATIC_DIRS) {
    const abs = dir === "." ? root : path.join(root, dir);
    if (isDir(abs) && isFile(path.join(abs, "index.html"))) {
      // `$HOST` rather than a constant: it is set by `startPreview` to whatever
      // this deployment binds, so a published preview is served on the published
      // address and a private one stays on loopback. A hard-coded `127.0.0.1`
      // here would make the one detector that starts a server of its own the one
      // detector that cannot be published.
      return { command: "python3 -m http.server $PORT --bind ${HOST:-127.0.0.1}", cwd: rel(abs) };
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
  // same files, and the operator asked for "the app", singular. The port the
  // outgoing preview held is remembered so the replacement can take it back
  // rather than landing somewhere new on every restart.
  const previous = previewPort();
  await stopPreview();
  if (previous !== null) await waitForPortFree(previous);

  // The detection's own directory is relative to the one it searched, so a static
  // site found inside a chosen directory has to carry that directory with it.
  const detectedCwd = suggestion === null || suggestion.cwd === "." ? "" : suggestion.cwd;
  const runCwd = [relCwd, detectedCwd].filter((part) => part !== "").join("/") || ".";
  const absCwd = resolveInWorkspace(runCwd);
  const port = await findFreePort(options.port ?? previous ?? config.previewPort);

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
      // What the app binds. Not what it is *dialled* on — see `previewDialHost`.
      HOST: config.previewHost,
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
    pending: false,
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

  // Wait for it to answer, so "started" can be reported as "answering" or
  // "not yet" — as soon as it is true rather than after a fixed guess.
  const answeredOnPort = entry.exitCode === null && (await waitForAnswer(port, READY_GRACE_MS));

  if (entry.exitCode === null && !answeredOnPort) {
    // It ignored PORT. Follow it to whichever quiet port it took instead.
    for (const candidate of COMMON_PORTS) {
      if (candidate === port || !wasQuiet.has(candidate)) continue;
      if (await waitForAnswer(candidate, READY_PROBE_MS)) {
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
  } else if (!(await portAnswers(entry.port))) {
    // Up, but not listening yet. Not a failure: mark it as starting so the pane
    // waits for the app instead of showing the 503 the proxy would answer with.
    entry.pending = true;
    status.pending = true;
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
