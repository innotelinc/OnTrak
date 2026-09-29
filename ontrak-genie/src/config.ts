import fs from "node:fs";
import path from "node:path";

// Node >= 20.12 can read a .env file without pulling in a dependency.
try {
  const envFile = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // Older runtimes, or a malformed .env: fall back to the real environment.
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `int`, but 0 is a real setting rather than "unset" (it disables things). */
function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() !== "false";
}

type SandboxPreference = "auto" | "docker" | "host";

function sandboxPreference(name: string, fallback: SandboxPreference): SandboxPreference {
  const raw = str(name, fallback).toLowerCase();
  return raw === "docker" || raw === "host" || raw === "auto" ? raw : fallback;
}

/**
 * Values `.env.example` ships that must never be read as a real credential.
 *
 * "Empty" counts: a template leaves a secret blank, and an unset secret is the
 * normal state of a laptop. The prefixes are the ones the stack writes into its
 * templates ("change-me", "your-…"), because a deployment that copied the file
 * and never edited it should read as *unconfigured* rather than as configured
 * with a placeholder — a distinction that decides whether sign-in and tenancy
 * are on, and one no log line would otherwise explain.
 */
const PLACEHOLDER_PREFIXES = ["change-me", "changeme", "your-", "xxx", "todo"];

export function isPlaceholderSecret(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (lowered === "") return true;
  return PLACEHOLDER_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export type ApprovalMode = "off" | "risky" | "all";

function approvalMode(name: string, fallback: ApprovalMode): ApprovalMode {
  const raw = str(name, fallback).toLowerCase();
  return raw === "off" || raw === "risky" || raw === "all" ? raw : fallback;
}

/** Comma-separated list, trimmed, with blanks dropped. */
function list(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export const config = {
  port: int("PORT", 3400),
  host: str("HOST", "127.0.0.1"),

  /** OmniRoute exposes an OpenAI-compatible surface. */
  gatewayUrl: str("OMNIROUTE_URL", "http://127.0.0.1:20128/v1").replace(/\/+$/, ""),
  gatewayKey: str("OMNIROUTE_API_KEY", ""),

  model: str("AGENT_MODEL", "auto/coding"),
  /**
   * Tried in order when the chosen model rate-limits, errors or answers with
   * nothing. Only safe before any text has reached the client.
   */
  fallbackModels: list("AGENT_FALLBACK_MODELS"),

  /**
   * A second gateway, tried only after every model on the primary one has
   * failed. Point it at a model server on this machine - Ollama's
   * OpenAI-compatible endpoint, for example - so the agent still works when the
   * network (or the primary gateway itself) is unreachable.
   */
  offlineUrl: str("AGENT_OFFLINE_URL", "").replace(/\/+$/, ""),
  offlineKey: str("AGENT_OFFLINE_KEY", ""),
  offlineModels: list("AGENT_OFFLINE_MODELS"),

  /**
   * How often to ask whether the models in the chain can still make a tool call.
   * Only the chain is probed, never the whole catalog, and 0 disables it.
   */
  healthIntervalMs: nonNegativeInt("AGENT_HEALTH_INTERVAL_MS", 900_000),

  /**
   * When a turn produces nothing because everything was throttled, wait and try
   * the whole chain again this many times. 0 disables it. Only ever applied
   * before any tool has run, so a retry cannot repeat work.
   */
  retryAttempts: nonNegativeInt("AGENT_RETRY_ATTEMPTS", 2),
  /** How long to wait before each retry. Doubles per attempt, up to a minute. */
  retryDelayMs: nonNegativeInt("AGENT_RETRY_DELAY_MS", 20_000),

  workspace: path.resolve(str("AGENT_WORKSPACE", "./workspace")),
  dataDir: path.resolve(str("AGENT_DATA_DIR", "./.agent")),

  maxSteps: int("AGENT_MAX_STEPS", 30),
  commandTimeoutMs: int("AGENT_COMMAND_TIMEOUT_MS", 120_000),
  requestTimeoutMs: int("AGENT_REQUEST_TIMEOUT_MS", 300_000),
  stream: bool("AGENT_STREAM", true),

  webToken: str("WEB_TOKEN", ""),

  /**
   * Optional Authentik (OIDC) sign-in, for a deployment that puts this console
   * behind the family's identity provider. Off until the issuer, the client id
   * and the session secret are all set — see the header of `src/oidc.ts` for why
   * the session secret is required rather than defaulted, and why turning this on
   * also closes the loopback trust the app otherwise starts with.
   */
  oidcIssuer: str("ONTRAK_OIDC_ISSUER", ""),
  oidcClientId: str("ONTRAK_OIDC_CLIENT_ID", ""),
  oidcClientSecret: str("ONTRAK_OIDC_CLIENT_SECRET", ""),
  /** Must equal the redirect URI registered with the provider, byte for byte. */
  oidcRedirectUrl: str("ONTRAK_OIDC_REDIRECT_URL", ""),
  oidcSessionSecret: str("ONTRAK_OIDC_SESSION_SECRET", ""),
  oidcSessionHours: int("ONTRAK_OIDC_SESSION_HOURS", 12),

  /**
   * Where `run_command` executes. "docker" refuses to fall back to the host,
   * "auto" prefers a container when one is available, "host" runs unisolated.
   */
  /**
   * When a file change or a command needs a human click before it runs.
   * "off" never asks, "risky" asks for every command and for overwrites above
   * AGENT_APPROVAL_MAX_LINES, "all" asks for every tool that changes anything.
   */
  approval: approvalMode("AGENT_APPROVAL", "off"),
  approvalMaxLines: int("AGENT_APPROVAL_MAX_LINES", 200),
  approvalTimeoutMs: int("AGENT_APPROVAL_TIMEOUT_MS", 300_000),

  sandbox: sandboxPreference("AGENT_SANDBOX", "auto"),
  sandboxImage: str("AGENT_SANDBOX_IMAGE", "coding-agent-sandbox:latest"),
  sandboxMemory: str("AGENT_SANDBOX_MEMORY", "2g"),
  sandboxCpus: str("AGENT_SANDBOX_CPUS", "2"),
  sandboxPids: int("AGENT_SANDBOX_PIDS", 512),

  /** Cap on any single tool result handed back to the model. */
  toolResultLimit: int("AGENT_TOOL_RESULT_LIMIT", 60_000),

  /**
   * Olympus's `build-requests/` directory, where an exported spec is written.
   *
   * Unset by default, and deliberately so: a spec is assembled from a workspace in
   * either case, but only a deployment that names this directory gets a file —
   * otherwise the export returns the markdown for the operator to place. Genie
   * does not assume where the factory's checkout lives.
   */
  factoryDir: str("AGENT_FACTORY_DIR", ""),

  /**
   * Distro's control plane, for per-identity accounts, quota and accounting.
   *
   * Both are required for it to be on, and a placeholder token counts as unset
   * (`isPlaceholderSecret`), so a fresh checkout is the single-operator tool it
   * has been rather than a console that refuses every turn. See
   * `src/tenancy.ts` for what turning it on changes: the shared `OMNIROUTE_API_KEY`
   * stops being the credential every turn spends.
   */
  controlPlaneUrl: str("CONTROL_PLANE_INTERNAL_URL", ""),
  controlToken: str("CONTROL_INTERNAL_TOKEN", ""),
} as const;
