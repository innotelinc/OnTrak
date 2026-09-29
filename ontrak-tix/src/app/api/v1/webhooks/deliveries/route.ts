/**
 * `/api/v1/webhooks/deliveries` — the delivery log (M6). Scope: `webhooks:manage`.
 *
 *   GET /api/v1/webhooks/deliveries?endpoint_id=…&status=RETRYING&limit=50
 *
 * This is the endpoint the roadmap's "delivery logs" means: every event we
 * attempted, what the receiver answered, how many times we tried, and — when a
 * retry is still owed — when the next attempt is due. `status` is the state a
 * support engineer would name: `PENDING`, `DELIVERED`, `RETRYING`, `EXHAUSTED`.
 *
 * The delivery's **payload** is included, because "what did you actually send us?"
 * is the question that ends most webhook arguments, and answering it from the
 * record is the difference between a fact and a reconstruction.
 */

import type { NextRequest } from "next/server";

import { apiTokenServicesFor, webhookServicesFor } from "../../../../../lib/db";
import { apiError, apiJson, gate, successHeaders } from "../../../../../lib/public-api-http";
import { API_VERSION } from "../../../../../lib/public-api-rules";
import { DELIVERY_STATUSES, type DeliveryStatus } from "../../../../../lib/webhook-rules";
import { send } from "../../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const result = await gate(request, apiTokenServicesFor(), "webhooks:manage");
  if (!result.ok) return send(result.response);

  const params = request.nextUrl.searchParams;
  const requestedStatus = (params.get("status") ?? "").trim().toUpperCase();
  if (requestedStatus && !(DELIVERY_STATUSES as readonly string[]).includes(requestedStatus)) {
    return send(
      apiError(400, "invalid_status", `Status is one of ${DELIVERY_STATUSES.join(", ")}.`, successHeaders(result.caller)),
    );
  }

  const requestedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const listed = await webhookServicesFor().listDeliveries(result.caller.actor, {
    endpointId: (params.get("endpoint_id") ?? "").trim() || undefined,
    status: (requestedStatus || undefined) as DeliveryStatus | undefined,
    limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 50,
  });
  if (!listed.ok) return send(apiError(403, "forbidden", listed.error));

  return send(
    apiJson(
      200,
      {
        api_version: API_VERSION,
        data: listed.value.map(({ delivery, endpointName }) => ({
          id: delivery.id,
          endpoint_id: delivery.endpointId,
          endpoint_name: endpointName,
          event: delivery.event,
          status: delivery.status,
          attempt_count: delivery.attemptCount,
          max_attempts: 5,
          last_status_code: delivery.lastStatusCode,
          last_error: delivery.lastError,
          last_attempt_at: delivery.lastAttemptAt === null ? null : new Date(delivery.lastAttemptAt).toISOString(),
          next_attempt_at: delivery.nextAttemptAt === null ? null : new Date(delivery.nextAttemptAt).toISOString(),
          delivered_at: delivery.deliveredAt === null ? null : new Date(delivery.deliveredAt).toISOString(),
          created_at: new Date(delivery.createdAt).toISOString(),
          payload: delivery.payload,
        })),
      },
      successHeaders(result.caller),
    ),
  );
}
