/**
 * SLA report CSV download (M1).
 *
 * A route handler rather than a page: the response is a file, not HTML. It
 * re-derives the actor and the permissions itself — the nav link is a courtesy,
 * not a control — and returns the same report the `/reports` screen shows, in
 * the report's own triage order.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentActor } from "../../../../lib/session";
import { ticketServicesFor, slaPolicyStoreFor } from "../../../../lib/db";
import { hasPermission } from "../../../../lib/access-rules";
import { buildSlaReport } from "../../../../lib/report-rules";
import { buildSlaCsv } from "../../../../lib/report-csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const actor = await currentActor();
  if (!actor) return NextResponse.redirect(new URL("/sign-in", request.url));
  // A report is a tenant-wide view; a requester has no business here.
  if (!hasPermission(actor.role, "ticket:read:any")) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const now = new Date().toISOString();
  const [tickets, policies] = await Promise.all([
    ticketServicesFor().store.listTickets(actor.tenantId),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
  ]);
  const csv = buildSlaCsv(buildSlaReport(tickets, policies, now), { generatedAt: now });
  const filename = `sla-report-${now.slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
