/**
 * `/api/v1/tickets` — the first versioned public endpoint (M6).
 *
 *   GET  /api/v1/tickets?limit=25&cursor=<ticket id>   scope: tickets:read
 *   POST /api/v1/tickets                               scope: tickets:write
 *
 * Both are reached with `Authorization: Bearer <token>`; `public-api-http.ts`
 * owns the gate, so this file does not decide anything about authentication,
 * scopes or rate limits. Three choices are worth stating out loud:
 *
 *  - **A write goes through `TicketService`, not the store.** That is what keeps
 *    the API honest: an integration-created ticket fires the desk's rules, lands
 *    on the tenant's hash chain with `api-token:<id>` as its actor, and appears in
 *    the inbox exactly as one raised by a person would. A public API that wrote
 *    rows directly would be a second, divergent product.
 *  - **The list is paged by id, not by page number.** A page number over a list
 *    being written to skips and repeats rows; "after this one" means the same
 *    thing however much arrived meanwhile. A cursor that names no row is a `400`
 *    rather than a silent restart at the beginning, because a client looping over
 *    the first page forever is worse than an error.
 *  - **The seam is admitted.** `TicketStore` today returns a tenant's tickets and
 *    the API pages them in memory; the port grows a cursor query when a tenant has
 *    more tickets than fit in a response, and until then the honest thing is to
 *    say so rather than to imply a database-level cursor exists.
 */

import type { NextRequest } from "next/server";

import { apiTokenServicesFor, chatNotifyServicesFor, ticketServicesFor, webhookServicesFor } from "../../../../lib/db";
import { apiError, apiJson, gate, successHeaders } from "../../../../lib/public-api-http";
import { API_VERSION, apiPage, pageResult } from "../../../../lib/public-api-rules";
import type { TicketPriority, TicketType } from "../../../../lib/ticket-rules";
import { send } from "../_respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The fields a list can carry. `messages` and `description` are a detail read. */
function ticketSummary(ticket: {
  id: string;
  ref: string;
  subject: string;
  type: string;
  status: string;
  priority: string;
  requesterId: string;
  assigneeId: string | null;
  queueId: string | null;
  clientId?: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  tags?: readonly string[];
}): Record<string, unknown> {
  return {
    id: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
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
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const result = await gate(request, apiTokenServicesFor(), "tickets:read");
  if (!result.ok) return send(result.response);

  const page = apiPage(request.nextUrl.searchParams);
  const all = await ticketServicesFor().store.listTickets(result.caller.tenantId);
  // Deterministic by id, so a client walking with a cursor sees every ticket once.
  const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id));

  let start = 0;
  if (page.cursor) {
    const index = sorted.findIndex((ticket) => ticket.id === page.cursor);
    if (index < 0) {
      return send(apiError(400, "invalid_cursor", "That cursor does not name a ticket in this workspace."));
    }
    start = index + 1;
  }

  const { data, nextCursor } = pageResult(sorted.slice(start, start + page.limit + 1), page);
  return send(
    apiJson(
      200,
      { api_version: API_VERSION, data: data.map(ticketSummary), next_cursor: nextCursor },
      successHeaders(result.caller),
    ),
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const result = await gate(request, apiTokenServicesFor(), "tickets:write");
  if (!result.ok) return send(result.response);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return send(apiError(400, "invalid_json", "Expected a JSON body."));
  }

  const created = await ticketServicesFor().service.createTicket(result.caller.actor, {
    subject: typeof body.subject === "string" ? body.subject : "",
    description: typeof body.description === "string" ? body.description : "",
    // An API client that omits these gets the same defaults the portal gives a
    // requester; `planTicketCreation` refuses anything that is not a real value,
    // so a typo becomes a `422` rather than a row with an invented type.
    type: (typeof body.type === "string" ? body.type : "INCIDENT") as TicketType,
    priority: (typeof body.priority === "string" ? body.priority : "NORMAL") as TicketPriority,
    requesterId: typeof body.requester_id === "string" ? body.requester_id : undefined,
    queueId: typeof body.queue_id === "string" ? body.queue_id : null,
    clientId: typeof body.client_id === "string" ? body.client_id : null,
  });

  // A refusal is the desk's own validation talking — "a subject is required",
  // "that queue does not exist" — so it is passed through rather than re-worded
  // into something the API invented.
  if (!created.ok) return send(apiError(422, "invalid_ticket", created.error));

  // The event is emitted after the row exists, so a subscriber can fetch what it
  // is told about. A delivery failure never fails the write: the ticket is real
  // either way, and the delivery log is where a failure is visible.
  await webhookServicesFor().emit(created.value.tenantId, "ticket.created", {
    id: created.value.id,
    ref: created.value.ref,
    subject: created.value.subject,
    status: created.value.status,
    priority: created.value.priority,
    requester_id: created.value.requesterId,
  });

  // And the rooms, from the same event: an integration reconciles from the webhook
  // and a person reads the channel, and neither is a substitute for the other. Same
  // rule as above — a message that cannot be posted never fails the write.
  await chatNotifyServicesFor().notify(created.value.tenantId, "ticket.created", {
    ref: created.value.ref,
    subject: created.value.subject,
    status: created.value.status,
    priority: created.value.priority,
  });

  return send(apiJson(201, { api_version: API_VERSION, data: ticketSummary(created.value) }, successHeaders(result.caller)));
}
