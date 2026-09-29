import { execFile } from "node:child_process";
import path from "node:path";

import { config } from "./config.js";

/**
 * `run_command` backend selection.
 *
 * By default commands run inside a throwaway container: no network, a read-only
 * root filesystem, every capability dropped, and only the workspace bind-mounted
 * read-write. A build script, a test suite, or a model that has been talked into
 * something unwise therefore cannot reach the host.
 *
 * `AGENT_SANDBOX=host` runs commands directly in the agent process, which is the
 * old behaviour: faster and dependency-free, but not isolated. `AGENT_SANDBOX=auto`
 * prefers Docker and quietly falls back to the host when Docker is unavailable.
 */

export type SandboxPreference = "auto" | "docker" | "host";
export type SandboxBackend = "docker" | "host";

export interface SandboxInfo {
  /** What the operator asked for. */
  preference: SandboxPreference;
  /** What will actually be used right now. */
  backend: SandboxBackend;
  image: string;
  dockerInstalled: boolean;
  imageReady: boolean;
  /** One sentence explaining the current state, for the UI and the logs. */
  detail: string;
}

/** Where the workspace is mounted inside the sandbox container. */
export const CONTAINER_WORKSPACE = "/workspace";

function run(command: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

interface Probe {
  dockerInstalled: boolean;
  imageReady: boolean;
}

let probe: Promise<Probe> | null = null;
let cachedProbe: Probe | null = null;

/** Probe Docker once per process; the answer rarely changes mid-session. */
async function probeDocker(): Promise<Probe> {
  if (cachedProbe !== null) return cachedProbe;
  if (probe === null) {
    probe = (async (): Promise<Probe> => {
      const version = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
      if (version === null || version === "") {
        return { dockerInstalled: false, imageReady: false };
      }
      const image = await run("docker", ["image", "inspect", "--format", "{{.Id}}", config.sandboxImage]);
      return { dockerInstalled: true, imageReady: image !== null && image !== "" };
    })();
  }
  cachedProbe = await probe;
  return cachedProbe;
}

/** Reset the memoised probe (used by the server's health endpoint and tests). */
export function resetSandboxProbe(): void {
  probe = null;
  cachedProbe = null;
}

export async function sandboxInfo(): Promise<SandboxInfo> {
  const preference = config.sandbox;
  if (preference === "host") {
    return {
      preference,
      backend: "host",
      image: config.sandboxImage,
      dockerInstalled: false,
      imageReady: false,
      detail: "Commands run directly on this host (AGENT_SANDBOX=host).",
    };
  }

  const detected = await probeDocker();

  if (!detected.dockerInstalled) {
    return {
      preference,
      backend: "host",
      image: config.sandboxImage,
      dockerInstalled: false,
      imageReady: false,
      detail:
        preference === "docker"
          ? "Docker is not reachable, so run_command cannot be sandboxed. Start Docker or set AGENT_SANDBOX=auto to allow host execution."
          : "Docker is not reachable; commands run directly on this host.",
    };
  }

  if (!detected.imageReady) {
    return {
      preference,
      backend: "host",
      image: config.sandboxImage,
      dockerInstalled: true,
      imageReady: false,
      detail:
        `Sandbox image ${config.sandboxImage} is not built yet, so commands run directly on this host. ` +
        "Build it with \"npm run sandbox:build\".",
    };
  }

  return {
    preference,
    backend: "docker",
    image: config.sandboxImage,
    dockerInstalled: true,
    imageReady: true,
    detail: `Commands run in a locked-down ${config.sandboxImage} container with no network access.`,
  };
}

/** Workspace-relative directory expressed as a path inside the container. */
export function containerCwd(absCwd: string): string {
  const rel = path.relative(config.workspace, absCwd);
  if (rel === "" || rel.startsWith("..")) return CONTAINER_WORKSPACE;
  return `${CONTAINER_WORKSPACE}/${rel.split(path.sep).join("/")}`;
}

export interface SandboxRun {
  command: string;
  args: string[];
  backend: SandboxBackend;
  /** Set for container runs so a timed-out command can be cleaned up. */
  containerName?: string;
}

/**
 * Build the argument vector for one sandboxed command. Exported so the hardening
 * can be asserted directly in tests without needing a Docker daemon.
 */
export function sandboxInvocation(
  command: string,
  absCwd: string,
  containerName: string,
): SandboxRun {
  const args = [
    "run",
    "--rm",
    // Named so a command that outlives its CLI process can still be killed.
    "--name",
    containerName,
    // No network at all: no data exfiltration, no downloads at run time.
    "--network",
    "none",
    // Immutable root filesystem. /tmp is the only writable scratch space.
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(config.sandboxPids),
    "--memory",
    config.sandboxMemory,
    // Cap both the swap allowance and CPU so a runaway command cannot take the
    // machine down with it.
    "--memory-swap",
    config.sandboxMemory,
    "--cpus",
    config.sandboxCpus,
    "-e",
    "HOME=/tmp",
    "-e",
    "CI=1",
    "-e",
    "AGENT_SANDBOX=1",
    "-e",
    "NPM_CONFIG_CACHE=/tmp/.npm",
    "-v",
    `${config.workspace}:${CONTAINER_WORKSPACE}`,
    "-w",
    containerCwd(absCwd),
  ];

  // Match the agent's own uid/gid so files written into the workspace keep
  // sensible ownership. A root agent just runs as root inside the container,
  // which is still namespaced away from the host.
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    args.push("--user", `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
  }

  args.push(config.sandboxImage, "bash", "-lc", command);
  return { command: "docker", args, backend: "docker", containerName };
}

/** Force-remove a container left behind by a killed or timed-out command. */
export function removeContainer(containerName: string): void {
  execFile("docker", ["rm", "-f", containerName], { timeout: 15_000 }, () => {
    // Best effort: the container is usually already gone.
  });
}
