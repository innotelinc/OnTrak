/**
 * `/api/v1/tokens` — minting and listing API tokens (M6).
 *
 *   GET  /api/v1/tokens        a signed-in administrator's session
 *   POST /api/v1/tokens        a signed-in administrator's session
 *
 * **Deliberately not reachable with an API token.** A token that can mint a token
 * can re-issue itself after being revoked, which removes the one remedy
 * revocation exists to provide — so minting stays a signed-in human's act, and the
 * service checks `tenant:manage` on top of that.
 *
 * The `POST` response is the **only** time the secret is ever readable. Nothing
 * stores it, so a second read of the row cannot produce it: a support engineer who
 * can read the database still cannot impersonate the integration, and a backup is
 * not a set of credentials. That is stated in the body itself (`secret_shown_once`)
 * so a client that swallowed the response has to make a human come back rather than
 * assume it can be fetched again.
 */

import type { NextRequest } from "next/server";

import { apiTokenServicesFor } from "../../../../lib/db";
import { apiError, apiJson } from "../../../../lib/public-api-http";
import { API_VERSION } from "../../../../lib/public-api-rules";
import { send, staffActor } from "../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The token as a console reads it: identity, scopes and state, never the secret. */
function tokenView(token: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: readonly string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rateLimitPerMinute: number;
}): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    scopes: [...token.scopes],
    rate_limit_per_minute: token.rateLimitPerMinute,
    created_at: token.createdAt,
    expires_at: token.expiresAt,
    revoked_at: token.revokedAt,
    last_used_at: token.lastUsedAt,
    active: token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > Date.now()),
  };
}

export async function GET(): Promise<Response> {
  const actor = await staffActor();
  if (!actor) return send(apiError(401, "session_required", "Sign in to read this workspace's API tokens."));

  const listed = await apiTokenServicesFor().list(actor);
  if (!listed.ok) return send(apiError(403, "forbidden", listed.error));
  return send(apiJson(200, { api_version: API_VERSION, data: listed.value.map(tokenView) }));
}

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await staffActor();
  if (!actor) return send(apiError(401, "session_required", "Sign in to mint an API token."));

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return send(apiError(400, "invalid_json", "Expected a JSON body."));
  }

  const created = await apiTokenServicesFor().create(actor, {
    name: typeof body.name === "string" ? body.name : "",
    scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
    expiresInDays: typeof body.expires_in_days === "number" ? body.expires_in_days : null,
    rateLimitPerMinute: typeof body.rate_limit_per_minute === "number" ? body.rate_limit_per_minute : undefined,
  });
  if (!created.ok) return send(apiError(422, "invalid_token_request", created.error));

  return send(
    apiJson(201, {
      api_version: API_VERSION,
      data: tokenView(created.value.token),
      token: created.value.secret,
      secret_shown_once: "This is the only time this value can be read. Store it now.",
    }),
  );
}
