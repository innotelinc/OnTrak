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
import {
  clientServicesFor,
  clientSurveyServicesFor,
  csatServicesFor,
  slaPolicyStoreFor,
  ticketServicesFor,
} from "../../../../lib/db";
import { hasPermission } from "../../../../lib/access-rules";
import { buildSlaReport, clientScorecards, type ReportSurvey } from "../../../../lib/report-rules";
import { buildClientCsv, buildSlaCsv } from "../../../../lib/report-csv";

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

  // Two exports off one screen: the ticket-level report, and the per-client one
  // that an account manager forwards.
  const scope = request.nextUrl.searchParams.get("scope");
  const perClient = scope === "clients";

  let csv: string;
  let filename: string;
  if (perClient) {
    const [clients, ticketSurveys, clientSurveys] = await Promise.all([
      clientServicesFor().list(actor),
      csatServicesFor().list(actor.tenantId),
      clientSurveyServicesFor().all(actor),
    ]);
    const clientOfTicket = new Map(tickets.map((ticket) => [ticket.id, ticket.clientId ?? null]));
    const surveys: ReportSurvey[] = [
      ...ticketSurveys.map((survey) => ({
        clientId: clientOfTicket.get(survey.ticketId) ?? null,
        requestedAt: survey.requestedAt,
        respondedAt: survey.respondedAt,
        score: survey.score,
      })),
      ...(clientSurveys.ok ? clientSurveys.value : []).map((survey) => ({
        clientId: survey.clientId,
        requestedAt: survey.requestedAt,
        respondedAt: survey.respondedAt,
        score: survey.score,
      })),
    ];
    csv = buildClientCsv(
      clientScorecards(tickets, policies, clients.ok ? clients.value.map((entry) => entry.client) : [], now, surveys),
      { generatedAt: now },
    );
    filename = `client-report-${now.slice(0, 10)}.csv`;
  } else {
    csv = buildSlaCsv(buildSlaReport(tickets, policies, now), { generatedAt: now });
    filename = `sla-report-${now.slice(0, 10)}.csv`;
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
