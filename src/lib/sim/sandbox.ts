/**
 * Sandbox sessions, server side.
 *
 * An attempt that declares container fidelity gets one sandbox for its lifetime, keyed by the
 * attempt id, and every command the student types is run inside it. Keeping the session on
 * the server rather than the browser is not a preference: the sandbox is a process on the
 * server, and the browser's job is to send a line and render what came back.
 *
 * Three decisions are worth reading:
 *
 *  - **The server's copy of the machine is the truth, and the client's is a view.** Each
 *    command takes the client's state, lifts the parts the client owns (notes, hint usage)
 *    onto the session's machine, runs the line, and returns the machine. That keeps the
 *    student's notes from being clobbered by a harvest while keeping the filesystem honest.
 *  - **A session that is not being used is disposed of.** A container per attempt that is
 *    never cleaned up is a resource leak that only shows up as a full disk, so idle sessions
 *    are reaped on the next command and after `SESSION_IDLE_MS`, and a session that fails to
 *    build is reported rather than retried forever.
 *  - **Nothing here is called from the browser directly.** The server action owns the
 *    authorisation and the attempt lookup; this module owns the sandbox.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContainerDriver, DockerSandbox, ProcessSandbox, type Sandbox } from "./drivers/container";
import { createInitialState } from "./state";
import { sandboxAvailability, sandboxConfigFromEnv, type SandboxAvailability, type SandboxConfig } from "./fidelity";
import type { CommandResult, EngineState, ScenarioDefinition, ShellDriver } from "./types";

/** How long a session may sit idle before its sandbox is thrown away. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

interface Session {
  id: string;
  sandbox: Sandbox;
  driver: ShellDriver;
  state: EngineState;
  lastUsedAt: number;
}

const sessions = new Map<string, Session>();

/** The sandbox this deployment has. Read fresh, so a test can change the environment. */
export function sandboxStatus(env: Record<string, string | undefined> = process.env): SandboxAvailability {
  return sandboxAvailability(sandboxConfigFromEnv(env));
}

export type SandboxCommandOutcome =
  | { ok: true; result: CommandResult; state: EngineState }
  | { ok: false; error: string };

/** Dispose of every session, for tests and for a graceful shutdown. */
export function disposeAllSandboxes(): void {
  for (const [key, session] of sessions) {
    try {
      session.sandbox.dispose();
    } catch {
      /* a sandbox that is already gone is not a problem */
    }
    sessions.delete(key);
  }
}

function reap(now = Date.now()): void {
  for (const [key, session] of sessions) {
    if (now - session.lastUsedAt <= SESSION_IDLE_MS) continue;
    try {
      session.sandbox.dispose();
    } catch {
      /* as above */
    }
    sessions.delete(key);
  }
}

/** Build the sandbox a backend names, or `null` when this deployment has none. */
export function createSandbox(config: SandboxConfig, attemptId: string): Sandbox | null {
  if (config.backend === "docker") {
    return new DockerSandbox({ image: config.image, name: `ontrak-sandbox-${attemptId.replace(/[^a-zA-Z0-9_.-]/g, "")}` });
  }
  if (config.backend === "process" && config.allowProcess) {
    return new ProcessSandbox({ scratch: join(tmpdir(), `ontrak-sandbox-${attemptId.replace(/[^a-zA-Z0-9_.-]/g, "")}-${randomUUID().slice(0, 8)}`) });
  }
  return null;
}

function sessionFor(attemptId: string, definition: ScenarioDefinition, env: Record<string, string | undefined>): Session | SandboxCommandOutcome {
  reap();
  const existing = sessions.get(attemptId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const config = sandboxConfigFromEnv(env);
  const availability = sandboxAvailability(config);
  if (!availability.available) return { ok: false, error: availability.reason };

  const sandbox = createSandbox(config, attemptId);
  if (!sandbox) return { ok: false, error: availability.reason };

  const state = createInitialState(definition);
  const driver = createContainerDriver({ engine: definition.engine, sandbox, user: definition.machine.user });

  try {
    driver.boot?.(state);
  } catch (error) {
    try {
      sandbox.dispose();
    } catch {
      /* the build failed; a second failure while tidying up must not mask the first */
    }
    return { ok: false, error: `The simulator sandbox could not be started: ${(error as Error).message}` };
  }

  const session: Session = { id: attemptId, sandbox, driver, state, lastUsedAt: Date.now() };
  sessions.set(attemptId, session);
  return session;
}

/**
 * Run one line in the attempt's sandbox.
 *
 * `clientState` is the console's copy of the machine: its notes and hint usage are carried
 * onto the session's machine before the command runs, because those belong to the student and
 * the sandbox has no opinion about them.
 */
export function runSandboxCommand(
  attemptId: string,
  definition: ScenarioDefinition,
  input: string,
  clientState: EngineState,
  env: Record<string, string | undefined> = process.env,
): SandboxCommandOutcome {
  const session = sessionFor(attemptId, definition, env);
  if ("ok" in session) return session;

  session.state.machine.notes = clientState.machine.notes;
  session.state.meta.hintsUsed = clientState.meta.hintsUsed;

  let result: CommandResult;
  try {
    result = session.driver.run(input, session.state);
  } catch (error) {
    // A sandbox that dies mid-attempt is thrown away so the next command builds a fresh one,
    // rather than every later command failing against a corpse.
    disposeSession(attemptId);
    return { ok: false, error: `The simulator sandbox stopped responding (${(error as Error).message}).` };
  }

  // The client's view is refreshed with the machine as it now is, notes and hints included.
  session.state.machine.notes = clientState.machine.notes;
  session.state.meta.hintsUsed = clientState.meta.hintsUsed;
  session.lastUsedAt = Date.now();
  return { ok: true, result, state: session.state };
}

/** Throw away one attempt's sandbox, e.g. when the attempt is submitted or abandoned. */
export function disposeSession(attemptId: string): void {
  const session = sessions.get(attemptId);
  if (!session) return;
  try {
    session.sandbox.dispose();
  } catch {
    /* as above */
  }
  sessions.delete(attemptId);
}

/** How many sandboxes are open — used by tests to prove nothing is leaked. */
export function openSessionCount(): number {
  return sessions.size;
}
