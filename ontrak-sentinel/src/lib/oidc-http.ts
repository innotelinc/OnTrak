/**
 * OIDC HTTP surface (S1): the five endpoints a client actually speaks to, wired
 * to the service without adding a single decision.
 *
 * The split is the same one the rest of Sentinel uses: `oidc-rules.ts` decides
 * whether a request is allowed, `oidc-service.ts` carries it out and records it,
 * and this file only moves bytes. It is written as a pure function over plain
 * request/response shapes — no framework, no `node:http` — so a test can drive
 * every endpoint without opening a socket, and a different server (a Next route,
 * a serverless handler) is an adapter over it rather than a rewrite.
 *
 * Three choices are worth stating out loud:
 *
 *  - **An error is only sent to a redirect URI we recognise.** The service
 *    already returns the destination only when it was registered; this file
 *    therefore never invents one, and an unrecognised request is a `400` page
 *    rather than a redirect that would make the provider an open redirector.
 *  - **The session travels in a cookie, not a query string.** A session id in a
 *    URL ends up in referrers and proxy logs; the authorize endpoint reads
 *    `sentinel_session` (or the `X-Sentinel-Session` header, for a server that
 *    calls it directly).
 *  - **The token response is `no-store`, and an error is never cached.** A cached
 *    error for a client that then succeeds is how an integrator spends an
 *    afternoon on a working system.
 *
 * `OidcService` satisfies `OidcEndpoints` structurally, so the app passes the
 * real service and a test passes whatever it is exercising.
 */

import type {
  AuthorizeInput,
  AuthorizeResult,
  LogoutInput,
  LogoutResult,
  RevokeInput,
  RevokeResult,
  TokenInput,
  TokenResult,
} from "./oidc-service";
import type { ServiceResult } from "./identity-service";
import { OIDC_PATHS } from "./oidc-rules";

export interface HttpRequest {
  method: string;
  /** The absolute request URL, query string included. */
  url: string;
  /** Header names are matched case-insensitively. */
  headers: Record<string, string | undefined>;
  /** The raw request body, for a form post. */
  body?: string;
  /** Cookies already parsed by the adapter, so this file does not guess a split. */
  cookies?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /**
   * A header's value, or its values when the header may legitimately repeat.
   *
   * `set-cookie` is why this is not plain `string`. Ending an upstream sign-in both
   * clears the sealed attempt and sets the session, and two cookies packed into one
   * header are split by browsers on a comma — usually. "Usually" is a completed sign-in
   * that leaves somebody holding no session, so the adapter writes an array as repeated
   * headers, which is what the wire has always wanted.
   */
  headers: Record<string, string | string[]>;
  body: string;
}

/** The cookie the provider's own sign-in sets, and the header a server may use. */
export const SESSION_COOKIE = "sentinel_session";
export const SESSION_HEADER = "x-sentinel-session";

/**
 * The endpoints this file routes, as the service offers them.
 *
 * A port rather than the class so a test can hand in a stub, and so the HTTP
 * layer never grows a reason to reach for anything else the service can do.
 */
export interface OidcEndpoints {
  discovery(): Record<string, unknown>;
  jwks(): { keys: Record<string, unknown>[] };
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  token(input: TokenInput): Promise<TokenResult>;
  userinfo(accessToken: string): Promise<ServiceResult<Record<string, unknown>>>;
  logout(input: LogoutInput): Promise<LogoutResult>;
  revoke(input: RevokeInput): Promise<RevokeResult>;
}

/* -------------------------------------------------------------------------- */
/*  Response helpers                                                          */
/* -------------------------------------------------------------------------- */

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value),
  };
}

function html(status: number, message: string): HttpResponse {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in error</title></head>` +
      `<body><main><h1>Sign-in could not continue</h1><p>${safe}</p></main></body></html>`,
  };
}

function redirect(location: string): HttpResponse {
  return { status: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}

const NOT_FOUND: HttpResponse = { status: 404, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: "not_found" }) };

function methodNotAllowed(allowed: readonly string[]): HttpResponse {
  return {
    status: 405,
    headers: { allow: allowed.join(", "), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: "invalid_request", error_description: `Use ${allowed.join(" or ")}.` }),
  };
}

function header(request: HttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return "";
}

/** The form parameters of a request: an already-parsed body, or a form-encoded one. */
function formParams(request: HttpRequest): Record<string, string> {
  const params: Record<string, string> = {};
  const contentType = header(request, "content-type").toLowerCase();
  if (request.body && contentType.includes("application/x-www-form-urlencoded")) {
    for (const [key, value] of new URLSearchParams(request.body)) params[key] = value;
  }
  return params;
}

/** Query parameters when the request is a GET, form parameters when it is a POST. */
function requestParams(request: HttpRequest, url: URL): Record<string, string> {
  if (request.method.toUpperCase() === "POST") return formParams(request);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;
  return params;
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

function handleDiscovery(service: OidcEndpoints): HttpResponse {
  // Discovery is cacheable: a client caches it, and it changes only when the
  // deployment does.
  return json(200, service.discovery(), { "cache-control": "public, max-age=300" });
}

function handleJwks(service: OidcEndpoints): HttpResponse {
  // The public key set is meant to be cached; a client fetching it per token
  // would put the provider on the critical path of every request.
  return json(200, service.jwks(), { "cache-control": "public, max-age=3600" });
}

/**
 * A refusal's OIDC error code.
 *
 * The service speaks to a person ("That session does not exist."); the wire
 * speaks in codes, and a client acts on them differently. A missing or unusable
 * session is `login_required` — the fix is to sign in again — and everything that
 * reaches here is otherwise a malformed request.
 */
export function authorizeErrorCode(message: string): string {
  return /session/i.test(message) ? "login_required" : "invalid_request";
}

function redirectWithError(base: string, error: string, description: string, state: string | null): HttpResponse {
  const url = new URL(base);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

async function handleAuthorize(request: HttpRequest, url: URL, service: OidcEndpoints): Promise<HttpResponse> {
  const params = requestParams(request, url);
  const sessionId = request.cookies?.[SESSION_COOKIE] ?? header(request, SESSION_HEADER) ?? "";

  const result = await service.authorize({
    responseType: params.response_type,
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    scope: params.scope,
    state: params.state,
    nonce: params.nonce,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    sessionId: sessionId.trim(),
  });

  if (result.ok) return redirect(result.redirectTo);
  // Never invent a redirect target: the service returns one only when the URI was
  // registered, which is the one case an error may be reported back to.
  if (!result.redirectUri) return html(400, result.error);
  return redirectWithError(result.redirectUri, authorizeErrorCode(result.error), result.error, result.state);
}

async function handleToken(request: HttpRequest, service: OidcEndpoints): Promise<HttpResponse> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed(["POST"]);
  const contentType = header(request, "content-type").toLowerCase();
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return json(
      400,
      { error: "invalid_request", error_description: "The token endpoint takes an application/x-www-form-urlencoded body." },
      { "cache-control": "no-store" },
    );
  }

  const params = formParams(request);
  const result = await service.token({
    grantType: params.grant_type,
    clientId: params.client_id,
    code: params.code,
    redirectUri: params.redirect_uri,
    codeVerifier: params.code_verifier,
  });

  if (result.ok) {
    return json(
      200,
      {
        access_token: result.accessToken,
        id_token: result.idToken,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
        scope: result.scope,
      },
      { "cache-control": "no-store", pragma: "no-cache" },
    );
  }

  const status = result.code === "invalid_client" ? 401 : 400;
  const authenticate: Record<string, string> =
    result.code === "invalid_client" ? { "www-authenticate": 'Basic realm="sentinel"' } : {};
  return json(status, { error: result.code, error_description: result.error }, { "cache-control": "no-store", ...authenticate });
}

/*
 * Expiring the session cookie is part of the answer, not decoration: a browser
 * that still holds a live session id will simply get the same session back.
 */
const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

function signedOut(redirectTo: string | null): HttpResponse {
  if (redirectTo) {
    return {
      status: 302,
      headers: { location: redirectTo, "cache-control": "no-store", "set-cookie": CLEAR_SESSION_COOKIE },
      body: "",
    };
  }
  const page = html(200, "You are signed out. Every token that session held has been revoked.");
  return { ...page, headers: { ...page.headers, "set-cookie": CLEAR_SESSION_COOKIE } };
}

/**
 * The end-session endpoint.
 *
 * The session is read from the cookie (or the `X-Sentinel-Session` header) the
 * same way authorize reads it, so a sign-out ends the session the provider
 * actually used. Where the browser goes next is decided by the service from what
 * the client registered; an unregistered destination is dropped rather than
 * honoured, and the page says so.
 */
async function handleLogout(request: HttpRequest, url: URL, service: OidcEndpoints): Promise<HttpResponse> {
  const params = requestParams(request, url);
  const sessionId = request.cookies?.[SESSION_COOKIE] ?? header(request, SESSION_HEADER) ?? "";

  const result = await service.logout({
    clientId: params.client_id,
    postLogoutRedirectUri: params.post_logout_redirect_uri,
    state: params.state,
    idTokenHint: params.id_token_hint,
    sessionId: sessionId.trim(),
  });
  // A refusal means the session could not be identified at all, so there is
  // nothing to claim was ended and the cookie is left alone.
  if (!result.ok) return html(400, result.error);
  return signedOut(result.redirectTo);
}

/**
 * The revocation endpoint (RFC 7009).
 *
 * A successful revocation answers `200` with an empty body, and so does an
 * unknown token — the difference would tell a caller whether a token they hold
 * is live, which is precisely what an attacker holding one wants to know. A
 * missing `token` is the only `400`, because that is a malformed request rather
 * than a question about a token.
 */
async function handleRevoke(request: HttpRequest, service: OidcEndpoints): Promise<HttpResponse> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed(["POST"]);
  const params = formParams(request);

  const result = await service.revoke({ token: params.token, tokenTypeHint: params.token_type_hint });
  if (!result.ok) {
    return json(400, { error: "invalid_request", error_description: result.error }, { "cache-control": "no-store" });
  }
  // `known` is deliberately not in the body: see the note above.
  return { status: 200, headers: { "cache-control": "no-store" }, body: "" };
}

async function handleUserinfo(request: HttpRequest, service: OidcEndpoints): Promise<HttpResponse> {
  const authorization = header(request, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    return json(
      401,
      { error: "invalid_token", error_description: "A Bearer access token is required." },
      { "cache-control": "no-store", "www-authenticate": "Bearer" },
    );
  }

  const result = await service.userinfo(match[1]);
  if (result.ok) return json(200, result.value, { "cache-control": "no-store" });
  return json(
    401,
    { error: "invalid_token", error_description: result.error },
    { "cache-control": "no-store", "www-authenticate": "Bearer" },
  );
}

/* -------------------------------------------------------------------------- */
/*  The router                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Route one request. Pure and total: every input produces a response, and the
 * only awaited work is the service call itself.
 */
export async function routeOidc(request: HttpRequest, service: OidcEndpoints): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { error: "invalid_request", error_description: "The request URL is not absolute." });
  }

  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  switch (path) {
    case OIDC_PATHS.discovery:
      return method === "GET" ? handleDiscovery(service) : methodNotAllowed(["GET"]);
    case OIDC_PATHS.jwks:
      return method === "GET" ? handleJwks(service) : methodNotAllowed(["GET"]);
    case OIDC_PATHS.authorization:
      return method === "GET" || method === "POST" ? handleAuthorize(request, url, service) : methodNotAllowed(["GET", "POST"]);
    case OIDC_PATHS.token:
      return handleToken(request, service);
    case OIDC_PATHS.userinfo:
      return method === "GET" || method === "POST" ? handleUserinfo(request, service) : methodNotAllowed(["GET", "POST"]);
    case OIDC_PATHS.logout:
      return method === "GET" || method === "POST" ? handleLogout(request, url, service) : methodNotAllowed(["GET", "POST"]);
    case OIDC_PATHS.revocation:
      return handleRevoke(request, service);
    default:
      return NOT_FOUND;
  }
}
