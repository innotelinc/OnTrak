/**
 * Talking to the guest.
 *
 * This is the TypeScript half of OnTrak-dev's `ontrak/guest.py`: the layer that runs
 * a scenario's `setup`/`check` script inside a machine and reads its output back.
 * The guest contract is unchanged, and it is deliberately tiny — a scenario injects
 * a fault and prints one JSON object between the lab's markers, on Windows as
 * PowerShell and on Linux as shell. Everything downstream (scoring, the portal, the
 * ticket rubric) stays platform-independent because of that.
 *
 * **The WinRM transport is not ported, and that is a recorded decision rather than
 * an oversight.** `guest.py`'s Windows default is `winrm` over `pywinrm`; there is
 * no maintained WinRM client for Node, and this port will not grow a hand-written
 * WSMan/NTLM stack it cannot test. So Windows guests here are driven through the
 * **Incus agent** (`incus-exec`), which the lab's own architecture notes call the
 * better transport anyway: it rides virtio-vsock, needs no reachable port, and
 * therefore also survives a scenario whose whole point is a broken NIC. The driver
 * name list stays complete and `buildDriver` **refuses `winrm` loudly**, naming the
 * gap and the transport to use instead — an operator's existing configuration must
 * fail with an explanation, not silently grade through another transport.
 *
 * Three porting rules, so the rest of the layer reads the same way.
 *
 * **Nothing here spawns a process or opens a socket.** The Incus client and the ssh
 * process runner are both injected (`GuestExecClient`, `ProcessRunner`), typed as
 * narrow local interfaces rather than imported from the modules that implement them.
 * That is what makes every rule in this file testable on a machine with no
 * hypervisor, no guest and no `incus` binary — which is the only kind of machine the
 * test suite has.
 *
 * **All PowerShell goes as a UTF-16LE `-EncodedCommand`.** Quoting, newlines and
 * non-ASCII characters then survive every transport, and nothing has to guess how a
 * given shell will re-split an argument. Shell scripts go on stdin for the same
 * reason, and file uploads go as base64 in a quoted heredoc (Linux) or in
 * `Add-Content` chunks (Windows), so no SMB/SCP path is required and no
 * transfer-API flags have to be guessed per Incus version.
 *
 * **The two transports have two different widths.** A Linux guest is handed the
 * payload on stdin, where 32k of base64 is cheap; a Windows guest gets each chunk as
 * its own `-EncodedCommand`, and Windows caps the command line long before that
 * (see `WINRM_UPLOAD_CHUNK`). The narrow width is the one that has to be known here.
 */

import type { LabSession } from "./models";

/** The interpreter every Windows scenario's scripts are run with. */
export const POWERSHELL = "powershell";

/**
 * Base64 characters per upload chunk on a roomy transport (stdin heredoc).
 */
export const UPLOAD_CHUNK = 32_000;

/**
 * Base64 characters per upload chunk where the chunk rides a Windows command line.
 *
 * The same upload has to survive two very different transports, and only one of them
 * is roomy. WinRM (and, here, the Incus agent reaching a Windows guest) runs each
 * chunk as an argument of `powershell -EncodedCommand`, which the guest refuses with
 * "The command line is too long" long before 32k. Measured in the Python lab against
 * an 8,197-byte `post-install.ps1`, whose 10,932 characters of base64 became roughly
 * 14,600 characters of `-EncodedCommand` and failed uploading at offset 0. 2,000
 * holds the whole command line near a third of the limit, which is the room the
 * `-EncodedCommand` wrapper, the file paths and `Add-Content`'s own arguments need.
 */
export const WINRM_UPLOAD_CHUNK = 2_000;

/**
 * The guest's own command-line ceiling, which a generated upload command has to stay
 * under. It is the `cmd.exe` line (8,191), and deliberately the same number the
 * Python suite asserts against rather than the point the upload was measured failing
 * at: the command must stay *under* the limit, not merely near where it broke.
 */
export const COMMAND_LINE_LIMIT = 8_191;

/** Raised for unrecoverable transport problems. */
export class GuestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestError";
  }
}

/** What one guest call returned. */
export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock seconds the call took. */
  duration: number;
}

/**
 * One result, with `ok` derived from the exit code unless a transport says otherwise.
 *
 * A transport that reports its own boolean (a status code that is not an exit code)
 * passes `ok` explicitly; everything else gets the ordinary reading, so callers can
 * write `if (result.ok)` and mean the same thing on every driver.
 */
export function newCommandResult(
  exitCode: number,
  fields: { stdout?: string; stderr?: string; duration?: number; ok?: boolean } = {},
): CommandResult {
  return {
    ok: fields.ok ?? exitCode === 0,
    exitCode,
    stdout: fields.stdout ?? "",
    stderr: fields.stderr ?? "",
    duration: fields.duration ?? 0,
  };
}

/**
 * A transport error as a failed result rather than a thrown one.
 *
 * The Incus-agent driver does this on purpose: a guest that cannot be reached is
 * data to a caller that is grading (the check failed) and an incident to one that is
 * provisioning (the session errors), and the caller is the only place that can tell
 * the two apart.
 */
export function commandResultFromError(error: unknown, duration = 0): CommandResult {
  return newCommandResult(1, {
    ok: false,
    stderr: error instanceof Error ? error.message : String(error),
    duration,
  });
}

/** The payload of one call: which machine, and how long it may take. */
export interface RunOptions {
  host?: string;
  instance?: string;
  timeoutSeconds?: number;
}

/** The machine a readiness probe is aimed at — a session's two addressing facts. */
export type ReadyTarget = Pick<LabSession, "instance" | "hostIp">;

/** A wall clock and a sleep, injected so a polling loop can be tested in no time. */
export interface Clock {
  now(): number;
  sleep(seconds: number): Promise<void>;
}

/** The real thing: `Date.now()` and a timer. */
export const systemClock: Clock = {
  now: (): number => Date.now(),
  sleep: (seconds: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, seconds * 1_000);
    }),
};

/**
 * One command inside a guest, as the Incus client reports it.
 *
 * Mirrors the Python client's `CompletedProcess` usage (`returncode`/`stdout`/
 * `stderr`), because a failed check is data: `guestShell` never raises on a non-zero
 * exit code, and grading depends on reading it.
 */
export interface GuestCommandOutput {
  returncode: number;
  stdout: string;
  stderr: string;
}

/**
 * The slice of the Incus client the guest drivers use.
 *
 * Structural, and local to this module: the port takes its client by injection so
 * this file never imports the Incus client's module, and so a test can hand it a
 * stub. `incus.ts` (the client's own port) satisfies this shape.
 */
export interface GuestExecClient {
  /** Run a shell script verbatim in a guest. Never raises on exit code. */
  guestShell(
    instance: string,
    script: string,
    // `timeout`, `user` — the real client's own spelling (`incus.ts`). Not
    // `timeoutSeconds`: that name belongs to the process runner seam below, and a
    // driver handing `timeoutSeconds` to a client that reads `timeout` gets the client's
    // default instead, so a scenario's timeout would be silently ignored.
    options?: { timeout?: number; user?: string | null },
  ): Promise<GuestCommandOutput>;
  /** Run an argv inside a guest (this is how Windows is reached, via the agent). */
  execIn(
    instance: string,
    argv: readonly string[],
    options?: { timeout?: number },
  ): Promise<GuestCommandOutput>;
}

/** What a spawned process runner reports. */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a process with `input` on stdin. Injected for the same reason as the client. */
export type ProcessRunner = (
  argv: readonly string[],
  input: string | undefined,
  timeoutSeconds: number,
) => Promise<ProcessResult>;

/**
 * The guest and credential facts the drivers read.
 *
 * A narrow local interface rather than the lab's full `Settings`: every field here
 * is one a driver actually uses, so the settings layer can be ported and tested
 * separately, and a driver can be constructed in a test from a literal.
 *
 * `driver` defaults to `incus-exec` in this port (see the module note on WinRM);
 * `linuxDriver` keeps the Python default of `incus-shell`. Every other field is
 * supplied by the settings layer — no timeout is invented here.
 */
export interface GuestSettings {
  driver: string;
  linuxDriver: string;
  user: string;
  password: string;
  staticHost: string;
  winrmPort: number;
  winrmUseSsl: boolean;
  winrmTransport: string;
  rdpPort: number;
  sshPort: number;
  sshKey: string;
  linuxUser: string;
  bootTimeoutSeconds: number;
  readyTimeoutSeconds: number;
  linuxReadyTimeoutSeconds: number;
}

/** The transports this port can actually build. */
export const PORTED_DRIVER_NAMES = ["incus-exec", "incus-shell", "ssh", "null"] as const;

/**
 * Every transport the lab's configuration may name.
 *
 * `winrm` is in the list and not in the port, on purpose: a deployment that names it
 * has to be told why instead of being quietly moved to another transport.
 */
export const DRIVER_NAMES = ["winrm", "incus-exec", "incus-shell", "ssh", "null"] as const;

export type DriverName = (typeof DRIVER_NAMES)[number];

/**
 * The message a `winrm` configuration fails with.
 *
 * Exported as a constant so a test can assert it, an operator's log quotes the same
 * sentence, and the port's documentation can point at one string rather than three
 * paraphrases of it.
 */
export const WINRM_NOT_PORTED =
  "guest.driver = 'winrm' is not available in this port: there is no WinRM client for " +
  "Node, and this port does not ship a hand-written WSMan/NTLM stack it cannot test. " +
  "Windows guests are driven through the Incus agent instead — set guest.driver to " +
  "'incus-exec' (it needs no reachable port and survives a scenario that breaks the " +
  "NIC). guest.driver = 'null' is available for dry runs.";

/** UTF-16LE base64, which is what `powershell -EncodedCommand` expects. */
export function encodePs(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * The inverse of `encodePs`.
 *
 * Nothing in the transport needs to decode what it sent; this exists so the claim
 * "the script survives the encoding" is checkable — by the test suite, and by whoever
 * is reading a log line to see what a guest was actually asked to run.
 */
export function decodePs(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le");
}

/** The full argument vector for one PowerShell call. */
export function powershellArgv(script: string): string[] {
  return [
    POWERSHELL,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePs(script),
  ];
}

/** Single-quote a value for PowerShell, escaping embedded quotes. */
export function quotePs(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Single-quote a value for a POSIX shell, escaping embedded quotes. */
export function quoteSh(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** `path.dirname` for POSIX paths, without importing a platform-specific `path`. */
function posixDirname(remotePath: string): string {
  const cut = remotePath.lastIndexOf("/");
  if (cut < 0) return ".";
  return cut === 0 ? "/" : remotePath.slice(0, cut);
}

/** `os.path.dirname` for a Windows path, matching the Python `rsplit("\\", 1)`. */
function windowsDirname(remotePath: string): string {
  if (!remotePath.includes("\\")) return ".";
  return remotePath.slice(0, remotePath.lastIndexOf("\\"));
}

/** The ssh argument vector for one command. Key-based only: no password path. */
export function sshArgv(settings: GuestSettings, target: string, command: string): string[] {
  const argv = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-p",
    String(settings.sshPort),
  ];
  if (settings.sshKey) argv.push("-i", settings.sshKey);
  argv.push(`${settings.linuxUser || "root"}@${target}`, command);
  return argv;
}

/**
 * The default ssh transport: spawn `ssh`, feed the script on stdin.
 *
 * Isolated here rather than inlined in the driver so that the driver stays testable
 * with an injected runner, and so the one place this module touches a process is a
 * single function that says so.
 */
export async function spawnProcessRunner(
  argv: readonly string[],
  input: string | undefined,
  timeoutSeconds: number,
): Promise<ProcessResult> {
  const { spawn } = await import("node:child_process");
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new GuestError(`the ssh call timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1_000);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      finish(() => reject(new GuestError(`the ssh client could not be run: ${error.message}`)));
    });
    child.on("close", (code: number | null) => {
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
    child.stdin?.end(input ?? "");
  });
}

/**
 * What every driver shares: addressing, script execution by path, uploads, and the
 * readiness wait.
 *
 * An abstract class rather than an interface because the shared half is real
 * behaviour (the chunked upload is four steps and one error path) and because the
 * Python suite's recording driver is a subclass; a test can subclass this too and
 * reproduce the transport it is standing in for.
 */
export abstract class BaseDriver {
  abstract readonly name: DriverName;

  /** Base64 characters per upload chunk. Narrower on a command-line transport. */
  uploadChunk: number = UPLOAD_CHUNK;

  protected readonly settings: GuestSettings;
  protected readonly clock: Clock;

  constructor(settings: GuestSettings, options: DriverOptions = {}) {
    this.settings = settings;
    this.clock = options.clock ?? systemClock;
  }

  /** Which address to talk to, refusing rather than guessing at a blank one. */
  resolveHost(instance = "", host = ""): string {
    if (host) return host;
    if (this.settings.staticHost) return this.settings.staticHost;
    throw new GuestError(
      `${this.name} driver needs a host address for instance ${JSON.stringify(instance)}; ` +
        "set guest.static_host or pass the session's host_ip",
    );
  }

  abstract runPowerShell(script: string, options?: RunOptions): Promise<CommandResult>;

  /** Run a `.ps1` already inside the guest, with stderr folded into stdout. */
  async runScriptFile(remotePath: string, options: RunOptions = {}): Promise<CommandResult> {
    const script =
      "$ErrorActionPreference='Continue';" +
      `& ${quotePs(remotePath)} *>&1 | Out-String -Width 4096`;
    return this.runPowerShell(script, options);
  }

  /** Write UTF-8 text to a guest path (used for scenario scripts). */
  async uploadText(text: string, remotePath: string, options: RunOptions = {}): Promise<CommandResult> {
    return this.writeBytes(new TextEncoder().encode(text), remotePath, options);
  }

  /** Write a local file to a guest path. */
  async uploadFile(
    localPath: string,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(localPath);
    return this.writeBytes(bytes, remotePath, options);
  }

  /**
   * Chunked base64 upload.
   *
   * The whole payload is base64-encoded once and then cut into `uploadChunk`-sized
   * pieces *of base64* (not of source bytes), which is what keeps every generated
   * command inside the transport's width. Each step that can fail says which step it
   * was and, for a chunk, the offset it failed at — the offset is what turned a
   * Windows command-line overflow into a diagnosis rather than a mystery.
   */
  async writeBytes(
    data: Uint8Array,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const b64 = Buffer.from(data).toString("base64");
    const remoteB64 = `${remotePath}.b64`;
    const parent = windowsDirname(remotePath);

    const run = (script: string): Promise<CommandResult> => this.runPowerShell(script, options);

    const prep =
      `New-Item -ItemType Directory -Force -Path ${quotePs(parent)} | Out-Null;` +
      `Set-Content -Path ${quotePs(remoteB64)} -Value '' -NoNewline -Encoding Ascii`;
    const prepared = await run(prep);
    if (!prepared.ok) {
      throw new GuestError(`cannot prepare ${parent}: ${prepared.stderr || prepared.stdout}`);
    }

    for (let offset = 0; offset < b64.length; offset += this.uploadChunk) {
      const chunk = b64.slice(offset, offset + this.uploadChunk);
      const appended = await run(
        `Add-Content -Path ${quotePs(remoteB64)} -Value '${chunk}' -NoNewline -Encoding Ascii`,
      );
      if (!appended.ok) {
        throw new GuestError(
          `upload of ${remotePath} failed at offset ${offset}: ${appended.stderr || appended.stdout}`,
        );
      }
    }

    const decode =
      `$b=[Convert]::FromBase64String((Get-Content -Raw -Path ${quotePs(remoteB64)}));` +
      `[IO.File]::WriteAllBytes(${quotePs(remotePath)},$b);` +
      `Remove-Item -Path ${quotePs(remoteB64)} -Force;` +
      `'wrote ${data.length} bytes'`;
    const decoded = await run(decode);
    if (!decoded.ok) {
      throw new GuestError(`upload decode failed for ${remotePath}: ${decoded.stderr || decoded.stdout}`);
    }
    return decoded;
  }

  abstract waitReady(target: ReadyTarget, timeoutSeconds?: number): Promise<boolean>;

  /**
   * Poll the guest for its own name until it answers — the readiness signal Windows
   * guests share across transports.
   *
   * `$env:COMPUTERNAME` rather than a port: a machine can accept a TCP connection
   * long before a shell can run in it, and the console link is only useful once the
   * latter is true.
   */
  protected async waitForPowerShell(target: ReadyTarget, timeoutSeconds?: number): Promise<boolean> {
    const deadline = this.clock.now() + (timeoutSeconds ?? this.settings.bootTimeoutSeconds) * 1_000;
    while (this.clock.now() < deadline) {
      const result = await this.runPowerShell("$env:COMPUTERNAME", {
        host: target.hostIp,
        instance: target.instance,
        timeoutSeconds: 30,
      });
      if (result.ok && result.stdout.trim()) return true;
      await this.clock.sleep(5);
    }
    return false;
  }
}

/** Collaborators a driver may be given, so nothing has to be constructed here. */
export interface DriverOptions {
  clock?: Clock;
  client?: GuestExecClient;
  processRunner?: ProcessRunner;
  responses?: Record<string, string>;
}

/**
 * Base for Linux guests: the same contract as Windows, spoken in shell.
 *
 * A scenario on Linux owes the platform exactly what a Windows scenario owes it — a
 * `setup.sh` that injects the fault and confirms it, and a `check.sh` that prints the
 * grading JSON between the markers — which is why nothing downstream has to know
 * which platform it is looking at.
 */
export abstract class ShellRunner extends BaseDriver {
  readonly interpreter = "bash";

  abstract runShell(script: string, options?: RunOptions): Promise<CommandResult>;

  /**
   * A Linux scenario that asks to run PowerShell is a modelling mistake, not a
   * transport problem: the honest answer is to name the file it should have shipped
   * rather than to translate the script.
   */
  async runPowerShell(_script: string, _options: RunOptions = {}): Promise<CommandResult> {
    throw new GuestError(
      `the ${this.name} driver talks shell, not PowerShell: a Linux scenario must ` +
        "ship setup.sh/check.sh with `platform: linux` in scenario.yaml",
    );
  }

  /** Run a shell script already inside the guest, stderr folded in. */
  async runScriptFile(remotePath: string, options: RunOptions = {}): Promise<CommandResult> {
    return this.runShell(
      `${this.interpreter} ${quoteSh(remotePath)} < /dev/null 2>&1`,
      options,
    );
  }

  /**
   * Upload any file (text or binary) over stdin.
   *
   * Base64 in a quoted heredoc rather than a quoted command line: the payload can
   * contain anything at all, the delimiter is never expanded, and it depends on no
   * file-transfer flags that differ between Incus versions. This is why the Linux
   * transport can afford `UPLOAD_CHUNK` and the Windows one cannot.
   */
  async writeBytes(
    data: Uint8Array,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const payload = Buffer.from(data).toString("base64");
    const parent = posixDirname(remotePath);
    const script =
      `mkdir -p ${quoteSh(parent)}\n` +
      `base64 -d > ${quoteSh(remotePath)} <<'ONTRAK_B64'\n` +
      `${payload}\n` +
      "ONTRAK_B64\n" +
      `printf 'wrote %s bytes\\n' ${quoteSh(String(data.length))}`;
    return this.runShell(script, options);
  }

  async waitReady(target: ReadyTarget, timeoutSeconds?: number): Promise<boolean> {
    const deadline =
      this.clock.now() + (timeoutSeconds ?? this.settings.linuxReadyTimeoutSeconds) * 1_000;
    while (this.clock.now() < deadline) {
      // A guest that is not up yet answers with a failed *result* (the client never
      // raises on an exit code), which is the state this loop exists to wait out. A
      // genuinely broken driver — no instance name, no client — still raises, because
      // a misconfiguration must not be reported as a machine that never booted.
      const result = await this.runShell("printf 'ontrak-ready\\n'", {
        host: target.hostIp,
        instance: target.instance,
        timeoutSeconds: 30,
      });
      if (result.ok && (result.stdout ?? "").includes("ontrak-ready")) return true;
      await this.clock.sleep(4);
    }
    return false;
  }
}

/**
 * Linux guests over the Incus agent: no credentials, no open port, no keys.
 *
 * The default for Linux, because a machine that has to be graded should not also
 * have to be reachable over SSH to be gradable.
 */
export class IncusShellDriver extends ShellRunner {
  readonly name = "incus-shell" as const;

  private readonly client: GuestExecClient | null;

  constructor(settings: GuestSettings, options: DriverOptions = {}) {
    super(settings, options);
    this.client = options.client ?? null;
  }

  async runShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    const instance = options.instance ?? "";
    if (!instance) throw new GuestError("the incus-shell driver needs the instance name");
    const client = this.client;
    if (client === null) {
      throw new GuestError(
        "the incus-shell driver has no Incus client: pass one when constructing the " +
          "driver (the port injects its client rather than importing one)",
      );
    }
    const started = this.clock.now();
    const proc = await client.guestShell(instance, script, {
      timeout: options.timeoutSeconds ?? 120,
      user: this.settings.linuxUser || null,
    });
    return newCommandResult(proc.returncode, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      duration: (this.clock.now() - started) / 1_000,
    });
  }
}

/**
 * Linux guests over SSH, for machines OnTrak does not run on Incus.
 *
 * Key-based only: an sshd accepting passwords is one more credential to rotate in
 * every image, and the lab already has a credential story.
 */
export class SSHDriver extends ShellRunner {
  readonly name = "ssh" as const;

  private readonly runner: ProcessRunner;

  constructor(settings: GuestSettings, options: DriverOptions = {}) {
    super(settings, options);
    this.runner = options.processRunner ?? spawnProcessRunner;
  }

  async runShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    const target = this.resolveHost(options.instance ?? "", options.host ?? "");
    const argv = sshArgv(this.settings, target, `${this.interpreter} -s`);
    const started = this.clock.now();
    let proc: ProcessResult;
    try {
      proc = await this.runner(argv, script, options.timeoutSeconds ?? 120);
    } catch (error) {
      throw new GuestError(
        `ssh ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return newCommandResult(proc.code, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      duration: (this.clock.now() - started) / 1_000,
    });
  }
}

/**
 * Windows guests through the Incus agent (virtio-vsock).
 *
 * This is the port's Windows default in place of `winrm` (see the module note).
 * A transport failure is returned as a failed result rather than thrown, because
 * grading reads a failure as data and provisioning is the caller that decides it is
 * an incident.
 */
export class IncusExecDriver extends BaseDriver {
  readonly name = "incus-exec" as const;

  private readonly client: GuestExecClient | null;

  constructor(settings: GuestSettings, options: DriverOptions = {}) {
    super(settings, options);
    this.client = options.client ?? null;
  }

  private async exec(
    instance: string,
    argv: readonly string[],
    timeoutSeconds: number,
  ): Promise<CommandResult> {
    const client = this.client;
    const started = this.clock.now();
    if (client === null) {
      return commandResultFromError(
        new GuestError(
          "the incus-exec driver has no Incus client: pass one when constructing the " +
            "driver (the port injects its client rather than importing one)",
        ),
      );
    }
    try {
      const proc = await client.execIn(instance, argv, { timeout: timeoutSeconds });
      return newCommandResult(proc.returncode, {
        stdout: proc.stdout,
        stderr: proc.stderr,
        duration: (this.clock.now() - started) / 1_000,
      });
    } catch (error) {
      return commandResultFromError(error, (this.clock.now() - started) / 1_000);
    }
  }

  async runPowerShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    const instance = options.instance ?? "";
    if (!instance) throw new GuestError("incus-exec driver requires an instance name");
    return this.exec(instance, powershellArgv(script), options.timeoutSeconds ?? 120);
  }

  async waitReady(target: ReadyTarget, timeoutSeconds?: number): Promise<boolean> {
    if (!target.instance) return false;
    return this.waitForPowerShell(target, timeoutSeconds ?? this.settings.bootTimeoutSeconds);
  }
}

/**
 * No-op driver: everything succeeds with canned (or empty) output.
 *
 * Lets an operator validate the catalogue, exercise the portal and run the suite
 * with no Windows infrastructure at all. `responses` maps a substring of the script
 * to the output to return, which is how a test simulates a passing or a failing
 * guest, and `calls` records what it was asked to run.
 */
export class NullDriver extends BaseDriver {
  readonly name = "null" as const;

  readonly responses: Record<string, string>;
  readonly calls: [string, string][] = [];

  constructor(settings: GuestSettings, options: DriverOptions = {}) {
    super(settings, options);
    this.responses = options.responses ?? {};
  }

  async runPowerShell(script: string, options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push([options.instance ?? "", script.slice(0, 200)]);
    for (const [needle, response] of Object.entries(this.responses)) {
      if (script.includes(needle)) return newCommandResult(0, { stdout: response });
    }
    return newCommandResult(0);
  }

  async waitReady(): Promise<boolean> {
    return true;
  }

  async writeBytes(
    data: Uint8Array,
    remotePath: string,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push([options.instance ?? "", `upload:${remotePath}:${data.length}B`]);
    return newCommandResult(0, { stdout: "wrote bytes" });
  }
}

/**
 * Pick the Linux transport.
 *
 * `guest.linuxDriver` decides; `incus-shell` is the default because it needs no
 * credentials and no open port. A scenario that names a Linux workload is graded
 * through this driver whatever `guest.driver` says, since a Windows transport cannot
 * speak shell.
 */
export function buildShellDriver(settings: GuestSettings, options: DriverOptions = {}): BaseDriver {
  const kind = (settings.linuxDriver || "incus-shell").trim().toLowerCase();
  if (kind === "ssh") return new SSHDriver(settings, options);
  return new IncusShellDriver(settings, options);
}

/**
 * Pick the Windows transport.
 *
 * The default is `incus-exec`, not the Python lab's `winrm` — see the module note:
 * there is no WinRM client for Node, so naming `winrm` raises `WINRM_NOT_PORTED`
 * rather than silently grading through the agent.
 */
export function buildDriver(settings: GuestSettings, options: DriverOptions = {}): BaseDriver {
  const wanted = (settings.driver || "incus-exec").trim().toLowerCase();
  if (wanted === "winrm") throw new GuestError(WINRM_NOT_PORTED);
  if (wanted === "incus-exec" || wanted === "incus" || wanted === "agent") {
    return new IncusExecDriver(settings, options);
  }
  if (wanted === "null" || wanted === "none" || wanted === "dry-run") {
    return new NullDriver(settings, options);
  }
  if (wanted === "incus-shell" || wanted === "shell" || wanted === "posix") {
    return new IncusShellDriver(settings, options);
  }
  if (wanted === "ssh") return new SSHDriver(settings, options);
  throw new GuestError(
    `unknown guest.driver ${JSON.stringify(settings.driver)} ` +
      "(incus-exec | incus-shell | ssh | null; winrm is recorded as not ported)",
  );
}

/** The transport for a scenario's platform, which is what the session manager asks. */
export function chooseDriver(
  platform: "windows" | "linux",
  settings: GuestSettings,
  options: DriverOptions = {},
): BaseDriver {
  return platform === "linux" ? buildShellDriver(settings, options) : buildDriver(settings, options);
}
