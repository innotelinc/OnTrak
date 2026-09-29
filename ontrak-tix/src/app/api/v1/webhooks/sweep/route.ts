/**
 * `POST /api/v1/webhooks/sweep` — attempt every delivery that is owed one (M6).
 *
 * A retry schedule is only a promise if something acts on it. Every failure that
 * is not final is stored with the instant of its next attempt, and this endpoint
 * is the thing that reads that clock — the same shape as the SLA sweep and the
 * retention sweep, and authenticated the same way, with the shared cron secret
 * rather than an API token: it is infrastructure's call, not a customer's.
 *
 *   POST /api/v1/webhooks/sweep                # every workspace
 *   POST /api/v1/webhooks/sweep?tenant=acme    # one of them
 *   POST /api/v1/webhooks/sweep?limit=200
 *
 * Safe to run as often as you like: a delivery that is not due is not in the
 * worklist, one that has been delivered is not either, and a removed endpoint
 * stops its deliveries rather than queueing them forever. The counts are returned
 * so a schedule that found nothing is a visible fact rather than a silent one.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, webhookServicesFor } from "../../../../../lib/db";
import { ESCALATION_CRON_SECRET_ENV } from "../../../../../lib/escalation-service";
import { extractSecret, secretsMatch } from "../../../../../lib/intake-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[ESCALATION_CRON_SECRET_ENV] ?? process.env.ONTRAK_TIX_WEBHOOK_SECRET ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const slug = request.nextUrl.searchParams.get("tenant");
  const tenants = await prisma.tenant.findMany({ where: slug ? { slug } : undefined, select: { id: true, slug: true } });
  if (slug && tenants.length === 0) {
    return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });
  }

  const requestedLimit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 50;
  const webhooks = webhookServicesFor();

  const perTenant: { tenant: string; considered: number; delivered: number; retrying: number; exhausted: number }[] = [];
  let delivered = 0;
  let retrying = 0;
  let exhausted = 0;

  for (const tenant of tenants) {
    const result = await webhooks.deliverDue(tenant.id, limit);
    delivered += result.delivered;
    retrying += result.retrying;
    exhausted += result.exhausted;
    perTenant.push({ tenant: tenant.slug, ...result });
  }

  return NextResponse.json({ status: "ok", delivered, retrying, exhausted, tenants: perTenant });
}
