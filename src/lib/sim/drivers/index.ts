/**
 * Driver registry — the seam that keeps the console engine swappable.
 *
 * Today every driver runs in-process (browser or Node) against a virtual
 * filesystem, which is what makes the product instant and phone-friendly.
 * A `container` driver that shells into a real VM can be added later by
 * implementing `ShellDriver`, registering it here, and flipping the engine
 * field on a scenario — no UI or grading changes required, because both read
 * only `EngineState`.
 */

import { DEFAULT_FIDELITY, normalizeFidelity } from "../fidelity";
import type { EngineId, Platform, ScenarioDefinition, ShellDriver } from "../types";
import { createBashDriver } from "./bash";
import { createOfficeDriver } from "./office";
import { createPowerShellDriver } from "./powershell";
import { createProxyDriver, type SandboxBridge } from "./proxy";

export interface DriverOptions {
  /** Local account the student is signed in as. */
  user?: string;
  /** Hint that this attempt will be driven by an external backend. */
  remote?: { endpoint: string; token: string };
}

const BUILDERS: Record<EngineId, (options: DriverOptions) => ShellDriver> = {
  bash: (options) => createBashDriver({ user: options.user }),
  powershell: (options) => createPowerShellDriver({ user: options.user }),
  office: () => createOfficeDriver(),
};

export function createDriver(engine: EngineId, options: DriverOptions = {}): ShellDriver {
  const builder = BUILDERS[engine];
  if (!builder) throw new Error(`Unknown simulation engine "${engine}"`);
  return builder(options);
}

/**
 * The driver for a scenario, in a browser.
 *
 * One decision, in one place: a scenario that declares container fidelity and has a bridge
 * to the server gets the sandbox proxy, and everything else — including a container-fidelity
 * scenario in an environment with no sandbox — gets the simulated driver for its platform.
 * The proxy falls back to the simulated driver itself if the sandbox stops answering, so a
 * student never loses an attempt to an infrastructure problem.
 */
export function createScenarioDriver(
  definition: Pick<ScenarioDefinition, "engine" | "platform" | "fidelity" | "machine">,
  options: { bridge?: SandboxBridge; onFallback?: (reason: string, message: string) => void } = {},
): ShellDriver {
  const simulated = createDriver(definition.engine, { user: definition.machine.user });
  const fidelity = normalizeFidelity(definition.fidelity, DEFAULT_FIDELITY);
  if (fidelity !== "container" || !options.bridge) return simulated;

  return createProxyDriver({
    engine: definition.engine,
    platform: definition.platform,
    bridge: options.bridge,
    fallback: simulated,
    onFallback: options.onFallback,
  });
}

export const SUPPORTED_ENGINES: { id: EngineId; platform: Platform; label: string; blurb: string }[] = [
  {
    id: "bash",
    platform: "LINUX",
    label: "Linux terminal",
    blurb: "Ubuntu-style bash: files, permissions, users, systemd, apt, networking.",
  },
  {
    id: "powershell",
    platform: "WINDOWS",
    label: "Windows PowerShell",
    blurb: "Windows Server workstation: services, local accounts, registry, firewall, shares.",
  },
  {
    id: "office",
    platform: "OFFICE",
    label: "Office productivity",
    blurb: "Spreadsheets, documents and a mailbox — clean a real help-desk ticket.",
  },
];

/** Type guard used by the authoring UI when it loads a stored definition. */
export function isEngineId(value: string): value is EngineId {
  return value === "bash" || value === "powershell" || value === "office";
}

export { createBashDriver, createPowerShellDriver, createOfficeDriver };

export { createProxyDriver, adoptRemoteState, fallbackMessage, fidelityBadge, type SandboxBridge, type SandboxCommandResponse } from "./proxy";

/**
 * The sandbox driver is deliberately *not* re-exported here.
 *
 * This module is what the browser imports, and `drivers/container.ts` needs
 * `node:child_process` and a filesystem. Keeping the sandbox behind its own module means the
 * client bundle can never reach for it by accident: the console imports the proxy from here,
 * and the server imports the container driver directly.
 */
