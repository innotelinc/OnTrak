/**
 * The lab's settings, read the way the lab read them.
 *
 * This is the TypeScript half of OnTrak-dev's `ontrak/config.py`. The precedence is
 * the Python's, lowest to highest: the deployment's config file, a local override
 * file, `ONTRAK_<SECTION>__<KEY>` environment variables, then explicit overrides.
 * Nested keys are addressed with a double underscore, so `ONTRAK_GUEST__PASSWORD`
 * reaches `guest.password`.
 *
 * Five decisions a reader should not have to reverse-engineer.
 *
 * **There is no YAML parser here, on purpose.** The Python read
 * `config/ontrak.yaml`; this repository has no YAML dependency and the port's
 * decision (docs/lab-port.md §3/C6) is that the lab's data is JSON here — its
 * scenarios are already JSON fixtures. So the *file* half of this loader takes an
 * already-parsed record and the caller owns the parsing. This module does no file
 * I/O at all: it never reads a path, and a test never needs one.
 *
 * **The operator's vocabulary stays snake_case.** `operation_timeout_seconds`,
 * `secret_key`, `linux_driver` — those are the names in a deployment's config file,
 * in its `.env`, and in the lab's documentation. So the schemas below map each
 * snake_case key onto the camelCase field that holds it, and nothing an operator
 * writes changes when this code changes.
 *
 * **A value that cannot be read as its field's kind is refused, not guessed at.**
 * The Python parsed every env value as YAML and then handed the result to a dataclass
 * with no type check, which is worse than it sounds: `enabled: "false"` arrived as
 * the string `"false"`, which is *truthy*, so a schedule switched off in `.env` ran
 * anyway. Here `session.ttl_minutes=abc` is a `ConfigError` naming the variable, and
 * the falsy spellings are read as false.
 *
 * **An environment variable that names a setting the app cannot read is an error
 * naming the variable.** This is the Python's `_reject_unknown_env` and it exists for
 * one real failure: a spent `ONTRAK_GUAC__PUBLIC_PORT` left in an operator's `.env`
 * made every command that loaded config die on a field name with nothing to grep for.
 *
 * **The environment's values are parsed with the shapes `yaml.safe_load` gave them**
 * — scalars, flow mappings (`{net-dns-failure: 30}`) and flow sequences (`[45, 90]`)
 * — because that is how a deployment's `.env` has always been written. A construct
 * outside that subset (an anchor, a block scalar) stays the raw string rather than
 * being guessed at, which is the same fallback the Python took on a YAML error.
 *
 * Two fields are deliberately different from the Python, both stated where they are
 * declared: `guest.driver` defaults to `incus-exec` because WinRM is not ported
 * (§3/C1), and `paths.db_path` is not ported because SQLite is superseded by the
 * app's Postgres (§3/C3).
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { secretBytes as guacKeyBytes, type GuacSettings } from "./guac";
import { LabSchedule } from "./scheduler";

/** Every override variable starts here. */
export const ENV_PREFIX = "ONTRAK_";
/** Names the config file. Read by the caller, which owns file I/O — this module only skips it. */
export const CONFIG_ENV = "ONTRAK_CONFIG";

/** Raised when configuration is missing, unreadable or addresses something unknown. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Lowercase, dash-separated, filesystem-and-Incus-safe name fragment. */
export function slugify(value: unknown): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* -------------------------------------------------------------------------- */
/*  Environment values, parsed the way YAML parsed them                       */
/* -------------------------------------------------------------------------- */

/** A value the subset parser could not read, so the caller keeps the raw string. */
const UNPARSED = Symbol("unparsed");

/** YAML 1.1's booleans, which is what `yaml.safe_load` implements. */
const TRUE_SPELLINGS = ["true", "yes", "on"];
const FALSE_SPELLINGS = ["false", "no", "off"];
const NULL_SPELLINGS = ["null", "~", ""];

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

function parseScalar(text: string): unknown {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return unquote(text);
  }
  const lowered = text.toLowerCase();
  if (NULL_SPELLINGS.includes(lowered)) return null;
  if (TRUE_SPELLINGS.includes(lowered)) return true;
  if (FALSE_SPELLINGS.includes(lowered)) return false;
  // Numbers, including YAML's `1_000` grouping and a leading sign.
  if (/^[+-]?\d[\d_]*$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?\.\d[\d_]*$/.test(text)) return Number(text.replace(/_/g, ""));
  return UNPARSED;
}

/**
 * Split on a separator that is not inside quotes or brackets.
 *
 * Returns `null` when the text is malformed — an unterminated bracket or quote — so a
 * caller falls back to the raw string rather than half-parsing something.
 */
function splitTopLevel(text: string, separator: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth < 0) return null;
    if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote || depth !== 0) return null;
  parts.push(current);
  return parts;
}

/** `{a: 1, b: 2}` — the flow mapping an operator writes on one line. */
function parseFlowMapping(inner: string): Record<string, unknown> | null {
  const items = splitTopLevel(inner, ",");
  if (items === null) return null;
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    const pair = splitTopLevel(trimmed, ":");
    if (pair === null || pair.length < 2) return null;
    const first = pair[0];
    if (first === undefined) return null;
    const key = unquote(first.trim());
    if (key === "") return null;
    const rest = pair.slice(1).join(":");
    out[key] = parseEnvValue(rest.trim());
  }
  return out;
}

/** `[45, 90]` — the flow sequence an operator writes on one line. */
function parseFlowSequence(inner: string): unknown[] | null {
  const items = splitTopLevel(inner, ",");
  if (items === null) return null;
  const out: unknown[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    out.push(parseEnvValue(trimmed));
  }
  return out;
}

/**
 * One environment value, as YAML would have read it.
 *
 * Flow collections first, then scalars, then the raw string: that order matters
 * because `{x: 1}` must not be read as the string `"{x: 1}"`.
 */
export function parseEnvValue(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    const mapping = parseFlowMapping(text.slice(1, -1));
    if (mapping !== null) return mapping;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const sequence = parseFlowSequence(text.slice(1, -1));
    if (sequence !== null) return sequence;
  }
  const scalar = parseScalar(text);
  // `typeof` rather than a comparison: `UNPARSED` is a unique symbol, no parsed value
  // can be one, and this never has to cast `unknown` to ask the question.
  return typeof scalar === "symbol" ? raw : scalar;
}

/* -------------------------------------------------------------------------- */
/*  Coercion: refuse what cannot be read, never guess                          */
/* -------------------------------------------------------------------------- */

type FieldKind = "string" | "int" | "float" | "bool" | "stringList" | "intList" | "targets" | "windows";

interface FieldSpec {
  /** The camelCase field on the section class. */
  readonly field: string;
  readonly kind: FieldKind;
}

interface SectionSchema {
  /** The Python dataclass's name, which is what its error messages used. */
  readonly label: string;
  /** snake_case operator key -> where it lands. */
  readonly fields: Record<string, FieldSpec>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, where: string): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ConfigError(`${where} must be a single value, not a list or a mapping.`);
}

function asInt(value: unknown, where: string): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ConfigError(`${where} must be a whole number, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function asFloat(value: unknown, where: string): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new ConfigError(`${where} must be a number, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function asBool(value: unknown, where: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUE_SPELLINGS.includes(lowered) || lowered === "1") return true;
    if (FALSE_SPELLINGS.includes(lowered) || lowered === "0" || lowered === "") return false;
  }
  throw new ConfigError(
    `${where} must be a boolean (true/false, yes/no, on/off, 1/0), got ${JSON.stringify(value)}.`,
  );
}

function asStringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where} must be a list, got ${JSON.stringify(value)}.`);
  }
  return value.map((entry) => asString(entry, where));
}

function asIntList(value: unknown, where: string): number[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where} must be a list of whole numbers, got ${JSON.stringify(value)}.`);
  }
  return value.map((entry) => asInt(entry, where));
}

function asTargets(value: unknown, where: string): Record<string, number> {
  if (!isRecord(value)) {
    throw new ConfigError(`${where} must be a mapping of scenario to count, got ${JSON.stringify(value)}.`);
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = asInt(entry, `${where}.${key}`);
  return out;
}

/** Windows are passed through unchanged: `LabSchedule.fromConfig` validates them. */
function asWindows(value: unknown, where: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where} must be a list of schedule windows, got ${JSON.stringify(value)}.`);
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw new ConfigError(`${where} holds an entry that is not a window.`);
    return { ...entry };
  });
}

function coerce(kind: FieldKind, value: unknown, where: string): unknown {
  switch (kind) {
    case "string":
      return asString(value, where);
    case "int":
      return asInt(value, where);
    case "float":
      return asFloat(value, where);
    case "bool":
      return asBool(value, where);
    case "stringList":
      return asStringList(value, where);
    case "intList":
      return asIntList(value, where);
    case "targets":
      return asTargets(value, where);
    case "windows":
      return asWindows(value, where);
  }
}

/* -------------------------------------------------------------------------- */
/*  The sections                                                              */
/* -------------------------------------------------------------------------- */

export interface IncusConfigInit {
  remote?: string;
  project?: string;
  storagePool?: string;
  network?: string;
  profile?: string;
  imageAlias?: string;
  templatePrefix?: string;
  poolPrefix?: string;
  sessionPrefix?: string;
  operationTimeoutSeconds?: number;
  knownWorkloads?: readonly string[];
}

/** One instance name, or the scenario-and-workload pair parsed back out of one. */
export interface ParsedName {
  scenario: string;
  workload: string;
}

export interface ParsedPoolName extends ParsedName {
  index: number;
}

export class IncusConfig {
  readonly remote: string;
  readonly project: string;
  readonly storagePool: string;
  readonly network: string;
  readonly profile: string;
  readonly imageAlias: string;
  readonly templatePrefix: string;
  readonly poolPrefix: string;
  readonly sessionPrefix: string;
  readonly operationTimeoutSeconds: number;
  /**
   * The catalog entries a name may end with.
   *
   * Populated by the session manager from the catalog so parsing a pool name stays a
   * string operation with no import cycle. Instance names are slugified while catalog
   * ids keep their dots — `ubuntu-24.04` becomes `ubuntu-24-04` in a name — and
   * matching on the slug is what keeps `ontrak-pool-x-ubuntu-24-04-1` attributable.
   */
  readonly knownWorkloads: readonly string[];

  constructor(init: IncusConfigInit = {}) {
    this.remote = init.remote ?? "local";
    this.project = init.project ?? "ontrak";
    this.storagePool = init.storagePool ?? "default";
    this.network = init.network ?? "ontrak0";
    this.profile = init.profile ?? "ontrak-student";
    this.imageAlias = init.imageAlias ?? "ontrak-win-base";
    this.templatePrefix = init.templatePrefix ?? "tpl";
    this.poolPrefix = init.poolPrefix ?? "ontrak-pool";
    this.sessionPrefix = init.sessionPrefix ?? "ontrak-sess";
    this.operationTimeoutSeconds = init.operationTimeoutSeconds ?? 300;
    this.knownWorkloads = [...(init.knownWorkloads ?? [])];
  }

  /** A deterministic instance name, e.g. `tpl-net-dns-failure`. */
  instanceName(kind: string, ...parts: readonly string[]): string {
    const slugs = parts.filter((part) => String(part).trim() !== "").map((part) => slugify(part));
    const safe = slugs.filter((slug) => slug !== "").join("-");
    return safe === "" ? slugify(kind) : `${slugify(kind)}-${safe}`;
  }

  // Templates and pooled VMs are keyed by (scenario, workload): the same fault on
  // Windows 11 and on Ubuntu are different machines with different images, so they
  // need different names. An empty workload means "the site's golden image", which is
  // how scenarios that do not name a platform keep working.
  templateName(scenarioId: string, workload = ""): string {
    return this.instanceName(this.templatePrefix, scenarioId, workload);
  }

  poolName(scenarioId: string, index: number | string, workload = ""): string {
    return this.instanceName(this.poolPrefix, scenarioId, workload, String(index));
  }

  sessionName(scenarioId: string, sessionId: number | string, workload = ""): string {
    return this.instanceName(this.sessionPrefix, scenarioId, workload, String(sessionId));
  }

  /** Inverse of `templateName`: `tpl-<scenario>[-<workload>]`. */
  parseTemplateName(name: string): ParsedName {
    return this.splitSuffix(name, this.templatePrefix);
  }

  /** `ontrak-pool-<scenario>[-<workload>]-<n>` -> the pair and the index, or `null`. */
  parsePoolName(name: string): ParsedPoolName | null {
    const prefix = `${slugify(this.poolPrefix)}-`;
    if (!name.startsWith(prefix)) return null;
    const rest = name.slice(prefix.length);
    const at = rest.lastIndexOf("-");
    const indexText = at === -1 ? "" : rest.slice(0, at);
    const remainder = at === -1 ? rest : rest.slice(at + 1);
    if (!/^\d+$/.test(remainder)) return null;
    const parsed = this.splitSuffix(indexText, "");
    return { scenario: parsed.scenario, workload: parsed.workload, index: Number(remainder) };
  }

  /**
   * Strip a known-workload suffix, longest match first.
   *
   * Scenarios whose own id ends in a known workload id cannot be told apart by name
   * alone, so the longest match wins rather than the first.
   */
  private splitSuffix(name: string, prefix: string): ParsedName {
    let text = name;
    if (prefix) {
      const head = `${slugify(prefix)}-`;
      if (text.startsWith(head)) text = text.slice(head.length);
    }
    const candidates = this.knownWorkloads
      .filter((workload) => workload !== "")
      .map((workload) => ({ slug: slugify(workload), workload }))
      .sort((a, b) => b.slug.length - a.slug.length);
    for (const candidate of candidates) {
      if (candidate.slug !== "" && text.endsWith(`-${candidate.slug}`)) {
        return { scenario: text.slice(0, -candidate.slug.length - 1), workload: candidate.workload };
      }
    }
    return { scenario: text, workload: "" };
  }
}

export interface GuestConfigInit {
  driver?: string;
  user?: string;
  password?: string;
  adminGroup?: string;
  winrmPort?: number;
  winrmTransport?: string;
  winrmUseSsl?: boolean;
  rdpPort?: number;
  bootTimeoutSeconds?: number;
  readyTimeoutSeconds?: number;
  staticHost?: string;
  linuxDriver?: string;
  linuxUser?: string;
  linuxWorkDir?: string;
  linuxReadyTimeoutSeconds?: number;
  sshPort?: number;
  sshKey?: string;
  workDir?: string;
}

export class GuestConfig {
  /**
   * The Windows transport. **Not the Python's `winrm`** — the port has no WinRM
   * client, so the default is the Incus agent over virtio-vsock, which the lab's own
   * documentation calls the better transport (no network dependency, so a scenario
   * that breaks the NIC still grades). Setting `winrm` explicitly still fails loudly
   * rather than silently moving to another transport: see `guest.ts`.
   */
  readonly driver: string;
  readonly user: string;
  readonly password: string;
  readonly adminGroup: string;
  readonly winrmPort: number;
  readonly winrmTransport: string;
  readonly winrmUseSsl: boolean;
  readonly rdpPort: number;
  readonly bootTimeoutSeconds: number;
  readonly readyTimeoutSeconds: number;
  readonly staticHost: string;
  /**
   * `incus-shell` by default: run inside the guest through the Incus agent, so no
   * sshd, key material or extra port is needed. `ssh` is for machines OnTrak does not
   * run on Incus, key-based only.
   */
  readonly linuxDriver: string;
  /**
   * The account shell scripts run as. Root is the honest default: grading reads
   * things an unprivileged user cannot see (`/etc/shadow`, `/etc/sudoers`,
   * ownership), and the guest is a disposable lab machine.
   */
  readonly linuxUser: string;
  readonly linuxWorkDir: string;
  readonly linuxReadyTimeoutSeconds: number;
  readonly sshPort: number;
  readonly sshKey: string;
  readonly workDir: string;

  constructor(init: GuestConfigInit = {}) {
    this.driver = init.driver ?? "incus-exec";
    this.user = init.user ?? "student";
    this.password = init.password ?? "";
    this.adminGroup = init.adminGroup ?? "Administrators";
    this.winrmPort = init.winrmPort ?? 5985;
    this.winrmTransport = init.winrmTransport ?? "ntlm";
    this.winrmUseSsl = init.winrmUseSsl ?? false;
    this.rdpPort = init.rdpPort ?? 3389;
    this.bootTimeoutSeconds = init.bootTimeoutSeconds ?? 300;
    this.readyTimeoutSeconds = init.readyTimeoutSeconds ?? 420;
    this.staticHost = init.staticHost ?? "";
    this.linuxDriver = init.linuxDriver ?? "incus-shell";
    this.linuxUser = init.linuxUser ?? "root";
    this.linuxWorkDir = init.linuxWorkDir ?? "/var/lib/ontrak";
    this.linuxReadyTimeoutSeconds = init.linuxReadyTimeoutSeconds ?? 180;
    this.sshPort = init.sshPort ?? 22;
    this.sshKey = init.sshKey ?? "";
    this.workDir = init.workDir ?? "C:\\ProgramData\\OnTrak";
  }
}

export interface SessionConfigInit {
  ttlMinutes?: number;
  idleRecycleMinutes?: number;
  maxPerStudent?: number;
  randomizeCredentials?: boolean;
  checkTimeoutSeconds?: number;
  persistProgress?: boolean;
  timeLimitChoices?: readonly number[];
  destroyOnComplete?: boolean;
}

export class SessionConfig {
  readonly ttlMinutes: number;
  readonly idleRecycleMinutes: number;
  readonly maxPerStudent: number;
  readonly randomizeCredentials: boolean;
  readonly checkTimeoutSeconds: number;
  /**
   * Results-only by default: a student may check their work as often as they like,
   * but only the grade they submit at "Complete & End" is stored.
   */
  readonly persistProgress: boolean;
  /** Time limits a student may pick from, in minutes; the first is the default. */
  readonly timeLimitChoices: readonly number[];
  /** The VM is graded once and then destroyed, so "what happens now" is never ambiguous. */
  readonly destroyOnComplete: boolean;

  constructor(init: SessionConfigInit = {}) {
    this.ttlMinutes = init.ttlMinutes ?? 90;
    this.idleRecycleMinutes = init.idleRecycleMinutes ?? 20;
    this.maxPerStudent = init.maxPerStudent ?? 1;
    this.randomizeCredentials = init.randomizeCredentials ?? false;
    this.checkTimeoutSeconds = init.checkTimeoutSeconds ?? 240;
    this.persistProgress = init.persistProgress ?? false;
    this.timeLimitChoices = [...(init.timeLimitChoices ?? [45, 90, 180])];
    this.destroyOnComplete = init.destroyOnComplete ?? true;
  }
}

export interface PoolConfigInit {
  enabled?: boolean;
  defaultTarget?: number;
  targets?: Record<string, number>;
  maxTotal?: number;
  refillIntervalSeconds?: number;
  claimTimeoutSeconds?: number;
}

export class PoolConfig {
  readonly enabled: boolean;
  readonly defaultTarget: number;
  readonly targets: Record<string, number>;
  readonly maxTotal: number;
  readonly refillIntervalSeconds: number;
  readonly claimTimeoutSeconds: number;

  constructor(init: PoolConfigInit = {}) {
    this.enabled = init.enabled ?? true;
    this.defaultTarget = init.defaultTarget ?? 0;
    this.targets = { ...(init.targets ?? {}) };
    this.maxTotal = init.maxTotal ?? 60;
    this.refillIntervalSeconds = init.refillIntervalSeconds ?? 120;
    this.claimTimeoutSeconds = init.claimTimeoutSeconds ?? 90;
  }
}

export interface GuacConfigInit {
  baseUrl?: string;
  secretKey?: string;
  linkTtlMinutes?: number;
  recording?: boolean;
  recordingPath?: string;
  serverLayout?: string;
  keyboardLayout?: string;
  linuxSsh?: boolean;
}

export class GuacConfig {
  /**
   * The address a *browser* uses. The console is a path on the stack's one published
   * port, so this only has to change when a TLS host is put in front.
   */
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly linkTtlMinutes: number;
  readonly recording: boolean;
  readonly recordingPath: string;
  readonly serverLayout: string;
  readonly keyboardLayout: string;
  /**
   * Off by default: the container transport works through the Incus agent and runs no
   * sshd, so an SSH console pointed at such a guest is a page that says the remote
   * desktop server is unreachable — which is what the console iframe used to show for
   * every container scenario.
   */
  readonly linuxSsh: boolean;

  constructor(init: GuacConfigInit = {}) {
    this.baseUrl = init.baseUrl ?? "http://127.0.0.1:8080/guacamole/";
    this.secretKey = init.secretKey ?? "";
    this.linkTtlMinutes = init.linkTtlMinutes ?? 480;
    this.recording = init.recording ?? false;
    this.recordingPath = init.recordingPath ?? "/recordings";
    this.serverLayout = init.serverLayout ?? "en-us-qwerty";
    this.keyboardLayout = init.keyboardLayout ?? "en-us-qwerty";
    this.linuxSsh = init.linuxSsh ?? false;
  }
}

export interface PortalConfigInit {
  host?: string;
  port?: number;
  secret?: string;
  title?: string;
  brandNote?: string;
  allowSelfReset?: boolean;
  hintsRequireAttempt?: boolean;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcRedirectUri?: string;
  oidcInstructorGroup?: string;
  oidcRequiredGroup?: string;
}

/**
 * The portal's own settings.
 *
 * Kept as data because a deployment's config file carries them and an unknown key is
 * an error — but **`secret` and the OIDC group are superseded by this app's identity**
 * (docs/lab-port.md §3/C2): the lab's own sign-in is not ported, so nothing consumes
 * them here yet. `requireSecrets` still asks for `secret` because it is the lab's own
 * preflight and a later stage decides what replaces it; a reader should not assume
 * that means a second login exists.
 */
export class PortalConfig {
  readonly host: string;
  readonly port: number;
  readonly secret: string;
  readonly title: string;
  readonly brandNote: string;
  readonly allowSelfReset: boolean;
  readonly hintsRequireAttempt: boolean;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly oidcClientSecret: string;
  readonly oidcRedirectUri: string;
  readonly oidcInstructorGroup: string;
  readonly oidcRequiredGroup: string;

  constructor(init: PortalConfigInit = {}) {
    this.host = init.host ?? "0.0.0.0";
    this.port = init.port ?? 8080;
    this.secret = init.secret ?? "";
    this.title = init.title ?? "OnTrak";
    this.brandNote = init.brandNote ?? "IT support training range — powered by Innotel OnTrak";
    this.allowSelfReset = init.allowSelfReset ?? true;
    this.hintsRequireAttempt = init.hintsRequireAttempt ?? true;
    this.oidcIssuer = init.oidcIssuer ?? "";
    this.oidcClientId = init.oidcClientId ?? "";
    this.oidcClientSecret = init.oidcClientSecret ?? "";
    this.oidcRedirectUri = init.oidcRedirectUri ?? "";
    this.oidcInstructorGroup = init.oidcInstructorGroup ?? "";
    this.oidcRequiredGroup = init.oidcRequiredGroup ?? "";
  }
}

export interface PathsConfigInit {
  scenarios?: string;
  state?: string;
  catalog?: string;
  media?: string;
  lessons?: string;
}

export class PathsConfig {
  readonly scenarios: string;
  readonly state: string;
  /** The workload catalog: manifests for every OS and Microsoft product. */
  readonly catalog: string;
  /** Installation media. Free media is downloaded here, licensed media placed here. */
  readonly media: string;
  /** Command walkthroughs a scenario can point a student at. */
  readonly lessons: string;

  constructor(init: PathsConfigInit = {}) {
    this.scenarios = init.scenarios ?? "scenarios";
    this.state = init.state ?? "state";
    this.catalog = init.catalog ?? "catalog";
    this.media = init.media ?? "media";
    this.lessons = init.lessons ?? "lessons";
  }
}

export interface SelectionConfigInit {
  strategy?: string;
  autoAssign?: boolean;
  maxDifficulty?: number;
  seed?: number;
}

export class SelectionConfig {
  readonly strategy: string;
  readonly autoAssign: boolean;
  readonly maxDifficulty: number;
  readonly seed: number;

  constructor(init: SelectionConfigInit = {}) {
    this.strategy = init.strategy ?? "balanced";
    this.autoAssign = init.autoAssign ?? true;
    this.maxDifficulty = init.maxDifficulty ?? 4;
    this.seed = init.seed ?? 0;
  }
}

export interface ScheduleConfigInit {
  enabled?: boolean;
  windows?: readonly Record<string, unknown>[];
}

export class ScheduleConfig {
  readonly enabled: boolean;
  readonly windows: readonly Record<string, unknown>[];

  constructor(init: ScheduleConfigInit = {}) {
    this.enabled = init.enabled ?? false;
    this.windows = (init.windows ?? []).map((window) => ({ ...window }));
  }
}

export interface DemoConfigInit {
  enabled?: boolean;
  students?: number;
  successRate?: number;
  resetState?: boolean;
}

export class DemoConfig {
  readonly enabled: boolean;
  readonly students: number;
  readonly successRate: number;
  readonly resetState: boolean;

  constructor(init: DemoConfigInit = {}) {
    this.enabled = init.enabled ?? false;
    this.students = init.students ?? 6;
    this.successRate = init.successRate ?? 1.0;
    this.resetState = init.resetState ?? true;
  }
}

/* -------------------------------------------------------------------------- */
/*  The schemas: the one place the operator's vocabulary is declared          */
/* -------------------------------------------------------------------------- */

const INCUS_SCHEMA: SectionSchema = {
  label: "IncusConfig",
  fields: {
    remote: { field: "remote", kind: "string" },
    project: { field: "project", kind: "string" },
    storage_pool: { field: "storagePool", kind: "string" },
    network: { field: "network", kind: "string" },
    profile: { field: "profile", kind: "string" },
    image_alias: { field: "imageAlias", kind: "string" },
    template_prefix: { field: "templatePrefix", kind: "string" },
    pool_prefix: { field: "poolPrefix", kind: "string" },
    session_prefix: { field: "sessionPrefix", kind: "string" },
    operation_timeout_seconds: { field: "operationTimeoutSeconds", kind: "int" },
    known_workloads: { field: "knownWorkloads", kind: "stringList" },
  },
};

const GUEST_SCHEMA: SectionSchema = {
  label: "GuestConfig",
  fields: {
    driver: { field: "driver", kind: "string" },
    user: { field: "user", kind: "string" },
    password: { field: "password", kind: "string" },
    admin_group: { field: "adminGroup", kind: "string" },
    winrm_port: { field: "winrmPort", kind: "int" },
    winrm_transport: { field: "winrmTransport", kind: "string" },
    winrm_use_ssl: { field: "winrmUseSsl", kind: "bool" },
    rdp_port: { field: "rdpPort", kind: "int" },
    boot_timeout_seconds: { field: "bootTimeoutSeconds", kind: "int" },
    ready_timeout_seconds: { field: "readyTimeoutSeconds", kind: "int" },
    static_host: { field: "staticHost", kind: "string" },
    linux_driver: { field: "linuxDriver", kind: "string" },
    linux_user: { field: "linuxUser", kind: "string" },
    linux_work_dir: { field: "linuxWorkDir", kind: "string" },
    linux_ready_timeout_seconds: { field: "linuxReadyTimeoutSeconds", kind: "int" },
    ssh_port: { field: "sshPort", kind: "int" },
    ssh_key: { field: "sshKey", kind: "string" },
    work_dir: { field: "workDir", kind: "string" },
  },
};

const SESSION_SCHEMA: SectionSchema = {
  label: "SessionConfig",
  fields: {
    ttl_minutes: { field: "ttlMinutes", kind: "int" },
    idle_recycle_minutes: { field: "idleRecycleMinutes", kind: "int" },
    max_per_student: { field: "maxPerStudent", kind: "int" },
    randomize_credentials: { field: "randomizeCredentials", kind: "bool" },
    check_timeout_seconds: { field: "checkTimeoutSeconds", kind: "int" },
    persist_progress: { field: "persistProgress", kind: "bool" },
    time_limit_choices: { field: "timeLimitChoices", kind: "intList" },
    destroy_on_complete: { field: "destroyOnComplete", kind: "bool" },
  },
};

const POOL_SCHEMA: SectionSchema = {
  label: "PoolConfig",
  fields: {
    enabled: { field: "enabled", kind: "bool" },
    default_target: { field: "defaultTarget", kind: "int" },
    targets: { field: "targets", kind: "targets" },
    max_total: { field: "maxTotal", kind: "int" },
    refill_interval_seconds: { field: "refillIntervalSeconds", kind: "int" },
    claim_timeout_seconds: { field: "claimTimeoutSeconds", kind: "int" },
  },
};

const GUAC_SCHEMA: SectionSchema = {
  label: "GuacConfig",
  fields: {
    base_url: { field: "baseUrl", kind: "string" },
    secret_key: { field: "secretKey", kind: "string" },
    link_ttl_minutes: { field: "linkTtlMinutes", kind: "int" },
    recording: { field: "recording", kind: "bool" },
    recording_path: { field: "recordingPath", kind: "string" },
    server_layout: { field: "serverLayout", kind: "string" },
    keyboard_layout: { field: "keyboardLayout", kind: "string" },
    linux_ssh: { field: "linuxSsh", kind: "bool" },
  },
};

const PORTAL_SCHEMA: SectionSchema = {
  label: "PortalConfig",
  fields: {
    host: { field: "host", kind: "string" },
    port: { field: "port", kind: "int" },
    secret: { field: "secret", kind: "string" },
    title: { field: "title", kind: "string" },
    brand_note: { field: "brandNote", kind: "string" },
    allow_self_reset: { field: "allowSelfReset", kind: "bool" },
    hints_require_attempt: { field: "hintsRequireAttempt", kind: "bool" },
    oidc_issuer: { field: "oidcIssuer", kind: "string" },
    oidc_client_id: { field: "oidcClientId", kind: "string" },
    oidc_client_secret: { field: "oidcClientSecret", kind: "string" },
    oidc_redirect_uri: { field: "oidcRedirectUri", kind: "string" },
    oidc_instructor_group: { field: "oidcInstructorGroup", kind: "string" },
    oidc_required_group: { field: "oidcRequiredGroup", kind: "string" },
  },
};

const PATHS_SCHEMA: SectionSchema = {
  label: "PathsConfig",
  fields: {
    scenarios: { field: "scenarios", kind: "string" },
    state: { field: "state", kind: "string" },
    catalog: { field: "catalog", kind: "string" },
    media: { field: "media", kind: "string" },
    lessons: { field: "lessons", kind: "string" },
  },
};

const SELECTION_SCHEMA: SectionSchema = {
  label: "SelectionConfig",
  fields: {
    strategy: { field: "strategy", kind: "string" },
    auto_assign: { field: "autoAssign", kind: "bool" },
    max_difficulty: { field: "maxDifficulty", kind: "int" },
    seed: { field: "seed", kind: "int" },
  },
};

const SCHEDULE_SCHEMA: SectionSchema = {
  label: "ScheduleConfig",
  fields: {
    enabled: { field: "enabled", kind: "bool" },
    windows: { field: "windows", kind: "windows" },
  },
};

const DEMO_SCHEMA: SectionSchema = {
  label: "DemoConfig",
  fields: {
    enabled: { field: "enabled", kind: "bool" },
    students: { field: "students", kind: "int" },
    success_rate: { field: "successRate", kind: "float" },
    reset_state: { field: "resetState", kind: "bool" },
  },
};

/**
 * Every section an `ONTRAK_<SECTION>__<KEY>` variable may address.
 *
 * One place, because the loader and the unknown-variable check both need it and they
 * must never drift apart.
 */
export const SECTION_SCHEMAS: Record<string, SectionSchema> = {
  incus: INCUS_SCHEMA,
  guest: GUEST_SCHEMA,
  session: SESSION_SCHEMA,
  pool: POOL_SCHEMA,
  guac: GUAC_SCHEMA,
  portal: PORTAL_SCHEMA,
  paths: PATHS_SCHEMA,
  selection: SELECTION_SCHEMA,
  schedule: SCHEDULE_SCHEMA,
  demo: DEMO_SCHEMA,
};

export const SECTION_NAMES: readonly string[] = Object.keys(SECTION_SCHEMAS);

/* -------------------------------------------------------------------------- */
/*  The settings tree                                                         */
/* -------------------------------------------------------------------------- */

export interface LabSettingsInit {
  incus?: IncusConfig;
  guest?: GuestConfig;
  session?: SessionConfig;
  pool?: PoolConfig;
  guac?: GuacConfig;
  portal?: PortalConfig;
  paths?: PathsConfig;
  selection?: SelectionConfig;
  schedule?: ScheduleConfig;
  demo?: DemoConfig;
  sourceFiles?: readonly string[];
  rootDir?: string;
}

export class LabSettings {
  readonly incus: IncusConfig;
  readonly guest: GuestConfig;
  readonly session: SessionConfig;
  readonly pool: PoolConfig;
  readonly guac: GuacConfig;
  readonly portal: PortalConfig;
  readonly paths: PathsConfig;
  readonly selection: SelectionConfig;
  readonly schedule: ScheduleConfig;
  readonly demo: DemoConfig;
  /** Which files contributed, for the doctor output. Paths the caller supplied. */
  readonly sourceFiles: readonly string[];
  /** What a relative path in `paths` is relative to. */
  readonly rootDir: string;

  constructor(init: LabSettingsInit = {}) {
    this.incus = init.incus ?? new IncusConfig();
    this.guest = init.guest ?? new GuestConfig();
    this.session = init.session ?? new SessionConfig();
    this.pool = init.pool ?? new PoolConfig();
    this.guac = init.guac ?? new GuacConfig();
    this.portal = init.portal ?? new PortalConfig();
    this.paths = init.paths ?? new PathsConfig();
    this.selection = init.selection ?? new SelectionConfig();
    this.schedule = init.schedule ?? new ScheduleConfig();
    this.demo = init.demo ?? new DemoConfig();
    this.sourceFiles = [...(init.sourceFiles ?? [])];
    this.rootDir = init.rootDir ?? process.cwd();
  }

  private resolve(value: string): string {
    return isAbsolute(value) ? value : join(this.rootDir, value);
  }

  get scenariosDir(): string {
    return this.resolve(this.paths.scenarios);
  }

  get stateDir(): string {
    return this.resolve(this.paths.state);
  }

  get catalogDir(): string {
    return this.resolve(this.paths.catalog);
  }

  get mediaDir(): string {
    return this.resolve(this.paths.media);
  }

  get lessonsDir(): string {
    return this.resolve(this.paths.lessons);
  }

  /**
   * No `dbPath`. The Python pointed it at `state/ontrak.sqlite3`; the port's decision
   * (§3/C3) is that the lab's rows live in this app's Postgres through Prisma, so a
   * helper naming a database file would point at something that will not exist.
   */
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                   */
/* -------------------------------------------------------------------------- */

/** Recursive merge where a mapping replaces a mapping. Arrays are replaced whole. */
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    out[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
  }
  return out;
}

/** One section's values, keyed by the camelCase field, with unknown keys refused. */
function sectionValues(schema: SectionSchema, data: unknown): Record<string, unknown> {
  const record = isRecord(data) ? data : {};
  const known = Object.keys(schema.fields);
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown setting(s) for ${schema.label}: ${[...unknown].sort().join(", ")}. ` +
        `Known: ${[...known].sort().join(", ")}`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.fields)) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      out[spec.field] = coerce(spec.kind, record[key], key);
    }
  }
  return out;
}

/**
 * One section's values, in the shape that section's own constructor takes.
 *
 * The record is assembled from the schema table at runtime, so no single section's
 * init type describes it; `T` is inferred from the parameter of the constructor each
 * call site passes it to (`new GuacConfig(asSectionConfig(...))`), which keeps the
 * assertion in one place instead of ten. It is the only cast in this file `tsc`
 * cannot check for us, which is exactly why every field is coerced through its schema
 * — and why an unreadable value is refused by name rather than passed through.
 */
function asSectionConfig<T>(data: unknown): T {
  return (isRecord(data) ? data : {}) as T;
}

/** Collect `ONTRAK_<SECTION>__<KEY>` into nested records. */
function envOverrides(env: Record<string, string | undefined>): Record<string, Record<string, unknown>> {
  const nested: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || key === CONFIG_ENV) continue;
    const rest = key.slice(ENV_PREFIX.length);
    const split = rest.indexOf("__");
    // Not a section-scoped override: ignored rather than guessed at.
    if (split === -1) continue;
    const section = rest.slice(0, split).toLowerCase();
    const leaf = rest.slice(split + 2).toLowerCase();
    const values = nested[section] ?? {};
    values[leaf] = parseEnvValue(raw ?? "");
    nested[section] = values;
  }
  return nested;
}

/**
 * Check the environment before it is merged, so a bad variable is named as a variable.
 *
 * Two rules, both the Python's. A leaf that names no field of a section the app models
 * is an error naming the variable — this is what turns a spent `ONTRAK_...` left in an
 * operator's `.env` into a message they can act on instead of a bare field name. A
 * section the app does not model (`ONTRAK_FOO__BAR`) stays ignored, because other
 * tooling shares the environment and a name that was never a setting must not become a
 * boot failure.
 */
function checkEnv(env: Record<string, string | undefined>): Record<string, Record<string, unknown>> {
  const overrides = envOverrides(env);
  for (const [section, values] of Object.entries(overrides)) {
    const schema = SECTION_SCHEMAS[section];
    if (schema === undefined) continue;
    const known = Object.keys(schema.fields);
    for (const leaf of Object.keys(values)) {
      const variable = `${ENV_PREFIX}${section.toUpperCase()}__${leaf.toUpperCase()}`;
      const spec = schema.fields[leaf];
      if (spec === undefined) {
        throw new ConfigError(
          `unknown setting ${variable} for ${schema.label}: not one of ${[...known].sort().join(", ")}. ` +
            `Remove it from the environment — if it came from a .env file, delete the line there.`,
        );
      }
      values[leaf] = coerce(spec.kind, values[leaf], variable);
    }
  }
  return overrides;
}

export interface LoadSettingsOptions {
  /** The deployment's config file, already parsed by the caller. */
  file?: Record<string, unknown> | null;
  /** The local override file, already parsed. */
  local?: Record<string, unknown> | null;
  /** The environment map. Defaults to `process.env` at this one entry point. */
  env?: Record<string, string | undefined>;
  /** Explicit overrides, highest precedence. */
  overrides?: Record<string, unknown> | null;
  /** Paths to name in `sourceFiles`, for the doctor output. */
  sourceFiles?: readonly string[];
  /** What a relative path in `paths` resolves against. Defaults to the process's cwd. */
  rootDir?: string;
}

/**
 * Load the lab's settings.
 *
 * The caller parses its own files — this module does no I/O — and the merge order is
 * file, local, environment, overrides, so an explicit override still wins over the
 * environment exactly as it did in Python.
 */
export function loadSettings(options: LoadSettingsOptions = {}): LabSettings {
  const env = options.env ?? process.env;
  const sources: string[] = [...(options.sourceFiles ?? [])];
  let data: Record<string, unknown> = isRecord(options.file) ? options.file : {};
  if (isRecord(options.local)) {
    data = deepMerge(data, options.local);
  }
  data = deepMerge(data, checkEnv(env));
  if (isRecord(options.overrides)) {
    data = deepMerge(data, options.overrides);
    sources.push("<overrides>");
  }

  return new LabSettings({
    incus: new IncusConfig(asSectionConfig(sectionValues(INCUS_SCHEMA, data.incus))),
    guest: new GuestConfig(asSectionConfig(sectionValues(GUEST_SCHEMA, data.guest))),
    session: new SessionConfig(asSectionConfig(sectionValues(SESSION_SCHEMA, data.session))),
    pool: new PoolConfig(asSectionConfig(sectionValues(POOL_SCHEMA, data.pool))),
    guac: new GuacConfig(asSectionConfig(sectionValues(GUAC_SCHEMA, data.guac))),
    portal: new PortalConfig(asSectionConfig(sectionValues(PORTAL_SCHEMA, data.portal))),
    paths: new PathsConfig(asSectionConfig(sectionValues(PATHS_SCHEMA, data.paths))),
    selection: new SelectionConfig(asSectionConfig(sectionValues(SELECTION_SCHEMA, data.selection))),
    schedule: new ScheduleConfig(asSectionConfig(sectionValues(SCHEDULE_SCHEMA, data.schedule))),
    demo: new DemoConfig(asSectionConfig(sectionValues(DEMO_SCHEMA, data.demo))),
    sourceFiles: sources,
    rootDir: options.rootDir ?? process.cwd(),
  });
}

/* -------------------------------------------------------------------------- */
/*  Derived facts the callers ask for                                         */
/* -------------------------------------------------------------------------- */

/**
 * The bytes behind the configured Guacamole key.
 *
 * The rule lives in `guac.ts` — one hex check for the whole lab — so this is a
 * convenience for a caller holding the settings tree, not a second implementation.
 */
export function guacSecretBytes(guac: GuacConfig | GuacSettings): Buffer {
  return guacKeyBytes(guac);
}

export function defaultTimeLimit(session: SessionConfig): number {
  const first = session.timeLimitChoices[0];
  return first === undefined ? session.ttlMinutes : first;
}

/**
 * Warm-pool target for a (scenario, workload) pair.
 *
 * The explicit `<scenario>@<workload>` key wins, then the plain scenario key, then the
 * default. That ordering is what lets a site say "30 Windows 11 DNS machines, but only
 * 5 of them on Ubuntu" without two config blocks per scenario.
 */
export function poolTargetFor(pool: PoolConfig, scenarioId: string, workload = ""): number {
  if (workload) {
    const explicit = pool.targets[`${scenarioId}@${workload}`];
    if (explicit !== undefined) return explicit;
  }
  const byScenario = pool.targets[scenarioId];
  return byScenario === undefined ? pool.defaultTarget : byScenario;
}

/** The schedule section as the scheduler reads it. */
export function scheduleToSchedule(config: ScheduleConfig): LabSchedule {
  return LabSchedule.fromConfig({ enabled: config.enabled, windows: config.windows });
}

/** Create the state and media directories. Explicit, so loading config has no side effects. */
export function ensureDirs(settings: LabSettings): void {
  mkdirSync(settings.stateDir, { recursive: true });
  mkdirSync(settings.mediaDir, { recursive: true });
}

/**
 * The whole tree as plain data, under the operator's own key spellings.
 *
 * This is `dataclass_to_dict` from the Python, and it is what the doctor output and the
 * admin panel print — so the keys are the snake_case ones a deployment's file uses, not
 * the camelCase fields this code reads.
 */
export function settingsToDict(settings: LabSettings): Record<string, unknown> {
  const sections: Record<string, object> = {
    incus: settings.incus,
    guest: settings.guest,
    session: settings.session,
    pool: settings.pool,
    guac: settings.guac,
    portal: settings.portal,
    paths: settings.paths,
    selection: settings.selection,
    schedule: settings.schedule,
    demo: settings.demo,
  };
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SECTION_SCHEMAS)) {
    const section = sections[name];
    const fields = (section ?? {}) as unknown as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(schema.fields)) values[key] = fields[spec.field];
    out[name] = values;
  }
  out.source_files = [...settings.sourceFiles];
  return out;
}

/**
 * Every problem that stops the lab from starting, or an empty list.
 *
 * Demo mode short-circuits: it never touches a hypervisor or a guest, so it runs with
 * no secrets at all, which is what makes "clone and try it" a two-command experience.
 */
export function requireSecrets(settings: LabSettings): string[] {
  const problems: string[] = [];
  if (settings.demo.enabled) return problems;
  if (!settings.guest.password) {
    problems.push("guest.password is empty (set ONTRAK_GUEST__PASSWORD)");
  }
  if (!settings.portal.secret) {
    problems.push("portal.secret is empty (set ONTRAK_PORTAL__SECRET)");
  }
  try {
    guacSecretBytes(settings.guac);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    problems.push(`guac.secret_key is unusable — ${detail} Set ONTRAK_GUAC__SECRET_KEY.`);
  }
  return problems;
}
