/**
 * The lab's Incus client — the TypeScript half of OnTrak-dev's `ontrak/incus.py`.
 *
 * We drive the `incus` CLI rather than a client library, for the reason the Python
 * module gives and which survives the port: operators already have the CLI, version
 * skew between a daemon and a client binding is a common source of breakage, and
 * every call here maps 1:1 onto a command someone can run by hand while debugging.
 * `--format=json` supplies the structured half.
 *
 * THREE CLI RULES THIS CLIENT IS BUILT AROUND, each one a mistake that stopped the
 * platform dead on a real host before it was understood. The ported test runs the
 * client against a stand-in that enforces all three, so putting any of them back
 * fails a test rather than a class:
 *
 *   * `--format` is a flag of the *list* commands only. `image info`, `info` and
 *     `storage info` answer `Error: unknown flag: --format`, exit 1 — which made
 *     `imageExists()` answer false for every image and made every template build
 *     refuse every workload, pointing the operator at a build command that answered
 *     "already an image; nothing to build". So every structured read below is either
 *     a `* list --format=json` or a `query`, which is the machine-readable form of
 *     the same answer and has existed in every version.
 *   * `query` is a raw API call and refuses `--project` outright (the project belongs
 *     in the path), so `base()` drops that flag when a caller says so.
 *   * `exec --user` takes a *numeric* uid and refuses an account name, and the
 *     platform's default Linux account is the name `root` — so every shell call used
 *     to fail, no readiness probe ever succeeded, and no template could be built.
 *     Root is what `exec` does anyway and needs no flag; any other name is resolved
 *     in the guest once and remembered, because the answer cannot change while a
 *     disposable lab machine lives.
 *
 * ONE DELIBERATE DEVIATION FROM THE PYTHON. `subprocess.run` is synchronous, and the
 * Python portal runs the session manager on worker threads. The faithful-in-shape
 * Node equivalent would be `spawnSync`, but a blocking 120-second `incus list`
 * inside a request handler stalls this application's single event loop for everyone
 * — so every method here returns a promise and the process seam is a promise. A
 * caller that wants the Python's blocking semantics (a CLI script) simply awaits.
 *
 * The process boundary is injectable (`Runner`) on purpose: that is what lets the
 * whole client be proven against a stand-in reproducing the CLI's refusals, which is
 * the one thing a method-name double can never catch. Nothing here reads the
 * environment — the settings a call needs arrive as a narrow structural subset of
 * the lab's `IncusConfig`.
 *
 * Server-side only: it spawns a process, so it must never reach a client component.
 */

import { spawn } from "node:child_process";

/** The ceiling used when neither the call nor the settings name one. */
export const DEFAULT_TIMEOUT = 120;

/**
 * The process seam.
 *
 * `argv[0]` is the program to run, exactly as `execve` sees it, so a stand-in can
 * tell which binary a call was aimed at. A runner signals the two failures the
 * client distinguishes from an exit code — no such binary, and a timeout — by
 * throwing, which is how Python's `FileNotFoundError`/`TimeoutExpired` arrive.
 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(
    argv: readonly string[],
    options: { timeoutSeconds: number; input?: string | undefined },
  ): Promise<CommandResult>;
}

/** Thrown by a runner when the program does not exist on this host. */
export class RunnerSpawnError extends Error {
  constructor(
    readonly program: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerSpawnError";
  }
}

/** Thrown by a runner when the process outlived its timeout and was killed. */
export class RunnerTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`timed out after ${seconds}s`);
    this.name = "RunnerTimeoutError";
  }
}

/** Raised when an incus command fails. */
export class IncusError extends Error {
  readonly argsList: readonly string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: readonly string[], code: number, stderr: string) {
    const trimmed = stderr.trim();
    super(`incus ${args.join(" ")} failed (${code}): ${trimmed}`);
    this.name = "IncusError";
    this.argsList = [...args];
    this.code = code;
    this.stderr = trimmed;
    // Keeps `instanceof` honest if this ever compiles down to ES5 helpers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an instance/image/snapshot does not exist. */
export class IncusNotFound extends IncusError {
  constructor(args: readonly string[], code: number, stderr: string) {
    super(args, code, stderr);
    this.name = "IncusNotFound";
  }
}

/** The settings this client reads — a structural subset of the lab's `IncusConfig`. */
export interface IncusSettings {
  /** A cluster endpoint, or empty/`local` for the host this runs on. */
  remote: string;
  /** The project the lab's machines live in. */
  project: string;
  /** The storage pool whose driver decides whether clones are cheap. */
  storagePool: string;
  /** The ceiling for every call, not only the mutating ones. */
  operationTimeoutSeconds: number;
}

/** One instance as the CLI describes it. */
export interface InstanceInfo {
  name: string;
  status: string;
  kind: string;
  ipv4: string;
  cpu: number;
  memoryMb: number;
  os: string;
  raw: Record<string, unknown> | null;
}

/** True once the machine is up, which is what the pool and every wait key on. */
export function instanceRunning(info: InstanceInfo): boolean {
  return info.status.toUpperCase() === "RUNNING";
}

/**
 * `limits.memory` as megabytes.
 *
 * Incus accepts several spellings for the same quantity and reports back the one the
 * operator typed, so a pool's memory arithmetic cannot assume `4GiB`. An
 * unrecognised value is 0 rather than a crash: this number sizes a display and a
 * capacity estimate, and a hand-edited config should not take the pool view down.
 */
export function parseMemoryMb(value: string): number {
  const text = (value || "").trim().toUpperCase();
  if (!text) return 0;
  const multipliers: readonly (readonly [string, number])[] = [
    ["KIB", 1 / 1024],
    ["MIB", 1],
    ["GIB", 1024],
    ["TIB", 1024 * 1024],
  ];
  for (const [suffix, factor] of multipliers) {
    if (text.endsWith(suffix)) {
      const amount = Number.parseFloat(text.slice(0, -suffix.length));
      return Number.isFinite(amount) ? Math.trunc(amount * factor) : 0;
    }
  }
  const plain = Number.parseFloat(text);
  return Number.isFinite(plain) ? Math.trunc(plain) : 0;
}

/**
 * The default runner: `child_process.spawn`, always with piped stdio.
 *
 * Python's `capture` parameter has no counterpart here because no caller in the lab
 * passes `capture=False` — every call reads stdout and stderr, so the port always
 * pipes them rather than carrying a switch with one setting.
 */
export function processRunner(): Runner {
  return {
    run(argv, options) {
      return new Promise<CommandResult>((resolve, reject) => {
        const program = argv[0];
        if (!program) {
          reject(new RunnerSpawnError("", "no program given to the runner"));
          return;
        }
        const child = spawn(program, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        const out = child.stdout;
        const err = child.stderr;
        const stdin = child.stdin;
        if (!out || !err || !stdin) {
          reject(new RunnerSpawnError(program, `${program} could not be given pipes`));
          return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        out.setEncoding("utf8");
        err.setEncoding("utf8");
        out.on("data", (chunk: string) => {
          stdout += chunk;
        });
        err.on("data", (chunk: string) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, Math.max(1, options.timeoutSeconds) * 1000);
        child.on("error", (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new RunnerSpawnError(program, error.message));
        });
        child.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (timedOut) {
            reject(new RunnerTimeoutError(options.timeoutSeconds));
            return;
          }
          resolve({ code: code ?? 0, stdout, stderr });
        });
        stdin.end(options.input ?? "");
      });
    },
  };
}

interface RunOptions {
  timeout?: number | undefined;
  check?: boolean | undefined;
  input?: string | undefined;
  project?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Whether an instance reference names a snapshot (`tpl-x/clean`). */
function isSnapshot(source: string): boolean {
  const body = source.includes(":") ? source.slice(source.indexOf(":") + 1) : source;
  return body.includes("/");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class IncusClient {
  readonly settings: IncusSettings;
  readonly binary: string;
  private readonly runner: Runner;
  private readonly timeout: number;
  /**
   * Account name -> uid, per instance. Resolving one costs a command, and the answer
   * cannot change while a disposable lab machine lives.
   */
  private readonly uidCache = new Map<string, string>();

  constructor(settings: IncusSettings, options: { binary?: string; runner?: Runner } = {}) {
    this.settings = settings;
    this.binary = options.binary ?? "incus";
    this.runner = options.runner ?? processRunner();
    this.timeout = settings.operationTimeoutSeconds;
  }

  // ------------------------------------------------------------------
  // plumbing
  // ------------------------------------------------------------------

  private base(project = true): string[] {
    const cmd = [this.binary];
    if (this.settings.remote && this.settings.remote !== "local") {
      cmd.push("--remote", this.settings.remote);
    }
    if (project && this.settings.project) {
      cmd.push("--project", this.settings.project);
    }
    return cmd;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const cmd = [...this.base(options.project ?? true), ...args];
    // The configured operation timeout is the ceiling for *every* call, not just the
    // mutating ones that ask explicitly. Reads are not cheap: `incus list` reports
    // each instance's state, agent status and address, so on a busy host it blocks
    // for minutes on a VM that is still booting — a bare DEFAULT_TIMEOUT failed a
    // template build at exactly that point even with the operator's timeout raised.
    const effectiveTimeout = options.timeout && options.timeout > 0 ? options.timeout : this.timeout || DEFAULT_TIMEOUT;
    let result: CommandResult;
    try {
      result = await this.runner.run(cmd, { timeoutSeconds: effectiveTimeout, input: options.input });
    } catch (error) {
      if (error instanceof RunnerSpawnError) {
        throw new IncusError(args, 127, `${this.binary} not found on PATH: ${error.message}`);
      }
      if (error instanceof RunnerTimeoutError) {
        throw new IncusError(args, 124, `timed out after ${effectiveTimeout}s`);
      }
      throw error;
    }

    if (options.check ?? true) {
      if (result.code !== 0) {
        const stderr = result.stderr || "";
        // The CLI says "not found" for a missing instance, snapshot or image, and
        // that is a state the callers handle; anything else is an incident.
        if (/not found/i.test(stderr) || stderr.includes("No such")) {
          throw new IncusNotFound(args, result.code, stderr);
        }
        throw new IncusError(args, result.code, stderr);
      }
    }
    return result;
  }

  async runJson<T = unknown>(args: readonly string[], options: RunOptions = {}): Promise<T | null> {
    const result = await this.run(args, options);
    const out = (result.stdout || "").trim();
    if (!out) return null;
    try {
      return JSON.parse(out) as T;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new IncusError(args, result.code, `unparseable JSON output: ${detail}`);
    }
  }

  /**
   * Whether the CLI is here at all — asked by running it, not by consulting PATH.
   *
   * Python used `shutil.which`, which answers "is a file of that name on PATH", not
   * "does it run". Running `--version` answers the question that matters and needs no
   * environment read; an absent binary or a refused timeout is `false`, because
   * `doctor` asks this on hosts that may not have Incus installed.
   */
  static async available(binary = "incus", runner?: Runner): Promise<boolean> {
    try {
      const result = await (runner ?? processRunner()).run([binary, "--version"], { timeoutSeconds: 10 });
      return result.code === 0;
    } catch (error) {
      if (error instanceof RunnerSpawnError || error instanceof RunnerTimeoutError || error instanceof IncusError) {
        return false;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // queries
  // ------------------------------------------------------------------

  async listInstances(): Promise<InstanceInfo[]> {
    const data = await this.runJson<unknown>(["list", "--format=json"]);
    return asArray(data)
      .filter(isRecord)
      .map((entry) => IncusClient.toInfo(entry));
  }

  async getInstance(name: string): Promise<InstanceInfo | null> {
    for (const info of await this.listInstances()) {
      if (info.name === name) return info;
    }
    return null;
  }

  async instanceStatus(name: string): Promise<string | null> {
    const info = await this.getInstance(name);
    return info ? info.status : null;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.getInstance(name)) !== null;
  }

  async instanceIp(name: string): Promise<string | null> {
    const info = await this.getInstance(name);
    return info && info.ipv4 ? info.ipv4 : null;
  }

  /**
   * Whether an image alias resolves — locally, or on the image server.
   *
   * Asked with `image info` and its exit code, because there is no JSON form to ask
   * for: `image info` has no `--format`. The alias resolving *is* the question, and a
   * server-side alias like `images:ubuntu/24.04` resolves without being cached — which
   * is what lets a container workload launch straight from the image server, as the
   * catalog planner promises.
   */
  async imageExists(alias: string): Promise<boolean> {
    try {
      const result = await this.run(["image", "info", alias], { check: false });
      return result.code === 0;
    } catch (error) {
      if (error instanceof IncusError) return false;
      throw error;
    }
  }

  async imageAliases(): Promise<string[]> {
    let data: unknown;
    try {
      data = await this.runJson<unknown>(["image", "list", "--format=json"]);
    } catch (error) {
      if (error instanceof IncusError) return [];
      throw error;
    }
    const aliases: string[] = [];
    for (const image of asArray(data)) {
      for (const alias of asArray(asRecord(image).aliases)) {
        const name = text(asRecord(alias).name);
        if (name) aliases.push(name);
      }
    }
    return aliases.sort();
  }

  async snapshotNames(instance: string): Promise<string[]> {
    let data: unknown;
    try {
      data = await this.runJson<unknown>(["snapshot", "list", instance, "--format=json"]);
    } catch (error) {
      if (error instanceof IncusError) return [];
      throw error;
    }
    const names: string[] = [];
    for (const entry of asArray(data)) {
      const name = text(asRecord(entry).name);
      if (name) names.push(name);
    }
    return names;
  }

  async hasSnapshot(instance: string, snapshot: string): Promise<boolean> {
    return (await this.snapshotNames(instance)).includes(snapshot);
  }

  /**
   * The server's own record: version, API extensions, environment.
   *
   * Not project-scoped, and `query` will not take a project, so the flag is dropped.
   * Asking for it with the wrong flag is what made this answer `{}` and `doctor`
   * print "incus server unknown" on a host whose server was answering fine.
   */
  async serverInfo(): Promise<Record<string, unknown>> {
    try {
      return (await this.runJson<Record<string, unknown>>(["query", "/1.0"], { project: false })) ?? {};
    } catch (error) {
      if (error instanceof IncusError) return {};
      throw error;
    }
  }

  /**
   * One pool's record, from the list the CLI *can* render as JSON.
   *
   * `storage info` has no `--format`, and `query` refuses `--project`, so this is the
   * same answer in a form that exists and stays project-aware.
   */
  async storageInfo(pool?: string): Promise<Record<string, unknown>> {
    const name = pool ?? this.settings.storagePool;
    let pools: unknown;
    try {
      pools = await this.runJson<unknown>(["storage", "list", "--format=json"]);
    } catch (error) {
      if (error instanceof IncusError) return {};
      throw error;
    }
    for (const record of asArray(pools)) {
      if (isRecord(record) && record.name === name) return record;
    }
    return {};
  }

  // ------------------------------------------------------------------
  // mutation
  // ------------------------------------------------------------------

  async createInstance(name: string, image: string, profiles?: readonly string[]): Promise<void> {
    const args = ["init", image, name];
    for (const profile of profiles ?? []) {
      if (profile) args.push("-p", profile);
    }
    await this.run(args, { timeout: this.timeout });
  }

  /**
   * Copy an instance, or one of its snapshots (`tpl-x/clean`), to `name`.
   *
   * `instanceOnly` means "the instance, without its snapshots", so it is an argument
   * about an *instance* source and the CLI refuses it on a snapshot:
   * `--instance-only can't be passed when the source is a snapshot`. Handing a student
   * their machine is exactly that second case — the clean snapshot is cloned — so
   * carrying the flag made `session start` fail every time and the pool never filled.
   */
  async copyInstance(source: string, name: string, instanceOnly = true): Promise<void> {
    const args = ["copy", source, name];
    if (instanceOnly && !isSnapshot(source)) args.push("--instance-only");
    await this.run(args, { timeout: this.timeout });
  }

  async startInstance(name: string, options: { wait?: boolean; timeout?: number } = {}): Promise<void> {
    await this.run(["start", name], { timeout: this.timeout });
    if (options.wait) {
      await this.waitForStatus(name, "RUNNING", { timeout: options.timeout ?? Math.max(this.timeout, 300) });
    }
  }

  async stopInstance(name: string, options: { force?: boolean; timeout?: number } = {}): Promise<void> {
    const grace = options.timeout ?? 120;
    const args = ["stop", name, "--timeout", String(grace)];
    if (options.force) args.push("--force");
    await this.run(args, { timeout: this.timeout + grace, check: !options.force });
  }

  async deleteInstance(name: string, options: { force?: boolean } = {}): Promise<void> {
    const args = ["delete", name];
    if (options.force ?? true) args.push("--force");
    await this.run(args, { timeout: this.timeout });
  }

  async createSnapshot(instance: string, snapshot: string): Promise<void> {
    await this.run(["snapshot", "create", instance, snapshot], { timeout: this.timeout });
  }

  async deleteSnapshot(instance: string, snapshot: string): Promise<void> {
    await this.run(["snapshot", "delete", instance, snapshot], { timeout: this.timeout });
  }

  /**
   * Read one instance config key, or `""` when it is not set.
   *
   * A key that was never set is not an error, and `incus config get` exits non-zero
   * for it, so the exit code is the answer rather than a failure to raise. That is
   * what lets the QEMU accelerator fix merge rather than overwrite: it has to know
   * what is already there before it adds to it.
   */
  async configGet(instance: string, key: string): Promise<string> {
    const result = await this.run(["config", "get", instance, key], { check: false });
    if (result.code !== 0) return "";
    return (result.stdout || "").trim();
  }

  async setConfig(instance: string, key: string, value: string | number | boolean): Promise<void> {
    await this.run(["config", "set", instance, `${key}=${value}`]);
  }

  async setConfigs(instance: string, values: Record<string, string | number | boolean>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await this.setConfig(instance, key, value);
    }
  }

  async addDevice(
    instance: string,
    kind: string,
    name: string,
    options: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    const args = ["config", "device", "add", instance, name, kind];
    for (const [key, value] of Object.entries(options)) {
      args.push(`${key}=${value}`);
    }
    await this.run(args);
  }

  async removeDevice(instance: string, name: string): Promise<void> {
    await this.run(["config", "device", "remove", instance, name], { check: false });
  }

  async assignProfiles(instance: string, profiles: readonly string[]): Promise<void> {
    if (profiles.length === 0) return;
    await this.run(["profile", "assign", instance, profiles.join(",")]);
  }

  async renameInstance(instance: string, newName: string): Promise<void> {
    await this.run(["rename", instance, newName], { timeout: this.timeout });
  }

  /**
   * Run a command inside a guest (containers always; VMs need the agent).
   *
   * `input` is fed to the command's stdin, which is how shell scripts are executed
   * without quoting them into a command line, and `check` lets a caller read a
   * non-zero exit code instead of having it raised — grading does exactly that: a
   * failing check is data, not an incident.
   */
  async execIn(
    instance: string,
    command: readonly string[],
    options: {
      timeout?: number;
      detach?: boolean;
      check?: boolean | null;
      input?: string | undefined;
      user?: string | null;
    } = {},
  ): Promise<CommandResult> {
    const args = ["exec", instance, "-T"];
    const uid = await this.uidArgument(instance, options.user);
    if (uid) args.push("--user", uid);
    if (options.detach) args.push("--mode=detach");
    args.push("--");
    args.push(...command);
    const check = options.check == null ? !options.detach : options.check;
    return this.run(args, { timeout: options.timeout ?? 60, check, input: options.input });
  }

  /**
   * The uid to pass to `exec --user`, or `null` to leave the flag off.
   *
   * `incus exec --user` takes a *numeric* uid and refuses an account name outright:
   * `invalid argument "root" for "--user" flag: strconv.ParseUint: parsing "root":
   * invalid syntax`. The platform's default Linux account is the name `root`, so
   * passing it through made every shell call fail — readiness probes never succeeded
   * and no template could be built, on any host. Root is what `incus exec` already
   * uses, so it needs no flag at all. Any other name is resolved in the guest once
   * and remembered; a name that does not exist there is a misconfiguration worth
   * failing on, because the alternative is running a graded check as the wrong
   * account.
   */
  private async uidArgument(instance: string, user: string | null | undefined): Promise<string | null> {
    const value = String(user ?? "").trim();
    if (!value || value === "0" || value === "root") return null;
    if (/^[0-9]+$/.test(value)) return value;

    const key = `${instance}\u0000${value}`;
    let uid = this.uidCache.get(key);
    if (uid === undefined) {
      const result = await this.run(["exec", instance, "-T", "--", "id", "-u", value], {
        check: false,
        timeout: 30,
      });
      const resolved = (result.stdout || "").trim();
      uid = result.code === 0 && /^[0-9]+$/.test(resolved) ? resolved : "";
      this.uidCache.set(key, uid);
    }
    if (!uid) {
      throw new IncusError(
        ["exec", instance, "--user", value],
        1,
        `no account '${value}' in ${instance} — guest.linux_user must be a user that exists in the guest, or root`,
      );
    }
    // uid 0 needs no flag: it is what exec does anyway.
    return uid === "0" ? null : uid;
  }

  /** Run a shell script inside a guest verbatim. Never raises on exit code. */
  async guestShell(
    instance: string,
    script: string,
    options: { timeout?: number; user?: string | null } = {},
  ): Promise<CommandResult> {
    return this.execIn(instance, ["bash", "-s"], {
      timeout: options.timeout ?? 120,
      check: false,
      input: script,
      user: options.user,
    });
  }

  async waitForStatus(
    instance: string,
    status: string,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<boolean> {
    const timeoutMs = (options.timeout ?? 300) * 1000;
    const intervalMs = Math.max(0, (options.interval ?? 2) * 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.instanceStatus(instance);
      if (current && current.toUpperCase() === status.toUpperCase()) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  /**
   * One `list --format=json` entry as an `InstanceInfo`.
   *
   * The address search prefers `eth0` and otherwise keeps the order the daemon gave,
   * and only a `global` `inet` address counts: a `link` scope address is the one that
   * exists before DHCP answers, and the console link and the readiness probe both
   * need the address a student would be handed.
   */
  private static toInfo(entry: Record<string, unknown>): InstanceInfo {
    const state = asRecord(entry.state);
    const network = asRecord(state.network);
    let ipv4 = "";
    const interfaces = Object.entries(network).sort((a, b) => interfaceRank(a[0]) - interfaceRank(b[0]));
    for (const [, iface] of interfaces) {
      for (const address of asArray(asRecord(iface).addresses)) {
        const record = asRecord(address);
        if (record.family === "inet" && record.scope === "global") {
          ipv4 = text(record.address);
          break;
        }
      }
      if (ipv4) break;
    }
    const config = asRecord(entry.config);
    const memory = String(config["limits.memory"] ?? "");
    const cpuRaw = String(config["limits.cpu"] ?? "").split(",")[0]?.trim() ?? "";
    return {
      name: String(entry.name ?? ""),
      status: String(entry.status ?? "Unknown"),
      kind: String(entry.type ?? "virtual-machine"),
      ipv4,
      cpu: /^[0-9]+$/.test(cpuRaw) ? Number(cpuRaw) : 0,
      memoryMb: parseMemoryMb(memory),
      os: String(config["image.os"] ?? ""),
      raw: entry,
    };
  }
}

function interfaceRank(name: string): number {
  return name === "eth0" ? 0 : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
