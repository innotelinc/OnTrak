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
  const rows = await readRegistry();
  await sweepPreviews(rows);
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPreview(name: string): Promise<Preview | null> {
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

function ttlFor(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? config.previewTtlMs;
  return ttl > 0 ? Date.now() + ttl : 0;
}

/**
 * Register (and, with a command, start) a preview.
 *
 * Creation is idempotent on the port: a second request for a port that is already
 * registered returns the existing record rather than leaking a duplicate address.
 */
export async function createPreview(options: CreatePreviewOptions = {}): Promise<Preview> {
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
  if (existingPort !== undefined) return existingPort;

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
    expiresAt: ttlFor(options.ttlMs),
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
      child.once("exit", () => {
        children.delete(preview.name);
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
  const rows = await readRegistry();
  const found = rows.find((row) => row.name === name);
  if (found === undefined) return false;
  killPreviewProcess(name);
  await writeRegistry(rows.filter((row) => row.name !== name));
  return true;
}

/** Stop a preview's process but keep its address registered. */
export async function stopPreview(name: string): Promise<boolean> {
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

// --- public projection ------------------------------------------------------

/** The registry record as the browser should see it. */
export function previewPublic(preview: Preview): Record<string, unknown> {
  return {
    name: preview.name,
    host: previewDomainName(preview.name),
    url: previewUrl(preview.name),
    port: preview.port,
    custom: preview.custom,
    command: preview.command,
    running: children.has(preview.name) || preview.pid !== null,
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
  };
}
