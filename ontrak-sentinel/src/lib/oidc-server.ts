/**
 * OIDC server (S1): the `node:http` adapter over `routeOidc`, and the assembly
 * that turns configuration into a running provider.
 *
 * The adapter is the whole of the framework: read the bytes, hand them to the
 * pure router, write the answer back. Nothing decides anything there — the same
 * router runs in a test with no socket and in a deployment with one, which is
 * what makes the HTTP surface testable without a running server.
 *
 * The one judgement is the request line: `node:http` hands over a path, while the
 * router wants an absolute URL, so the adapter reconstructs one from the `Host`
 * header (and `X-Forwarded-Proto`, because behind a proxy the scheme is in the
 * header and not in the socket). A body is read with a cap, so a client cannot
 * make the provider allocate without bound.
 *
 * The assembly at the bottom mirrors `identity-server.ts`: `createOidcServices`
 * builds a stack over any client-shaped object, and `configureOidc`/
 * `oidcServices` bind the one the process uses. Persistence lives behind the
 * `OidcStore` port, so the same engine runs over Prisma or, in tests and the
 * in-memory dev provider, over `MemoryOidcStore`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";


import type { HashFn } from "./audit-chain";
import type { AuditTrail, IdentityService, IdentityStore } from "./identity-service";
import { routeConsole, type ConsoleEndpoints } from "./console-http";
import { routeGuard, type GuardEndpoints } from "./guard-http";
import type { HttpRequest, HttpResponse, OidcEndpoints } from "./oidc-http";
import { routeOidc } from "./oidc-http";
import { OidcService, type OidcConfig, type OidcIds, type OidcStore } from "./oidc-service";
import { routeSaml, type SamlEndpoints } from "./saml-http";
import { routeScim, type ScimEndpoints } from "./scim-http";

/** A form post is a few kilobytes; anything larger is not one. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The liveness path the family's portal probes to draw a product's status light.
 *
 * Unauthenticated by design: asking the Network "are you there" must not need a
 * credential the portal would have to hold, which is why every member of the
 * family exposes one path for it. It sits at the root rather than under
 * `/console` so it is answerable before sign-in is reachable at all.
 */
export const HEALTH_PATH = "/health";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Parse a `Cookie` header into a plain map. The router does not guess a split. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** The absolute URL the router expects, reconstructed from the request line. */
export function absoluteUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "127.0.0.1";
  const forwarded = request.headers["x-forwarded-proto"];
  const scheme = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || "http";
  return new URL(request.url ?? "/", `${scheme}://${host}`).toString();
}

export function toHttpRequest(request: IncomingMessage, body: string): HttpRequest {
  return {
    method: request.method ?? "GET",
    url: absoluteUrl(request),
    headers: request.headers as Record<string, string | undefined>,
    body,
    cookies: parseCookies(request.headers.cookie),
  };
}

export function sendResponse(response: ServerResponse, result: HttpResponse): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

/**
 * The other surfaces that share this listener.
 *
 * Each is a pure router over the same plain request/response shapes, so the adapter
 * below knows nothing about any of them beyond the order they are asked in.
 */
export interface ServerSurfaces {
  saml?: SamlEndpoints | null;
  console?: ConsoleEndpoints | null;
  scim?: ScimEndpoints | null;
  /** Telemetry ingest (S3). Absent unless the deployment issued an ingest token. */
  guard?: GuardEndpoints | null;
  /**
   * Bytes served verbatim, keyed by path: the shared theme.
   *
   * The theme is two files that only ever change as a pair with the canonical copies
   * in `theme/`, so they are read once at startup and held in memory rather than read
   * per request — a console page that had to hit the disk for its stylesheet would put
   * a filesystem in the path of every render. This is also why they are not a router:
   * a router decides, and these are just a file.
   */
  assets?: Record<string, { body: string; contentType: string }> | null;
}

/**
 * The liveness answer, or `null` when this is not the health path.
 *
 * It reports only that the process is up and answering. A check that also
 * depended on Postgres would take the product down for a dependency the caller
 * cannot fix and turn a slow query into an outage report; the database's own
 * health is the compose healthcheck's business, not the portal's.
 */
function health(request: HttpRequest): HttpResponse | null {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
  if (pathname !== HEALTH_PATH) return null;
  return {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: method === "HEAD" ? "" : JSON.stringify({ status: "ok", service: "ontrak-sentinel" }),
  };
}

/**
 * A static asset, or `null` when this path is not one.
 *
 * Only `GET` and `HEAD` — a `POST` to `/unity-theme.css` is not a stylesheet request,
 * and answering it with the file would be answering something nobody asked.
 *
 * The lookup is an exact key match rather than a filesystem join: there is no user
 * input reaching a path here, so there is no traversal to defend against. That is a
 * property worth keeping, and it is why this takes a map rather than a directory.
 */
function staticAsset(
  request: HttpRequest,
  assets: ServerSurfaces["assets"],
): HttpResponse | null {
  if (!assets) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const asset = assets[pathname];
  if (!asset) return null;
  return {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      // Long-lived and immutable: the file's identity is its content, and the only
      // thing that changes it is a deploy, which changes the path's whole app anyway.
      "cache-control": "public, max-age=3600",
    },
    body: method === "HEAD" ? "" : asset.body,
  };
}

/**
 * A server that speaks the OIDC surface for one provider, and whatever else is
 * mounted on it.
 *
 * An unreadable body is not a reason to crash the process: it is answered as a
 * `413`, the same way an oversized upload would be.
 */
export function createOidcServer(service: OidcEndpoints, surfaces: ServerSurfaces = {}): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const httpRequest = toHttpRequest(request, body);
        // Liveness is answered before any router: it is the one path a caller can
        // ask without a credential, and no surface may claim it.
        const alive = health(httpRequest);
        if (alive) {
          sendResponse(response, alive);
          return;
        }
        // The theme is answered first because it is not a decision: a path in the map
        // is a file, and asking four routers to agree about that would be four chances
        // for one of them to claim `/unity-theme.css` and answer it with JSON.
        const asset = staticAsset(httpRequest, surfaces.assets);
        if (asset) {
          sendResponse(response, asset);
          return;
        }
        let result = await routeOidc(httpRequest, service);
        // Five routers share one listener, and no router claims a path another serves.
        // A `404` is therefore the signal to ask the next one, rather than a decision
        // this adapter makes five times. The console comes before Guard because the
        // console is the only one whose paths a deployment might want to move, and Guard
        // is the only one a deployment can switch off entirely (no token, no ingest).
        if (result.status === 404 && surfaces.saml) result = await routeSaml(httpRequest, surfaces.saml);
        if (result.status === 404 && surfaces.scim) result = await routeScim(httpRequest, surfaces.scim);
        if (result.status === 404 && surfaces.console) result = await routeConsole(httpRequest, surfaces.console);
        if (result.status === 404 && surfaces.guard) result = await routeGuard(httpRequest, surfaces.guard);
        sendResponse(response, result);
      } catch (error) {
        const tooLarge = error instanceof Error && /body too large/.test(error.message);
        const result: HttpResponse = tooLarge
          ? {
              status: 413,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ error: "invalid_request", error_description: "The request body is too large." }),
            }
          : {
              status: 500,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ error: "server_error" }),
            };
        sendResponse(response, result);
      }
    })();
  });
}

/* -------------------------------------------------------------------------- */
/*  Assembly                                                                  */
/* -------------------------------------------------------------------------- */

/** The OIDC stack: where it stores grants, and the service that decides them. */
export interface OidcServices {
  store: OidcStore;
  service: OidcService;
}

/**
 * Build the OIDC stack over any store.
 *
 * The store is a parameter rather than a Prisma client, so the same assembly
 * serves a deployment (`PrismaOidcStore`) and the in-memory dev provider — the
 * engine cannot tell them apart. The identity spine is passed in rather than
 * rebuilt, so a grant is judged by the *same* session policy, and written to the
 * *same* evidence chain, as every other decision in the product.
 */
export function createOidcServices(
  store: OidcStore,
  identities: IdentityStore,
  spine: IdentityService,
  config: OidcConfig,
  audit: AuditTrail | null = null,
  ids?: OidcIds,
  hash?: HashFn,
): OidcServices {
  return { store, service: new OidcService(store, identities, spine, config, audit, ids, hash) };
}

let configured: OidcServices | null = null;

/** Bind the process-wide OIDC stack, once, at server startup. */
export function configureOidc(
  store: OidcStore,
  identities: IdentityStore,
  spine: IdentityService,
  config: OidcConfig,
  audit?: AuditTrail | null,
  ids?: OidcIds,
  hash?: HashFn,
): OidcServices {
  configured = createOidcServices(store, identities, spine, config, audit, ids, hash);
  return configured;
}

/** The configured stack. Throws when the server forgot to call `configureOidc`. */
export function oidcServices(): OidcServices {
  if (!configured) {
    throw new Error("OnTrak Sentinel's OIDC provider is not configured: call configureOidc(...) during startup.");
  }
  return configured;
}

/** Start listening and resolve with the bound address, so a caller knows the port. */
export function startOidcServer(
  service: OidcEndpoints,
  options: { port?: number; host?: string } & ServerSurfaces = {},
): Promise<{ server: Server; url: string }> {
  const server = createOidcServer(service, {
    saml: options.saml,
    console: options.console,
    scim: options.scim,
    assets: options.assets,
    guard: options.guard,
  });
  const port = options.port ?? 8787;
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://${host}:${boundPort}` });
    });
  });
}
