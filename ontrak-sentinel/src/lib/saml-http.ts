/**
 * SAML HTTP surface (S1): the two endpoints a service provider speaks to.
 *
 * The same split as `oidc-http.ts`: `saml-rules.ts` decides, `saml-service.ts`
 * carries it out, and this file moves bytes. It is a pure function over plain
 * request/response shapes — no framework, no `node:http` — so every endpoint is
 * tested with no socket, and the `node:http` adapter is a thin translation over
 * it rather than a second implementation.
 *
 * Four choices are worth stating out loud:
 *
 *  - **The assertion is never delivered by redirect.** Success is an
 *    auto-submitting HTML form (`postBindingPage`), because an assertion in a
 *    query string ends up in a proxy log, a referrer and the browser's history —
 *    and it is a bearer credential, so that is a credential leak.
 *  - **Metadata is public and cacheable.** A service provider needs it before it
 *    has any relationship with us, and it describes this provider rather than one
 *    tenant, so there is nothing in it to protect.
 *  - **A refusal is an HTML page, not a redirect.** SAML lets an IdP answer with
 *    a `Status` of `Requester` instead, but that answer goes to an ACS URL we
 *    would then have to trust before we have finished deciding whether to trust
 *    it — the same trap `oidc-http.ts` refuses to fall into.
 *  - **The session travels in the cookie, exactly as it does for authorize.** No
 *    session id in a query string.
 *
 * `SamlService` satisfies `SamlEndpoints` structurally, so the app passes the real
 * service and a test passes whatever it is exercising.
 */

import type { HttpRequest, HttpResponse } from "./oidc-http";
import { SESSION_COOKIE, SESSION_HEADER } from "./oidc-http";
import { SAML_PATHS, type SamlBinding } from "./saml-rules";
import type { SsoInput, SsoResult } from "./saml-service";

/**
 * The endpoints this file routes, as the service offers them.
 *
 * A port rather than the class so a test can hand in a stub, and so the HTTP
 * layer never grows a reason to reach for anything else the service can do — the
 * SAML counterpart of `OidcEndpoints`.
 */
export interface SamlEndpoints {
  metadata(): string;
  sso(input: SsoInput): Promise<SsoResult>;
}

/** The media type SAML metadata is published under. */
export const SAML_METADATA_CONTENT_TYPE = "application/samlmetadata+xml; charset=utf-8";

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

/** The `SAMLRequest`/`RelayState` a binding carries, from the query or the body. */
function bindingParams(request: HttpRequest, url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  if (request.method.toUpperCase() === "POST") {
    const contentType = header(request, "content-type").toLowerCase();
    if (request.body && contentType.includes("application/x-www-form-urlencoded")) {
      for (const [key, value] of new URLSearchParams(request.body)) params[key] = value;
    }
    return params;
  }
  for (const [key, value] of url.searchParams) params[key] = value;
  return params;
}

/** The session the browser presented, from the cookie or the server-to-server header. */
function sessionOf(request: HttpRequest): string {
  return (request.cookies?.[SESSION_COOKIE] ?? header(request, SESSION_HEADER) ?? "").trim();
}

function handleMetadata(service: SamlEndpoints): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": SAML_METADATA_CONTENT_TYPE, "cache-control": "public, max-age=300" },
    body: service.metadata(),
  };
}

async function handleSso(request: HttpRequest, url: URL, service: SamlEndpoints): Promise<HttpResponse> {
  const binding: SamlBinding = request.method.toUpperCase() === "POST" ? "post" : "redirect";
  const params = bindingParams(request, url);

  const input: SsoInput = {
    samlRequest: params.SAMLRequest,
    relayState: params.RelayState,
    binding,
    sessionId: sessionOf(request),
  };

  const result = await service.sso(input);
  if (!result.ok) return html(400, result.error);
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: result.html };
}

/* -------------------------------------------------------------------------- */
/*  The router                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Route one SAML request. Pure and total: every input produces a response, and
 * the only awaited work is the service call itself. A request for a path this
 * file does not serve is a `404`, which is what lets the OIDC router and this one
 * share one server.
 */
export async function routeSaml(request: HttpRequest, service: SamlEndpoints): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { error: "invalid_request", error_description: "The request URL is not absolute." });
  }

  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  switch (path) {
    case SAML_PATHS.metadata:
      return method === "GET" ? handleMetadata(service) : methodNotAllowed(["GET"]);
    case SAML_PATHS.sso:
      return method === "GET" || method === "POST" ? handleSso(request, url, service) : methodNotAllowed(["GET", "POST"]);
    default:
      return json(404, { error: "not_found" });
  }
}
