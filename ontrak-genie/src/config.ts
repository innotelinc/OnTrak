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

export type SandboxNetwork = "none" | "bridge" | "host";

/**
 * Whether a sandboxed command may reach the network.
 *
 * `none` (the default) is the promise the sandbox makes: a build script cannot
 * exfiltrate the workspace and a model that has been talked into something
 * unwise cannot reach out. But it also cannot install anything, and an agent
 * asked to build a real project needs `curl`, a `pip install`, or a package it
 * does not have yet. So this is a deliberate choice rather than a constant: an
 * operator who wants the agent to fetch its own dependencies sets `bridge`, and
 * one who wants the lockdown keeps the default. `host` shares Genie's own
 * network namespace, which on a deployment that publishes its ports is how a
 * sandboxed command — and an app it starts — is reachable at the deployment's
 * LAN address rather than behind a docker bridge address that only this host can
 * dial. The host backend is unaffected — commands there already have whatever
 * network the process has.
 */
function sandboxNetwork(name: string, fallback: SandboxNetwork): SandboxNetwork {
  const raw = str(name, fallback).toLowerCase();
  return raw === "bridge" || raw === "none" || raw === "host" ? raw : fallback;
}

/**
 * An address a published port is reachable at, or the two words that mean "work
 * it out" and "only this machine".
 *
 * `AGENT_PREVIEW_HOST` decides what the app binds: `loopback` (the default —
 * nothing is exposed by accident), `all` (every interface, which is what a
 * container published by compose needs, because the container's `0.0.0.0` is the
 * host's published port), or an explicit address.
 */
function bindHost(name: string, fallback: string): string {
  const raw = str(name, fallback).toLowerCase();
  if (raw === "loopback" || raw === "local" || raw === "localhost") return "127.0.0.1";
  if (raw === "all" || raw === "any" || raw === "0.0.0.0") return "0.0.0.0";
  return str(name, fallback);
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

  /**
   * The gateway's browser-facing address, for the one message that sends a human
   * to it.
   *
   * `OMNIROUTE_URL` is the address *this process* dials, and in a deployed stack
   * that is routinely a LAN one (`http://192.168.1.71:20128/v1`) — reachable from
   * this container and from nobody's laptop. A message that tells somebody to go
   * connect a provider has to name an address their browser can open; an
   * internal one also fails the provider's redirect-URI check, because the
   * callback it sends is not the one registered for that app. Empty keeps the old
   * behaviour (`OMNIROUTE_URL`), so a single-operator checkout reads the same.
   */
  gatewayConsoleUrl: str("AGENT_GATEWAY_CONSOLE_URL", "").replace(/\/+$/, ""),

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

  /**
   * The live preview: the app running, beside the code that makes it.
   *
   * `previewPort` is the port a dev server is asked to listen on (a free one is
   * chosen if it is taken, and the proxy follows), and `previewCommand` is what
   * to run when nobody has said otherwise — the agent normally names it, having
   * read the project. Empty means the console will not start an app by itself.
   */
  previewPort: int("AGENT_PREVIEW_PORT", 5173),
  previewCommand: str("AGENT_PREVIEW_COMMAND", ""),
  /**
   * The address the running app is *reached at*, which is not the address this
   * process dials it on.
   *
   * A container has several addresses and only one of them is useful to anyone
   * outside it: the docker bridge (`172.x`) is reachable from that bridge and
   * nowhere else, and loopback from this process alone. Handing a gateway a
   * `172.17.0.1` is handing it an address that will refuse to connect — so the
   * deployment names the LAN address here (`192.168.1.21`), and empty means
   * "work it out from the routing table" (see `src/network.ts`).
   */
  lanIp: str("AGENT_LAN_IP", ""),
  /**
   * What the preview's dev server binds. See `bindHost` above: the default keeps
   * the app on loopback, and a deployment that publishes the port sets `all`.
   */
  previewHost: bindHost("AGENT_PREVIEW_HOST", "loopback"),
  /**
   * Whether the advertised address is really reachable, i.e. the port is
   * published and the app binds beyond loopback. Off, the console still proxies
   * the app for the person using it, and says so instead of inventing a URL.
   */
  previewPublish: bool("AGENT_PREVIEW_PUBLISH", false),

  sandbox: sandboxPreference("AGENT_SANDBOX", "auto"),
  sandboxNetwork: sandboxNetwork("AGENT_SANDBOX_NETWORK", "none"),
  sandboxImage: str("AGENT_SANDBOX_IMAGE", "coding-agent-sandbox:latest"),
  sandboxMemory: str("AGENT_SANDBOX_MEMORY", "2g"),
  sandboxCpus: str("AGENT_SANDBOX_CPUS", "2"),
  sandboxPids: int("AGENT_SANDBOX_PIDS", 512),

  /** Cap on any single tool result handed back to the model. */
  toolResultLimit: int("AGENT_TOOL_RESULT_LIMIT", 60_000),

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

/**
 * Where to send a human who needs the gateway's own console.
 *
 * The browser-facing address when one is configured, otherwise the dialled URL
 * with a trailing `/v1` removed — which is what the message said before there was
 * anything better to say. Pure, so both halves are testable in one process: the
 * configured value is read from the environment exactly once.
 */
export function gatewayConsoleHref(dialledUrl: string, consoleUrl: string): string {
  return consoleUrl !== "" ? consoleUrl : dialledUrl.replace(/\/v1$/, "");
}

export function gatewayConsoleUrl(): string {
  return gatewayConsoleHref(config.gatewayUrl, config.gatewayConsoleUrl);
}
