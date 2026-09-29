/**
 * Guard HTTP surface (S3): where telemetry arrives.
 *
 * The same shape as every other router in the product — a pure function over plain
 * request/response shapes — with one difference worth naming: this is the only surface
 * that *untrusted, machine-generated* data reaches, and it is not tied to a session. A
 * sensor in a rack has no browser and no cookie; it has a bearer token the deployment
 * issued and an address.
 *
 * Four decisions worth stating out loud:
 *
 *  - **The token is checked by the service, not the router.** The router moves bytes; what
 *    "authorised" means for ingestion is one function in one place, testable without a
 *    socket, and the comparison is constant-time (see `guard-service.ts`).
 *  - **The organization is named in the request and verified against the token's
 *    deployment.** A single deployment token cannot choose a tenant it was not issued for;
 *    where that restriction is insufficient, the limit is stated rather than implied — see
 *    the note on `SENTINEL_GUARD_ORGANIZATION`.
 *  - **A body is a batch, and a batch is what detection needs.** A behavioural rule is a
 *    statement about several observations; a one-event-per-request endpoint would make
 *    every such rule impossible to satisfy honestly.
 *  - **The answer says what was accepted, what was refused, and what fired.** A relay that
 *    is silently discarding telemetry looks identical to a network with no incidents,
 *    which is the worst failure mode a detection platform has.
 */

import type { HttpRequest, HttpResponse } from "./oidc-http";
import type { ServiceResult } from "./identity-service";
import type { RulebookEntry } from "./guard-service";

export const GUARD_PATHS = {
  events: "/guard/v1/events",
  rules: "/guard/v1/rules",
} as const;

/**
 * What the router needs of the guard.
 *
 * `ingest` takes the raw header rather than a parsed credential, so the one place that
 * decides what "authorised" means is the service — a router that half-checked a token would
 * be a second, weaker copy of the rule.
 */
export interface GuardEndpoints {
  ingest(input: {
    authorization: string;
    organization: string;
    payload: unknown;
    at: number;
  }): Promise<ServiceResult<{ accepted: number; rejected: { reason: string }[]; alerts: { id: string; ruleId: string; severity: string; created: boolean }[] }>>;
  /** The rules this deployment runs, so a sensor platform can be reconciled against them. */
  rulebook(): RulebookEntry[];
}

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(value),
  };
}

const NOT_FOUND: HttpResponse = {
  status: 404,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ error: "not_found" }),
};

function header(request: HttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return "";
}

/** A refusal's status: an unauthenticated ingest is `401`, anything else is a bad request. */
function statusFor(message: string): number {
  return /token|authoris|authoriz/i.test(message) ? 401 : 400;
}

/**
 * Route one guard request. Total, like every other router: an unknown path answers `404`,
 * which is what lets it share a listener with the OIDC, SAML, SCIM and console routers.
 */
export async function routeGuard(request: HttpRequest, endpoints: GuardEndpoints): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { error: "invalid_request", error_description: "The request URL is not absolute." });
  }

  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === GUARD_PATHS.rules) {
    if (method !== "GET") return json(405, { error: "method_not_allowed", allow: "GET" });
    // Public on purpose: a detection rule is not a secret, and a sensor platform that can
    // read the rulebook can be reconciled against it. Nothing here is telemetry.
    return json(200, { rules: endpoints.rulebook() });
  }

  if (path !== GUARD_PATHS.events) return NOT_FOUND;
  if (method !== "POST") return json(405, { error: "method_not_allowed", allow: "POST" });

  let payload: unknown;
  try {
    payload = request.body ? JSON.parse(request.body) : null;
  } catch {
    return json(400, { error: "invalid_request", error_description: "The body is not JSON." });
  }
  if (payload === null || typeof payload !== "object") {
    return json(400, { error: "invalid_request", error_description: "The body must be an object." });
  }

  const result = await endpoints.ingest({
    authorization: header(request, "authorization"),
    organization: header(request, "x-sentinel-organization"),
    payload,
    at: Date.now(),
  });
  if (!result.ok) return json(statusFor(result.error), { error: result.error });

  return json(202, {
    accepted: result.value.accepted,
    refused: result.value.rejected,
    alerts: result.value.alerts,
  });
}
