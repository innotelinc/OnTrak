/**
 * The lab's CLI, run as an operator runs it.
 *
 * A script is the one kind of code a unit test cannot reach from the inside: the thing that
 * breaks is the seam between `process.argv` and the command, and a test that imported a
 * function would not touch it. So this spawns the real entry point (`npm run lab -- …`'s
 * equivalent) and asserts on what comes back — output and, where it matters, the exit code,
 * because a doctor that cannot fail is worse than none.
 *
 * The commands chosen are the ones that need no host, no database and no settings: the
 * catalogue reader, the primitive list, the usage text, and the three commands the port
 * deliberately retired. What each of them proves is stated with it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const CLI = "scripts/lab/cli.ts";

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with extra environment, and keep its exit code whether it succeeded or not. */
function runEnv(extra: Record<string, string>, ...args: string[]): Run {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", ...extra },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Run the CLI and keep its exit code, whether it succeeded or not. */
function run(...args: string[]): Run {
  return runEnv({}, ...args);
}

/**
 * The same, against the ported in-memory range.
 *
 * `ONTRAK_DEMO__ENABLED` is the one setting that opens a whole lab with no hypervisor, no
 * database and no secret, which is what lets a test reach the store and the ticket code
 * from a shell — the same door a laptop uses.
 */
function runDemo(...args: string[]): Run {
  return runEnv({ ONTRAK_DEMO__ENABLED: "1" }, ...args);
}

test("cli: the usage text lists the commands, and asks for one", () => {
  const listed = run("help");
  assert.equal(listed.status, 0);
  for (const command of ["doctor", "session", "pool", "template", "reap", "demo run", "results"]) {
    assert.match(listed.stdout, new RegExp(command.replace(/ /g, "\\s")), `usage should name ${command}`);
  }
  // The write-up's five actions, as the Python's own usage line listed them: the port
  // once advertised the three it had implemented, which is how an operator learns the
  // shape of a command that is not there.
  assert.match(listed.stdout, /ticket form\|show\|save\|grade\|complete/);

  // No command at all is a usage error, not a silent success.
  assert.equal(run().status, 2);
  assert.equal(run("nonsense").status, 2);
});

test("cli: the scenario catalogue reads the shipped tree, and validates it", () => {
  const listed = run("scenario", "list");
  assert.equal(listed.status, 0);
  // The 14 real lab scenarios, from the tree on disk — the same loader the pages use.
  assert.match(listed.stdout, /net-dns-failure/);
  assert.match(listed.stdout, /linux-ownership-chown-repair/);
  assert.match(listed.stdout, /^id\s+platform\s+difficulty\s+minutes\s+ticket$/m);

  const validated = run("scenario", "validate");
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  assert.match(validated.stdout, /all 14 scenarios validate/);
});

test("cli: the fault primitives and the catalogue are readable without a host", () => {
  const primitives = run("generate", "list");
  assert.equal(primitives.status, 0);
  assert.match(primitives.stdout, /^id\s+category\s+objectives$/m);

  const catalog = run("catalog", "groups");
  assert.equal(catalog.status, 0);

  const lessons = run("lesson", "list");
  assert.equal(lessons.status, 0);
  assert.match(lessons.stdout, /^id\s+platform\s+difficulty\s+minutes\s+commands$/m);
});

/*
 * ── the three commands the port retired ────────────────────────────────────
 *
 * An operator following the Python's own documentation will type these. A script that
 * answered "unknown command" would send them looking for a bug; each of these names the
 * decision that replaced it, and exits with the usage code so a script around them can tell
 * "wrong command" from "the command failed".
 */

test("cli: the retired commands refuse with the reason that replaced them", () => {
  const user = run("user", "list");
  assert.equal(user.status, 2);
  assert.match(user.stderr, /accounts are the family's/);
  assert.match(user.stderr, /§3\/C2/);

  const serve = run("serve");
  assert.equal(serve.status, 2);
  assert.match(serve.stderr, /this app is the server/);
  assert.match(serve.stderr, /\/lab/, "and it says where the lab is served instead");

  const image = run("image", "build", "win11-24h2");
  assert.equal(image.status, 2);
  assert.match(image.stderr, /lab host/);
});

/*
 * ── the session and write-up surface, against a lab that needs no host ──────
 *
 * `demo run` proves the flow end to end inside one process; these two prove the *seam* an
 * operator types, which is the thing a script can get wrong while every module under it is
 * right. Both were wrong here once: `session start` filed a row and never stood a machine
 * up, so the `check` that followed had nothing to grade, and the write-up advertised two
 * actions it did not have.
 */

test("cli: `session start` allocates the machine, not just the row", () => {
  const started = runDemo(
    "session",
    "start",
    "--student",
    "cli-test@example.com",
    "--scenario",
    "linux-sudo-delegation",
  );
  assert.equal(started.status, 0, started.stdout + started.stderr);
  // `allocate`, not `createSession`: an instance, an address and a limit come back, which is
  // what the next command an operator types (`check`) needs in order to have anything to do.
  assert.match(started.stdout, /ready on \S+ \(\d+\.\d+\.\d+\.\d+\) for \d+ minutes/);

  // The student is the one argument with no default: a session is somebody's.
  const unnamed = runDemo("session", "start", "--scenario", "linux-sudo-delegation");
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /pass --student/);
});

test("cli: the write-up reads its form, and refuses what it cannot answer", () => {
  const form = runDemo("ticket", "form", "--scenario", "linux-sudo-delegation");
  assert.equal(form.status, 0, form.stdout + form.stderr);
  assert.match(form.stdout, /% of the grade, pass mark \d+%/);
  assert.match(form.stdout, /root_cause \(textarea, required, 25 pts\): Root cause/);

  // A missing scenario is a usage error (2), not the exception an unknown id raises — the
  // same distinction the Python drew, and the reason a wrapper script can tell them apart.
  const unasked = runDemo("ticket", "form");
  assert.equal(unasked.status, 2);
  assert.match(unasked.stderr, /specify --scenario/);

  const unknown = runDemo("ticket", "form", "--scenario", "no-such-scenario");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no-such-scenario/);

  // Acting on a session that does not exist is refused before any write, by either half.
  const nothing = runDemo("ticket", "show", "--session-id", "4242");
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr, /no session 4242/);
});

test("cli: `demo serve` points at the app, rather than starting a second server", () => {
  // The Python's `demo serve` was uvicorn. In the port, demo mode is a setting on this app
  // plus the in-app door, and the message is the migration instruction.
  const served = run("demo", "serve");
  assert.equal(served.status, 2);
  assert.match(served.stderr, /ONTRAK_DEMO__ENABLED/);
  assert.match(served.stderr, /ONTRAK_LAB_IN_APP/);
  assert.match(served.stderr, /npm start/);
});
