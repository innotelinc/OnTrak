/**
 * Invoice CSV download (M4).
 *
 * A read, not an issue. The invoice is created by the action that stamps its
 * entries (a POST, audited, once); this route re-reads what that recorded so
 * that following the link a second time — from an email, from the ledger, from
 * anybody's bookmark — cannot bill anything again. That is the whole reason
 * issuing and downloading are two steps.
 *
 * Like the report export it re-derives the actor and the permission itself: the
 * link on the page is a courtesy, not a control.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentActor } from "../../../../lib/session";
import { clientServicesFor, timeServicesFor } from "../../../../lib/db";
import { hasPermission } from "../../../../lib/access-rules";
import { buildInvoiceCsv } from "../../../../lib/invoice-csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const actor = await currentActor();
  if (!actor) return NextResponse.redirect(new URL("/sign-in", request.url));
  if (!hasPermission(actor.role, "ticket:read:any")) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const ref = request.nextUrl.searchParams.get("ref") ?? "";
  if (!ref) return NextResponse.json({ error: "Give the invoice reference." }, { status: 400 });

  const invoice = await timeServicesFor().issued(actor, ref);
  if (!invoice.ok) return NextResponse.json({ error: invoice.error }, { status: 404 });

  // The client's name, not its id: this file is what the client is sent.
  let clientName: string | undefined = invoice.value.clientId ? undefined : "the desk";
  if (invoice.value.clientId) {
    const clients = await clientServicesFor().list(actor);
    if (clients.ok) {
      clientName = clients.value.find((entry) => entry.client.id === invoice.value.clientId)?.client.name;
    }
  }

  const csv = buildInvoiceCsv(invoice.value, {
    generatedAt: new Date().toISOString(),
    ...(clientName ? { clientName } : {}),
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ref}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
