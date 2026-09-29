/**
 * `/api/v1/tickets/:id` — read one ticket (M6). Scope: `tickets:read`.
 *
 * The list omits the description and the conversation; this returns them, because
 * an integration that has been told about a ticket by webhook needs a way to fetch
 * the thing it was told about.
 *
 * The lookup is tenant-scoped from the caller's token, and a ticket in another
 * workspace is simply **not found** rather than forbidden — the same answer as for
 * an id that never existed, which is the only answer a caller can act on without
 * learning about another tenant.
 */

import type { NextRequest } from "next/server";

import { apiTokenServicesFor, ticketServicesFor } from "../../../../../lib/db";
import { apiError, apiJson, gate, successHeaders } from "../../../../../lib/public-api-http";
import { API_VERSION } from "../../../../../lib/public-api-rules";
import { send } from "../../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await gate(request, apiTokenServicesFor(), "tickets:read");
  if (!result.ok) return send(result.response);

  const { id } = await context.params;
  const ticket = await ticketServicesFor().store.findTicket(result.caller.tenantId, id);
  if (!ticket) return send(apiError(404, "not_found", "That ticket does not exist."));

  return send(
    apiJson(
      200,
      {
        api_version: API_VERSION,
        data: {
          id: ticket.id,
          ref: ticket.ref,
          subject: ticket.subject,
          description: ticket.description,
          type: ticket.type,
          status: ticket.status,
          priority: ticket.priority,
          requester_id: ticket.requesterId,
          assignee_id: ticket.assigneeId,
          queue_id: ticket.queueId,
          client_id: ticket.clientId ?? null,
          tags: ticket.tags ?? [],
          created_at: ticket.createdAt,
          updated_at: ticket.updatedAt,
          first_response_at: ticket.firstResponseAt,
          resolved_at: ticket.resolvedAt,
          closed_at: ticket.closedAt,
          messages: ticket.messages.map((message) => ({
            id: message.id,
            kind: message.kind,
            author_id: message.authorId,
            body: message.body,
            created_at: message.createdAt,
          })),
        },
      },
      successHeaders(result.caller),
    ),
  );
}
