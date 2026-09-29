/**
 * Console HTTP surface (S0/S1): the pages, wired to the service without adding a
 * single decision.
 *
 * The same split as `oidc-http.ts` and `saml-http.ts`: this file moves bytes and
 * renders, the service resolves the session and decides, and the rules module builds
 * the HTML. It is a pure function over plain request/response shapes — no framework,
 * no `node:http` — so every page and every POST is tested with no socket, and the
 * `node:http` adapter is a translation over it rather than a second implementation.
 *
 * Four choices worth stating out loud:
 *
 *  - **The session travels in the same cookie the OIDC endpoints read.** One login,
 *    one session: a console that kept its own would be a second place to sign in and
 *    a second place to forget to sign out.
 *  - **Every page is `no-store`.** These pages carry a factor's state and, once, a
 *    shared secret; a cached console is a console somebody else's browser can page
 *    back to.
 *  - **A state change is a POST, and a POST that finished redirects.** Removing a
 *    factor answers `303` to `/console/mfa` with the outcome in a flash, so a refresh
 *    re-fetches a page rather than re-removing a factor.
 *  - **The one secret that is shown is shown in a body, never in a location.** A
 *    newly minted TOTP secret is rendered into the response to the POST that asked
 *    for it. It is not put in a query string, and not in a redirect, for the same
 *    reason the integrations console in Tix keeps a minted token in a cookie: a URL
 *    ends up in history, in `Referer` and in a proxy log.
 */

import type { HttpRequest, HttpResponse } from "./oidc-http";
import { SESSION_COOKIE, SESSION_HEADER } from "./oidc-http";
import type { ServiceResult } from "./identity-service";
import {
  CONSOLE_PATHS,
  consoleErrorPage,
  consoleSignedOutPage,
  renderDirectory,
  renderMfa,
  renderOverview,
  renderPolicies,
  renderProvisioning,
  type ConsoleDirectoryView,
  type ConsoleMfaView,
  type ConsoleOverviewView,
  type ConsolePoliciesView,
  type ConsoleProvisioningView,
  type ConsoleSyncReportView,
} from "./console-rules";
import type { WebAuthnRegistrationResponse } from "./webauthn-rules";
import type { WebAuthnRegistrationOptions } from "./webauthn-service";

/**
 * The pages this router serves, as the service offers them.
 *
 * A port rather than the class so a test can hand in a stub, and so the HTTP layer
 * never grows a reason to reach for anything else the service can do — the console
 * counterpart of `OidcEndpoints`.
 */
export interface ConsoleEndpoints {
  overview(sessionId: string): Promise<ServiceResult<ConsoleOverviewView>>;
  provisioning(sessionId: string): Promise<ServiceResult<ConsoleProvisioningView>>;
  /** The directories this organization reads, and what their last runs did. */
  directory(sessionId: string): Promise<ServiceResult<ConsoleDirectoryView>>;
  connectDirectory(
    sessionId: string,
    input: {
      name: string;
      source: string;
      settings: Record<string, string>;
      conflictPolicy: string;
      defaultRole: string;
      secret: string | null;
    },
  ): Promise<ServiceResult<{ name: string }>>;
  removeDirectory(sessionId: string, connectionId: string): Promise<ServiceResult<{ name: string }>>;
  /** `dryRun` writes nothing, so it is safe for the page to render the plan in place. */
  syncDirectory(sessionId: string, connectionId: string, dryRun: boolean): Promise<ServiceResult<ConsoleSyncReportView>>;
  /** The session policies the organization has, one card per scope. */
  policies(sessionId: string): Promise<ServiceResult<ConsolePoliciesView>>;
  /** Write the baseline or one role's override; the scope is echoed for the flash. */
  setPolicy(
    sessionId: string,
    input: { scope: string; requireMfa: boolean; maxSessionSeconds: number; idleTimeoutSeconds: number },
  ): Promise<ServiceResult<{ scope: string }>>;
  /**
   * Mint a connector token. The plaintext is in the *result*, never in a redirect:
   * a token in a `Location` header ends up in browser history, in `Referer` and in a
   * proxy log, which is where a credential must never be.
   */
  mintScimToken(
    sessionId: string,
    label: string | null,
  ): Promise<ServiceResult<{ view: ConsoleProvisioningView; plaintext: string; label: string }>>;
  revokeScimToken(
    sessionId: string,
    tokenId: string,
  ): Promise<ServiceResult<{ view: ConsoleProvisioningView; label: string }>>;
  mfaView(sessionId: string): Promise<ServiceResult<ConsoleMfaView>>;
  beginTotp(sessionId: string, label: string | null): Promise<ServiceResult<ConsoleMfaView>>;
  confirmTotp(sessionId: string, code: string): Promise<ServiceResult<ConsoleMfaView>>;
  removeFactors(sessionId: string): Promise<ServiceResult<{ removed: number }>>;
  beginWebAuthn(sessionId: string): Promise<ServiceResult<WebAuthnRegistrationOptions>>;
  finishWebAuthn(
    sessionId: string,
    input: { challengeId: string; label: string | null; response: WebAuthnRegistrationResponse },
  ): Promise<ServiceResult<{ credentialId: string }>>;
  removeCredential(sessionId: string, credentialId: string): Promise<ServiceResult<{ removed: number }>>;
  logout(sessionId: string): Promise<ServiceResult<{ revoked: number }>>;
}

const NOT_FOUND: HttpResponse = {
  status: 404,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ error: "not_found" }),
};

function html(status: number, body: string): HttpResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body };
}

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(value),
  };
}

function redirect(location: string, headers: Record<string, string> = {}): HttpResponse {
  // `303` rather than `302`: the answer to a POST is a GET, and saying so is what
  // stops a refresh from repeating the change.
  return { status: 303, headers: { location, "cache-control": "no-store", ...headers }, body: "" };
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

/** The session the browser presented, from the cookie or the server-to-server header. */
function sessionOf(request: HttpRequest): string {
  return (request.cookies?.[SESSION_COOKIE] ?? header(request, SESSION_HEADER) ?? "").trim();
}

/**
 * A refusal's status code.
 *
 * A message about a session is `401` — the fix is to sign in again — and one about
 * permission is `403`; everything else is a bad request. The console says the same
 * sentence either way, because the sentence is what a person acts on.
 */
export function consoleErrorStatus(message: string): number {
  // Deliberately narrow. "The session is not usable" is about *this* request's
  // credential; a policy complaint that merely contains the word "session" is a bad
  // request, and answering it with `401` would tell a signed-in administrator to sign
  // in again instead of reading the field it named.
  if (/sign in|no session|session does not exist|session is not usable/i.test(message)) return 401;
  if (/administer|allowed/i.test(message)) return 403;
  return 400;
}

function failure(message: string): HttpResponse {
  const page = consoleErrorPage(message, consoleErrorStatus(message));
  return html(page.status, page.html);
}

/** Render a view, or answer the refusal as a page. */
function respond<T>(result: ServiceResult<T>, render: (value: T) => HttpResponse): HttpResponse {
  return result.ok ? render(result.value) : failure(result.error);
}

/** The form parameters of a POST: an already-parsed body, or a form-encoded one. */
function formParams(request: HttpRequest): Record<string, string> {
  const params: Record<string, string> = {};
  const contentType = header(request, "content-type").toLowerCase();
  if (!request.body) return params;
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(request.body) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") params[key] = value;
        }
      }
    } catch {
      return params;
    }
    return params;
  }
  for (const [key, value] of new URLSearchParams(request.body)) params[key] = value;
  return params;
}

/** The JSON body of the WebAuthn finish step, kept whole rather than flattened. */
function jsonBody(request: HttpRequest): Record<string, unknown> | null {
  if (!request.body) return null;
  try {
    const parsed = JSON.parse(request.body) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function flashFrom(url: URL): string | null {
  const value = url.searchParams.get("flash");
  return value === null ? null : value;
}

function errorFrom(url: URL): string | null {
  const value = url.searchParams.get("error");
  return value === null ? null : value;
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

async function handleHome(url: URL, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.overview(sessionId);
  return respond(result, (view) => html(200, renderOverview(view)));
}

async function handleProvisioningPage(url: URL, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.provisioning(sessionId);
  return respond(result, (view) => html(200, renderProvisioning(view, null, flashFrom(url), errorFrom(url))));
}

/**
 * Mint a token and show it in this response.
 *
 * Rendered rather than redirected, exactly like the TOTP secret: the value is shown
 * once, in a body, and a refresh re-POSTs (minting a second token, which is a
 * deliberate act rather than an accident).
 */
async function handleMintToken(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const label = formParams(request).label?.trim() || null;
  const result = await endpoints.mintScimToken(sessionId, label);
  return respond(result, (value) =>
    html(200, renderProvisioning(value.view, { plaintext: value.plaintext, label: value.label })),
  );
}

async function handleRevokeToken(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const tokenId = formParams(request).tokenId ?? "";
  if (!tokenId) return failure("Choose a token first.");
  const result = await endpoints.revokeScimToken(sessionId, tokenId);
  if (!result.ok) return failure(result.error);
  return redirect(
    `${CONSOLE_PATHS.provisioning}?flash=${encodeURIComponent(`Revoked ${result.value.label}. A connector holding it is refused from now on.`)}`,
  );
}

async function handleDirectoryPage(url: URL, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.directory(sessionId);
  return respond(result, (view) => html(200, renderDirectory(view, null, flashFrom(url), errorFrom(url))));
}

/**
 * Connect a directory.
 *
 * The settings are read as a flat form and kept as a flat map, because that is what they
 * are: a URL, a tenant id, a host. An empty field is *absent* rather than an empty string,
 * so the reader's `setting()` refuses by name instead of calling `https://`.
 */
async function handleConnectDirectory(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const params = formParams(request);
  const settings: Record<string, string> = {};
  for (const key of ["url", "nextKey", "auth", "clientId", "tokenUrl", "scope"]) {
    const value = params[key]?.trim();
    if (value) settings[key] = value;
  }

  const result = await endpoints.connectDirectory(sessionId, {
    name: params.name ?? "",
    source: params.source ?? "",
    settings,
    conflictPolicy: params.conflictPolicy ?? "preferDirectory",
    defaultRole: params.defaultRole ?? "AGENT",
    secret: params.secret?.trim() ? params.secret : null,
  });
  if (!result.ok) return failure(result.error);
  return redirect(
    `${CONSOLE_PATHS.directory}?flash=${encodeURIComponent(`Connected ${result.value.name}. Preview a sync before you run one.`)}`,
  );
}

async function handleRemoveDirectory(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const connectionId = formParams(request).connectionId ?? "";
  if (!connectionId) return failure("Choose a connection first.");
  const result = await endpoints.removeDirectory(sessionId, connectionId);
  if (!result.ok) return failure(result.error);
  return redirect(
    `${CONSOLE_PATHS.directory}?flash=${encodeURIComponent(
      `Removed ${result.value.name}. The identities it provisioned stay, switched on: a sync is not what deletes a person.`,
    )}`,
  );
}

/**
 * Run a sync, or preview one.
 *
 * A preview is rendered into this response and a real sync redirects, and the difference
 * is deliberate: a preview is safe to repeat (a refresh re-runs it and shows the same
 * plan), while a real sync that answered with a body would sync again on every refresh.
 * The result of a real run is in the flash and in the run table below it.
 */
async function handleSyncDirectory(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const params = formParams(request);
  const connectionId = params.connectionId ?? "";
  if (!connectionId) return failure("Choose a connection first.");
  const dryRun = params.dryRun === "1" || params.dryRun === "true";

  const result = await endpoints.syncDirectory(sessionId, connectionId, dryRun);
  if (!result.ok) return failure(result.error);
  if (!dryRun) {
    return redirect(`${CONSOLE_PATHS.directory}?flash=${encodeURIComponent(result.value.detail)}`);
  }

  const view = await endpoints.directory(sessionId);
  return respond(view, (page) => html(200, renderDirectory(page, result.value)));
}

async function handlePoliciesPage(url: URL, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.policies(sessionId);
  return respond(result, (view) => html(200, renderPolicies(view, flashFrom(url), errorFrom(url))));
}

/**
 * Save one scope's policy.
 *
 * An unchecked checkbox is absent from the body rather than `false`, so
 * "no second factor" has to be read as *not `on`* rather than as a value that
 * arrived. The numbers are parsed here and judged by the rules: a blank field
 * becomes `0`, which the policy validator refuses by name rather than silently
 * clamping — a control somebody meant to tighten should never be quietly rounded.
 */
async function handleSetPolicy(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const params = formParams(request);
  const result = await endpoints.setPolicy(sessionId, {
    scope: params.scope ?? "",
    requireMfa: params.requireMfa === "on" || params.requireMfa === "true",
    maxSessionSeconds: Number(params.maxSessionSeconds),
    idleTimeoutSeconds: Number(params.idleTimeoutSeconds),
  });
  if (!result.ok) return failure(result.error);
  return redirect(
    `${CONSOLE_PATHS.policies}?flash=${encodeURIComponent(`Saved the ${result.value.scope} policy; every new session is judged by it.`)}`,
  );
}

async function handleMfaPage(url: URL, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.mfaView(sessionId);
  return respond(result, (view) => html(200, renderMfa(view, flashFrom(url), errorFrom(url))));
}

/**
 * Start a TOTP enrollment and show the secret in this response.
 *
 * Rendered rather than redirected, because the alternative is the secret in a URL.
 * A refresh re-POSTs and starts a fresh enrollment, which is a restart rather than a
 * mistake: the code the user was looking at belongs to the secret they were just
 * shown, and `beginEnrollment` discards any pending one.
 */
async function handleBeginTotp(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const label = formParams(request).label?.trim() || null;
  const result = await endpoints.beginTotp(sessionId, label);
  return respond(result, (view) => html(200, renderMfa(view)));
}

async function handleConfirmTotp(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const code = formParams(request).code ?? "";
  const result = await endpoints.confirmTotp(sessionId, code);
  if (!result.ok) return failure(result.error);
  return redirect(`${CONSOLE_PATHS.mfa}?flash=${encodeURIComponent("The authenticator app is enrolled, and the session policy is satisfied.")}`);
}

async function handleRemoveFactors(sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.removeFactors(sessionId);
  if (!result.ok) return failure(result.error);
  // The flash is deliberately blunt about the consequence: under the default policy
  // this identity now owes a second factor, so the session that asked for this is
  // about to stop working — including for the page it is redirecting to.
  return redirect(
    `${CONSOLE_PATHS.mfa}?flash=${encodeURIComponent(
      `Removed ${result.value.removed} factor(s). Every session for this identity is now refused until a factor is enrolled again.`,
    )}`,
  );
}

async function handleRemoveCredential(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const credentialId = formParams(request).credentialId ?? "";
  if (!credentialId) return failure("Choose a security key first.");
  const result = await endpoints.removeCredential(sessionId, credentialId);
  if (!result.ok) return failure(result.error);
  return redirect(`${CONSOLE_PATHS.mfa}?flash=${encodeURIComponent("That security key was removed.")}`);
}

async function handleBeginWebAuthn(sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.beginWebAuthn(sessionId);
  if (!result.ok) return json(consoleErrorStatus(result.error), { error: result.error });
  return json(200, result.value);
}

async function handleFinishWebAuthn(request: HttpRequest, sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const body = jsonBody(request);
  if (!body) return json(400, { error: "The registration body is not JSON." });
  const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
  const response = body.response;
  if (!challengeId) return json(400, { error: "A challenge is required." });
  if (!response || typeof response !== "object") return json(400, { error: "A credential is required." });

  const result = await endpoints.finishWebAuthn(sessionId, {
    challengeId,
    label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : null,
    response: response as unknown as WebAuthnRegistrationResponse,
  });
  if (!result.ok) return json(consoleErrorStatus(result.error), { error: result.error });
  return json(200, { ok: true, credentialId: result.value.credentialId });
}

async function handleLogout(sessionId: string, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  const result = await endpoints.logout(sessionId);
  const page = result.ok
    ? html(200, consoleSignedOutPage())
    : (() => {
        const refused = consoleErrorPage(result.error, consoleErrorStatus(result.error));
        return html(refused.status, refused.html);
      })();
  // The cookie is expired either way: a session that could not be ended is not one
  // to keep sending back.
  return { ...page, headers: { ...page.headers, "set-cookie": clearCookie() } };
}

/** Expiring the cookie is part of the answer: a live session id would just be re-used. */
function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/* -------------------------------------------------------------------------- */
/*  The router                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Route one console request. Pure and total: every input produces a response, and
 * the only awaited work is the service call itself. A request for a path this file
 * does not serve is a `404`, which is what lets the OIDC, SAML and console routers
 * share one server.
 */
export async function routeConsole(request: HttpRequest, endpoints: ConsoleEndpoints): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { error: "invalid_request", error_description: "The request URL is not absolute." });
  }

  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const sessionId = sessionOf(request);
  const get = (handler: () => Promise<HttpResponse>): Promise<HttpResponse> =>
    method === "GET" ? handler() : Promise.resolve(methodNotAllowed(["GET"]));
  const post = (handler: () => Promise<HttpResponse>): Promise<HttpResponse> =>
    method === "POST" ? handler() : Promise.resolve(methodNotAllowed(["POST"]));

  switch (path) {
    case CONSOLE_PATHS.home:
      return get(() => handleHome(url, sessionId, endpoints));
    case CONSOLE_PATHS.provisioning:
      return get(() => handleProvisioningPage(url, sessionId, endpoints));
    case CONSOLE_PATHS.mintToken:
      return post(() => handleMintToken(request, sessionId, endpoints));
    case CONSOLE_PATHS.revokeToken:
      return post(() => handleRevokeToken(request, sessionId, endpoints));
    case CONSOLE_PATHS.policies:
      // One path, two verbs: the page and the form that changes it. Splitting them
      // would mean a second URL to keep in the nav and in a bookmark.
      return method === "GET"
        ? handlePoliciesPage(url, sessionId, endpoints)
        : method === "POST"
          ? handleSetPolicy(request, sessionId, endpoints)
          : Promise.resolve(methodNotAllowed(["GET", "POST"]));
    case CONSOLE_PATHS.directory:
      return get(() => handleDirectoryPage(url, sessionId, endpoints));
    case CONSOLE_PATHS.directoryConnect:
      return post(() => handleConnectDirectory(request, sessionId, endpoints));
    case CONSOLE_PATHS.directoryRemove:
      return post(() => handleRemoveDirectory(request, sessionId, endpoints));
    case CONSOLE_PATHS.directorySync:
      return post(() => handleSyncDirectory(request, sessionId, endpoints));
    case CONSOLE_PATHS.mfa:
      return get(() => handleMfaPage(url, sessionId, endpoints));
    case CONSOLE_PATHS.totpBegin:
      return post(() => handleBeginTotp(request, sessionId, endpoints));
    case CONSOLE_PATHS.totpConfirm:
      return post(() => handleConfirmTotp(request, sessionId, endpoints));
    case CONSOLE_PATHS.removeAll:
      return post(() => handleRemoveFactors(sessionId, endpoints));
    case CONSOLE_PATHS.webauthnBegin:
      return post(() => handleBeginWebAuthn(sessionId, endpoints));
    case CONSOLE_PATHS.webauthnFinish:
      return post(() => handleFinishWebAuthn(request, sessionId, endpoints));
    case CONSOLE_PATHS.webauthnRemove:
      return post(() => handleRemoveCredential(request, sessionId, endpoints));
    case CONSOLE_PATHS.logout:
      return post(() => handleLogout(sessionId, endpoints));
    default:
      return NOT_FOUND;
  }
}
