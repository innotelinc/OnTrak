/**
 * The real Incus client, driven against a stand-in for the CLI.
 *
 * This is the port of `OnTrak-dev/tests/test_incus_client.py`, and it keeps that
 * file's reason for existing. The lab's own `FakeIncus` implements the same *method
 * names* as the real client, so it can never catch a command line the CLI does not
 * accept — and that is how three separate mistakes shipped, each of which stopped the
 * platform dead on a real host:
 *
 *   * `image info`, `info` and `storage info` have no `--format` on Incus 7.4 —
 *     `Error: unknown flag: --format`, exit 1 — so `imageExists()` answered false for
 *     every image and `template build` refused every workload;
 *   * `query` refuses `--project` outright, because the project belongs in the path;
 *   * `exec --user` takes a *numeric* uid and refuses an account name, and `root` is
 *     the platform's default Linux account, so *every* shell call failed and no
 *     machine ever looked ready.
 *
 * So the stand-in below reproduces all three refusals, plus the rule that
 * `copy --instance-only` is invalid on a snapshot source, and the tests assert
 * behaviour rather than argv. The last test names each rule directly, for whoever
 * arrives here from a failure.
 *
 * A second, scripted runner covers what a CLI double cannot reach: the process seam
 * itself — a missing binary, a timeout, a non-zero exit, unparseable JSON, and the
 * argv the client asks for (remote/project flags and their absence).
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-incus.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IncusClient,
  IncusError,
  IncusNotFound,
  RunnerSpawnError,
  RunnerTimeoutError,
  instanceRunning,
  parseMemoryMb,
  type CommandResult,
  type IncusSettings,
  type Runner,
} from "../src/lib/lab/incus";

// --------------------------------------------------------------------------- #
// runners
// --------------------------------------------------------------------------- #

interface RecordedCall {
  argv: string[];
  timeoutSeconds: number;
  input: string | null;
}

/** Answers in order, and shouts if a test asks for one more command than scripted. */
class ScriptedRunner implements Runner {
  readonly calls: RecordedCall[] = [];
  private readonly queue: (CommandResult | Error)[];

  constructor(queue: readonly (CommandResult | Error)[]) {
    this.queue = [...queue];
  }

  async run(
    argv: readonly string[],
    options: { timeoutSeconds: number; input?: string | undefined },
  ): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], timeoutSeconds: options.timeoutSeconds, input: options.input ?? null });
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`the scripted runner has no answer for: ${argv.join(" ")}`);
    if (next instanceof Error) throw next;
    return next;
  }
}

const KNOWN_ALIASES = new Set(["images:ubuntu/24.04", "images:debian/12", "ontrak-win-base"]);
const UIDS: Record<string, number> = { root: 0, student: 1000, ubuntu: 1000 };
const SERVER = { environment: { server_version: "7.4", driver: "incus" } };

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function die(message: string): CommandResult {
  return { code: 1, stdout: "", stderr: `Error: ${message}\n` };
}

/**
 * A stand-in for the `incus` CLI, carrying the rules the platform's calls trip over.
 *
 * Ported from the Python test's `STUB` script: the same refusals, the same alias set,
 * the same uid table, and the same ledger of every command it was asked to run.
 */
class CliStandIn implements Runner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly poolName: string) {}

  async run(
    argv: readonly string[],
    options: { timeoutSeconds: number; input?: string | undefined },
  ): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], timeoutSeconds: options.timeoutSeconds, input: options.input ?? null });

    // Drop the program name, then the global flags the way the CLI consumes them.
    const rest = argv.slice(1);
    let project: string | null = null;
    while (rest.length > 0 && (rest[0] === "--project" || rest[0] === "--remote")) {
      if (rest[0] === "--project") project = rest[1] ?? "";
      rest.splice(0, 2);
    }

    const head = rest[0] ?? "";
    const tail = rest.slice(1);
    const asksForFormat = (args: readonly string[]): boolean =>
      args.some((arg) => arg === "--format" || arg.startsWith("--format="));

    // The raw API: JSON by nature, and no place for a project flag.
    if (head === "query") {
      if (project !== null) return die("--project cannot be used with the query command");
      if (asksForFormat(tail)) return die("unknown flag: --format");
      const path = tail[0] ?? "";
      return ok(`${JSON.stringify(path === "/1.0" ? SERVER : {})}\n`);
    }

    if (head === "image" && tail[0] === "info") {
      if (asksForFormat(tail.slice(1))) return die("unknown flag: --format");
      const alias = tail[1] ?? "";
      if (KNOWN_ALIASES.has(alias)) return ok(`Architecture: x86_64\nFingerprint: ${"a".repeat(64)}\n`);
      return die("Failed getting image: The requested image couldn't be found");
    }

    if (head === "info") {
      if (asksForFormat(tail)) return die("unknown flag: --format");
      return ok("api_extensions: []\napi_version: 1.0\n");
    }

    if (head === "storage" && tail[0] === "info") {
      if (asksForFormat(tail.slice(1))) return die("unknown flag: --format");
      return ok("driver: zfs\n");
    }

    if (head === "storage" && tail[0] === "list" && asksForFormat(tail)) {
      return ok(`${JSON.stringify([{ name: this.poolName, driver: "zfs", status: "Created" }])}\n`);
    }

    if (head === "copy") {
      const source = tail[0] ?? "";
      const body = source.includes(":") ? source.slice(source.indexOf(":") + 1) : source;
      if (body.includes("/") && tail.slice(1).some((arg) => arg === "--instance-only")) {
        return die("--instance-only can't be passed when the source is a snapshot");
      }
      return ok();
    }

    if (head === "exec") {
      // `--user` takes a uid. An account name is refused, in either spelling.
      const probe = [...tail];
      let at = probe.indexOf("--user");
      while (at !== -1) {
        const value = probe[at + 1] ?? "";
        if (!/^[0-9]+$/.test(value)) {
          return die(
            `invalid argument "${value}" for "--user" flag: strconv.ParseUint: parsing "${value}": invalid syntax`,
          );
        }
        probe.splice(at, 2);
        at = probe.indexOf("--user");
      }
      for (const token of tail) {
        if (token.startsWith("--user=")) {
          const value = token.slice("--user=".length);
          if (!/^[0-9]+$/.test(value)) {
            return die(
              `invalid argument "${value}" for "--user" flag: strconv.ParseUint: parsing "${value}": invalid syntax`,
            );
          }
        }
      }

      // `... -- id -u <name>` is how the client resolves an account name.
      if (tail.includes("-u") && tail.includes("id")) {
        const name = tail[tail.indexOf("-u") + 1] ?? "";
        const uid = UIDS[name];
        if (uid !== undefined) return ok(`${uid}\n`);
        return die(`id: '${name}': no such user`);
      }

      if (tail.join(" ").includes("ontrak-ready")) return ok("ontrak-ready\n");
      return ok();
    }

    if (asksForFormat(tail)) return ok("[]\n");
    return ok();
  }
}

// --------------------------------------------------------------------------- #
// fixtures
// --------------------------------------------------------------------------- #

const SETTINGS: IncusSettings = {
  remote: "",
  project: "",
  storagePool: "default",
  operationTimeoutSeconds: 60,
};

function settingsWith(overrides: Partial<IncusSettings> = {}): IncusSettings {
  return { ...SETTINGS, ...overrides };
}

/** Every command as a single line, without the program name. */
function askedLines(runner: { calls: RecordedCall[] }): string[] {
  return runner.calls.map((call) => call.argv.slice(1).join(" "));
}

/** The rejection the call produced, or a test failure when it succeeded. */
async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail, but it succeeded");
}

/**
 * The failure as an `IncusError`.
 *
 * An explicit throw rather than `assert.ok(failure instanceof IncusError)`: the
 * narrowing has to hold for the typecheck, not only at run time, and an
 * `if`/`throw` holds everywhere.
 */
function asIncusError(failure: unknown): IncusError {
  if (!(failure instanceof IncusError)) {
    throw new Error(`expected the call to fail with an IncusError, got: ${String(failure)}`);
  }
  return failure;
}

/** A value a test knows is present, for indexing the compiler cannot prove. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

function firstCall(runner: { calls: RecordedCall[] }): RecordedCall {
  return required(runner.calls[0], "a recorded command");
}

// --------------------------------------------------------------------------- #
// an alias that resolves
// --------------------------------------------------------------------------- #

test("incus: a server-side alias counts as present", async () => {
  // `images:ubuntu/24.04` is not cached on a fresh host and does not need to be: a
  // container workload launches it from the image server, which is the path the
  // catalog planner calls `container-image`.
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  assert.equal(await client.imageExists("images:ubuntu/24.04"), true);
});

test("incus: the site's golden image counts as present", async () => {
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  assert.equal(await client.imageExists("ontrak-win-base"), true);
});

test("incus: an alias that resolves nowhere is absent", async () => {
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  assert.equal(await client.imageExists("images:nothing/1.0"), false);
});

test("incus: a missing binary reads as absent rather than raising", async () => {
  // `doctor` asks this on hosts that may not have Incus at all.
  const missing: Runner = {
    run: async () => {
      throw new RunnerSpawnError("/nope/incus", "spawn /nope/incus ENOENT");
    },
  };
  const client = new IncusClient(SETTINGS, { binary: "/nope/incus", runner: missing });
  assert.equal(await client.imageExists("images:ubuntu/24.04"), false);
  // `available` answers by *running* the binary, so an absent one is false — proven
  // through the seam and, for `node`, through the real process runner as well.
  assert.equal(await IncusClient.available("incus", missing), false);
  assert.equal(await IncusClient.available("node"), true);
  assert.equal(await IncusClient.available("definitely-not-an-incus-binary-xyz"), false);
});

// --------------------------------------------------------------------------- #
// the calls that asked the API for a flag it does not have
// --------------------------------------------------------------------------- #

test("incus: server info reports the version", async () => {
  // This answered `{}` on Incus 7.4, so `doctor` printed "server unknown".
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  const info = await client.serverInfo();
  const environment = info.environment as Record<string, unknown> | undefined;
  assert.equal(environment?.server_version, "7.4");
});

test("incus: storage info reports the pool driver", async () => {
  // The driver decides whether clones are cheap, so an empty answer is a lie.
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  assert.equal((await client.storageInfo("default")).driver, "zfs");
});

test("incus: storage info defaults to the configured pool", async () => {
  const runner = new CliStandIn("ontrak-pool");
  const client = new IncusClient(settingsWith({ storagePool: "ontrak-pool" }), { runner });
  assert.equal((await client.storageInfo()).name, "ontrak-pool");
});

test("incus: storage info says nothing about a pool that is not there", async () => {
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  assert.deepEqual(await client.storageInfo("nosuchpool"), {});
});

// --------------------------------------------------------------------------- #
// the account a shell runs as
// --------------------------------------------------------------------------- #

test("incus: the default root account sends no user flag", async () => {
  // Root is what `exec` does anyway, and the name is not a valid argument.
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.execIn("probe", ["/bin/true"], { user: "root", check: false });
  const asked = askedLines(runner).join("\n");
  assert.ok(!asked.includes("--user"), asked);
});

test("incus: an account name is resolved to its uid", async () => {
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.execIn("probe", ["/bin/true"], { user: "student", check: false });
  const asked = askedLines(runner);
  assert.ok(
    asked.some((line) => line.includes("--user 1000")),
    asked.join("\n"),
  );
});

test("incus: the lookup is paid once per instance", async () => {
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await client.execIn("probe", ["/bin/true"], { user: "student", check: false });
  }
  const lookups = askedLines(runner).filter((line) => line.includes("id -u"));
  assert.equal(lookups.length, 1);
});

test("incus: an account the guest does not have is refused", async () => {
  // Better a clear failure than a graded check run as the wrong account.
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  const failure = asIncusError(
    await captureFailure(() => client.execIn("probe", ["/bin/true"], { user: "ghost", check: false })),
  );
  assert.match(failure.message, /no account 'ghost'/);
});

test("incus: no user flag is sent when none was configured", async () => {
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.execIn("probe", ["/bin/true"], { check: false });
  assert.ok(!askedLines(runner).join("\n").includes("--user"));
});

// --------------------------------------------------------------------------- #
// cloning the clean snapshot
// --------------------------------------------------------------------------- #

test("incus: cloning the clean snapshot works", async () => {
  // Handing a student their machine: `copy tpl-x/clean <name>`. This is the call that
  // fills the pool and starts every session, and the flag it used to carry made it
  // fail outright.
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.copyInstance("tpl-linux-user-lifecycle-ubuntu-24-04/clean", "ontrak-sess-42");
  const asked = askedLines(runner).join("\n");
  assert.ok(asked.includes("copy tpl-linux-user-lifecycle-ubuntu-24-04/clean ontrak-sess-42"), asked);
  assert.ok(!asked.includes("--instance-only"), asked);
});

test("incus: copying a whole instance still skips its snapshots", async () => {
  // The flag's actual meaning, kept where it is valid.
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.copyInstance("tpl-linux-user-lifecycle-ubuntu-24-04", "ontrak-copy");
  assert.ok(askedLines(runner).join("\n").includes("--instance-only"));
});

test("incus: a cluster-qualified snapshot reads the same way", async () => {
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.copyInstance("lab:tpl-x/clean", "ontrak-copy");
  assert.ok(!askedLines(runner).join("\n").includes("--instance-only"));
});

test("incus: a snapshot copy is not asked to skip snapshots", async () => {
  // Fails loudly if the flag comes back on a snapshot source.
  const client = new IncusClient(SETTINGS, { runner: new CliStandIn("default") });
  await client.copyInstance("tpl-x/clean", "ontrak-copy");
});

test("incus: the source of a copy is never an image alias", async () => {
  // A reminder in a test rather than a comment: `copy` here is always a template.
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.copyInstance("tpl-x/clean", "ontrak-copy");
  assert.ok(askedLines(runner).join("\n").includes("copy tpl-x/clean"));
});

test("incus: the client asks nothing the CLI refuses", async () => {
  const runner = new CliStandIn("default");
  const client = new IncusClient(SETTINGS, { runner });
  await client.imageExists("images:ubuntu/24.04");
  await client.serverInfo();
  await client.storageInfo("default");
  await client.execIn("probe", ["/bin/true"], { user: "root", check: false });
  await client.copyInstance("tpl-x/clean", "ontrak-probe");

  const asked = askedLines(runner).filter((line) => line.length > 0);
  assert.ok(asked.length > 0, "the stand-in recorded no commands");
  for (const line of asked) {
    if (line.startsWith("query")) {
      assert.ok(!line.includes("--project"), `query refuses a project flag: ${line}`);
      assert.ok(!line.includes("--format"), `query has no --format: ${line}`);
    }
    if (line.startsWith("image info") || line.startsWith("info ") || line.startsWith("storage info")) {
      assert.ok(!line.includes("--format"), `no such flag on this subcommand: ${line}`);
    }
    if (line.startsWith("exec")) {
      assert.ok(!line.includes("--user root"), `--user wants a uid, not a name: ${line}`);
      assert.ok(!line.includes("--user student"), `--user wants a uid, not a name: ${line}`);
    }
    if (line.startsWith("copy")) {
      const source = line.split(" ")[1] ?? "";
      const body = source.includes(":") ? source.slice(source.indexOf(":") + 1) : source;
      assert.ok(
        !(body.includes("/") && line.includes("--instance-only")),
        `a snapshot source cannot skip its own snapshots: ${line}`,
      );
    }
  }
});

// --------------------------------------------------------------------------- #
// the process seam: argv, and every failure the CLI can produce
// --------------------------------------------------------------------------- #

test("incus: the remote and project flags are asked for, and omitted when absent", async () => {
  const both = new ScriptedRunner([ok("[]")]);
  await new IncusClient(settingsWith({ remote: "lab", project: "ontrak" }), { runner: both }).listInstances();
  assert.deepEqual(firstCall(both).argv, [
    "incus",
    "--remote",
    "lab",
    "--project",
    "ontrak",
    "list",
    "--format=json",
  ]);

  const local = new ScriptedRunner([ok("[]")]);
  await new IncusClient(settingsWith({ remote: "local", project: "ontrak" }), { runner: local }).listInstances();
  assert.deepEqual(firstCall(local).argv, ["incus", "--project", "ontrak", "list", "--format=json"]);

  const bare = new ScriptedRunner([ok("[]")]);
  await new IncusClient(SETTINGS, { runner: bare }).listInstances();
  assert.deepEqual(firstCall(bare).argv, ["incus", "list", "--format=json"]);
});

test("incus: a query call asks for no project flag", async () => {
  const runner = new ScriptedRunner([ok(JSON.stringify(SERVER))]);
  await new IncusClient(settingsWith({ project: "ontrak" }), { runner }).serverInfo();
  assert.deepEqual(firstCall(runner).argv, ["incus", "query", "/1.0"]);
});

test("incus: a missing binary is a 127 naming the binary", async () => {
  const runner = new ScriptedRunner([new RunnerSpawnError("incus", "spawn incus ENOENT")]);
  const client = new IncusClient(SETTINGS, { runner });
  const failure = asIncusError(await captureFailure(() => client.listInstances()));
  assert.equal(failure.code, 127);
  assert.match(failure.message, /not found on PATH/);
});

test("incus: a timeout is a 124 naming the seconds it waited", async () => {
  const runner = new ScriptedRunner([new RunnerTimeoutError(45)]);
  const client = new IncusClient(settingsWith({ operationTimeoutSeconds: 45 }), { runner });
  const failure = asIncusError(await captureFailure(() => client.listInstances()));
  assert.equal(failure.code, 124);
  assert.match(failure.message, /timed out after 45s/);
});

test("incus: the configured timeout is the ceiling for reads too", async () => {
  // A bare `incus list` on a busy host blocks for minutes on a booting VM, so the
  // operation timeout has to be what a read waits for.
  const runner = new ScriptedRunner([ok("[]")]);
  await new IncusClient(settingsWith({ operationTimeoutSeconds: 300 }), { runner }).listInstances();
  assert.equal(firstCall(runner).timeoutSeconds, 300);
});

test("incus: 'not found' in stderr is an IncusNotFound", async () => {
  const runner = new ScriptedRunner([{ code: 1, stdout: "", stderr: "Error: Instance not found\n" }]);
  const client = new IncusClient(SETTINGS, { runner });
  const failure = asIncusError(await captureFailure(() => client.run(["info", "ghost"])));
  assert.equal(failure instanceof IncusNotFound, true);
  assert.equal(failure.code, 1);
});

test("incus: any other failure carries the trimmed stderr", async () => {
  const runner = new ScriptedRunner([{ code: 2, stdout: "", stderr: "  boom  \n" }]);
  const client = new IncusClient(SETTINGS, { runner });
  const failure = asIncusError(await captureFailure(() => client.run(["delete", "x"])));
  assert.equal(failure.code, 2);
  assert.equal(failure.stderr, "boom");
  assert.match(failure.message, /incus delete x failed \(2\): boom/);
});

test("incus: check false reads a non-zero exit instead of raising", async () => {
  const runner = new ScriptedRunner([{ code: 1, stdout: "out", stderr: "no" }]);
  const client = new IncusClient(SETTINGS, { runner });
  const result = await client.run(["stop", "x"], { check: false });
  assert.equal(result.code, 1);
});

test("incus: unparseable JSON is an error, not junk", async () => {
  const runner = new ScriptedRunner([ok("{not json")]);
  const client = new IncusClient(SETTINGS, { runner });
  const failure = asIncusError(await captureFailure(() => client.listInstances()));
  assert.match(failure.message, /unparseable JSON output/);
});

test("incus: an empty answer is null rather than a parse failure", async () => {
  const runner = new ScriptedRunner([ok("")]);
  const client = new IncusClient(SETTINGS, { runner });
  assert.equal(await client.runJson(["list", "--format=json"]), null);
});

// --------------------------------------------------------------------------- #
// reading an instance
// --------------------------------------------------------------------------- #

const INSTANCES = JSON.stringify([
  {
    name: "ontrak-sess-1",
    status: "RUNNING",
    type: "virtual-machine",
    config: { "limits.cpu": "4,8", "limits.memory": "4GiB", "image.os": "Windows 11" },
    state: {
      network: {
        enp5s0: { addresses: [{ family: "inet", scope: "global", address: "10.20.0.9" }] },
        eth0: {
          addresses: [
            { family: "inet", scope: "link", address: "169.254.1.1" },
            { family: "inet", scope: "global", address: "10.20.0.5" },
          ],
        },
      },
    },
  },
  { name: "ontrak-pool-x-1", status: "STOPPED", type: "container", config: {}, state: {} },
  { name: "tpl-x", status: "Unknown" },
]);

test("incus: an instance is read with its address, cpu and memory", async () => {
  const runner = new ScriptedRunner([ok(INSTANCES)]);
  const client = new IncusClient(SETTINGS, { runner });
  const instances = await client.listInstances();
  const first = required(instances[0], "the running instance");
  const second = required(instances[1], "the stopped instance");
  const third = required(instances[2], "the template");
  assert.equal(first.name, "ontrak-sess-1");
  assert.equal(instanceRunning(first), true);
  // eth0's global address, not the link-scope one that exists before DHCP answers.
  assert.equal(first.ipv4, "10.20.0.5");
  assert.equal(first.cpu, 4);
  assert.equal(first.memoryMb, 4096);
  assert.equal(first.os, "Windows 11");
  assert.equal(first.kind, "virtual-machine");
  assert.equal(instanceRunning(second), false);
  assert.equal(second.kind, "container");
  assert.equal(second.ipv4, "");
  assert.equal(third.kind, "virtual-machine");
  assert.equal(third.status, "Unknown");
});

test("incus: lookups by name follow the list", async () => {
  const client = new IncusClient(SETTINGS, {
    runner: new ScriptedRunner(Array.from({ length: 4 }, () => ok(INSTANCES))),
  });
  assert.equal(await client.instanceStatus("ontrak-pool-x-1"), "STOPPED");
  assert.equal(await client.instanceIp("ontrak-sess-1"), "10.20.0.5");
  assert.equal(await client.exists("tpl-x"), true);
  assert.equal(await client.exists("nobody"), false);
});

test("incus: an answer that is not a list of instances is no instances", async () => {
  // Python would raise on `entry.get`; a caller rendering the pool must not 500
  // because the daemon answered with an error object.
  const runner = new ScriptedRunner([ok(JSON.stringify({ error: "nope" }))]);
  const client = new IncusClient(SETTINGS, { runner });
  assert.deepEqual(await client.listInstances(), []);
});

test("incus: image aliases and snapshots are read from their lists", async () => {
  const aliases = new ScriptedRunner([
    ok(JSON.stringify([{ aliases: [{ name: "ontrak-win-base" }, { name: "images:ubuntu/24.04" }, { name: "" }] }, { aliases: null }])),
  ]);
  const client = new IncusClient(SETTINGS, { runner: aliases });
  assert.deepEqual(await client.imageAliases(), ["images:ubuntu/24.04", "ontrak-win-base"]);

  const snapshots = new ScriptedRunner(
    Array.from({ length: 2 }, () => ok(JSON.stringify([{ name: "clean" }, { name: "" }]))),
  );
  const other = new IncusClient(SETTINGS, { runner: snapshots });
  assert.deepEqual(await other.snapshotNames("tpl-x"), ["clean"]);
  assert.equal(await other.hasSnapshot("tpl-x", "clean"), true);
});

test("incus: a failing list reads as empty rather than breaking the page", async () => {
  const runner = new ScriptedRunner([
    { code: 1, stdout: "", stderr: "Error: boom" },
    { code: 1, stdout: "", stderr: "Error: boom" },
    { code: 1, stdout: "", stderr: "Error: boom" },
  ]);
  const client = new IncusClient(SETTINGS, { runner });
  assert.deepEqual(await client.imageAliases(), []);
  assert.deepEqual(await client.snapshotNames("tpl-x"), []);
  assert.deepEqual(await client.serverInfo(), {});
});

test("incus: memory is reported in megabytes whatever spelling was typed", () => {
  assert.equal(parseMemoryMb("4GiB"), 4096);
  assert.equal(parseMemoryMb("512MiB"), 512);
  assert.equal(parseMemoryMb("1TiB"), 1048576);
  assert.equal(parseMemoryMb("1048576KiB"), 1024);
  assert.equal(parseMemoryMb("1.5GiB"), 1536);
  assert.equal(parseMemoryMb("2048"), 2048);
  assert.equal(parseMemoryMb(""), 0);
  assert.equal(parseMemoryMb("junk"), 0);
});

// --------------------------------------------------------------------------- #
// the commands the session manager issues
// --------------------------------------------------------------------------- #

test("incus: creating an instance names every profile", async () => {
  const runner = new ScriptedRunner([ok()]);
  const client = new IncusClient(SETTINGS, { runner });
  await client.createInstance("ontrak-tpl-x", "images:ubuntu/24.04", ["lab", "compute"]);
  assert.deepEqual(firstCall(runner).argv, [
    "incus",
    "init",
    "images:ubuntu/24.04",
    "ontrak-tpl-x",
    "-p",
    "lab",
    "-p",
    "compute",
  ]);

  const bare = new ScriptedRunner([ok()]);
  await new IncusClient(SETTINGS, { runner: bare }).createInstance("ontrak-tpl-x", "images:ubuntu/24.04");
  assert.deepEqual(firstCall(bare).argv, ["incus", "init", "images:ubuntu/24.04", "ontrak-tpl-x"]);
});

test("incus: start can wait for the machine to be running", async () => {
  const runner = new ScriptedRunner([ok(), ok(INSTANCES)]);
  const client = new IncusClient(SETTINGS, { runner });
  await client.startInstance("ontrak-sess-1", { wait: true, timeout: 60 });
  assert.deepEqual(firstCall(runner).argv, ["incus", "start", "ontrak-sess-1"]);
  assert.ok(askedLines(runner)[1]?.startsWith("list"), askedLines(runner).join(" | "));
});

test("incus: stop takes a grace period, and force reads its own failure", async () => {
  const runner = new ScriptedRunner([ok()]);
  const client = new IncusClient(SETTINGS, { runner });
  await client.stopInstance("x");
  assert.deepEqual(firstCall(runner).argv, ["incus", "stop", "x", "--timeout", "120"]);

  const forced = new ScriptedRunner([{ code: 1, stdout: "", stderr: "still running" }]);
  await new IncusClient(SETTINGS, { runner: forced }).stopInstance("x", { force: true, timeout: 5 });
  assert.deepEqual(firstCall(forced).argv, ["incus", "stop", "x", "--timeout", "5", "--force"]);
});

test("incus: delete is forced by default", async () => {
  const runner = new ScriptedRunner([ok()]);
  await new IncusClient(SETTINGS, { runner }).deleteInstance("ontrak-sess-1");
  assert.deepEqual(firstCall(runner).argv, ["incus", "delete", "ontrak-sess-1", "--force"]);

  const gentle = new ScriptedRunner([ok()]);
  await new IncusClient(SETTINGS, { runner: gentle }).deleteInstance("ontrak-sess-1", { force: false });
  assert.deepEqual(firstCall(gentle).argv, ["incus", "delete", "ontrak-sess-1"]);
});

test("incus: snapshots are created, listed against and deleted", async () => {
  const runner = new ScriptedRunner([ok(), ok()]);
  const client = new IncusClient(SETTINGS, { runner });
  await client.createSnapshot("tpl-x", "clean");
  await client.deleteSnapshot("tpl-x", "clean");
  assert.deepEqual(
    askedLines(runner),
    ["snapshot create tpl-x clean", "snapshot delete tpl-x clean"],
  );
});

test("incus: an unset config key is empty rather than an error", async () => {
  // This is what lets the QEMU accelerator merge rather than overwrite.
  const unset = new ScriptedRunner([{ code: 1, stdout: "", stderr: "Error: not set" }]);
  assert.equal(await new IncusClient(SETTINGS, { runner: unset }).configGet("x", "raw.qemu"), "");

  const set = new ScriptedRunner([ok("  value  \n")]);
  assert.equal(await new IncusClient(SETTINGS, { runner: set }).configGet("x", "raw.qemu"), "value");
});

test("incus: config, devices, profiles and rename are asked for as expected", async () => {
  const runner = new ScriptedRunner([ok(), ok(), ok(), ok(), ok(), ok()]);
  const client = new IncusClient(SETTINGS, { runner });
  await client.setConfig("x", "limits.memory", "4GiB");
  await client.setConfigs("x", { "raw.qemu.conf": "[machine]", "limits.cpu": 4 });
  await client.addDevice("x", "nic", "eth1", { nictype: "bridged", parent: "ontrak0" });
  await client.removeDevice("x", "eth1");
  await client.assignProfiles("x", ["lab"]);
  assert.deepEqual(askedLines(runner), [
    "config set x limits.memory=4GiB",
    "config set x raw.qemu.conf=[machine]",
    "config set x limits.cpu=4",
    "config device add x eth1 nic nictype=bridged parent=ontrak0",
    "config device remove x eth1",
    "profile assign x lab",
  ]);
});

test("incus: assigning no profiles asks for nothing", async () => {
  const runner = new ScriptedRunner([]);
  await new IncusClient(SETTINGS, { runner }).assignProfiles("x", []);
  assert.equal(runner.calls.length, 0);
});

test("incus: a rename waits for its own operation timeout", async () => {
  const runner = new ScriptedRunner([ok()]);
  await new IncusClient(settingsWith({ operationTimeoutSeconds: 240 }), { runner }).renameInstance("a", "b");
  assert.deepEqual(firstCall(runner).argv, ["incus", "rename", "a", "b"]);
  assert.equal(firstCall(runner).timeoutSeconds, 240);
});

// --------------------------------------------------------------------------- #
// running things inside a guest
// --------------------------------------------------------------------------- #

test("incus: a guest command is run with a stdin payload available", async () => {
  const runner = new ScriptedRunner([ok("done\n")]);
  const client = new IncusClient(SETTINGS, { runner });
  const result = await client.guestShell("x", "set -e\necho done\n");
  assert.equal(result.stdout, "done\n");
  const call = firstCall(runner);
  assert.deepEqual(call.argv, ["incus", "exec", "x", "-T", "--", "bash", "-s"]);
  assert.equal(call.input, "set -e\necho done\n");
  assert.equal(call.timeoutSeconds, 120);
});

test("incus: a detached command is not waited on, and its exit is not raised", async () => {
  const runner = new ScriptedRunner([{ code: 1, stdout: "", stderr: "detached" }]);
  const client = new IncusClient(SETTINGS, { runner });
  const result = await client.execIn("x", ["/bin/true"], { detach: true });
  // `returncode`, the guest transport contract every driver reads — see GuestExecOutput.
  assert.equal(result.returncode, 1);
  assert.deepEqual(firstCall(runner).argv, ["incus", "exec", "x", "-T", "--mode=detach", "--", "/bin/true"]);
});

test("incus: a graded check can read its own failure", async () => {
  // Grading catches a failing check as data, so `check: false` must not raise.
  const runner = new ScriptedRunner([{ code: 3, stdout: "###ONTRAK-JSON-BEGIN###{}###ONTRAK-JSON-END###", stderr: "" }]);
  const client = new IncusClient(SETTINGS, { runner });
  const result = await client.execIn("x", ["powershell", "-EncodedCommand", "AA=="], { check: false, timeout: 90 });
  assert.equal(result.returncode, 3);
  assert.equal(firstCall(runner).timeoutSeconds, 90);
});

test("incus: waiting for a status stops at the first match and gives up on time", async () => {
  const reached = new ScriptedRunner([
    ok(JSON.stringify([{ name: "x", status: "STOPPED" }])),
    ok(JSON.stringify([{ name: "x", status: "RUNNING" }])),
  ]);
  const client = new IncusClient(SETTINGS, { runner: reached });
  assert.equal(await client.waitForStatus("x", "running", { timeout: 5, interval: 0.001 }), true);

  const stalled = new ScriptedRunner(
    Array.from({ length: 8 }, () => ok(JSON.stringify([{ name: "x", status: "STOPPED" }]))),
  );
  const other = new IncusClient(SETTINGS, { runner: stalled });
  assert.equal(await other.waitForStatus("x", "RUNNING", { timeout: 0.02, interval: 0.005 }), false);
});
