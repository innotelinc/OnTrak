/**
 * RMM / monitoring webhook (M6 integration).
 *
 * A monitoring system — an RMM, an uptime checker, a metrics alertmanager — POSTs
 * one alert as JSON here when a check fails or recovers. The route does three
 * things and decides nothing else:
 *
 *   1. authenticate the caller with the shared secret (`Authorization: Bearer` or
 *      `x-ontrak-secret`), failing closed when the secret is unset;
 *   2. resolve the tenant (`?tenant=<slug>` or the `x-ontrak-tenant` header);
 *   3. hand the payload to `RmmConnectorService`, which classifies it, matches it
 *      to the condition it belongs to, raises or closes a ticket through the normal
 *      lifecycle, and records the whole thing on the tenant's audit chain.
 *
 * Status codes are policy in `rmm-rules.ts` (`rmmReply`, pure and unit-tested):
 * `202` when the desk acted, `200` for an answer that is already true (a repeat, a
 * recovery we never opened against), `400` when the payload was never an alert, and
 * `503` when the desk cannot respond at all so the sender should retry later.
 *
 * The secret is its own (`ONTRAK_TIX_RMM_SECRET`) rather than the inbound-email
 * one: two integrations with the same shared secret means rotating either one
 * breaks both, and a monitoring system is exactly the caller somebody replaces.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, rmmServicesFor } from "../../../lib/db";
import { RMM_SECRET_ENV, rmmReply } from "../../../lib/rmm-rules";
import { extractSecret, secretsMatch, tenantSlug } from "../../../lib/intake-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[RMM_SECRET_ENV] ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const slug = tenantSlug(
    request.nextUrl.searchParams.get("tenant"),
    request.headers.get("x-ontrak-tenant"),
  );
  if (!slug) {
    return NextResponse.json(
      { error: "Missing tenant (use ?tenant=<slug> or the x-ontrak-tenant header)." },
      { status: 400 },
    );
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const outcome = await rmmServicesFor().receive(tenant.id, body);
  const reply = rmmReply(outcome);
  return NextResponse.json(reply.body, { status: reply.status });
}
