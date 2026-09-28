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

import type { EngineId, Platform, ShellDriver } from "../types";
import { createBashDriver } from "./bash";
import { createOfficeDriver } from "./office";
import { createPowerShellDriver } from "./powershell";

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
