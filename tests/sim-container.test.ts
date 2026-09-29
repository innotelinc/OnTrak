/**
 * Container fidelity (v1.2).
 *
 * The claim this suite exists to check is the roadmap's exit criterion: *a scenario authored
 * for real bash runs in a sandbox and grades identically to the simulated driver on the
 * bundled checks*. So the centrepiece is one scenario graded twice — once driven by the
 * simulated engine and once by a sandbox running real bash — with the two reports compared
 * check for check.
 *
 * The sandbox in that test is the **process** backend: real bash, a scratch directory, no
 * Docker. That is a deliberate choice rather than a shortcut. It means the suite proves the
 * driver against a real shell on any machine, including CI, without a Docker daemon. The
 * container backend differs from it only in how a command is started (`docker exec -i -w …`
 * instead of `bash -lc`), and that difference is covered by the `dockerCreateArgs` and
 * `DockerSandbox` tests, which assert the flags and the argv without needing a daemon.
 *
 * Everything else here is the pure half: which fidelity a scenario asks for, what a
 * deployment can deliver, what happens when it cannot, how a command line is planned, and
 * how a harvest of a real filesystem — hostile filenames and all — becomes virtual entries.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/sim-container.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ALL_PLATFORMS_ENABLED, NO_SANDBOX, evaluateScenario } from "../src/lib/availability-rules";
import { validateDefinition } from "../src/lib/validate";
import { createDriver, createScenarioDriver } from "../src/lib/sim/drivers";
import {
  DockerSandbox,
  ProcessSandbox,
  createContainerDriver,
  dockerCreateArgs,
  harvestPathToVfs,
  harvestScript,
  parseHarvest,
  planCommand,
  resolveSandboxPath,
  sandboxPathFor,
  sandboxShellFor,
  seedScript,
  shellQuote,
} from "../src/lib/sim/drivers/container";
import { createProxyDriver, fallbackMessage } from "../src/lib/sim/drivers/proxy";
import {
  normalizeFidelity,
  resolveFidelity,
  sandboxAvailability,
  sandboxConfigFromEnv,
  satisfiesFidelity,
} from "../src/lib/sim/fidelity";
import { disposeAllSandboxes, openSessionCount, runSandboxCommand, sandboxStatus } from "../src/lib/sim/sandbox";
import { createInitialState } from "../src/lib/sim/state";
import { gradeAttempt } from "../src/lib/sim/grade";
import type { ScenarioDefinition } from "../src/lib/sim/types";

/* -------------------------------------------------------------------------- */
/*  A scenario authored for real bash                                         */
/* -------------------------------------------------------------------------- */

const HOME = "/home/student";

/** The same definition drives both halves of the comparison below. */
const SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  fidelity: "container",
  objective: "Lock down the shared service configuration",
  brief: "A reviewer flagged the shared config. Tighten its permissions, log the change, and clear the stale copy.",
  tasks: ["Tighten app.conf", "Record the change in the file", "Remove the stale copy", "Create the logs directory"],
  machine: { hostname: "srv01", user: "student", os: "Ubuntu", version: "24.04 LTS", kernel: "6.8.0", arch: "x86_64" },
  files: [
    { path: "/home/student/shared/app.conf", content: "workers = 4\n", mode: "644" },
    { path: "/home/student/stale.conf", content: "retired\n", mode: "644" },
  ],
  checks: [
    { id: "mode", label: "app.conf is readable only by its group", kind: "file_mode", path: "/home/student/shared/app.conf", mode: "640" },
    { id: "recorded", label: "app.conf records the lockdown", kind: "file_contains", path: "/home/student/shared/app.conf", pattern: "locked" },
    { id: "stale", label: "the stale copy is gone", kind: "file_absent", path: "/home/student/stale.conf" },
    { id: "logs", label: "the logs directory exists", kind: "dir_exists", path: "/home/student/logs" },
    { id: "ran", label: "chmod was used on the config", kind: "command_matched", pattern: "chmod 640" },
  ],
};

/**
 * What a student would type, in order. Relative paths, so standing in a directory matters.
 *
 * The append comes before the `chmod` on purpose: the simulated engine writes the file back
 * with the default mode when it appends to it, so tightening the permissions first would
 * leave the two engines disagreeing about a state the student did nothing wrong to reach.
 */
const COMMANDS = [
  "printf 'locked = 1\\n' >> shared/app.conf",
  "chmod 640 shared/app.conf",
  "rm stale.conf",
  "mkdir -p logs",
];

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ontrak-sim-"));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  disposeAllSandboxes();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/*  The exit criterion                                                        */
/* -------------------------------------------------------------------------- */

test("container: a scenario authored for real bash grades exactly as it does simulated", () => {
  // ---- The simulated engine, which is what every scenario has always used --------------
  const simulatedState = createInitialState(SCENARIO);
  const simulatedDriver = createDriver("bash", { user: SCENARIO.machine.user });
  simulatedDriver.boot?.(simulatedState);
  for (const command of COMMANDS) simulatedDriver.run(command, simulatedState);
  const simulatedReport = gradeAttempt(SCENARIO, simulatedState, 0);

  // ---- A real bash in a sandbox --------------------------------------------------------
  const sandbox = new ProcessSandbox({ scratch: scratch() });
  const containerDriver = createContainerDriver({ engine: "bash", sandbox, user: SCENARIO.machine.user });
  const containerState = createInitialState(SCENARIO);
  containerDriver.boot?.(containerState);
  for (const command of COMMANDS) containerDriver.run(command, containerState);
  const containerReport = gradeAttempt(SCENARIO, containerState, 0);
  sandbox.dispose();

  // Every check passes in the simulation, so the comparison is only interesting if every
  // check also passes under real bash — otherwise "they agree" would be "both failed".
  assert.equal(simulatedReport.percent, 100, "the bundled checks should all pass in the simulated engine");
  assert.equal(containerReport.percent, 100, "the same checks must pass under real bash");
  assert.deepEqual(
    containerReport.results.map((result) => [result.checkId, result.passed]),
    simulatedReport.results.map((result) => [result.checkId, result.passed]),
    "the two reports must agree check for check, in the same order",
  );
  assert.equal(containerReport.maxScore, simulatedReport.maxScore);
});

test("container: the real filesystem is what grades, including what bash changed", () => {
  const root = scratch();
  const sandbox = new ProcessSandbox({ scratch: root });
  const driver = createContainerDriver({ engine: "bash", sandbox, user: "student" });
  const state = createInitialState(SCENARIO);
  driver.boot?.(state);

  // Seeding put the scenario's files into the sandbox, so they are in the machine too.
  assert.ok(state.vfs[`${HOME}/shared/app.conf`], "the seeded config should be harvested at boot");
  assert.equal(state.vfs[`${HOME}/shared/app.conf`]?.content, "workers = 4\n");

  assert.equal(driver.run("chmod 640 shared/app.conf", state).exitCode, 0);
  assert.equal(state.vfs[`${HOME}/shared/app.conf`]?.mode, 0o640, "the permission change is real and is read back from the sandbox");

  assert.equal(driver.run("rm stale.conf", state).exitCode, 0);
  assert.equal(state.vfs[`${HOME}/stale.conf`], undefined, "a deleted file is absent, not stale");
  assert.equal(existsSync(join(root, "stale.conf")), false, "and it is gone from the sandbox itself");

  // A real command's real failure is reported as one.
  const missing = driver.run("cat nope.conf", state);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /No such file or directory/);

  // The machine's bookkeeping keeps the shape the rest of the product expects.
  assert.deepEqual(
    state.machine.history.map((entry) => entry.input),
    ["chmod 640 shared/app.conf", "rm stale.conf", "cat nope.conf"],
  );
  assert.equal(state.machine.history[2].cwd, HOME);
  assert.equal(state.machine.exitCode, 1);
  sandbox.dispose();
});

test("container: cd and pwd belong to the driver, and a failed cd changes nothing", () => {
  const sandbox = new ProcessSandbox({ scratch: scratch() });
  const driver = createContainerDriver({ engine: "bash", sandbox, user: "student" });
  const state = createInitialState(SCENARIO);
  driver.boot?.(state);

  assert.equal(driver.run("cd shared", state).exitCode, 0);
  assert.equal(state.machine.cwd, `${HOME}/shared`);

  // `pwd` answers from the machine, so it never prints the sandbox's own root.
  assert.equal(driver.run("pwd", state).stdout, `${HOME}/shared\n`);

  // A real command runs in the directory the student is standing in. A file created with
  // `touch` is zero bytes long, which is the case that catches a `stat` reading of `%F`
  // that only knows the words "regular file".
  assert.equal(driver.run("touch marker.txt", state).exitCode, 0);
  assert.ok(state.vfs[`${HOME}/shared/marker.txt`], "a just-created empty file must be harvested as a file");

  const failed = driver.run("cd nowhere", state);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr ?? "", /No such file or directory/);
  assert.equal(state.machine.cwd, `${HOME}/shared`, "a failed cd must leave the student where they were");

  assert.equal(driver.run("cd ~", state).exitCode, 0);
  assert.equal(state.machine.cwd, HOME);
  assert.deepEqual(state.machine.env.OLDPWD, `${HOME}/shared`);

  // `cd -` goes back, and prints where it landed, the way bash does.
  const back = driver.run("cd -", state);
  assert.equal(back.exitCode, 0);
  assert.equal(back.stdout, `${HOME}/shared\n`);
  assert.equal(state.machine.cwd, `${HOME}/shared`);

  sandbox.dispose();
});

/* -------------------------------------------------------------------------- */
/*  Planning a command line (pure)                                            */
/* -------------------------------------------------------------------------- */

test("plan: everything a student types goes to the sandbox, except what cannot", () => {
  const state = createInitialState(SCENARIO);

  assert.deepEqual(planCommand("", state, HOME), { kind: "local", result: { stdout: "", stderr: "", exitCode: 0 } });
  assert.equal(planCommand("clear", state, HOME).kind, "local");
  assert.equal(planCommand("exit", state, HOME).kind, "local");
  assert.deepEqual(planCommand("pwd", state, HOME), {
    kind: "local",
    result: { stdout: `${HOME}\n`, stderr: "", exitCode: 0 },
  });

  // Pipes, redirection and chaining are the sandbox's job, not the driver's.
  for (const line of ["ls -l | head -3", "echo x > y", "make all && echo done", "for i in 1 2; do echo $i; done"]) {
    const plan = planCommand(line, state, HOME);
    assert.equal(plan.kind, "sandbox");
    if (plan.kind === "sandbox") assert.equal(plan.command, line);
  }

  const up = planCommand("cd ..", state, HOME);
  assert.equal(up.kind, "cd");
  if (up.kind === "cd") assert.equal(up.cwd, "/home");

  // `cd -` needs a remembered directory, and says so when there is none.
  const dash = planCommand("cd -", state, HOME);
  assert.equal(dash.kind, "cd");
  if (dash.kind === "cd") assert.match(dash.error ?? "", /OLDPWD not set/);
  const remembered = planCommand("cd -", state, HOME, "/etc");
  assert.equal(remembered.kind, "cd");
  if (remembered.kind === "cd") {
    assert.equal(remembered.cwd, "/etc");
    assert.equal(remembered.print, true);
  }
});

test("plan: a path resolves the way bash resolves it", () => {
  assert.equal(resolveSandboxPath("/home/student", "shared/app.conf", HOME, HOME), `${HOME}/shared/app.conf`);
  assert.equal(resolveSandboxPath("/home/student", "/etc/hosts", HOME, HOME), "/etc/hosts");
  assert.equal(resolveSandboxPath("/home/student", "~/notes.txt", HOME, HOME), `${HOME}/notes.txt`);
  assert.equal(resolveSandboxPath("/home/student", "~", HOME, HOME), HOME);
  assert.equal(resolveSandboxPath("/home/student", "../root", HOME, HOME), "/home/root");
  assert.equal(resolveSandboxPath("/home/student", "/", HOME, HOME), "/");
  assert.equal(resolveSandboxPath("/home/student", "./.././x", HOME, HOME), "/home/x");
});

test("paths: the machine's namespace maps onto a sandbox root and back", () => {
  assert.equal(sandboxPathFor("/sandbox", "/home/student"), "/sandbox/home/student");
  assert.equal(sandboxPathFor("/sandbox/", "/home/student"), "/sandbox/home/student");
  assert.equal(sandboxPathFor("/", "/home/student"), "/home/student");
  assert.equal(sandboxPathFor("/sandbox", "/"), "/sandbox");

  assert.equal(harvestPathToVfs("./home/student/x"), "/home/student/x");
  assert.equal(harvestPathToVfs("home/student/x"), "/home/student/x");
  assert.equal(harvestPathToVfs("../etc/passwd"), null, "a step upward is refused, not normalised away");
  assert.equal(harvestPathToVfs("./"), null);
});

/* -------------------------------------------------------------------------- */
/*  The harvest (pure)                                                        */
/* -------------------------------------------------------------------------- */

/** One harvest record, printed exactly the way the script prints it. */
function record(type: string, kind: string, mode: string, owner: string, path: string, content = ""): string {
  const payload = content === "" ? "" : Buffer.from(content, "utf8").toString("base64");
  const size = Buffer.byteLength(content, "utf8");
  return [type, `${kind}|${mode}|${owner}|${owner}|1700000000|${size}`, path, payload].join("\0") + "\0";
}

test("harvest: records become virtual entries, and junk is reported rather than guessed at", () => {
  const output =
    record("d", "directory", "755", "root", "home") +
    record("f", "regular file", "640", "student", "home/student/app.conf", "workers = 4\n") +
    record("l", "symbolic link", "777", "root", "home/student/current");

  const parsed = parseHarvest(output);
  assert.deepEqual(Object.keys(parsed.vfs).sort(), ["/home", "/home/student/app.conf", "/home/student/current"]);
  assert.equal(parsed.vfs["/home/student/app.conf"].content, "workers = 4\n");
  assert.equal(parsed.vfs["/home/student/app.conf"].mode, 0o640);
  assert.equal(parsed.vfs["/home/student/app.conf"].owner, "student");
  assert.equal(parsed.vfs["/home/student/app.conf"].type, "file");
  assert.equal(parsed.vfs["/home"].type, "dir");
  assert.equal(parsed.vfs["/home"].mtime, 1700000000000, "the sandbox's own mtime is kept, in milliseconds");
  assert.equal(parsed.vfs["/home/student/current"].type, "link");
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.truncated, []);

  // An empty sandbox is an empty machine, not an error.
  assert.deepEqual(parseHarvest("").vfs, {});

  // A record cut in half is dropped with a reason: applying three of four fields would put
  // a file at a path nobody wrote.
  const truncated = parseHarvest(record("f", "regular file", "644", "root", "x") + "f\0regular file|644");
  assert.equal(truncated.vfs["/x"].content, "");
  assert.ok(truncated.issues.some((issue) => /truncated/.test(issue.reason)));

  // Something that is not a file, a directory or a link is reported, not skipped silently.
  const odd = parseHarvest(record("o", "socket", "755", "root", "run/app.sock"));
  assert.deepEqual(odd.vfs, {});
  assert.equal(odd.issues.length, 1);

  // Paths outside the sandbox never become machine paths.
  const escaping = parseHarvest(record("f", "regular file", "644", "root", "../outside"));
  assert.deepEqual(escaping.vfs, {});
  assert.equal(escaping.issues.length, 1);
});

test("harvest: a file cut off at the limit is named as one", () => {
  const output = record("f", "regular file", "644", "root", "home/student/big.log", "x".repeat(5000));
  const whole = parseHarvest(output);
  assert.equal(whole.vfs["/home/student/big.log"]?.content?.length, 5000);
  assert.deepEqual(whole.truncated, []);

  // A record whose size field is larger than the content that arrived was cut off, and the
  // author needs to know which file it was.
  const cut = output.replace("|5000\0", "|900000\0");
  const short = parseHarvest(cut);
  assert.deepEqual(short.truncated, ["/home/student/big.log"]);

  // The script is what enforces the cap, and it walks with -print0 so a hostile filename
  // cannot split a record.
  const script = harvestScript("/sandbox", 1024);
  assert.match(script, /head -c 1024/);
  assert.match(script, /find \. -mindepth 1 -maxdepth 32 -print0/);
  assert.match(script, /read -r -d ''/);
  assert.match(script, /stat -c/);
  assert.match(script, /^root='\/sandbox'$/m);
});

test("harvest: a filename with a space, a quote and a newline survives the round trip", () => {
  const nasty = "home/student/a file's name\nsecond line.txt";
  const parsed = parseHarvest(record("f", "regular file", "644", "root", nasty, "hi"));
  assert.equal(parsed.vfs[`/home/student/a file's name\nsecond line.txt`].content, "hi");
  assert.equal(parsed.issues.length, 0);
});

/* -------------------------------------------------------------------------- */
/*  Seeding (pure)                                                            */
/* -------------------------------------------------------------------------- */

test("seed: content is written byte-for-byte, never interpolated into the script", () => {
  const state = createInitialState(SCENARIO);
  const script = seedScript(state.vfs, "/sandbox");

  assert.match(script, /^root='\/sandbox'$/m);
  assert.match(script, /rm -rf "\$root"/);
  // The config's content travels base64-encoded, so a `$`, a quote or a backtick in a file
  // cannot become part of the script that writes it.
  assert.match(script, new RegExp(Buffer.from("workers = 4\n").toString("base64")));
  assert.match(script, /chmod 644 'home\/student\/shared\/app.conf'/);
  assert.match(script, /mkdir -p 'home\/student\/shared'/);
  assert.match(script, /base64 -d > 'home\/student\/shared\/app.conf'/);

  // Directories are created before the files inside them, so a file is never written into a
  // directory that does not exist yet.
  const sharedAt = script.indexOf("mkdir -p 'home/student/shared'");
  const fileAt = script.indexOf("base64 -d > 'home/student/shared/app.conf'");
  assert.ok(sharedAt > 0 && fileAt > sharedAt);

  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

/* -------------------------------------------------------------------------- */
/*  The container backend                                                     */
/* -------------------------------------------------------------------------- */

test("docker: the sandbox is disposable, unprivileged and capped", () => {
  const args = dockerCreateArgs({ image: "debian:bookworm-slim", name: "ontrak-sandbox-abc" });
  assert.deepEqual(args.slice(0, 3), ["create", "--name", "ontrak-sandbox-abc"]);
  assert.ok(args.includes("--network") && args.includes("none"), "no network");
  assert.ok(args.includes("--cap-drop") && args.includes("ALL"), "no capabilities");
  assert.ok(args.includes("--security-opt") && args.includes("no-new-privileges"));
  assert.ok(args.includes("--memory") && args.includes("512m"));
  assert.ok(args.includes("--cpus") && args.includes("1"));
  assert.ok(args.includes("--pids-limit") && args.includes("256"));
  assert.ok(args.includes("--label"));
  assert.ok(args.includes("debian:bookworm-slim"));
  assert.ok(args.includes("sleep") && args.includes("infinity"), "the container idles so exec has something to talk to");

  const capped = dockerCreateArgs({
    image: "debian:bookworm-slim",
    name: "x",
    limits: { memory: "1g", cpus: "2", pids: 64 },
  });
  assert.ok(capped.includes("1g") && capped.includes("2") && capped.includes("64"));
});

test("docker: the driver talks to the daemon in the shape docker expects", () => {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const sandbox = new DockerSandbox({
    image: "debian:bookworm-slim",
    name: "ontrak-sandbox-attempt",
    run: (args, timeoutMs) => {
      calls.push({ args, timeoutMs });
      if (args[0] === "exec" && args.some((arg) => arg.includes("find ."))) {
        return { stdout: record("f", "regular file", "644", "root", "home/student/x", "hello"), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  const driver = createContainerDriver({ engine: "bash", sandbox, user: "student" });
  const state = createInitialState(SCENARIO);
  driver.boot?.(state);

  // Remove anything left over, create capped, start, prove the image has a shell, then seed.
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.args[0]),
    ["rm", "create", "start"],
  );
  const probe = calls[3];
  assert.equal(probe.args[0], "exec");
  assert.equal(probe.args[probe.args.length - 1], "command -v bash");
  const seed = calls.find((call) => call.args[0] === "exec" && call.args[call.args.length - 1].includes("base64 -d"));
  assert.ok(seed, "the filesystem is seeded through exec");
  assert.deepEqual(seed!.args.slice(0, 5), ["exec", "-i", "-w", "/", "ontrak-sandbox-attempt"]);
  assert.deepEqual(seed!.args.slice(5, 7), ["bash", "-lc"]);
  assert.match(seed!.args[7], /^root='\/sandbox'/, "the seed is a script, not a list of arguments");

  // A command runs in the container directory matching the machine's working directory.
  // (The harvest that follows it runs from the container's own `/`, which is why this looks
  // for the command by its argument rather than taking the most recent call.)
  assert.equal(driver.run("echo hello", state).exitCode, 0);
  const run = calls.find((call) => call.args[call.args.length - 1] === "echo hello");
  assert.ok(run, "the command itself must reach docker exec");
  assert.deepEqual(run!.args.slice(0, 4), ["exec", "-i", "-w", sandboxPathFor("/sandbox", HOME)]);

  // And the harvest is read back in, so the machine reflects the container.
  assert.equal(state.vfs["/home/student/x"].content, "hello");
});

test("docker: an image with no bash is named as the problem, not discovered later", () => {
  const sandbox = new DockerSandbox({
    image: "node:20-alpine",
    name: "ontrak-sandbox-no-bash",
    run: (args) =>
      args[0] === "exec" && args[args.length - 1] === "command -v bash"
        ? { stdout: "", stderr: 'exec: "bash": executable file not found in $PATH', exitCode: 127 }
        : { stdout: "", stderr: "", exitCode: 0 },
  });
  assert.throws(
    () => sandbox.reset(createInitialState(SCENARIO).vfs),
    /cannot run bash.*debian:bookworm-slim/s,
  );
  // The failure is not cached as "started": a corrected image would be tried again.
  assert.throws(() => sandbox.reset(createInitialState(SCENARIO).vfs), /cannot run bash/);
});

test("docker: honours the time limit it is given", () => {
  const timeouts: number[] = [];
  const sandbox = new DockerSandbox({
    image: "debian:bookworm-slim",
    name: "t",
    run: (_args, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  sandbox.exec("true", "/", 4321);
  assert.deepEqual(timeouts, [4321]);
});

test("engines: only bash has an honest sandbox in this release", () => {
  assert.deepEqual(sandboxShellFor("bash"), { program: "bash", flags: ["-lc"] });
  assert.equal(sandboxShellFor("powershell"), null);
  assert.equal(sandboxShellFor("office"), null);
  assert.throws(() => createContainerDriver({ engine: "powershell", sandbox: new ProcessSandbox({ scratch: scratch() }) }));
});

/* -------------------------------------------------------------------------- */
/*  Fidelity: what was asked for, what can be delivered                       */
/* -------------------------------------------------------------------------- */

test("fidelity: a definition that names none is simulated", () => {
  assert.equal(normalizeFidelity(undefined), "simulated");
  assert.equal(normalizeFidelity("simulated"), "simulated");
  assert.equal(normalizeFidelity("container"), "container");
  assert.equal(normalizeFidelity("nonsense"), "simulated");
  assert.equal(normalizeFidelity(null, "container"), "container");
});

test("fidelity: the sandbox is configuration, and the local backend is opt-in twice over", () => {
  const none = sandboxConfigFromEnv({});
  assert.equal(none.backend, undefined);
  assert.equal(sandboxAvailability(none).available, false);
  assert.match(sandboxAvailability(none).reason, /ONTRAK_SANDBOX_BACKEND/);

  // Naming the backend is not enough: the local backend runs real commands on the app
  // server, so it also has to be allowed.
  const notAllowed = sandboxConfigFromEnv({ ONTRAK_SANDBOX_BACKEND: "process" });
  assert.equal(notAllowed.backend, undefined);
  assert.equal(sandboxAvailability(notAllowed).available, false);

  const allowed = sandboxConfigFromEnv({ ONTRAK_SANDBOX_BACKEND: "process", ONTRAK_SANDBOX_ALLOW_PROCESS: "1" });
  assert.equal(allowed.backend, "process");
  assert.equal(sandboxAvailability(allowed).available, true);

  const docker = sandboxConfigFromEnv({ ONTRAK_SANDBOX_BACKEND: "Docker", ONTRAK_SANDBOX_IMAGE: "my/image:1" });
  assert.equal(docker.backend, "docker");
  assert.equal(docker.image, "my/image:1");
  assert.equal(sandboxAvailability(docker).available, true);
  assert.equal(sandboxConfigFromEnv({}).image, "debian:bookworm-slim");

  // An unknown backend is no backend, and a root that is not absolute falls back.
  assert.equal(sandboxConfigFromEnv({ ONTRAK_SANDBOX_BACKEND: "kubernetes" }).backend, undefined);
  assert.equal(sandboxConfigFromEnv({}).root, "/sandbox");
  assert.equal(sandboxConfigFromEnv({ ONTRAK_SANDBOX_ROOT: "sandbox/" }).root, "/sandbox");
  assert.equal(sandboxConfigFromEnv({ ONTRAK_SANDBOX_ROOT: "/scratch//" }).root, "/scratch");
});

test("fidelity: asking for a sandbox that is not there falls back, and says so", () => {
  const absent = sandboxAvailability(sandboxConfigFromEnv({}));
  const fellBack = resolveFidelity("container", absent);
  assert.equal(fellBack.fidelity, "simulated");
  assert.equal(fellBack.fellBack, true);
  assert.match(fellBack.reason, /real shell/);
  assert.match(fellBack.reason, /simulated terminal/);

  const present = sandboxAvailability(sandboxConfigFromEnv({ ONTRAK_SANDBOX_BACKEND: "docker" }));
  const kept = resolveFidelity("container", present);
  assert.equal(kept.fidelity, "container");
  assert.equal(kept.fellBack, false);
  assert.equal(kept.reason, "");

  // A simulated scenario never falls back, whatever the deployment has.
  assert.deepEqual(resolveFidelity("simulated", absent), { fidelity: "simulated", fellBack: false, reason: "" });

  assert.equal(satisfiesFidelity("simulated", absent), true);
  assert.equal(satisfiesFidelity("container", absent), false);
  assert.equal(satisfiesFidelity("container", present), true);
});

test("fidelity: a sandbox-only scenario is not offered where there is no sandbox", () => {
  const scenario = { id: "s1", platform: "LINUX" as const, published: true, software: [] };

  const simulated = evaluateScenario(scenario, ALL_PLATFORMS_ENABLED);
  assert.equal(simulated.available, true, "a scenario written before fidelity existed is unaffected");

  const sandboxOnly = evaluateScenario({ ...scenario, fidelity: "container" as const }, ALL_PLATFORMS_ENABLED);
  assert.equal(sandboxOnly.available, false);
  assert.equal(sandboxOnly.blockers[0].kind, "sandbox");
  assert.match(sandboxOnly.blockers[0].message, /real shell/);

  const withSandbox = evaluateScenario(
    { ...scenario, fidelity: "container" as const },
    { ...ALL_PLATFORMS_ENABLED, sandbox: { available: true, reason: "A docker sandbox is available." } },
  );
  assert.equal(withSandbox.available, true);

  assert.equal(NO_SANDBOX.available, false);
});

/* -------------------------------------------------------------------------- */
/*  The author's side: validation                                             */
/* -------------------------------------------------------------------------- */

test("validate: container fidelity is allowed for bash, and reported honestly", () => {
  const withSandbox = { ONTRAK_SANDBOX_BACKEND: "docker" };

  const ok = validateDefinition(SCENARIO, {});
  assert.equal(ok.ok, true, "a container-fidelity bash scenario is a valid definition");
  assert.equal(ok.fidelity, "container");
  assert.equal(ok.sandbox.available, false);
  assert.ok(
    ok.issues.some((issue) => issue.level === "warning" && issue.field === "fidelity" && /will not be offered/.test(issue.message)),
    "the author is told this deployment cannot offer it yet",
  );
  assert.ok(ok.issues.some((issue) => /dry run above ran in the simulated engine/.test(issue.message)));

  const available = validateDefinition(SCENARIO, withSandbox);
  assert.equal(available.sandbox.available, true);
  assert.equal(
    available.issues.some((issue) => /will not be offered/.test(issue.message)),
    false,
  );

  // PowerShell has no honest sandbox here, so it is an error rather than a surprise.
  const powershell = validateDefinition({ ...SCENARIO, platform: "WINDOWS", engine: "powershell" }, withSandbox);
  assert.equal(powershell.ok, false);
  assert.ok(
    powershell.issues.some(
      (issue) => issue.level === "error" && issue.field === "fidelity" && /only available for the "bash" engine/.test(issue.message),
    ),
  );

  // A definition that names no fidelity keeps validating exactly as it did.
  const { fidelity: _omitted, ...withoutFidelity } = SCENARIO;
  const plain = validateDefinition(withoutFidelity, {});
  assert.equal(plain.fidelity, "simulated");
  assert.equal(plain.ok, true);
  assert.equal(
    plain.issues.some((issue) => issue.field === "fidelity"),
    false,
  );
});

/* -------------------------------------------------------------------------- */
/*  The browser's end: the proxy                                              */
/* -------------------------------------------------------------------------- */

test("proxy: the server's machine is adopted, and the result passed through", async () => {
  const simulated = createDriver("bash", { user: "student" });
  const state = createInitialState(SCENARIO);
  const remote = createInitialState(SCENARIO);
  remote.machine.cwd = "/etc";
  remote.meta.revision = 7;
  remote.machine.history = [{ index: 1, input: "ls", stdout: "", stderr: "", exitCode: 0, cwd: "/etc", at: 0 }];
  remote.machine.notes = ["kept"];

  const driver = createProxyDriver({
    engine: "bash",
    platform: "LINUX",
    fallback: simulated,
    bridge: { command: async () => ({ ok: true, result: { stdout: "done\n", stderr: "", exitCode: 0 }, state: remote }) },
  });

  assert.ok(driver.runAsync, "the console needs an async driver to await");
  const result = await driver.runAsync!("ls", state);
  assert.equal(result.stdout, "done\n");
  assert.equal(state.machine.cwd, "/etc", "the machine the server produced is adopted");
  assert.equal(state.meta.revision, 7);
  assert.equal(state.machine.history.length, 1);

  // The prompt and banner are the simulated driver's, so a sandboxed attempt looks the same.
  assert.equal(driver.prompt(state), simulated.prompt(state));
});

test("proxy: a sandbox that stops answering falls back once, and the attempt continues", async () => {
  const simulated = createDriver("bash", { user: "student" });
  const state = createInitialState(SCENARIO);
  let refusals = 0;
  const notes: string[] = [];

  const driver = createProxyDriver({
    engine: "bash",
    platform: "LINUX",
    fallback: simulated,
    onFallback: (_reason, message) => notes.push(message),
    bridge: {
      command: async () => {
        refusals += 1;
        return { ok: false, error: "The sandbox could not be started." };
      },
    },
  });

  // The simulated engine answers, so the student's next line still works.
  const created = await driver.runAsync!("mkdir -p later", state);
  assert.equal(created.exitCode, 0);
  assert.ok(state.vfs["/home/student/later"], "the fallback driver really ran the command");

  await driver.runAsync!("mkdir -p later2", state);
  assert.equal(refusals, 1, "once it has fallen back, further lines do not keep asking");
  assert.equal(notes.length, 1, "the student is told once, not once per command");
  assert.match(notes[0], /simulated terminal/);
  assert.equal(
    fallbackMessage("Nope."),
    "Nope. The rest of this attempt runs in the simulated terminal, and every check still grades normally.",
  );

  // A driver whose only entry point is async refuses the synchronous one rather than
  // quietly running something else.
  assert.throws(() => driver.run("ls", state));
});

test("proxy: a bridge that throws is a fallback, not a broken attempt", async () => {
  const simulated = createDriver("bash", { user: "student" });
  const state = createInitialState(SCENARIO);
  const notes: string[] = [];
  const driver = createProxyDriver({
    engine: "bash",
    platform: "LINUX",
    fallback: simulated,
    onFallback: (_reason, message) => notes.push(message),
    bridge: {
      command: async () => {
        throw new Error("network down");
      },
    },
  });
  const result = await driver.runAsync!("echo alive", state);
  assert.equal(result.stdout, "alive");
  assert.match(notes[0], /network down/);
});

test("factory: the driver a scenario gets matches the fidelity it declares", () => {
  const bridge = { command: async () => ({ ok: true }) };
  const sandboxed = createScenarioDriver(SCENARIO, { bridge });
  assert.ok(sandboxed.runAsync, "container fidelity with a bridge is the proxy");

  const noBridge = createScenarioDriver(SCENARIO, {});
  assert.equal(noBridge.runAsync, undefined, "no bridge means the simulated engine, decided up front");

  const plain = createScenarioDriver({ ...SCENARIO, fidelity: "simulated" }, { bridge });
  assert.equal(plain.runAsync, undefined);
});

/* -------------------------------------------------------------------------- */
/*  The server's end: sessions                                                */
/* -------------------------------------------------------------------------- */

test("sandbox: an attempt gets one sandbox, commands run in it, and it is cleaned up", () => {
  const env = { ONTRAK_SANDBOX_BACKEND: "process", ONTRAK_SANDBOX_ALLOW_PROCESS: "1" };
  assert.equal(sandboxStatus(env).available, true);

  const state = createInitialState(SCENARIO);
  const first = runSandboxCommand("attempt-1", SCENARIO, "chmod 640 shared/app.conf", state, env);
  assert.ok(first.ok, first.ok ? "" : first.error);
  if (first.ok) {
    assert.equal(first.result.exitCode, 0);
    assert.equal(first.state.vfs[`${HOME}/shared/app.conf`].mode, 0o640);
  }
  assert.equal(openSessionCount(), 1, "one attempt, one sandbox");

  // The same session answers the next command, so the working directory persists. Both of
  // these are the driver's own: `cd` changes where the next line runs, and `pwd` answers
  // from the machine, so neither prints the sandbox's root.
  assert.ok(runSandboxCommand("attempt-1", SCENARIO, "cd shared", state, env).ok);
  const second = runSandboxCommand("attempt-1", SCENARIO, "pwd", state, env);
  assert.ok(second.ok, second.ok ? "" : second.error);
  if (second.ok) {
    assert.equal(second.result.stdout, `${HOME}/shared\n`);
    // And a real command really does run there.
    const created = runSandboxCommand("attempt-1", SCENARIO, "touch from-sandbox.txt", state, env);
    assert.ok(created.ok);
    if (created.ok) assert.ok(created.state.vfs[`${HOME}/shared/from-sandbox.txt`]);
  }

  // A second attempt gets its own machine.
  runSandboxCommand("attempt-2", SCENARIO, "rm stale.conf", createInitialState(SCENARIO), env);
  assert.equal(openSessionCount(), 2);

  // Notes belong to the student, so a harvest never touches them.
  const withNotes = structuredClone(state);
  withNotes.machine.notes = ["the reviewer signed off on 640"];
  const third = runSandboxCommand("attempt-1", SCENARIO, "true", withNotes, env);
  assert.ok(third.ok);
  if (third.ok) assert.deepEqual(third.state.machine.notes, ["the reviewer signed off on 640"]);

  disposeAllSandboxes();
  assert.equal(openSessionCount(), 0, "nothing is left running");
});

test("sandbox: with no sandbox configured, the command is refused with a reason", () => {
  disposeAllSandboxes();
  const state = createInitialState(SCENARIO);
  const outcome = runSandboxCommand("attempt-3", SCENARIO, "ls", state, {});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /ONTRAK_SANDBOX_BACKEND/);
  assert.equal(openSessionCount(), 0);
});
