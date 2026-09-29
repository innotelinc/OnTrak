/**
 * The container-backed driver: a real shell, behind the same seam.
 *
 * Everything above this file reads only `EngineState`, so a scenario can be driven by
 * genuine bash and graded by the code that has always graded the simulated machine. What
 * makes that work is one decision:
 *
 *   **The sandbox's filesystem is harvested back into the virtual one after every command.**
 *
 * A command runs in the sandbox at the student's current directory; then one `find` walks
 * the sandbox and reports type, permissions, owner, group, mtime, size and content for
 * every entry. Those entries *are* the attempt's `vfs`, so `file_exists`, `file_contains`,
 * `file_mode`, `dir_exists` and `file_absent` grade a real filesystem with no change to the
 * grader at all. Command history is recorded in the same shape the simulated driver records
 * it, so `command_matched` and `command_sequence` are unchanged too.
 *
 * Five things are worth stating plainly, because they are the limits of the illusion:
 *
 *  - **`cd` and `pwd` are the driver's, not the sandbox's.** Every command is a fresh
 *    process, so the working directory is tracked here and handed to the sandbox; `cd`
 *    changes it without a process starting, and a `cd` that fails leaves it alone.
 *  - **The sandbox lives under its own root** (`/sandbox` by default, beside the base
 *    image's own `/usr`, `/bin` and so on), and a command that prints an absolute path may
 *    print that root — a `readlink -f`, say. The driver does not rewrite command output,
 *    because quietly editing what a real shell really said is the one thing a fidelity
 *    backend must never do. Relative paths, `~`, `cd` and `pwd` are exact.
 *  - **Machine state that is not the filesystem is not harvested.** Users, services,
 *    packages, the registry and the firewall come from the scenario's boot state, exactly
 *    as they do for a simulated attempt. A container-fidelity scenario grades real files
 *    and real commands; `service_state` remains the simulated answer.
 *  - **The sandbox has no network.** Tools are baked into the image, which is what makes it
 *    a sandbox rather than a shell in the app's network namespace.
 *  - **Output is text.** Binary content is decoded as UTF-8 with replacement characters, and
 *    content is capped at `HARVEST_FILE_LIMIT` per file, so a check that greps a large or
 *    binary file is not a check anybody should write.
 *
 * The port is deliberately dumb — `reset`, `exec`, `harvest`, `dispose` — so the interesting
 * parts (planning a command line, parsing a harvest, building the seed script, the container
 * flags) are pure and tested without a container, and a fake sandbox can drive the whole
 * driver in a unit test.
 */

import { execFileSync } from "node:child_process";

import { parseMode, toKey } from "../paths";
import { makeEntry } from "../vfs";
import type { CommandResult, EngineId, EngineState, HistoryEntry, ShellDriver, Vfs } from "../types";

/* -------------------------------------------------------------------------- */
/*  The port                                                                  */
/* -------------------------------------------------------------------------- */

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * One isolated machine.
 *
 * The port speaks *engine* paths (`/home/student`) and each backend owns the mapping to its
 * own root, so the driver never has to know whether it is talking to a container or a
 * scratch directory. `reset` rebuilds the machine from the state, which is what booting an
 * attempt means: build the state, hand it to the sandbox, and let the sandbox be the truth
 * from then on.
 */
export interface Sandbox {
  readonly kind: "docker" | "process" | "fake";
  /** Recreate the machine's filesystem. Called once, before the first command. */
  reset(vfs: Vfs): void;
  /** Run one command line with the engine's working directory. */
  exec(command: string, cwd: string, timeoutMs: number): SandboxExecResult;
  /** The machine's whole filesystem, as raw harvest output. */
  harvest(timeoutMs: number): string;
  dispose(): void;
}

/** How long any single command may run before the sandbox kills it. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/** How long a harvest may take — it walks the sandbox root, nothing more. */
export const DEFAULT_HARVEST_TIMEOUT_MS = 10_000;
/** The most content harvested per file, so one large file cannot blow up the state. */
export const HARVEST_FILE_LIMIT = 256 * 1024;
/** Where the machine's `/` lives inside a container. */
export const DEFAULT_SANDBOX_ROOT = "/sandbox";

/* -------------------------------------------------------------------------- */
/*  Planning a command line (pure)                                            */
/* -------------------------------------------------------------------------- */

export type CommandPlan =
  | { kind: "local"; result: CommandResult }
  | { kind: "sandbox"; command: string; cwd: string }
  /** A directory change, which the driver makes rather than the sandbox. */
  | { kind: "cd"; cwd: string; error?: string; /** `cd -` prints where it landed, as bash does. */ print?: boolean };

/**
 * Decide what a typed line means.
 *
 * Almost everything goes to the sandbox untouched — pipes, redirection, `&&`, subshells and
 * loops are exactly what the student came for. The exceptions are the things that cannot
 * survive being run as a fresh process: `cd` (would be forgotten immediately), `pwd` (the
 * driver knows the answer exactly, and asking would print the sandbox's own root), `exit`
 * (would end nothing), `clear`/`cls` (a terminal instruction, not a program) and an empty
 * line.
 */
export function planCommand(input: string, state: EngineState, home: string, previousCwd?: string): CommandPlan {
  const line = input.trim();
  if (line === "") return { kind: "local", result: { stdout: "", stderr: "", exitCode: 0 } };

  const parts = line.split(/\s+/);
  const [head, ...rest] = parts;

  if (head === "clear" || head === "cls") return { kind: "local", result: { stdout: "", stderr: "", exitCode: 0, clear: true } };
  if (head === "exit" || head === "logout") {
    return { kind: "local", result: { stdout: "exit\n", stderr: "", exitCode: 0 } };
  }
  if (head === "pwd") return { kind: "local", result: { stdout: `${state.machine.cwd}\n`, stderr: "", exitCode: 0 } };

  if (head === "cd") {
    const raw = rest.join(" ").trim();
    // `cd -` is the one shell builtin that needs to remember something, so the caller
    // passes what it remembered. With nothing to go back to it fails the way bash does.
    if (raw === "-") {
      if (!previousCwd) return { kind: "cd", cwd: state.machine.cwd, error: "cd: OLDPWD not set" };
      return { kind: "cd", cwd: previousCwd, print: true };
    }
    const target = raw || home;
    const resolved = resolveSandboxPath(state.machine.cwd, target, home, state.machine.env.HOME ?? home);
    const entry = state.vfs[toKey("LINUX", resolved)];
    if (!entry) return { kind: "cd", cwd: state.machine.cwd, error: `cd: ${target}: No such file or directory` };
    if (entry.type !== "dir") return { kind: "cd", cwd: state.machine.cwd, error: `cd: ${target}: Not a directory` };
    return { kind: "cd", cwd: resolved };
  }

  return { kind: "sandbox", command: line, cwd: state.machine.cwd };
}

/**
 * Resolve a `cd` target the way bash would, within the machine's own namespace.
 *
 * Deliberately small: `~`, absolute and relative paths, and `.`/`..`. A glob or a variable
 * in a `cd` is not resolved — the sandbox would have to be asked, and a directory change is
 * not worth a round trip when the next harvest corrects the tree anyway.
 */
export function resolveSandboxPath(cwd: string, target: string, home: string, envHome: string): string {
  let raw = target;
  if (raw === "~") raw = envHome || home;
  else if (raw.startsWith("~/")) raw = `${envHome || home}${raw.slice(1)}`;
  if (!raw.startsWith("/")) raw = `${cwd}/${raw}`;

  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/* -------------------------------------------------------------------------- */
/*  The harvest (pure)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ask the sandbox for everything under `root`, one NUL-delimited record per entry.
 *
 * NUL separation is not decoration: a filename may contain a tab, a space, a quote or a
 * newline, and "clean up the files with spaces in the name" is a perfectly ordinary
 * scenario. `find -print0` plus `printf '%s\0'` makes the record format immune to all of it.
 *
 * The record is `type \0 stat \0 path \0 payload \0`, four fields at a time, where `stat` is
 * `%F|%a|%U|%G|%Y|%s` and the payload is base64 content for a file, the link target for a
 * link, and empty otherwise.
 *
 * `%F` is matched against both `regular file` and `regular empty file`, because GNU `stat`
 * calls a zero-byte file the latter — and a file a student has just created with `touch` is
 * exactly the file a scenario is most likely to check for.
 */
export function harvestScript(root: string, fileLimit = HARVEST_FILE_LIMIT): string {
  return [
    `root=${shellQuote(root)}`,
    `[ -d "$root" ] || exit 0`,
    `cd "$root" || exit 0`,
    `find . -mindepth 1 -maxdepth 32 -print0 2>/dev/null | while IFS= read -r -d '' p; do`,
    `  info=$(stat -c '%F|%a|%U|%G|%Y|%s' "$p" 2>/dev/null) || continue`,
    `  case "$info" in`,
    `    directory*) t=d ;;`,
    `    'regular file'*|'regular empty file'*) t=f ;;`,
    `    'symbolic link'*) t=l ;;`,
    `    *) t=o ;;`,
    `  esac`,
    `  rel=\${p#./}`,
    `  printf '%s\\0%s\\0%s\\0' "$t" "$info" "$rel"`,
    `  case "$t" in`,
    `    f) head -c ${Math.max(1, Math.floor(fileLimit))} "$p" 2>/dev/null | base64 | tr -d '\\n' ;;`,
    `    l) readlink "$p" 2>/dev/null | tr -d '\\n' ;;`,
    `  esac`,
    `  printf '\\0'`,
    `done`,
  ].join("\n");
}

/** A POSIX-safe single-quoted string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface HarvestIssue {
  reason: string;
  detail?: string;
}

export interface Harvest {
  vfs: Vfs;
  issues: HarvestIssue[];
  /** Files whose content was cut off at the harvest limit. */
  truncated: string[];
}

/**
 * Parse a harvest into virtual filesystem entries.
 *
 * Hostile input is the default assumption, because the input is whatever a real filesystem
 * happens to contain: a truncated record is dropped rather than half-applied, a file whose
 * content is not valid UTF-8 decodes with replacement characters, and anything the driver
 * does not recognise is reported as an issue instead of guessed at.
 */
export function parseHarvest(output: string, platform: "LINUX" | "WINDOWS" = "LINUX"): Harvest {
  const vfs: Vfs = {};
  const issues: HarvestIssue[] = [];
  const truncated: string[] = [];
  const fields = output.split("\0");
  // The final `\0` leaves one empty trailing field; a record is four fields.
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 4 !== 0) {
    issues.push({ reason: "The sandbox sent a truncated harvest; the last entry was ignored." });
  }

  const complete = fields.length - (fields.length % 4);

  for (let index = 0; index < complete; index += 4) {
    const [type, info, relative, payload] = [fields[index], fields[index + 1], fields[index + 2], fields[index + 3]];
    const stat = info.split("|");
    const mode = stat[1] ?? "";
    const owner = stat[2] ?? "root";
    const group = stat[3] ?? "root";
    const mtimeSeconds = Number(stat[4] ?? "");
    const size = Number(stat[5] ?? "");
    const mtime = Number.isFinite(mtimeSeconds) ? mtimeSeconds * 1000 : undefined;

    const canonical = harvestPathToVfs(relative);
    if (!canonical) {
      issues.push({ reason: "A harvested path was outside the sandbox and was ignored.", detail: relative });
      continue;
    }

    if (type === "d") {
      vfs[toKey(platform, canonical)] = makeEntry(canonical, { type: "dir", mode: parseMode(mode, 0o755), owner, group, mtime });
      continue;
    }

    if (type === "l") {
      vfs[toKey(platform, canonical)] = makeEntry(canonical, {
        type: "link",
        target: payload,
        mode: parseMode(mode, 0o777),
        owner,
        group,
        mtime,
      });
      continue;
    }

    if (type !== "f") {
      // Sockets, fifos, devices: real, gradable in no useful way, and reported so an author
      // who expected a file can see why it is missing.
      issues.push({ reason: "A harvested entry is neither a file, a directory nor a link.", detail: canonical });
      continue;
    }

    let content = "";
    try {
      content = Buffer.from(payload, "base64").toString("utf8");
    } catch {
      issues.push({ reason: "A harvested file's content could not be decoded.", detail: canonical });
    }
    if (Number.isFinite(size) && size > content.length) truncated.push(canonical);

    vfs[toKey(platform, canonical)] = makeEntry(canonical, {
      type: "file",
      content,
      mode: parseMode(mode, 0o644),
      owner,
      group,
      mtime,
    });
  }

  return { vfs, issues, truncated };
}

/**
 * A path a harvest reported (`home/student/x`) as an engine path.
 *
 * `null` when it escapes upward, which is the one case where applying it would let the
 * sandbox name a path the machine's namespace does not have.
 */
export function harvestPathToVfs(relative: string): string | null {
  const cleaned = relative.replace(/^\.?\//, "").replace(/^\/+/, "");
  if (cleaned === "" || cleaned.split("/").some((segment) => segment === "..")) return null;
  return `/${cleaned}`;
}

/* -------------------------------------------------------------------------- */
/*  Seeding (pure)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A shell script that recreates a machine inside the sandbox.
 *
 * Content is base64-encoded and decoded in the sandbox rather than interpolated, so a file
 * containing quotes, `$`, backticks or a newline is written byte-for-byte — which is the
 * whole point of seeding from the same state the simulated engine would have booted. The
 * root itself is rebuilt from empty, so an attempt never inherits the previous attempt's
 * leftovers.
 */
export function seedScript(vfs: Vfs, root = DEFAULT_SANDBOX_ROOT): string {
  const lines: string[] = [
    `root=${shellQuote(root)}`,
    `rm -rf "$root"`,
    `mkdir -p "$root"`,
    `cd "$root" || exit 1`,
    `chmod 755 .`,
  ];

  const entries = Object.values(vfs).filter((entry) => entry.path !== "/" && entry.path !== "/c:");
  // Directories first, shallowest first, so a file is never written into a directory that
  // does not exist yet.
  const dirs = entries
    .filter((entry) => entry.type === "dir")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const rest = entries.filter((entry) => entry.type !== "dir");

  for (const dir of dirs) {
    const target = shellQuote(relativeToRoot(dir.path));
    lines.push(`mkdir -p ${target} && chmod ${modeString(dir.mode)} ${target}`);
  }
  for (const entry of rest) {
    const target = shellQuote(relativeToRoot(entry.path));
    lines.push(`mkdir -p "$(dirname ${target})" 2>/dev/null || true`);
    if (entry.type === "link") {
      lines.push(`ln -sfn ${shellQuote(entry.target ?? "")} ${target}`);
    } else {
      lines.push(`printf '%s' ${shellQuote(Buffer.from(entry.content ?? "", "utf8").toString("base64"))} | base64 -d > ${target}`);
      lines.push(`chmod ${modeString(entry.mode)} ${target}`);
    }
  }

  return lines.join("\n");
}

/** An engine path as a path inside the sandbox root. */
export function relativeToRoot(path: string): string {
  return path.replace(/^\/+/, "");
}

/** An engine path as the absolute path inside a sandbox rooted at `root`. */
export function sandboxPathFor(root: string, path: string): string {
  const base = root.replace(/\/+$/, "");
  const rest = relativeToRoot(path);
  return base === "" ? `/${rest}` : rest === "" ? base : `${base}/${rest}`;
}

function modeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/* -------------------------------------------------------------------------- */
/*  Launching a container (pure)                                              */
/* -------------------------------------------------------------------------- */

export interface ContainerLimits {
  memory: string;
  cpus: string;
  pids: number;
}

export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  memory: "512m",
  cpus: "1",
  pids: 256,
};

/**
 * The `docker create` arguments for one attempt's sandbox.
 *
 * Every flag here is a refusal to be more than a disposable box: no network, no new
 * privileges, no Linux capabilities, a memory ceiling, a CPU ceiling and a process ceiling.
 * The image is what decides which tools exist, which is why an author who needs `htop` bakes
 * an image instead of installing one.
 */
export function dockerCreateArgs(options: { image: string; name: string; limits?: Partial<ContainerLimits> }): string[] {
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...options.limits };
  return [
    "create",
    "--name",
    options.name,
    "--network",
    "none",
    "--memory",
    limits.memory,
    "--memory-swap",
    limits.memory,
    "--cpus",
    limits.cpus,
    "--pids-limit",
    String(limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--label",
    "ontrak.sandbox=1",
    options.image,
    "sleep",
    "infinity",
  ];
}

/**
 * The program and flags that run one command line for an engine, or `null` when this release
 * cannot be faithful to that engine.
 *
 * Bash is genuine bash in a Linux container. PowerShell is deliberately not here yet: the
 * honest version of it is a Windows base image, and shipping a `pwsh` process on Linux under
 * a scenario that promises Windows would be fidelity theatre. Container fidelity is offered
 * for bash, and the availability rule says so rather than quietly substituting something.
 */
export function sandboxShellFor(engine: EngineId): { program: string; flags: string[] } | null {
  return engine === "bash" ? { program: "bash", flags: ["-lc"] } : null;
}

/* -------------------------------------------------------------------------- */
/*  The Docker sandbox                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A container per attempt.
 *
 * `execFileSync` is what makes the whole thing fit the existing seam: the driver's contract
 * is synchronous, and a synchronous `docker exec` is a real one — the console simply waits
 * the few hundred milliseconds a command takes. No async leaks into the grader, and no state
 * machine appears in the UI.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  private started = false;

  constructor(
    private readonly options: {
      image: string;
      name: string;
      root?: string;
      limits?: Partial<ContainerLimits>;
      /** Runs the docker CLI; injectable so the arguments can be asserted in a test. */
      run?: (args: string[], timeoutMs: number) => SandboxExecResult;
    },
  ) {}

  private get root(): string {
    return this.options.root ?? DEFAULT_SANDBOX_ROOT;
  }

  private docker(args: string[], timeoutMs: number): SandboxExecResult {
    if (this.options.run) return this.options.run(args, timeoutMs);
    try {
      const stdout = execFileSync("docker", args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number | null; message?: string };
      return {
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" && failure.stderr ? failure.stderr : (failure.message ?? "docker failed"),
        exitCode: typeof failure.status === "number" ? failure.status : 1,
      };
    }
  }

  /** Run a command in the container at an explicit *container* directory. */
  private execInside(inside: string, command: string, timeoutMs: number): SandboxExecResult {
    const shell = sandboxShellFor("bash");
    if (!shell) return { stdout: "", stderr: "This engine has no shell.", exitCode: 127 };
    return this.docker(["exec", "-i", "-w", inside, this.options.name, shell.program, ...shell.flags, command], timeoutMs);
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.docker(["rm", "-f", this.options.name], 30_000);
    const created = this.docker(
      dockerCreateArgs({ image: this.options.image, name: this.options.name, limits: this.options.limits }),
      120_000,
    );
    if (created.exitCode !== 0) throw new Error(created.stderr.trim() || "Could not create the simulator sandbox.");
    const started = this.docker(["start", this.options.name], 60_000);
    if (started.exitCode !== 0) throw new Error(started.stderr.trim() || "Could not start the simulator sandbox.");

    // Prove the image can actually run a command line before anything depends on it. `docker
    // start` succeeds even when the process it started exited immediately, and an image with
    // no `bash` (an Alpine or distroless base, say) otherwise fails much later with an exec
    // error that names a path rather than the problem.
    const shell = sandboxShellFor("bash");
    const probe = this.docker(["exec", "-i", "-w", "/", this.options.name, shell!.program, ...shell!.flags, "command -v bash"], 60_000);
    if (probe.exitCode !== 0) {
      throw new Error(
        `The sandbox image "${this.options.image}" cannot run bash, which container fidelity requires. Use an image that has it (for example debian:bookworm-slim) or bake one for the scenario. ${probe.stderr.trim()}`.trim(),
      );
    }

    this.started = true;
  }

  reset(vfs: Vfs): void {
    this.ensureStarted();
    // Seeding runs from the container's own `/`: the sandbox root does not exist yet, so
    // there is nothing to make the working directory out of until the script creates it.
    const result = this.execInside("/", seedScript(vfs, this.root), 120_000);
    if (result.exitCode !== 0) throw new Error(`Could not seed the sandbox: ${result.stderr.trim()}`);
  }

  exec(command: string, cwd: string, timeoutMs: number): SandboxExecResult {
    // The working directory *inside* the container is the machine's path under the root,
    // which is what makes `~`, relative paths and `cd ..` behave.
    return this.execInside(sandboxPathFor(this.root, cwd), command, timeoutMs);
  }

  harvest(timeoutMs: number): string {
    return this.execInside("/", harvestScript(this.root), timeoutMs).stdout;
  }

  dispose(): void {
    if (!this.started) return;
    this.docker(["rm", "-f", this.options.name], 60_000);
    this.started = false;
  }
}

/**
 * A local sandbox: real bash, a scratch directory, no isolation.
 *
 * This exists for two reasons and is honest about both. It is what makes the automated test
 * of the container driver exercise **real bash** on a machine with no Docker daemon, and it
 * is a development convenience. It is *not* a security boundary: commands run as the app
 * user with whatever access that user has. It is therefore never selected by environment
 * alone — `ONTRAK_SANDBOX_BACKEND=process` and `ONTRAK_SANDBOX_ALLOW_PROCESS=1` are both
 * required, and both are things an operator types on purpose.
 */
export class ProcessSandbox implements Sandbox {
  readonly kind = "process" as const;

  constructor(private readonly options: { scratch: string; env?: Record<string, string> }) {}

  private bash(command: string, cwd: string, timeoutMs: number): SandboxExecResult {
    try {
      const stdout = execFileSync("bash", ["-lc", command], {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...this.options.env },
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number | null; message?: string };
      return {
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" && failure.stderr ? failure.stderr : (failure.message ?? "bash failed"),
        exitCode: typeof failure.status === "number" ? failure.status : 1,
      };
    }
  }

  /** The host directory that stands in for the machine's `/`. */
  private get root(): string {
    return this.options.scratch;
  }

  reset(vfs: Vfs): void {
    execFileSync("mkdir", ["-p", this.root], { stdio: "ignore" });
    const result = this.bash(seedScript(vfs, this.root), "/", 120_000);
    if (result.exitCode !== 0) throw new Error(`Could not seed the sandbox: ${result.stderr.trim()}`);
  }

  exec(command: string, cwd: string, timeoutMs: number): SandboxExecResult {
    // The process starts in the host directory that mirrors the machine's working
    // directory, so relative paths and `cd ..` work exactly as they do in a container.
    return this.bash(command, sandboxPathFor(this.root, cwd), timeoutMs);
  }

  harvest(timeoutMs: number): string {
    return this.bash(harvestScript(this.root), "/", timeoutMs).stdout;
  }

  dispose(): void {
    try {
      execFileSync("rm", ["-rf", this.options.scratch], { stdio: "ignore" });
    } catch {
      /* a scratch directory that is already gone is not a problem */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The driver                                                                */
/* -------------------------------------------------------------------------- */

export interface ContainerDriverOptions {
  /** The engine to be faithful to. Only `bash` is supported — see `sandboxShellFor`. */
  engine: EngineId;
  /** The sandbox to run in. The driver never creates, starts or disposes of one. */
  sandbox: Sandbox;
  user?: string;
  home?: string;
  commandTimeoutMs?: number;
  /** Called once per command with how long the harvest took and what it found. */
  onHarvest?: (info: { ms: number; entries: number; issues: HarvestIssue[]; truncated: string[] }) => void;
}

/**
 * A `ShellDriver` driven by a real shell.
 *
 * `run` is the whole of it: plan the line, maybe run it in the sandbox, harvest, fold the
 * result into the state, record history. The state it returns is the shape the simulated
 * driver returns, which is what makes the two interchangeable to the console and to the
 * grader.
 */
export function createContainerDriver(options: ContainerDriverOptions): ShellDriver {
  const shell = sandboxShellFor(options.engine);
  if (!shell) throw new Error(`Container fidelity is not available for the "${options.engine}" engine.`);

  const user = options.user ?? "student";
  const home = options.home ?? `/home/${user}`;
  const commandTimeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  /** What `cd -` goes back to, exactly as a real shell remembers it. */
  let previousCwd: string | undefined;

  const pushHistory = (state: EngineState, input: string, result: CommandResult) => {
    const entry: HistoryEntry = {
      index: state.machine.history.length + 1,
      input,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      cwd: state.machine.cwd,
      at: Date.now(),
    };
    state.machine.history = [...state.machine.history, entry];
    state.machine.exitCode = result.exitCode ?? 0;
    state.meta.revision += 1;
  };

  const harvestInto = (state: EngineState): Harvest => {
    const startedAt = Date.now();
    const raw = options.sandbox.harvest(DEFAULT_HARVEST_TIMEOUT_MS);
    const parsed = parseHarvest(raw, "LINUX");
    // The harvested tree *is* the machine's filesystem. Nothing is merged over it: a file
    // the student deleted in the sandbox must be absent here too, or `file_absent` would be
    // grading a state the sandbox does not have.
    state.vfs = parsed.vfs;
    options.onHarvest?.({ ms: Date.now() - startedAt, entries: Object.keys(parsed.vfs).length, issues: parsed.issues, truncated: parsed.truncated });
    return parsed;
  };

  return {
    id: options.engine,
    platform: "LINUX",
    banner(state) {
      return [
        `${state.machine.os.name} (${state.machine.os.version}) — real shell, sandboxed`,
        "",
        ` * No network, no extra privileges, ${Math.round(commandTimeout / 1000)}s per command`,
        " * Your files live under the sandbox root; `cd` and `pwd` behave as they do on a real host",
        "",
        `Last login: ${new Date().toUTCString()} from 10.10.10.1`,
      ].join("\n");
    },
    prompt(state) {
      const short = state.machine.cwd.startsWith(home) ? state.machine.cwd.replace(home, "~") || "~" : state.machine.cwd;
      const suffix = user === "root" ? "#" : "$";
      return `${user}@${state.machine.hostname}:${short}${suffix} `;
    },
    run(input, state) {
      const plan = planCommand(input, state, home, previousCwd);

      if (plan.kind === "local") {
        pushHistory(state, input.trim(), plan.result);
        return plan.result;
      }

      if (plan.kind === "cd") {
        if (plan.error) {
          const failed: CommandResult = { stdout: "", stderr: plan.error, exitCode: 1 };
          pushHistory(state, input.trim(), failed);
          return failed;
        }
        previousCwd = state.machine.cwd;
        state.machine.cwd = plan.cwd;
        state.machine.env.PWD = plan.cwd;
        state.machine.env.OLDPWD = previousCwd;
        const ok: CommandResult = { stdout: plan.print ? `${plan.cwd}\n` : "", stderr: "", exitCode: 0 };
        pushHistory(state, input.trim(), ok);
        return ok;
      }

      let result: CommandResult;
      try {
        const executed = options.sandbox.exec(plan.command, plan.cwd, commandTimeout);
        result = { stdout: executed.stdout, stderr: executed.stderr, exitCode: executed.exitCode };
      } catch (error) {
        result = { stdout: "", stderr: `sandbox: ${(error as Error).message}`, exitCode: 1 };
      }

      try {
        harvestInto(state);
      } catch (error) {
        // A harvest that fails leaves the previous tree in place and says so: grading on a
        // half-read filesystem would be worse than grading on a stale one.
        const note = `sandbox: could not read the filesystem after that command (${(error as Error).message})`;
        result.stderr = result.stderr ? `${result.stderr}\n${note}` : note;
        result.exitCode = result.exitCode || 1;
      }

      pushHistory(state, input.trim(), result);
      return result;
    },
    boot(state) {
      options.sandbox.reset(state.vfs);
      harvestInto(state);
    },
    completions() {
      // The sandbox could be asked, but a round trip for a Tab press is not worth the
      // latency; the console falls back to the student's own typed history.
      return [];
    },
  };
}
