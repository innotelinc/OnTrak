/**
 * The browser's end of a sandboxed attempt.
 *
 * A sandboxed attempt runs real commands where the sandbox is — on the server — so the
 * console cannot call a synchronous driver for it. This driver is the adapter: it implements
 * the same contract as the simulated one (`prompt`, `banner`, `completions` are all local and
 * immediate) and answers `runAsync` by asking the server to run the line and hand back both
 * the result and the machine it produced.
 *
 * The fallback is the interesting part. A driver that is asked for a sandbox and cannot get
 * one does **not** fail the student's attempt: it swaps to the simulated driver, records why,
 * and tells the caller through `onFallback` so the console can say so on screen. Silently
 * pretending a simulation is a real shell is the one outcome worse than falling back, and
 * refusing to run at all is the other.
 *
 * State is mutated in place, like every other driver, by folding the server's filesystem,
 * working directory, history and revision onto the state the caller passed in. Everything the
 * client owns — notes, hints, office documents — is left alone.
 */

import type { CommandResult, EngineId, EngineState, Platform, ShellDriver } from "../types";
import type { Fidelity } from "../fidelity";

/** What the server answers a command with. */
export interface SandboxCommandResponse {
  ok: boolean;
  /** Why not, when `ok` is false: the sandbox is gone, the attempt moved on, and so on. */
  error?: string;
  result?: CommandResult;
  /** The machine after the command, for the client to adopt. */
  state?: EngineState;
}

export interface SandboxBridge {
  command(input: string, state: EngineState): Promise<SandboxCommandResponse>;
}

export interface ProxyDriverOptions {
  engine: EngineId;
  platform: Platform;
  bridge: SandboxBridge;
  /** The driver to finish the attempt in when the sandbox cannot be reached. */
  fallback: ShellDriver;
  /** Called once, the first time the sandbox fails, with the sentence to show the student. */
  onFallback?: (reason: string, message: string) => void;
}

/** The sentence a student sees when a sandboxed attempt has to continue simulated. */
export function fallbackMessage(reason: string): string {
  return `${reason} The rest of this attempt runs in the simulated terminal, and every check still grades normally.`;
}

/**
 * Copy the machine the server just produced onto the state the console holds.
 *
 * Only the parts the sandbox owns are replaced. Notes, hints and office documents belong to
 * the student's browser and are already on the server's copy, so they are not touched.
 */
export function adoptRemoteState(target: EngineState, remote: EngineState): void {
  target.vfs = remote.vfs;
  target.machine.cwd = remote.machine.cwd;
  target.machine.env = remote.machine.env;
  target.machine.history = remote.machine.history;
  target.machine.exitCode = remote.machine.exitCode;
  target.meta.revision = remote.meta.revision;
}

export function createProxyDriver(options: ProxyDriverOptions): ShellDriver {
  let fellBack = false;
  // A one-shot guard: a failing sandbox is reported once, not once per command.
  const fallBack = (reason: string) => {
    if (fellBack) return;
    fellBack = true;
    options.onFallback?.(reason, fallbackMessage(reason));
  };

  const driver: ShellDriver = {
    id: options.engine,
    platform: options.platform,
    prompt: (state) => options.fallback.prompt(state),
    banner: (state) => options.fallback.banner(state),
    completions: () => options.fallback.completions?.() ?? [],
    run() {
      // Not a user-facing path: the console checks for `runAsync` before it runs a line.
      throw new Error("This attempt is running in a sandbox; commands must be awaited.");
    },
    async runAsync(input, state) {
      if (fellBack) return options.fallback.run(input, state);
      try {
        const response = await options.bridge.command(input, state);
        if (!response.ok || !response.result || !response.state) {
          fallBack(response.error ?? "The simulator sandbox is not reachable right now.");
          return options.fallback.run(input, state);
        }
        adoptRemoteState(state, response.state);
        return response.result;
      } catch (error) {
        fallBack(`The simulator sandbox could not be reached (${(error as Error).message}).`);
        return options.fallback.run(input, state);
      }
    },
  };

  return driver;
}

/** How the console labels the machine an attempt is really running in. */
export function fidelityBadge(fidelity: Fidelity): { label: string; tone: "teal" | "sky" } {
  return fidelity === "container"
    ? { label: "Sandboxed shell", tone: "sky" }
    : { label: "Simulated", tone: "teal" };
}
