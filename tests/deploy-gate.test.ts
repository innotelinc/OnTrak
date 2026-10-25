/**
 * A deploy may not end before the capture it promises.
 *
 * `make all-up` used to finish on "containers started", which is the one thing the
 * capture crash did not disturb: REA's MCP server died with SIGSEGV on its first
 * `capture_process_scenario` while the g0dm0d3 container reported healthy, so a
 * deploy could be green over a stack where every capture failed. `scripts/deploy.sh`
 * now runs one real turn through Genie's agent after the stack is up, and this file
 * pins the decisions it makes around that turn.
 *
 * What is checked here is the gate's *shape*, not the capture: the deploy has to
 * stop before touching anything when it has no account to attribute the turn to,
 * treat a failed capture differently from a stack that is not listening, and pass
 * `--lan` through to both the `up` and the `exec`. A stub `docker` on `PATH` is what
 * makes those decisions observable — it records the compose calls and reports the
 * smoke's exit status, so no daemon, no images and no model are involved.
 *
 * What it deliberately does not check is that a capture actually works, because that
 * needs the thing CI has none of: a model behind Genie. That half is the deployment's
 * own — the deploy runs it, and the operator sees the evidence id or the tool's error.
 * Pretending otherwise in a hosted runner would be a green check for something that
 * never ran (see §9/Q8 on where the hosted boundary is).
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "deploy.sh");

interface Deployed {
  /** The script's exit status. */
  readonly status: number;
  /** Its stdout and stderr together. */
  readonly output: string;
  /** One line per `docker` invocation, in order. */
  readonly calls: readonly string[];
}

/**
 * Run the deploy against a `docker` that only records and answers.
 *
 * `exec` is the smoke, so its status stands in for what Genie's agent did: 0 a
 * capture with Evidence, 1 a capture that ran and failed, 2 one that could not be
 * attempted. The stub exits without reading stdin, which is fine — the script's own
 * redirect comes from a file, and the smoke's behaviour is not this file's subject.
 */
function deploy(env: Record<string, string>, args: readonly string[] = []): Deployed {
  const bin = mkdtempSync(path.join(os.tmpdir(), "deploy-gate-"));
  const log = path.join(bin, "docker.log");
  writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$*" in *" exec "*) exit "${FAKE_DOCKER_EXEC_STATUS:-0}" ;; esac',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(log, "");

  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: log,
      // The retry window is a minute and a half by default; the point here is that
      // the window ends, not how long it is.
      DEPLOY_SMOKE_WAIT_SECONDS: "1",
      ...env,
    },
  });

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    calls: readFileSync(log, "utf8").split("\n").filter((line) => line !== ""),
  };
}

const execs = (calls: readonly string[]) => calls.filter((call) => call.includes(" exec "));
const ups = (calls: readonly string[]) => calls.filter((call) => call.includes(" up "));

test("a deploy with no account to attribute the turn to stops before the stack", () => {
  const ran = deploy({});
  assert.equal(ran.status, 2);
  assert.deepEqual(ran.calls, [], "nothing may be started before the gate can run");
  assert.match(ran.output, /GENIE_SMOKE_ACTOR/);
});

test("a capture that works is what a finished deploy means", () => {
  const ran = deploy({ GENIE_SMOKE_ACTOR: "a@b" });
  assert.equal(ran.status, 0);
  assert.equal(ups(ran.calls).length, 1);
  assert.equal(execs(ran.calls).length, 1);
  // The turn belongs to the named account, and runs where GENIE_URL lives.
  assert.match(execs(ran.calls)[0] ?? "", /GENIE_SMOKE_ACTOR=a@b/);
  assert.match(execs(ran.calls)[0] ?? "", /\bg0dm0d3\b/);
  assert.match(ran.output, /answering captures/);
});

test("a capture that ran and failed ends the deploy at once, and says so", () => {
  const ran = deploy({ GENIE_SMOKE_ACTOR: "a@b", FAKE_DOCKER_EXEC_STATUS: "1" });
  assert.equal(ran.status, 1);
  // Nothing is gained by asking the same question again: the stack answered.
  assert.equal(execs(ran.calls).length, 1);
  assert.match(ran.output, /a capture through the agent failed/);
});

test("a stack that is not listening yet is retried, then reported with its log", () => {
  const ran = deploy({ GENIE_SMOKE_ACTOR: "a@b", FAKE_DOCKER_EXEC_STATUS: "2" });
  assert.equal(ran.status, 1);
  assert.ok(execs(ran.calls).length > 1, "an attempt that could not run must be retried");
  assert.match(ran.output, /never answered a capture/);
  // A bare timeout would leave an operator guessing; the console's own log is the
  // first thing they would ask for.
  assert.ok(
    ran.calls.some((call) => call.includes(" logs ") && call.includes("g0dm0d3")),
    "the console's log must be shown",
  );
});

test("--lan publishes the databases on both the up and the smoke", () => {
  const ran = deploy({ GENIE_SMOKE_ACTOR: "a@b" }, ["--lan"]);
  assert.equal(ran.status, 0);
  assert.match(ups(ran.calls)[0] ?? "", /docker-compose\.lan-db\.yml/);
  assert.match(execs(ran.calls)[0] ?? "", /docker-compose\.lan-db\.yml/);
});

test("there is no flag that starts the stack without the gate", () => {
  const ran = deploy({ GENIE_SMOKE_ACTOR: "a@b" }, ["--skip-smoke"]);
  assert.equal(ran.status, 2);
  assert.deepEqual(ran.calls, []);
  assert.match(ran.output, /unknown argument/);
});
