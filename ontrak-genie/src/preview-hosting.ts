/**
 * Preview hosting — temporary public addresses for servers running in a workspace.
 *
 * Genie is reached at one console name (`genie.innotel.us`). A single wildcard
 * (`*.genie.innotel.us`) is registered once in Cerulean — one DNS record, one
 * edge proxy host, one wildcard certificate — and points at this server. So every
 * preview subdomain arrives here, and Genie maps the left-most label to a loopback
 * port: `p4001.genie.innotel.us` is whatever is listening on 4001.
 *
 * That is the whole reason the address is `p<port>`: the port *is* the label, so a
 * preview needs no DNS write and no edge change, and the number of live previews
 * is bounded only by the port range rather than by how many proxy hosts somebody
 * is willing to create. Registering the wildcard is a one-time Cerulean operation
 * (`scripts/cerulean-genie-previews.py`).
 *
 * A paid subscriber (Magnate, the `genie` plan) may claim a *named* address —
 * `acme.genie.innotel.us` — instead of a port. `claimPreview` checks the
 * entitlement with Magnate before it registers the name.
 *
 * What this module does NOT do: it does not make a server safe. A preview is a
 * development server exposed to the network, so the feature is off unless an
 * operator turns it on (`PREVIEW_ENABLED`) and a command started by Genie runs
 * outside the command sandbox — a sandbox with no network and no published port
 * cannot serve one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";

import { config } from "./config.js";

/** A registered preview: an address, the port behind it, and how it is served. */
export interface Preview {
  /** The left-most label, lowercased. `p4001`, or a subscriber's chosen name. */
  name: string;
  /** The loopback port the backend listens on. */
  port: number;
  /** Address the backend is reached at (`PREVIEW_BACKEND_HOST`). */
  host: string;
  /** Absolute working directory a command runs in, or "". */
  cwd: string;
  /** Account that owns it, or "" for the deployment's shared scope. */
  account: string;
  /** True for a paid custom name; false for an auto `p<port>` address. */
  custom: boolean;
  /** The command Genie started, or "" when the server was started elsewhere. */
  command: string;
  /** OS process id of the process Genie started, or null. */
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  /** Epoch ms after which the address is swept. 0 means it never expires. */
  expiresAt: number;
  /**
   * Whether the server behind this address is up, when this record came from a
   * remote hosting server rather than this process. `undefined` means "work it
   * out from the local children", which is the in-process case.
   */
  running?: boolean;
}

export class PreviewError extends Error {}

/** Long-running children this process started, keyed by preview name. */
const children = new Map<string, ChildProcess>();

/** Names that may never be a preview label. */
const RESERVED = new Set([
  "",
  "www",
  "api",
  "admin",
  "auth",
  "login",
  "logout",
  "mail",
  "assets",
  "static",
  "localhost",
]);

/** A label an auto-allocated address uses: the port itself. */
const AUTO_NAME = /^p([0-9]{2,5})$/;

const NAME_RULE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function previewEnabled(): boolean {
  return config.previewEnabled;
}

/**
 * Whether *hosting* is available — here or on a separate hosting server.
 *
 * `previewEnabled()` is about this process: it decides whether the console routes
 * the preview wildcard, and a console that delegates must not. This is the wider
 * question the hosting UI asks, and the answer stays true when the processes were
 * moved to their own container (`GENIE_HOSTING_URL`).
 */
export function hostingEnabled(): boolean {
  return config.previewEnabled || hostingRemote();
}

/** Whether hosting runs somewhere else and this process is only its client. */
function hostingRemote(): boolean {
  return config.hostingUrl !== "";
}

/** The projection of a preview the hosting server returns over the wire. */
interface RemotePreviewRow {
  name?: unknown;
  port?: unknown;
  custom?: unknown;
  command?: unknown;
  running?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Rebuild an internal record from the hosting server's public projection.
 *
 * The projection is deliberately thin — it drops the loopback port's host, the
 * absolute cwd and the pid — because none of those are the client's business. What
 * it keeps is what the console renders, and `running` is carried across so the UI
 * says the same thing about a remote preview as it would about a local one.
 */
function previewFromRow(row: RemotePreviewRow): Preview {
  const createdAt = typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString();
  const running = row.running === true;
  return {
    name: String(row.name ?? ""),
    port: typeof row.port === "number" ? row.port : 0,
    host: config.previewBackendHost,
    cwd: "",
    account: "",
    custom: row.custom === true,
    command: typeof row.command === "string" ? row.command : "",
    pid: running ? 1 : null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
    running,
  };
}

/**
 * One call to the hosting server.
 *
 * A failure is surfaced as a `PreviewError` the routes already turn into a 400, so
 * an unreachable hosting server reads as "preview hosting is not answering" rather
 * than as a stack trace — the same way an unreachable Magnate is reported.
 */
async function remoteRequest(
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (config.hostingToken !== "") headers.Authorization = `Bearer ${config.hostingToken}`;
  let response: Response;
  try {
    response = await fetch(`${config.hostingUrl}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new PreviewError(`the preview hosting server is unreachable: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as unknown;
  return { status: response.status, body };
}

/** Normalize a requested label, or throw with the reason it cannot be used. */
export function normalizePreviewName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (name === "") throw new PreviewError("a preview name is required");
  if (name.includes(".")) throw new PreviewError("a preview name is a single label, not a hostname");
  if (RESERVED.has(name)) throw new PreviewError(`\"${name}\" is reserved`);
  if (!NAME_RULE.test(name)) {
    throw new PreviewError(
      "a preview name must be 1–63 characters of letters, numbers and internal dashes",
    );
  }
  return name;
}

/** True for an auto address (`p<port>`), which is not a paid custom name. */
export function isAutoPreviewName(name: string): boolean {
  return AUTO_NAME.test(name);
}

/** The full public hostname for a preview label. */
export function previewDomainName(name: string): string {
  return `${name}.${config.previewDomain.toLowerCase()}`;
}

/** The public URL a person opens. */
export function previewUrl(name: string): string {
  return `${config.previewScheme}://${previewDomainName(name)}`;
}

/**
 * The preview label a request's `Host` names, or null when it is not a preview.
 *
 * Only one level deep, deliberately: `p4001.genie.innotel.us` is a preview, and
 * `a.b.genie.innotel.us` is not, so a preview cannot shadow a deeper name someone
 * else owns. The console's own `genie.innotel.us` never matches — the suffix has
 * to leave a label of its own.
 */
export function previewLabelFromHost(hostHeader: string | undefined): string | null {
  const hostname = String(hostHeader ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .split(":")[0];
  if (hostname === undefined || hostname === "") return null;
  const suffix = `.${config.previewDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (label === "" || label.includes(".")) return null;
  return label;
}

// --- the registry -----------------------------------------------------------

let cache: Preview[] | null = null;

function registryPath(): string {
  return path.join(config.dataDir, "previews.json");
}

async function readRegistry(): Promise<Preview[]> {
  if (cache !== null) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(registryPath(), "utf8")) as unknown;
    const rows = Array.isArray(raw) ? raw : [];
    cache = rows.map(coercePreview).filter((row): row is Preview => row !== null);
  } catch {
    // A missing or unreadable registry is the ordinary first-run state, not an
    // error: refusing to serve previews because a file could not be parsed would
    // trade a working console for a nicer complaint.
    cache = [];
  }
  return cache;
}

function coercePreview(row: unknown): Preview | null {
  if (row === null || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (typeof value.name !== "string" || typeof value.port !== "number") return null;
  return {
    name: value.name,
    port: value.port,
    host: typeof value.host === "string" ? value.host : config.previewBackendHost,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    account: typeof value.account === "string" ? value.account : "",
    custom: value.custom === true,
    command: typeof value.command === "string" ? value.command : "",
    pid: typeof value.pid === "number" ? value.pid : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : 0,
  };
}

async function writeRegistry(rows: Preview[]): Promise<void> {
  cache = rows;
  await fs.mkdir(config.dataDir, { recursive: true });
  const file = registryPath();
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

/** Forget the in-memory copy. For tests, so a fresh data dir is picked up. */
export function resetPreviewCache(): void {
  cache = null;
}

/** Every registered preview, after expired ones have been swept. */
export async function listPreviews(): Promise<Preview[]> {
  if (hostingRemote()) {
    const { status, body } = await remoteRequest("/api/previews");
    if (status !== 200) return [];
    const rows = (body as { previews?: unknown[] }).previews ?? [];
    return rows
      .map((row) => previewFromRow(row as RemotePreviewRow))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows = await readRegistry();
  await sweepPreviews(rows);
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPreview(name: string): Promise<Preview | null> {
  if (hostingRemote()) {
    const { status, body } = await remoteRequest(`/api/previews/${encodeURIComponent(name)}`);
    if (status !== 200) return null;
    const row = (body as { preview?: unknown }).preview;
    return row === undefined ? null : previewFromRow(row as RemotePreviewRow);
  }
  const rows = await readRegistry();
  const found = rows.find((row) => row.name === name) ?? null;
  if (found !== null && isExpired(found)) {
    await removePreview(found.name);
    return null;
  }
  return found;
}

/** The preview a request's `Host` names, or null when nothing is registered. */
export async function previewForHost(hostHeader: string | undefined): Promise<Preview | null> {
  const label = previewLabelFromHost(hostHeader);
  if (label === null) return null;
  return await getPreview(label);
}

function isExpired(preview: Preview): boolean {
  return preview.expiresAt > 0 && preview.expiresAt <= Date.now();
}

/** Self-check: drop and kill anything past its TTL. */
export async function sweepPreviews(rows?: Preview[]): Promise<number> {
  const current = rows ?? (await readRegistry());
  const live = current.filter((row) => !isExpired(row));
  const removed = current.length - live.length;
  if (removed === 0) return 0;
  for (const row of current) {
    if (isExpired(row)) killPreviewProcess(row.name);
  }
  await writeRegistry(live);
  return removed;
}

// --- port allocation --------------------------------------------------------

/** Whether a loopback port is free right now, independent of the registry. */
export function portIsFree(port: number, host = config.previewBackendHost): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, host);
  });
}

/**
 * The first free port in the configured range that is not already registered.
 *
 * Both halves matter: the registry keeps two previews from claiming one address,
 * and the live bind test keeps a preview from taking a port something outside
 * Genie is already listening on.
 */
export async function allocatePort(exclude: Iterable<number> = []): Promise<number> {
  const taken = new Set(exclude);
  if (config.previewPortEnd < config.previewPortStart) {
    throw new PreviewError("PREVIEW_PORT_END is below PREVIEW_PORT_START");
  }
  for (let port = config.previewPortStart; port <= config.previewPortEnd; port += 1) {
    if (taken.has(port)) continue;
    if (await portIsFree(port)) return port;
  }
  throw new PreviewError(
    `no free preview port in ${config.previewPortStart}-${config.previewPortEnd}`,
  );
}

// --- lifecycle --------------------------------------------------------------

export interface CreatePreviewOptions {
  /** Requested label. Omitted, a `p<port>` address is allocated. */
  name?: string;
  /** Requested port. Omitted, the first free port in the range is used. */
  port?: number;
  /** Absolute working directory the command runs in. */
  cwd?: string;
  /** Shell command to start; omitted, the record is registered only. */
  command?: string;
  /** Account that owns the preview. */
  account?: string;
  /** Magnate subscriber identity, required for a custom name. */
  user?: string;
  /** TTL in ms; omitted, `PREVIEW_TTL_MS` applies. 0 never expires. */
  ttlMs?: number;
}

/**
 * When this preview expires.
 *
 * A named address gets the long TTL — it is the thing the plan sells, and it has
 * to still be there after lunch. A free `p<port>` address gets the short one,
 * because free addresses are allocated from one bounded port range: every
 * abandoned one is a port nobody else can publish on. An explicit `ttlMs` from
 * the caller always wins, so a test (or an operator script) can pin either.
 */
function ttlFor(ttlMs: number | undefined, custom: boolean): number {
  const ttl = ttlMs ?? (custom ? config.previewTtlMs : config.previewFreeTtlMs);
  return ttl > 0 ? Date.now() + ttl : 0;
}

/**
 * Register (and, with a command, start) a preview.
 *
 * Creation is idempotent on the port: a second request for a port that is already
 * registered returns the existing record rather than leaking a duplicate address.
 */
export async function createPreview(options: CreatePreviewOptions = {}): Promise<Preview> {
  if (hostingRemote()) {
    const { status, body } = await remoteRequest("/api/previews", {
      method: "POST",
      body: JSON.stringify({ ...options }),
    });
    if (status !== 201 && status !== 200) {
      throw new PreviewError(
        (body as { error?: string }).error ?? `the preview hosting server returned HTTP ${status}`,
      );
    }
    const row = (body as { preview?: unknown }).preview;
    if (row === undefined) throw new PreviewError("the preview hosting server returned no preview");
    return previewFromRow(row as RemotePreviewRow);
  }
  const rows = await readRegistry();
  await sweepPreviews(rows);

  const requestedName = options.name === undefined ? "" : normalizePreviewName(options.name);
  const custom = requestedName !== "" && !isAutoPreviewName(requestedName);
  if (custom && (options.user ?? "") === "") {
    throw new PreviewError("a custom preview name needs a Magnate subscriber identity");
  }

  let port = options.port;
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new PreviewError(`\"${port}\" is not a port`);
    }
  } else {
    port = await allocatePort(rows.map((row) => row.port));
  }

  const existingPort = rows.find((row) => row.port === port);
  if (existingPort !== undefined) {
    // Idempotent for an address that is already serving — a duplicate publish
    // must not bounce a healthy app — but *not* for one that is registered and
    // down. A preview that died, or that an operator stopped, is the case a
    // publish is trying to fix, so a request carrying a command starts it again
    // instead of handing the caller back the dead record. Without this the caller
    // gets `201` with `running: false`, the address stays dark, and the page they
    // are looking at goes on saying it is not answering yet.
    //
    // "Serving" is asked of the port, not of the record: the record can outlive
    // the process it names. A preview that fails leaves a pid behind, and a spawn
    // that lands after a stop can write one back, so a pid is evidence of a
    // process having been started rather than of anything being answered. The
    // port is the thing the user is actually looking at.
    if ((options.command ?? "") !== "" && (await portIsFree(existingPort.port))) {
      existingPort.command = options.command ?? "";
      if ((options.cwd ?? "") !== "") existingPort.cwd = options.cwd ?? "";
      if ((options.account ?? "") !== "") existingPort.account = options.account ?? "";
      // A restart is a fresh publish, so the address gets a fresh TTL: one
      // republished a second before it expired should not vanish on the next
      // sweep.
      existingPort.expiresAt = ttlFor(options.ttlMs, existingPort.custom);
      existingPort.updatedAt = new Date().toISOString();
      startPreviewProcess(existingPort);
      await writeRegistry(rows);
    }
    return existingPort;
  }

  const name = requestedName === "" ? `p${port}` : requestedName;
  const existingName = rows.find((row) => row.name === name);
  if (existingName !== undefined) {
    throw new PreviewError(`\"${name}\" is already registered (port ${existingName.port})`);
  }

  if (custom) {
    const entitled = await magnateEntitled(options.user ?? "");
    if (!entitled) {
      throw new PreviewError(
        `\"${options.user}\" has no active subscription for a custom preview name`,
      );
    }
  }

  const now = new Date().toISOString();
  const preview: Preview = {
    name,
    port,
    host: config.previewBackendHost,
    cwd: options.cwd ?? "",
    account: options.account ?? "",
    custom,
    command: options.command ?? "",
    pid: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlFor(options.ttlMs, custom),
  };

  if (preview.command !== "") startPreviewProcess(preview);

  rows.push(preview);
  await writeRegistry(rows);
  return preview;
}

/** Start the preview's command as a detached process, logging beside the data. */
function startPreviewProcess(preview: Preview): void {
  const logDir = path.join(config.dataDir, "previews");
  // The span between the spawn and the first write is tiny and the mkdir is
  // idempotent, so it is deliberately synchronous-ish: the child cannot write
  // before the descriptor exists.
  const logPath = path.join(logDir, `${preview.name}.log`);
  void fs.mkdir(logDir, { recursive: true }).then(() => {
    return fs.open(logPath, "a").then((handle) => {
      const child = spawn("bash", ["-lc", preview.command], {
        cwd: preview.cwd === "" ? config.workspace : preview.cwd,
        env: {
          ...process.env,
          PORT: String(preview.port),
          PREVIEW_PORT: String(preview.port),
          PREVIEW_URL: previewUrl(preview.name),
          GENIE_PREVIEW: "1",
          HOST: "0.0.0.0",
        },
        // Its own process group, so stopping the preview kills the server and
        // anything it forked rather than leaving an orphan on the port.
        detached: true,
        stdio: ["ignore", handle.fd, handle.fd],
      });
      child.unref();
      children.set(preview.name, child);
      preview.pid = child.pid ?? null;
      // A spawn that never becomes a process — an unknown `cwd`, a missing
      // interpreter — emits `error` and never `exit`. With no listener that event
      // is an uncaught exception, and it takes the *whole hosting server* down:
      // one preview that could not start becomes every address going dark, and
      // the console reads the outage as "the hosting server is unreachable".
      // Record the failure against the preview and keep this process serving the
      // others, so a bad `cwd` is one address that does not answer rather than an
      // outage nobody can attribute.
      //
      // Both handlers are guarded by identity, and that guard is load-bearing: a
      // name can have more than one child behind it over time. Publishing an
      // address that is registered and down starts it again, which means a stop
      // and a spawn in quick succession under the *same* name — and the stopped
      // child's `exit` can land after the new one has registered itself here. An
      // unguarded `children.delete(preview.name)` would then delete the *new*
      // child's entry, orphaning a process that is serving the port with nothing
      // left that can kill it: the address answers, the record's pid is stale, and
      // stopping it stops nothing. `preview.pid = null` is the same hazard from
      // the other side — a late `error` from a child that is already forgotten
      // must not unname the one that replaced it.
      child.once("error", (error) => {
        if (children.get(preview.name) === child) {
          children.delete(preview.name);
          preview.pid = null;
        }
        void fs
          .appendFile(logPath, `\n[preview] could not start: ${error.message}\n`)
          .catch(() => undefined);
      });
      child.once("exit", () => {
        if (children.get(preview.name) === child) children.delete(preview.name);
      });
      void handle.close();
    });
  });
}

function killPreviewProcess(name: string): void {
  const child = children.get(name);
  if (child?.pid !== undefined && child.pid !== null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone, or not our process group: best effort either way.
    }
  }
  children.delete(name);
}

/** Stop a preview's process and drop its address. */
export async function removePreview(name: string): Promise<boolean> {
  if (hostingRemote()) {
    const { status, body } = await remoteRequest(`/api/previews/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    return status === 200 && (body as { removed?: boolean }).removed === true;
  }
  const rows = await readRegistry();
  const found = rows.find((row) => row.name === name);
  if (found === undefined) return false;
  killPreviewProcess(name);
  await writeRegistry(rows.filter((row) => row.name !== name));
  return true;
}

/** Stop a preview's process but keep its address registered. */
export async function stopPreview(name: string): Promise<boolean> {
  if (hostingRemote()) {
    const { status, body } = await remoteRequest(
      `/api/previews/${encodeURIComponent(name)}/stop`,
      { method: "POST" },
    );
    return status === 200 && (body as { stopped?: boolean }).stopped === true;
  }
  const rows = await readRegistry();
  const found = rows.find((row) => row.name === name);
  if (found === undefined) return false;
  killPreviewProcess(name);
  found.pid = null;
  found.updatedAt = new Date().toISOString();
  await writeRegistry(rows);
  return true;
}

// --- Magnate entitlement ----------------------------------------------------

/** The shape of the answer Magnate's entitlement API returns. */
interface EntitlementAnswer {
  entitled?: boolean | null;
  reason?: string;
}

/**
 * Ask Magnate whether a subscriber may hold a custom preview name.
 *
 * A refusal is a refusal, but an unreachable Magnate is an *error* rather than a
 * silent "no": telling a paying subscriber their subscription is inactive when
 * the billing platform is simply down is the one wrong answer here.
 */
export async function magnateEntitled(user: string): Promise<boolean> {
  const base = config.magnateEntitlementsUrl;
  if (base === "") {
    throw new PreviewError(
      "MAGNATE_ENTITLEMENTS_URL is not set, so custom preview names are unavailable",
    );
  }
  const url = `${base}?plan=${encodeURIComponent(config.magnatePlan)}&user=${encodeURIComponent(user)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.magnateEntitlementsToken !== "") {
    headers.Authorization = `Bearer ${config.magnateEntitlementsToken}`;
  }
  let answer: EntitlementAnswer;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    answer = (await response.json()) as EntitlementAnswer;
  } catch (error) {
    throw new PreviewError(`could not reach Magnate to check the entitlement: ${(error as Error).message}`);
  }
  return answer.entitled === true;
}

// --- reverse proxy ----------------------------------------------------------

/** Headers that must not be copied upstream (hop-by-hop). */
const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(
  req: http.IncomingMessage,
  preview: Preview,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  // The preview's own public name is what a dev server sees, so absolute URLs it
  // generates and the host allow-list many dev servers enforce both match what
  // the browser typed.
  headers.host = previewDomainName(preview.name);
  headers["x-forwarded-host"] = req.headers.host ?? previewDomainName(preview.name);
  headers["x-forwarded-proto"] = config.previewScheme;
  headers["x-genie-preview"] = preview.name;
  return headers;
}

/**
 * Reverse-proxy one HTTP request to the preview's loopback port.
 *
 * Errors are reported as a 502 the browser can read, never as a thrown error that
 * would leave the connection open: the usual cause is that the server has not
 * started yet, and saying so is the difference between a wait and a mystery.
 */
export function proxyPreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  preview: Preview,
): void {
  const upstream = http.request(
    {
      host: preview.host,
      port: preview.port,
      method: req.method,
      path: req.url ?? "/",
      headers: forwardedHeaders(req, preview),
    },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    },
  );

  upstream.on("error", () => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>preview starting</title>` +
        `<h1>${preview.name} is not answering yet</h1>` +
        `<p>Nothing is listening on ${preview.host}:${preview.port}. ` +
        `A build may still be running — refresh in a moment.</p>`,
    );
  });

  req.pipe(upstream);
}

/**
 * Proxy a WebSocket (or any connection upgrade) to the preview's port, which is
 * what a dev server's live reload needs. A socket that cannot connect is closed
 * rather than left half-open.
 */
export function proxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  preview: Preview,
): void {
  const upstream = net.connect(preview.port, preview.host, () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    const headers = forwardedHeaders(req, preview);
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${key}: ${value}`);
      }
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// --- the clock --------------------------------------------------------------

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Sweep on a timer, so a TTL is a deadline rather than a hope.
 *
 * Expiry used to be enforced only when the registry was *read* — at boot, or by
 * a request that lists previews — which means a free address nobody is looking at
 * keeps its port **and its process** well past the thirty minutes it was given.
 * That defeats the point of a short free TTL, which is that the port comes back.
 * So the clock is enforced by this process rather than by somebody's next visit.
 *
 * Unref'd, like the health loop: a sweep must never be the reason this process
 * stays alive, and `stopModelHealthLoop`'s counterpart here exists for tests.
 */
export function startPreviewSweepLoop(): void {
  if (config.previewSweepIntervalMs <= 0 || sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    void sweepPreviews().catch(() => {
      // An unreadable registry is reported by the routes that need it; a timer
      // that threw once a minute would be noise rather than information.
    });
  }, config.previewSweepIntervalMs);
  sweepTimer.unref();
}

/** Stop the timer. Only used by tests. */
export function stopPreviewSweepLoop(): void {
  if (sweepTimer !== null) clearInterval(sweepTimer);
  sweepTimer = null;
}

// --- public projection ------------------------------------------------------

/** The registry record as the browser should see it. */
/**
 * Whether a preview's process is up.
 *
 * One definition, shared by the projection the API returns and by the publish
 * decision above, so the two can never disagree about what "running" means.
 */
function previewIsRunning(preview: Preview): boolean {
  return preview.running ?? (children.has(preview.name) || preview.pid !== null);
}

export function previewPublic(preview: Preview): Record<string, unknown> {
  return {
    name: preview.name,
    host: previewDomainName(preview.name),
    url: previewUrl(preview.name),
    port: preview.port,
    custom: preview.custom,
    command: preview.command,
    running: previewIsRunning(preview),
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
  };
}
