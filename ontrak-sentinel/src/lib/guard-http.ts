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
import { toObservedEventsFromOtlp } from "./telemetry-otel";

export const GUARD_PATHS = {
  events: "/guard/v1/events",
  /**
   * The OTLP/HTTP receiver (S3): the third way telemetry arrives, and the one an
   * OpenTelemetry collector or agent speaks natively.
   *
   * A separate path from `events` because the body is not the family's own batch
   * envelope — it is an OTLP `ExportLogsServiceRequest`/`ExportTraceServiceRequest`,
   * which the router expands into the same normalizer payloads and hands to the same
   * `ingest`. The token and the tenant are the ones the rest of the surface uses.
   */
  otel: "/guard/v1/otel",
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
  /**
   * The rule set's own id, so an alert read later can name the *corpus* it was judged by
   * and not only the rule that fired. See `rulebookVersion` in `detection-rules.ts`.
   */
  rulebookVersion(): string;
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
    //
    // The version comes first because it is what a reconciliation is *about*: two rules at
    // the same version in two different corpora is the case a per-rule version cannot
    // describe, and the one this field exists for.
    return json(200, { rulebookVersion: endpoints.rulebookVersion(), rules: endpoints.rulebook() });
  }

  if (path === GUARD_PATHS.otel) {
    if (method !== "POST") return json(405, { error: "method_not_allowed", allow: "POST" });
    let body: unknown;
    try {
      body = request.body ? JSON.parse(request.body) : null;
    } catch {
      return json(400, { error: "invalid_request", error_description: "The body is not JSON." });
    }

    const read = toObservedEventsFromOtlp(body);
    if (read.events.length === 0) {
      return json(400, {
        error: "invalid_request",
        error_description: read.issues[0] ?? "The OTLP export carried no log records or spans.",
      });
    }

    // The one call, with the source fixed to OTEL and the exporter's own name when it
    // gave one: an OTLP body has no field for "what kind of sensor is this", so the
    // receiver supplies what it knows and the normalizer decides the rest.
    const result = await endpoints.ingest({
      authorization: header(request, "authorization"),
      organization: header(request, "x-sentinel-organization"),
      payload: { source: "OTEL", sensor: read.sensor ?? "otel", events: read.events },
      at: Date.now(),
    });
    if (!result.ok) return json(statusFor(result.error), { error: result.error });

    // OTLP's own partial-success shape, so an exporter that inspects the response is not
    // surprised, with the family's report fields beside it (a client ignores fields it
    // does not know). A record the normalizer refused is a partial success by OTLP's
    // definition, and saying so is the whole point of the shape.
    const rejected = [...read.issues, ...result.value.rejected.map((entry) => entry.reason)];
    return json(200, {
      ...(rejected.length > 0
        ? { partialSuccess: { rejectedLogRecords: rejected.length, errorMessage: rejected.join("; ") } }
        : {}),
      accepted: result.value.accepted,
      refused: result.value.rejected,
      alerts: result.value.alerts,
    });
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
