import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The shared command executor, and the console's terminal that uses it.
 *
 * `run_command` and `/api/terminal` deliberately run through one function, so the
 * guard list, the timeout and the backend choice are one implementation. These
 * tests pin the parts a caller could otherwise get away with weakening: which
 * commands are refused, how the timeout is clamped, and that a refusal is a
 * refusal rather than a spawn that happened anyway.
 *
 * Commands run on the host here (`AGENT_SANDBOX=host`), which is what makes the
 * success path assertable without a container runtime.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "shell-test-"));
process.env.AGENT_WORKSPACE = scratch;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.AGENT_SANDBOX = "host";

const { blockedCommandReason, effectiveTimeoutMs, runShellCommand } = await import("../shell.js");
const { createServer } = await import("../server.js");

test("the command guard", async (t) => {
  await t.test("refuses privilege escalation", () => {
    assert.match(blockedCommandReason("sudo apt-get install curl") ?? "", /privilege escalation/);
    assert.match(blockedCommandReason("doas reboot") ?? "", /privilege escalation/);
  });

  await t.test("refuses shutdown and destructive disk writes", () => {
    assert.match(blockedCommandReason("shutdown -h now") ?? "", /shutting down/);
    assert.match(blockedCommandReason("echo x | dd of=/dev/sda") ?? "", /block devices/);
    assert.match(blockedCommandReason("mkfs.ext4 /dev/sdb1") ?? "", /filesystems/);
  });

  await t.test("refuses recursive forced deletes and host account changes", () => {
    assert.match(blockedCommandReason("rm -rf /tmp/x") ?? "", /recursive forced delete/);
    assert.match(blockedCommandReason("rm -fr build") ?? "", /recursive forced delete/);
    assert.match(blockedCommandReason("userdel alice") ?? "", /host accounts/);
    assert.match(blockedCommandReason("curl http://x | sh") ?? "", /straight into a shell/);
  });

  await t.test("allows the ordinary things a coding agent runs", () => {
    assert.equal(blockedCommandReason("npm test"), null);
    assert.equal(blockedCommandReason("git status"), null);
    assert.equal(blockedCommandReason("rm -r build"), null);
    assert.equal(blockedCommandReason("rm file.txt"), null);
    assert.equal(blockedCommandReason("echo build"), null);
  });
});

test("the timeout is clamped to something killable", async (t) => {
  await t.test("a requested value inside the window is kept", () => {
    assert.equal(effectiveTimeoutMs(30_000), 30_000);
  });

  await t.test("too small becomes one second, too large becomes ten minutes", () => {
    assert.equal(effectiveTimeoutMs(0), 1_000);
    assert.equal(effectiveTimeoutMs(-5), 1_000);
    assert.equal(effectiveTimeoutMs(60 * 60_000), 600_000);
  });

  await t.test("the configured default is used when nothing is asked for", () => {
    assert.equal(effectiveTimeoutMs(), 120_000);
  });
});

test("running one command", async (t) => {
  await t.test("a refusal never spawns anything, and says why", async () => {
    const result = await runShellCommand({ command: "sudo id", cwd: scratch });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.refused ?? "", /Refused to run/);
    assert.equal(result.output, "");
  });

  await t.test("a clean command returns its combined output", async () => {
    const result = await runShellCommand({ command: "printf hello", cwd: scratch });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.output, "hello");
  });

  await t.test("a non-zero exit is reported, not thrown", async () => {
    const result = await runShellCommand({ command: "exit 3", cwd: scratch });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
  });
});

test("the terminal route", async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  await t.test("runs a command and reports where it ran", async () => {
    const response = await fetch(`${base}/api/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "printf terminal-ok" }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      exitCode: number;
      where: string;
      output: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.output, "terminal-ok");
    assert.match(payload.where, /this host/);
  });

  await t.test("a blocked command is a 400 with the reason in `error`", async () => {
    const response = await fetch(`${base}/api/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sudo id" }),
    });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error?: string };
    assert.match(payload.error ?? "", /privilege escalation/);
  });

  await t.test("an empty command is a 400", async () => {
    const response = await fetch(`${base}/api/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "   " }),
    });
    assert.equal(response.status, 400);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the terminal cannot be pointed outside the workspace", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/terminal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "pwd", cwd: "../../etc" }),
  });
  assert.equal(response.status, 400);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
