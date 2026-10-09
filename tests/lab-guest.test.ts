/**
 * The guest transport: what a call sends, how a file arrives, and which driver is built.
 *
 * Three properties are pinned here, and each one is a real incident in the Python lab's
 * history rather than a preference.
 *
 * **The encoding.** Every PowerShell call travels as base64 of UTF-16LE, because that
 * is what `-EncodedCommand` reads. A port that quietly used UTF-8 would still work on
 * an ASCII-only script and would make the guest run mojibake on any script with an
 * accented name in it, so the round trip is asserted with non-ASCII in it.
 *
 * **The two widths.** A Linux upload rides a heredoc on stdin, where the payload size
 * barely matters. A Windows upload is cut into `Add-Content` chunks, each of which
 * becomes an argument of its own `-EncodedCommand` — and Windows caps that command
 * line. The suite reproduces the failure that set the narrower width (an 8 KiB
 * `post-install.ps1` refused at offset 0 with "The command line is too long"), measures
 * the worst-case command a full chunk produces against that cap, and checks a
 * multi-chunk payload arrives byte for byte.
 *
 * **The WinRM gap.** `buildDriver` must refuse `winrm` with an explanation instead of
 * grading through another transport, because a deployment that believes it is using
 * WinRM and is silently using the Incus agent would be a difference nobody could see.
 * That refusal is a test, not a comment.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-guest.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BaseDriver,
  COMMAND_LINE_LIMIT,
  type Clock,
  type CommandResult,
  type DriverOptions,
  type GuestExecClient,
  GuestError,
  type GuestSettings,
  IncusExecDriver,
  IncusShellDriver,
  NullDriver,
  POWERSHELL,
  SSHDriver,
  ShellRunner,
  UPLOAD_CHUNK,
  WINRM_UPLOAD_CHUNK,
  buildDriver,
  buildShellDriver,
  chooseDriver,
  decodePs,
  encodePs,
  newCommandResult,
  powershellArgv,
  quotePs,
  quoteSh,
  sshArgv,
  type ProcessRunner,
} from "../src/lib/lab/guest";

/** The guest facts a driver reads, with everything explicit — no invented default. */
function settings(overrides: Partial<GuestSettings> = {}): GuestSettings {
  return {
    driver: "incus-exec",
    linuxDriver: "incus-shell",
    user: "student",
    password: "TrainMe!12345",
    staticHost: "",
    winrmPort: 5985,
    winrmUseSsl: false,
    winrmTransport: "ntlm",
    rdpPort: 3389,
    sshPort: 22,
    sshKey: "",
    linuxUser: "",
    bootTimeoutSeconds: 60,
    readyTimeoutSeconds: 60,
    linuxReadyTimeoutSeconds: 60,
    ...overrides,
  };
}

/** A clock that only advances when something sleeps, so polling finishes instantly. */
class FakeClock implements Clock {
  nowMs = 0;

  now(): number {
    return this.nowMs;
  }

  async sleep(seconds: number): Promise<void> {
    this.nowMs += seconds * 1_000;
  }
}

/** An Incus client that answers success, unless a test says otherwise. */
function stubClient(
  guestShell: GuestExecClient["guestShell"] = async () => ({
    returncode: 0,
    stdout: "ontrak-ready\n",
    stderr: "",
  }),
  execIn: GuestExecClient["execIn"] = async () => ({ returncode: 0, stdout: "LAB-VM", stderr: "" }),
): GuestExecClient {
  return { guestShell, execIn };
}

/**
 * A Windows-transport driver that emulates the guest's side of an upload.
 *
 * It keeps every script it was asked to run — which is how the command-line bound is
 * checked with no Windows machine — and reassembles `Add-Content` chunks the way the
 * file would have been assembled in the guest.
 */
class RecordingDriver extends BaseDriver {
  readonly name = "incus-exec" as const;

  override uploadChunk = WINRM_UPLOAD_CHUNK;

  readonly scripts: string[] = [];
  readonly chunks: string[] = [];
  decoded: Buffer | null = null;

  async runPowerShell(script: string): Promise<CommandResult> {
    this.scripts.push(script);
    if (script.includes("Add-Content")) {
      const marker = "-Value '";
      const start = script.indexOf(marker) + marker.length;
      this.chunks.push(script.slice(start, script.indexOf("'", start)));
    } else if (script.includes("[Convert]::FromBase64String")) {
      this.decoded = Buffer.from(this.chunks.join(""), "base64");
    }
    return newCommandResult(0);
  }

  async waitReady(): Promise<boolean> {
    return true;
  }
}

/** A Linux-transport driver that records the script it was handed. */
class RecordingShellDriver extends ShellRunner {
  readonly name = "incus-shell" as const;

  readonly scripts: string[] = [];

  async runShell(script: string): Promise<CommandResult> {
    this.scripts.push(script);
    return newCommandResult(0);
  }
}

test("a PowerShell call is a UTF-16LE -EncodedCommand that round-trips the script", () => {
  const script = `$name = "café";
Write-Output "it's here"
# second line`;

  const argv = powershellArgv(script);
  assert.deepEqual(argv.slice(0, 7), [
    POWERSHELL,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]);

  const encoded = argv.at(7) ?? "";
  assert.equal(encoded, encodePs(script));
  assert.equal(decodePs(encoded), script);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);

  // UTF-16LE specifically: the same script encoded as UTF-8 would be a different
  // payload, and the guest would run mojibake rather than fail loudly.
  assert.notEqual(Buffer.from(script, "utf8").toString("base64"), encoded);
});

test("one value is quoted for each shell, escaping what that shell escapes", () => {
  assert.equal(quotePs("C:\\ProgramData\\OnTrak\\a b.ps1"), "'C:\\ProgramData\\OnTrak\\a b.ps1'");
  assert.equal(quotePs("it's"), "'it''s'");
  assert.equal(quoteSh("it's"), "'it'\\''s'");
  assert.equal(quoteSh("/home/student/a b.sh"), "'/home/student/a b.sh'");
});

test("the encoded command a full chunk produces fits the guest's command line", () => {
  // The failure this guards against, at the width of one whole chunk: `writeBytes`
  // wraps a chunk in `Add-Content -Path '<file>' -Value '<chunk>' ...`, then encodes
  // the whole thing. Building that worst case and measuring it is the only way to
  // know the bound holds without a Windows guest.
  const worstChunk = "A".repeat(WINRM_UPLOAD_CHUNK);
  const script =
    `Add-Content -Path 'C:\\ProgramData\\OnTrak\\post-install.ps1.b64' ` +
    `-Value '${worstChunk}' -NoNewline -Encoding Ascii`;
  const commandLine = powershellArgv(script).join(" ");
  assert.ok(
    commandLine.length < COMMAND_LINE_LIMIT,
    `a full chunk yields a ${commandLine.length}-character command line; the guest ` +
      `refuses anything over ${COMMAND_LINE_LIMIT}`,
  );
});

test("the command-line transport is the narrower one", () => {
  assert.ok(WINRM_UPLOAD_CHUNK < UPLOAD_CHUNK);
});

test("the production Windows transport carries the narrow width, not just the recording one", () => {
  // The gap this closes, found on a real Windows guest: the width rules above were
  // proven only against `RecordingDriver`, which sets `uploadChunk` itself. The one
  // Windows transport the port actually builds — `incus-exec`, which the agent runs as
  // `incus exec … powershell -EncodedCommand` — kept the roomy 32,000 and overflowed
  // the guest's command line uploading `OnTrak.Common.ps1` ("The filename or extension
  // is too long"). So the width is asserted of the driver the factory returns.
  const driver = buildDriver(settings());
  assert.equal(driver.name, "incus-exec");
  assert.equal(driver.uploadChunk, WINRM_UPLOAD_CHUNK);

  const worstChunk = "A".repeat(driver.uploadChunk);
  const script =
    `Add-Content -Path 'C:\\ProgramData\\OnTrak\\OnTrak.Common.ps1.b64' ` +
    `-Value '${worstChunk}' -NoNewline -Encoding Ascii`;
  const commandLine = powershellArgv(script).join(" ");
  assert.ok(
    commandLine.length < COMMAND_LINE_LIMIT,
    `the built driver yields a ${commandLine.length}-character command line, over the guest's limit`,
  );
});

test("a payload of several chunks arrives byte for byte, every command line fitting", async () => {
  const driver = new RecordingDriver(settings());
  const payload = Buffer.alloc(256 * 60);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 256;
  assert.ok(payload.length > WINRM_UPLOAD_CHUNK);

  const result = await driver.writeBytes(payload, "C:\\ProgramData\\OnTrak\\post-install.ps1");

  assert.equal(result.ok, true);
  assert.ok(driver.chunks.length > 1, "the payload fitted in one chunk; this test proves nothing");
  for (const chunk of driver.chunks) assert.ok(chunk.length <= WINRM_UPLOAD_CHUNK);
  for (const script of driver.scripts) {
    assert.ok(powershellArgv(script).join(" ").length < COMMAND_LINE_LIMIT);
  }
  const decoded = driver.decoded;
  assert.ok(decoded);
  assert.deepEqual(decoded, payload);
});

test("the upload names its target, its staging file and the directory it needs", async () => {
  const driver = new RecordingDriver(settings());
  await driver.writeBytes(new TextEncoder().encode("hello"), "C:\\ProgramData\\OnTrak\\thing.txt");

  const prep = driver.scripts.find((script) => script.includes("New-Item")) ?? "";
  assert.ok(
    prep.includes("New-Item -ItemType Directory -Force -Path 'C:\\ProgramData\\OnTrak'"),
    `the prep step did not create the target directory: ${prep}`,
  );

  const decode = driver.scripts.filter((script) => script.includes("[Convert]::FromBase64String"));
  assert.equal(decode.length, 1, "the decode step runs once");
  const only = decode.at(0) ?? "";
  assert.ok(only.includes("C:\\ProgramData\\OnTrak\\thing.txt"));
  assert.ok(only.includes("C:\\ProgramData\\OnTrak\\thing.txt.b64"));
  assert.ok(only.includes("'wrote 5 bytes'"));
});

test("a path with no directory is staged in the current directory", async () => {
  const driver = new RecordingDriver(settings());
  await driver.writeBytes(new TextEncoder().encode("x"), "post-install.ps1");
  const prep = driver.scripts.find((script) => script.includes("New-Item")) ?? "";
  assert.ok(prep.includes("-Path '.'"), `the prep step did not name the current directory: ${prep}`);
});

test("text is uploaded as UTF-8, byte for byte", async () => {
  const driver = new RecordingDriver(settings());
  await driver.uploadText("café\n", "C:\\x.txt");
  assert.equal(Buffer.from(driver.chunks.join(""), "base64").toString("utf8"), "café\n");
});

test("a Linux upload is one heredoc on stdin, not a chunk per call", async () => {
  // The roomy transport's advantage, stated as a test: the payload is not cut up at
  // all, because there is no command line to overflow.
  const driver = new RecordingShellDriver(settings());
  const data = new TextEncoder().encode("x".repeat(WINRM_UPLOAD_CHUNK * 3));

  await driver.writeBytes(data, "/home/student/check.sh");

  assert.equal(driver.scripts.length, 1);
  const script = driver.scripts.at(0) ?? "";
  assert.ok(script.includes("mkdir -p '/home/student'"));
  assert.ok(script.includes("base64 -d > '/home/student/check.sh' <<'ONTRAK_B64'"));
  assert.ok(script.includes(Buffer.from(data).toString("base64")));
});

test("a PowerShell script file is run with its errors folded into stdout", async () => {
  const driver = new RecordingDriver(settings());
  await driver.runScriptFile("C:\\ProgramData\\OnTrak\\check.ps1");
  const script = driver.scripts.at(0) ?? "";
  assert.ok(script.startsWith("$ErrorActionPreference='Continue';"));
  assert.ok(script.includes("& 'C:\\ProgramData\\OnTrak\\check.ps1' *>&1 | Out-String -Width 4096"));
});

test("a shell script file is run with its errors folded in", async () => {
  const driver = new RecordingShellDriver(settings());
  await driver.runScriptFile("/home/student/check.sh");
  assert.equal(driver.scripts.at(0), "bash '/home/student/check.sh' < /dev/null 2>&1");
});

test("addressing prefers the given host, then static_host, and refuses a blank one", () => {
  const driver = new RecordingDriver(settings({ staticHost: "10.0.0.7" }));
  assert.equal(driver.resolveHost("vm1", "10.0.0.8"), "10.0.0.8");
  assert.equal(driver.resolveHost("vm1", ""), "10.0.0.7");

  const blank = new RecordingDriver(settings());
  assert.throws(() => blank.resolveHost("vm1"), /needs a host address for instance "vm1"/);
});

test("a shell driver refuses PowerShell and names the files the scenario owes", async () => {
  const driver = new IncusShellDriver(settings(), { client: stubClient() });
  await assert.rejects(
    () => driver.runPowerShell("Get-Date"),
    (error: unknown) =>
      error instanceof GuestError &&
      /talks shell, not PowerShell/.test(error.message) &&
      /setup\.sh\/check\.sh/.test(error.message),
  );
});

test("a driver with no instance name raises instead of guessing", async () => {
  const shell = new IncusShellDriver(settings(), { client: stubClient() });
  await assert.rejects(() => shell.runShell("echo hi"), /needs the instance name/);

  const agent = new IncusExecDriver(settings(), { client: stubClient() });
  await assert.rejects(() => agent.runPowerShell("Get-Date"), /requires an instance name/);
});

test("a driver with no Incus client says so rather than failing obscurely", async () => {
  const shell = new IncusShellDriver(settings());
  await assert.rejects(
    () => shell.runShell("echo hi", { instance: "ontrak-sess-1" }),
    /has no Incus client/,
  );

  // The agent transport is the documented exception: a transport failure is a failed
  // result, because grading reads a failure as data and provisioning is what decides
  // it is an incident.
  const agent = new IncusExecDriver(settings());
  const result = await agent.runPowerShell("Get-Date", { instance: "ontrak-sess-1" });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /has no Incus client/);
});

test("the shell driver runs through the agent with the configured Linux account", async () => {
  const seen: { instance: string; script: string; user: string | null | undefined }[] = [];
  const client = stubClient(async (instance, script, options) => {
    seen.push({ instance, script, user: options?.user });
    return { returncode: 0, stdout: "ontrak-ready\n", stderr: "" };
  });
  const driver = new IncusShellDriver(settings({ linuxUser: "student" }), { client });

  const result = await driver.runShell("printf 'ontrak-ready\\n'", { instance: "ontrak-sess-1" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    seen.map((call) => [call.instance, call.user]),
    [["ontrak-sess-1", "student"]],
  );
  assert.equal(seen.at(0)?.script, "printf 'ontrak-ready\\n'");
});

test("the configured Linux account is passed through, and an unset one is not", async () => {
  // The driver hands the account straight to the client, which is where a name
  // becomes a uid (`incus exec --user` takes a number, and root is already the
  // default there). Passing it through unchanged is what keeps that rule in one
  // place instead of two.
  const seen: (string | null | undefined)[] = [];
  const client = stubClient(async (_instance, _script, options) => {
    seen.push(options?.user);
    return { returncode: 0, stdout: "", stderr: "" };
  });

  const root = new IncusShellDriver(settings({ linuxUser: "root" }), { client });
  await root.runShell("true", { instance: "ontrak-sess-1" });
  assert.equal(seen.at(0), "root");

  const unset = new IncusShellDriver(settings({ linuxUser: "" }), { client });
  await unset.runShell("true", { instance: "ontrak-sess-2" });
  assert.equal(seen.at(1), null, "an unset account asks for no particular user");
});

test("readiness polls until the guest answers, then stops", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const flaky = stubClient(undefined, async () => {
    calls += 1;
    return {
      returncode: calls >= 3 ? 0 : 1,
      stdout: calls >= 3 ? "LAB-VM" : "",
      stderr: calls >= 3 ? "" : "not up",
    };
  });
  const driver = new IncusExecDriver(settings(), { client: flaky, clock });

  assert.equal(await driver.waitReady({ instance: "ontrak-sess-1", hostIp: "" }), true);
  assert.equal(calls, 3);
});

test("readiness gives up inside its budget rather than hanging", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const never = stubClient(undefined, async () => {
    calls += 1;
    return { returncode: 1, stdout: "", stderr: "not up" };
  });
  const driver = new IncusExecDriver(settings({ bootTimeoutSeconds: 12 }), { client: never, clock });

  assert.equal(await driver.waitReady({ instance: "ontrak-sess-2", hostIp: "" }), false);
  assert.equal(calls, 3, "12 seconds at 5-second intervals: three probes, then the budget is spent");
});

test("readiness for an instance-less session is false, not an error", async () => {
  const driver = new IncusExecDriver(settings(), { client: stubClient() });
  assert.equal(await driver.waitReady({ instance: "", hostIp: "" }), false);
});

test("Linux readiness waits for the shell contract, not for a port", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const client = stubClient(async () => {
    calls += 1;
    return { returncode: 0, stdout: calls >= 2 ? "ontrak-ready\n" : "", stderr: "" };
  });
  const driver = new IncusShellDriver(settings({ linuxReadyTimeoutSeconds: 30 }), { client, clock });

  assert.equal(await driver.waitReady({ instance: "ontrak-sess-linux", hostIp: "" }), true);
  assert.equal(calls, 2);
});

test("the Linux transport defaults to the agent, and Windows to the agent too", () => {
  assert.equal(chooseDriver("linux", settings({ linuxDriver: "" })).name, "incus-shell");
  assert.equal(chooseDriver("windows", settings({ driver: "" })).name, "incus-exec");
  assert.equal(buildShellDriver(settings({ linuxDriver: "posix" })).name, "incus-shell");
  assert.equal(buildDriver(settings({ driver: "agent" })).name, "incus-exec");
  assert.equal(buildDriver(settings({ driver: "shell" })).name, "incus-shell");
  assert.equal(buildDriver(settings({ driver: "dry-run" })).name, "null");
  assert.equal(buildDriver(settings({ driver: "incus" })).name, "incus-exec");
});

test("the ssh transport is key-based and names its port and account", () => {
  const keyed = settings({ sshPort: 2222, sshKey: "/keys/lab", linuxUser: "student" });
  assert.deepEqual(sshArgv(keyed, "10.0.0.9", "bash -s"), [
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
    "2222",
    "-i",
    "/keys/lab",
    "student@10.0.0.9",
    "bash -s",
  ]);

  const bare = sshArgv(settings({ sshKey: "", linuxUser: "" }), "10.0.0.9", "bash -s");
  assert.equal(bare.includes("-i"), false);
  assert.equal(bare.at(-2), "root@10.0.0.9");
});

test("the ssh driver speaks through the injected runner and reports its exit code", async () => {
  const calls: { argv: readonly string[]; input: string | undefined }[] = [];
  const runner: ProcessRunner = async (argv, input) => {
    calls.push({ argv, input });
    return { code: 3, stdout: "out", stderr: "err" };
  };
  const driver = new SSHDriver(settings({ sshKey: "/keys/lab", linuxUser: "student" }), {
    processRunner: runner,
  });

  const result = await driver.runShell("echo hi", { host: "10.0.0.9" });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(calls.length, 1);
  assert.equal(calls.at(0)?.input, "echo hi");
  assert.equal(calls.at(0)?.argv.at(-1), "bash -s");
});

test("an ssh transport failure names the host rather than leaking a raw error", async () => {
  const driver = new SSHDriver(settings(), {
    processRunner: async () => {
      throw new Error("connect: connection refused");
    },
  });
  await assert.rejects(
    () => driver.runShell("echo hi", { host: "10.0.0.9" }),
    (error: unknown) =>
      error instanceof GuestError &&
      /ssh 10\.0\.0\.9 failed/.test(error.message) &&
      /connection refused/.test(error.message),
  );
});

test("naming winrm fails loudly, naming the transport to use instead", () => {
  assert.throws(
    () => buildDriver(settings({ driver: "winrm" })),
    (error: unknown) =>
      error instanceof GuestError &&
      /no WinRM client for Node/.test(error.message) &&
      /'incus-exec'/.test(error.message),
  );
});

test("an unknown transport is refused with the list of the real ones", () => {
  assert.throws(() => buildDriver(settings({ driver: "telepathy" })), /unknown guest\.driver "telepathy"/);
});

test("the null driver returns canned output for the script it recognises", async () => {
  const driver = new NullDriver(settings(), { responses: { "check.ps1": "ONTRAK-SETUP-OK" } });

  const hit = await driver.runPowerShell("& check.ps1", { instance: "vm1" });
  assert.equal(hit.stdout, "ONTRAK-SETUP-OK");
  const miss = await driver.runPowerShell("Get-Date", { instance: "vm1" });
  assert.equal(miss.stdout, "");
  // Each log entry is the `(instance, what-was-run)` tuple the Python double
  // appended, so the instance is element 0.
  assert.deepEqual(
    driver.calls.map((call) => call[0]),
    ["vm1", "vm1"],
  );

  const upload = await driver.writeBytes(new Uint8Array([1, 2, 3]), "C:\\x.txt");
  assert.equal(upload.ok, true);
  assert.equal(driver.calls.at(-1)?.[1], "upload:C:\\x.txt:3B");
  // The null driver is always ready; it takes no target because there is nothing
  // to dial.
  assert.equal(await driver.waitReady(), true);
});
