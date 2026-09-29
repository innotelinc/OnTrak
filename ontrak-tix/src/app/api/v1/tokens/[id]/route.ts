/**
 * `/api/v1/tokens/:id` — revoke one API token (M6). A signed-in administrator's
 * session, exactly as minting is, and for the same reason.
 *
 * Revoking is idempotent: the second call is what a person makes when the first
 * looked like it did nothing, so it answers `200` with the row as it stands rather
 * than `404` or an error. The token itself is never needed — and never accepted —
 * so a leaked value cannot be *un*-revoked by presenting it.
 */

import type { NextRequest } from "next/server";

import { apiTokenServicesFor } from "../../../../../lib/db";
import { apiError, apiJson } from "../../../../../lib/public-api-http";
import { API_VERSION } from "../../../../../lib/public-api-rules";
import { send, staffActor } from "../../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = await staffActor();
  if (!actor) return send(apiError(401, "session_required", "Sign in to revoke an API token."));

  const { id } = await context.params;
  const revoked = await apiTokenServicesFor().revoke(actor, id);
  if (!revoked.ok) {
    // A token in another workspace is simply not there, which is the same answer
    // as for an id that never existed.
    return send(apiError(404, "not_found", revoked.error));
  }

  return send(
    apiJson(200, {
      api_version: API_VERSION,
      data: {
        id: revoked.value.id,
        name: revoked.value.name,
        revoked_at: revoked.value.revokedAt,
      },
    }),
  );
}
