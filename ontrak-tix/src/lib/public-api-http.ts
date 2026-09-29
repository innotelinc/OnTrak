/**
 * Public API HTTP layer (M6): the shape of an answer, and the gate in front of
 * every endpoint.
 *
 * It is a pure module over plain request/response shapes rather than Next
 * plumbing, for the same reason Sentinel's routers are: the *order* of the checks
 * is the security, and an order that can only be exercised through a running
 * framework is an order nobody tests. The route files are then a few lines each.
 *
 * The gate answers four questions, in this order:
 *
 *  1. **Is a bearer token present at all?** No token is `401` with `WWW-Authenticate`,
 *     so a client that guessed wrong learns to send one.
 *  2. **Is it a token of ours, unrevoked and unexpired?** One `401` for every way
 *     it can fail. Which of unknown, revoked and expired it was is information a
 *     guesser wants, and it is already on the audit trail where it belongs.
 *  3. **Has it asked too often?** `429` with `Retry-After`, computed from the
 *     window rather than estimated by a client retrying until it fits.
 *  4. **Does it hold the scope this endpoint needs?** `403` with the scope named,
 *     because *that* is a fact the caller already knows and can act on.
 *
 * The rate window is spent by step 2, not step 4, and that is deliberate: an
 * integration hammering an endpoint it has no scope for is still hammering us, and
 * a token that could escape its budget by picking a forbidden path would make the
 * limit advisory.
 */

import { bearerToken, rateLimitHeaders, scopeCovers, type ApiScope } from "./public-api-rules";
import type { ApiCaller } from "./public-api-service";
import type { ServiceResult } from "./ticket-service";

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Everything the API answers with. `no-store` because a token is in the request. */
export function apiJson(status: number, value: unknown, headers: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: JSON.stringify(value),
  };
}

/**
 * An error body an integrator can branch on.
 *
 * A stable `error` code beside a human `message`, because a client that has to
 * string-match prose is a client that breaks when the prose improves.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): ApiResponse {
  return apiJson(status, { error: code, message }, headers);
}

export function methodNotAllowed(allowed: readonly string[]): ApiResponse {
  return apiError(405, "method_not_allowed", `Use ${allowed.join(" or ")}.`, { allow: allowed.join(", ") });
}

export const NOT_FOUND: ApiResponse = { status: 404, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: "not_found", message: "No such endpoint." }) };

/** The bit of a request the gate needs, so a test can hand in a literal object. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** What the gate calls. Structural, so a route passes the real service and a test a stub. */
export interface ApiGate {
  authenticate(presented: string | null): Promise<ServiceResult<ApiCaller>>;
}

export type GateResult = { ok: true; caller: ApiCaller } | { ok: false; response: ApiResponse };

/**
 * Authenticate, limit and authorise one request. See the note at the top of this
 * file for why the order is what it is.
 */
export async function gate(
  request: { headers: HeaderReader },
  tokens: ApiGate,
  required: ApiScope,
): Promise<GateResult> {
  const presented = bearerToken(request.headers);
  if (!presented) {
    return {
      ok: false,
      response: apiError(401, "api_token_required", "Send an API token as `Authorization: Bearer <token>`.", {
        "www-authenticate": "Bearer",
      }),
    };
  }

  const authenticated = await tokens.authenticate(presented);
  if (!authenticated.ok) {
    return {
      ok: false,
      response: apiError(401, "invalid_token", authenticated.error, { "www-authenticate": "Bearer" }),
    };
  }

  const caller = authenticated.value;
  const limitHeaders = rateLimitHeaders(caller.rate);
  if (!caller.rate.allowed) {
    return {
      ok: false,
      response: apiError(
        429,
        "rate_limited",
        `This token is allowed ${caller.rate.limit} requests a minute; retry in ${caller.rate.retryAfterSeconds}s.`,
        limitHeaders,
      ),
    };
  }

  if (!scopeCovers(caller.scopes, required)) {
    return {
      ok: false,
      response: apiError(403, "insufficient_scope", `This token does not hold the “${required}” scope.`, limitHeaders),
    };
  }

  return { ok: true, caller };
}

/** The headers a successful answer carries, so a client can pace itself. */
export function successHeaders(caller: ApiCaller): Record<string, string> {
  return rateLimitHeaders(caller.rate);
}
