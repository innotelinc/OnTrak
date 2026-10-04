import { spawn } from "node:child_process";

import { config } from "./config.js";
import { removeContainer, sandboxInfo, sandboxInvocation, type SandboxBackend } from "./sandbox.js";
import { workspaceRoot } from "./scope.js";

/**
 * Running a shell command, once.
 *
 * `run_command` had this logic inline, and the console's terminal needs exactly
 * the same thing: the same guard list, the same sandbox decision, the same
 * timeout and the same process-group kill. Two copies would drift, and the copy
 * that drifted would be the one with the weaker guard — so there is one executor
 * and both callers go through it.
 *
 * What a *caller* decides is only where the command runs (`cwd`, already resolved
 * and fenced) and what to do with the output. The rules below are not parameters.
 */

export interface ShellResult {
  /** True only for a clean exit inside the timeout. */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  backend: SandboxBackend;
  /** Combined stdout and stderr, in arrival order. */
  output: string;
  /** Set when the command was refused before anything ran. */
  refused?: string;
}

/**
 * Patterns that are refused outright.
 *
 * The agent is a coding assistant, not a system administrator: it never needs
 * root, and neither does somebody typing into the console's terminal — the
 * terminal is a faster way to run the same build the agent would run, not a
 * second route to the host. The list is deliberately about *host* harm (block
 * devices, accounts, services, deletions outside the workspace) rather than about
 * a workspace's own files, which are the thing this whole product exists to edit.
 */
const BLOCKED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b|\bdoas\b|\bsu\s+-/, reason: "privilege escalation is not available to the agent" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "formatting filesystems is destructive" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: "writing to block devices is destructive" },
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /(^|[;&|]\s*)\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, reason: "shutting down the host" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, reason: "recursive forced delete" },
  { pattern: /\brm\s+[^\n]*\s(\/|\/\*|~|\$HOME|\$\{HOME\})\s*$/, reason: "deleting outside the workspace" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)[a-z0-9]*/, reason: "raw block device writes" },
  { pattern: /\b(userdel|groupdel|passwd)\b/, reason: "modifying host accounts" },
  { pattern: /\bchown\b|\bchmod\s+-R\b/, reason: "changing ownership or permissions recursively" },
  { pattern: /\b(crontab|systemctl|service)\b/, reason: "changing host services or schedules" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|k)?sh\b/, reason: "piping a download straight into a shell" },
];

/** The guard on its own, so a caller can refuse before it spawns anything. */
export function blockedCommandReason(command: string): string | null {
  for (const rule of BLOCKED_COMMANDS) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  return null;
}

/** Human name for where a command ran, for the header both callers print. */
export function backendLabel(backend: SandboxBackend): string {
  return backend === "docker" ? `container ${config.sandboxImage}` : "this host";
}

export interface ShellOptions {
  command: string;
  /** Absolute, already resolved against the workspace by the caller. */
  cwd: string;
  timeoutMs?: number;
}

/**
 * The timeout a command will actually get.
 *
 * Exported because a caller that reports the timeout has to report the same
 * number the command was given — a header saying `30s` over a kill at `120s` is
 * exactly the kind of small lie that makes a timeout look like a hang.
 */
export function effectiveTimeoutMs(requested?: number): number {
  return Math.max(1_000, Math.min(requested ?? config.commandTimeoutMs, 600_000));
}

/**
 * Run one command and bring back everything it printed.
 *
 * Refusals come back as a result rather than as a thrown error: both callers show
 * them to somebody, and "refused, and here is why" is a better answer than an
 * exception each caller has to remember to catch.
 */
export async function runShellCommand(options: ShellOptions): Promise<ShellResult> {
  const command = options.command;

  const blocked = blockedCommandReason(command);
  if (blocked !== null) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      backend: "host",
      output: "",
      refused:
        `Refused to run this command: ${blocked}. ` +
        "This console is restricted to the workspace and has no host privileges.",
    };
  }

  const timeoutMs = effectiveTimeoutMs(options.timeoutMs);

  // Commands run in a throwaway container by default. This is the second lock,
  // after the guard above: even something the guard misses stays inside a
  // namespaced, network-less container instead of running on the host.
  const sandbox = await sandboxInfo();
  if (sandbox.backend === "host" && config.sandbox === "docker") {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      backend: sandbox.backend,
      output: "",
      refused:
        "Refused to run this command: commands are configured to execute only inside a container " +
        `(AGENT_SANDBOX=docker), but no sandbox is available. ${sandbox.detail}`,
    };
  }

  const containerName =
    sandbox.backend === "docker"
      ? `agent-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : "";
  const invocation =
    sandbox.backend === "docker"
      ? sandboxInvocation(command, options.cwd, containerName)
      : { command: "bash", args: ["-lc", command], backend: "host" as const };

  const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: sandbox.backend === "docker" ? workspaceRoot() : options.cwd,
        env: { ...process.env, AGENT_WORKSPACE: workspaceRoot() },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const append = (chunk: Buffer): void => {
        if (output.length < 200_000) output += chunk.toString("utf8");
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined && process.platform !== "win32") {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
        // Killing the CLI does not stop the container it started.
        if (containerName !== "") removeContainer(containerName);
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, output: `${output}\n${error.message}`, timedOut });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut });
      });
    },
  );

  return {
    ok: result.code === 0 && !result.timedOut,
    exitCode: result.code,
    timedOut: result.timedOut,
    backend: sandbox.backend,
    output: result.output,
  };
}
