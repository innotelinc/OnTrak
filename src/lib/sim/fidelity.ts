/**
 * Simulator fidelity, as pure rules.
 *
 * A scenario is authored *for* something: either the in-process simulated machine (fast,
 * always available, phone-friendly) or a real shell in a sandbox (genuine `apt`, genuine
 * `systemctl`, genuine output nobody wrote by hand). Those two are not interchangeable —
 * a scenario whose checks read `/proc` or whose briefing says "use real `ss`" only makes
 * sense in one of them — so fidelity is **declared** on the scenario rather than guessed.
 *
 * Three questions live here, and nothing else does:
 *
 *   1. **What did the scenario ask for?** `normalizeFidelity` — absent means simulated,
 *      because that is what every scenario authored before this existed is.
 *   2. **What can this deployment actually run?** `sandboxAvailability` — read from the
 *      environment, so the answer is the same in a page, a server action and a test.
 *   3. **What will this attempt get, and did it fall back?** `resolveFidelity` — the
 *      graceful-degradation rule. A scenario asks for a sandbox; if the sandbox is not
 *      there, the student still gets a working console in the simulated engine and is
 *      *told* the run is a simulation, because silently pretending is the one outcome
 *      worse than falling back.
 *
 * The distinction between "unavailable" (nothing to run in) and "fell back" (something
 * was asked for and could not be delivered) is the whole point: `availability-rules.ts`
 * blocks a sandbox-only scenario in a deployment that has no sandbox, and `resolveFidelity`
 * describes what a single attempt actually got.
 */

export type Fidelity = "simulated" | "container";

export const FIDELITIES: readonly Fidelity[] = ["simulated", "container"];
export const DEFAULT_FIDELITY: Fidelity = "simulated";

/** The sandbox backends the product knows how to talk to. */
export type SandboxBackend = "docker" | "process";

export interface SandboxConfig {
  /** Absent when no sandbox is configured at all. */
  backend?: SandboxBackend;
  /** Container image, for the `docker` backend. */
  image: string;
  /**
   * Where inside the sandbox the scenario's filesystem root lives. Paths are mapped
   * between this and the engine's canonical `/`, so a seed at `/home/student/x` is
   * written to `<root>/home/student/x` and nothing else in the sandbox is graded.
   */
  root: string;
  /** Whether the non-isolating local-process backend is permitted. */
  allowProcess: boolean;
}

export const DEFAULT_SANDBOX_IMAGE = "debian:bookworm-slim";
export const DEFAULT_SANDBOX_ROOT = "/sandbox";

/**
 * The sandbox this deployment has, read from the environment.
 *
 * Opt-in by design: an unset `ONTRAK_SANDBOX_BACKEND` means "no sandbox", which is what a
 * laptop, a preview deployment and the default test run all are. The `process` backend is
 * refused unless it is explicitly allowed, because it runs a real shell **on the app
 * server** with no isolation — useful in development and in CI, and never something to
 * enable by accident.
 */
export function sandboxConfigFromEnv(env: Record<string, string | undefined> = {}): SandboxConfig {
  const raw = (env.ONTRAK_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  const allowProcess = env.ONTRAK_SANDBOX_ALLOW_PROCESS === "1" || env.ONTRAK_SANDBOX_ALLOW_PROCESS === "true";
  const backend: SandboxBackend | undefined =
    raw === "docker" ? "docker" : raw === "process" && allowProcess ? "process" : undefined;

  return {
    backend,
    image: (env.ONTRAK_SANDBOX_IMAGE ?? "").trim() || DEFAULT_SANDBOX_IMAGE,
    root: normalizeSandboxRoot(env.ONTRAK_SANDBOX_ROOT),
    allowProcess,
  };
}

/** A sandbox root is an absolute, slash-separated path with no trailing slash. */
export function normalizeSandboxRoot(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed.startsWith("/")) return DEFAULT_SANDBOX_ROOT;
  const collapsed = trimmed.replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

export interface SandboxAvailability {
  available: boolean;
  /** Why not, in a sentence an instructor can act on. */
  reason: string;
  backend?: SandboxBackend;
}

/** Whether a sandbox can actually be used, and the sentence to show when it cannot. */
export function sandboxAvailability(config: SandboxConfig): SandboxAvailability {
  if (!config.backend) {
    return {
      available: false,
      reason:
        "No simulator sandbox is configured on this deployment (set ONTRAK_SANDBOX_BACKEND), so only simulated fidelity is available.",
    };
  }
  if (config.backend === "process" && !config.allowProcess) {
    return {
      available: false,
      reason:
        "The local sandbox backend runs real commands on the app server and is not enabled (set ONTRAK_SANDBOX_ALLOW_PROCESS=1 to allow it).",
      backend: config.backend,
    };
  }
  return { available: true, reason: `A ${config.backend} sandbox is available.`, backend: config.backend };
}

/** The fidelity a stored definition declares. Anything unknown is the default. */
export function normalizeFidelity(value: unknown, fallback: Fidelity = DEFAULT_FIDELITY): Fidelity {
  return value === "container" || value === "simulated" ? value : fallback;
}

export interface FidelityResolution {
  /** What this attempt will actually run in. */
  fidelity: Fidelity;
  /** True when a sandbox was asked for and simulated fidelity was delivered instead. */
  fellBack: boolean;
  /** The sentence to show the student when `fellBack`; empty otherwise. */
  reason: string;
}

/**
 * What one attempt gets.
 *
 * Note what this is *not*: it is not an error path. A sandbox-only scenario is kept out of
 * the catalogue by the availability rule; this is the runtime answer for everything else —
 * a student resuming an attempt after the sandbox went away, a deployment that lost its
 * Docker socket, an author previewing a scenario in an environment without a sandbox.
 */
export function resolveFidelity(requested: Fidelity, sandbox: SandboxAvailability): FidelityResolution {
  if (requested === "simulated") {
    return { fidelity: "simulated", fellBack: false, reason: "" };
  }
  if (sandbox.available) {
    return { fidelity: "container", fellBack: false, reason: "" };
  }
  return {
    fidelity: "simulated",
    fellBack: true,
    reason: `This scenario asks for a real shell, and ${lowerFirst(sandbox.reason)} You are working in the simulated terminal instead.`,
  };
}

/**
 * The same question the availability rule asks, in the form it asks it: may this scenario
 * be offered?
 *
 * Separate from `resolveFidelity` on purpose — one decides the catalogue, the other
 * describes a running attempt — but they must agree, so they read the same availability.
 */
export function satisfiesFidelity(requested: Fidelity, sandbox: SandboxAvailability): boolean {
  return requested === "simulated" || sandbox.available;
}

export function fidelityLabel(fidelity: Fidelity): string {
  return fidelity === "container" ? "Real shell (sandboxed)" : "Simulated";
}

export function fidelityBlurb(fidelity: Fidelity): string {
  return fidelity === "container"
    ? "Commands run in a real shell inside a sandbox: real exit codes, real error messages, real files."
    : "Commands run in the built-in simulated machine, which works everywhere and needs no sandbox.";
}

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}
