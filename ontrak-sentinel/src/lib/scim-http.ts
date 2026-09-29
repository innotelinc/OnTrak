/**
 * SCIM HTTP surface (S2): the endpoints, wired to the service without adding a
 * decision.
 *
 * The same split as `oidc-http.ts`, `saml-http.ts` and `console-http.ts`: this file
 * moves bytes, the service decides, and the rules module parses. Pure over plain
 * request/response shapes, so every endpoint — including the refusals, which are the
 * half that matters — is tested with no socket, and the `node:http` adapter is a
 * translation over it.
 *
 * Four choices worth stating out loud:
 *
 *  - **The paths are public and the data is not.** A request for `/scim/v2/Users`
 *    with no token is `401`, not `404`: a connector that mistypes its URL and a
 *    connector that forgot its token are different problems, and answering both with
 *    "not found" sends somebody looking in the wrong place. Discovery documents need
 *    no token at all, because they describe the server rather than anybody's people.
 *  - **The error body is the standard's, because a connector parses it.** `status`,
 *    `detail` and — where it is known — `scimType`, since `uniqueness` and
 *    `invalidValue` are different futures for a sync engine: one is a conflict a person
 *    resolves, the other is a retry that will never work.
 *  - **A created resource answers `201` with its `Location`.** A connector stores that
 *    URL and uses it to update the user later, so getting it wrong means the next
 *    write goes to the wrong place.
 *  - **`DELETE` answers `204` and the identity still exists.** Deleting is
 *    deactivating here — the evidence cannot be deleted — so the response says nothing
 *    and the service records the deprovision on the chain. A connector that expects the
 *    user to vanish will find, on its next read, an inactive user, which is exactly the
 *    truth.
 */

import type { ScimCaller } from "./scim-service";
import {
  SCIM_CONTENT_TYPE,
  SCIM_ERROR_SCHEMA,
  SCIM_PATHS,
  scimError,
  type ScimError,
  type ScimGroupResource,
  type ScimListResponse,
  type ScimUserResource,
} from "./scim-rules";
import type { HttpRequest, HttpResponse } from "./oidc-http";

/** A SCIM result, as the router needs it. */
export type ScimOutcome<T> = { ok: true; value: T } | { ok: false; error: ScimError };

/**
 * The endpoints a SCIM service must offer.
 *
 * A port rather than the class, so a test can hand in a stub and so this layer never
 * grows a reason to reach for anything else the service can do — the SCIM counterpart
 * of `OidcEndpoints` and `ConsoleEndpoints`. `ScimService` satisfies it structurally;
 * nothing here imports the implementation.
 */
export interface ScimEndpoints {
  authenticate(token: string): Promise<ScimOutcome<ScimCaller>>;

  listUsers(caller: ScimCaller, params: URLSearchParams): Promise<ScimOutcome<ScimListResponse<ScimUserResource>>>;
  getUser(caller: ScimCaller, userId: string): Promise<ScimOutcome<ScimUserResource>>;
  createUser(caller: ScimCaller, body: unknown): Promise<ScimOutcome<ScimUserResource>>;
  replaceUser(caller: ScimCaller, userId: string, body: unknown): Promise<ScimOutcome<ScimUserResource>>;
  patchUser(caller: ScimCaller, userId: string, body: unknown): Promise<ScimOutcome<ScimUserResource>>;
  deleteUser(caller: ScimCaller, userId: string): Promise<ScimOutcome<{ deactivated: true; sessionsEnded: number }>>;

  listGroups(caller: ScimCaller, params: URLSearchParams): Promise<ScimOutcome<ScimListResponse<ScimGroupResource>>>;
  getGroup(caller: ScimCaller, groupId: string): Promise<ScimOutcome<ScimGroupResource>>;
  createGroup(caller: ScimCaller, body: unknown): Promise<ScimOutcome<ScimGroupResource>>;
  patchGroup(caller: ScimCaller, groupId: string, body: unknown): Promise<ScimOutcome<ScimGroupResource>>;
  deleteGroup(caller: ScimCaller, groupId: string): Promise<ScimOutcome<{ deleted: true }>>;

  serviceProviderConfig(): Record<string, unknown>;
  resourceTypes(): Record<string, unknown>;
  schemas(): Record<string, unknown>;
}

export function scimJson(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

/** A refusal in the shape RFC 7644 §3.12 defines. */
export function scimErrorResponse(error: ScimError): HttpResponse {
  return scimJson(error.status, {
    schemas: [SCIM_ERROR_SCHEMA],
    detail: error.detail,
    status: String(error.status),
    ...(error.scimType ? { scimType: error.scimType } : {}),
  });
}

function methodNotAllowed(allowed: readonly string[]): HttpResponse {
  return scimJson(405, { schemas: [SCIM_ERROR_SCHEMA], detail: `Use ${allowed.join(" or ")}.`, status: "405" }, {
    allow: allowed.join(", "),
  });
}

function header(request: HttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return "";
}

/** The bearer token presented, or `""`. Scheme matching is case-insensitive. */
export function bearerToken(request: HttpRequest): string {
  const raw = header(request, "authorization").trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : "";
}

function jsonBody(request: HttpRequest): unknown {
  if (!request.body) return null;
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  The router                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Route one SCIM request. Pure and total: every input produces a response, and the
 * only awaited work is the service call. A path this file does not serve is `404`,
 * which is what lets it share the listener with OIDC, SAML and the console.
 */
export async function routeScim(request: HttpRequest, service: ScimEndpoints): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return scimErrorResponse(scimError(400, "The request URL is not absolute.", "invalidSyntax"));
  }

  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Discovery first, and without a token: these describe this server's support, and a
  // connector reads them before it has been given any of our data.
  if (path === SCIM_PATHS.serviceProviderConfig) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return scimJson(200, service.serviceProviderConfig());
  }
  if (path === SCIM_PATHS.resourceTypes) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return scimJson(200, service.resourceTypes());
  }
  if (path === SCIM_PATHS.schemas) {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return scimJson(200, service.schemas());
  }

  const users = matchCollection(path, SCIM_PATHS.users);
  const groups = matchCollection(path, SCIM_PATHS.groups);
  if (!users && !groups) {
    return scimJson(404, { schemas: [SCIM_ERROR_SCHEMA], detail: "No such SCIM endpoint.", status: "404" });
  }

  const authenticated = await service.authenticate(bearerToken(request));
  if (!authenticated.ok) {
    const response = scimErrorResponse(authenticated.error);
    return { ...response, headers: { ...response.headers, "www-authenticate": "Bearer" } };
  }
  const caller: ScimCaller = authenticated.value;

  /* --------------------------------------------------------------- users */
  if (users) {
    if (users.id === null) {
      if (method === "GET") return finish(await service.listUsers(caller, url.searchParams));
      if (method === "POST") {
        const body = jsonBody(request);
        if (body === null) return scimErrorResponse(scimError(400, "A user must be a JSON body.", "invalidSyntax"));
        return finish(await service.createUser(caller, body), SCIM_PATHS.users);
      }
      return methodNotAllowed(["GET", "POST"]);
    }

    if (method === "GET") return finish(await service.getUser(caller, users.id));
    if (method === "PATCH") {
      const body = jsonBody(request);
      if (body === null) return scimErrorResponse(scimError(400, "A PATCH body is required.", "invalidSyntax"));
      return finish(await service.patchUser(caller, users.id, body));
    }
    if (method === "PUT") {
      const body = jsonBody(request);
      if (body === null) return scimErrorResponse(scimError(400, "A PUT body is required.", "invalidSyntax"));
      return finish(await service.replaceUser(caller, users.id, body));
    }
    if (method === "DELETE") {
      const deleted = await service.deleteUser(caller, users.id);
      // `204`, per the standard, and no body: what happened is on the evidence chain,
      // and the identity is still there — switched off — for anybody who looks.
      return deleted.ok ? { status: 204, headers: { "cache-control": "no-store" }, body: "" } : scimErrorResponse(deleted.error);
    }
    return methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
  }

  /* -------------------------------------------------------------- groups */
  if (groups) {
    if (groups.id === null) {
      if (method === "GET") return finish(await service.listGroups(caller, url.searchParams));
      if (method === "POST") {
        const body = jsonBody(request);
        if (body === null) return scimErrorResponse(scimError(400, "A group must be a JSON body.", "invalidSyntax"));
        return finish(await service.createGroup(caller, body), SCIM_PATHS.groups);
      }
      return methodNotAllowed(["GET", "POST"]);
    }

    if (method === "GET") return finish(await service.getGroup(caller, groups.id));
    if (method === "PATCH") {
      const body = jsonBody(request);
      if (body === null) return scimErrorResponse(scimError(400, "A PATCH body is required.", "invalidSyntax"));
      return finish(await service.patchGroup(caller, groups.id, body));
    }
    if (method === "DELETE") {
      const deleted = await service.deleteGroup(caller, groups.id);
      return deleted.ok ? { status: 204, headers: { "cache-control": "no-store" }, body: "" } : scimErrorResponse(deleted.error);
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }

  return scimJson(404, { schemas: [SCIM_ERROR_SCHEMA], detail: "No such SCIM endpoint.", status: "404" });
}

/** Render a result, or the refusal — and stamp `Location` on a creation. */
function finish<T>(result: ScimOutcome<T>, collection?: string): HttpResponse {
  if (!result.ok) return scimErrorResponse(result.error);
  const created = collection !== undefined;
  const id = (result.value as { id?: unknown } | null)?.id;
  const location = created && typeof id === "string" ? `${collection}/${id}` : undefined;
  return scimJson(
    created ? 201 : 200,
    result.value,
    location === undefined ? {} : { location },
  );
}

/**
 * Which collection a path names, and which resource within it.
 *
 * `{ id: null }` is the collection itself. Anything *under* a resource — a
 * sub-resource this server does not expose — is not matched, so it falls through to
 * the `404` rather than being read as an id.
 */
function matchCollection(path: string, base: string): { id: string | null } | null {
  if (path === base) return { id: null };
  if (!path.startsWith(`${base}/`)) return null;
  const id = path.slice(base.length + 1);
  if (!id || id.includes("/")) return null;
  return { id: decodeURIComponent(id) };
}
