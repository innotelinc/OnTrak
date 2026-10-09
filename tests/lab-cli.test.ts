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

/** Run the CLI and keep its exit code, whether it succeeded or not. */
function run(...args: string[]): Run {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("cli: the usage text lists the commands, and asks for one", () => {
  const listed = run("help");
  assert.equal(listed.status, 0);
  for (const command of ["doctor", "session", "pool", "template", "reap", "demo run", "results"]) {
    assert.match(listed.stdout, new RegExp(command.replace(/ /g, "\\s")), `usage should name ${command}`);
  }

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

test("cli: `demo serve` points at the app, rather than starting a second server", () => {
  // The Python's `demo serve` was uvicorn. In the port, demo mode is a setting on this app
  // plus the in-app door, and the message is the migration instruction.
  const served = run("demo", "serve");
  assert.equal(served.status, 2);
  assert.match(served.stderr, /ONTRAK_DEMO__ENABLED/);
  assert.match(served.stderr, /ONTRAK_LAB_IN_APP/);
  assert.match(served.stderr, /npm start/);
});
