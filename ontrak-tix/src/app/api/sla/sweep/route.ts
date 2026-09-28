/**
 * Scheduled SLA sweep (M1).
 *
 * A cron — `curl -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" ...`
 * — hits this endpoint. For every tenant it walks the running response and
 * resolution clocks up their escalation ladder and raises each new rung exactly
 * once, writing an `SlaEscalation` row and an audit event.
 *
 * It is idempotent by construction: the rung's `dedupeKey` is checked before it
 * is raised, so running the sweep every minute, or twice by accident, never
 * double-fires. That is what makes it safe to schedule aggressively — which is
 * the point, since the goal is to surface breaches *before* they happen.
 *
 *   POST /api/sla/sweep            # every tenant
 *   POST /api/sla/sweep?tenant=acme
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "../../../../lib/db";
import { ticketServices } from "../../../../lib/ticket-server";
import { ESCALATION_CRON_SECRET_ENV, EscalationService, type EscalationTicket } from "../../../../lib/escalation-service";
import { PrismaEscalationStore, type EscalationPrismaClient } from "../../../../lib/escalation-store-prisma";
import { PrismaSlaPolicyStore, type SlaPolicyPrismaClient } from "../../../../lib/sla-store-prisma";
import { extractSecret, secretsMatch } from "../../../../lib/intake-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[ESCALATION_CRON_SECRET_ENV] ?? process.env.ONTRAK_TIX_WEBHOOK_SECRET ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const slug = request.nextUrl.searchParams.get("tenant");
  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
  });
  if (slug && tenants.length === 0) {
    return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });
  }

  const services = ticketServices();
  const escalationStore = new PrismaEscalationStore(prisma as unknown as EscalationPrismaClient);
  const policyStore = new PrismaSlaPolicyStore(prisma as unknown as SlaPolicyPrismaClient);
  const escalation = new EscalationService(escalationStore, services.audit);
  const now = new Date().toISOString();

  let raised = 0;
  const perTenant: { tenant: string; tickets: number; raised: number }[] = [];

  for (const tenant of tenants) {
    const [records, policies] = await Promise.all([
      services.store.listTickets(tenant.id),
      policyStore.listForTenant(tenant.id),
    ]);
    const tickets: EscalationTicket[] = records.map((record) => ({
      id: record.id,
      ref: record.ref,
      priority: record.priority,
      createdAt: record.createdAt,
      firstResponseAt: record.firstResponseAt,
      resolvedAt: record.resolvedAt,
      pauses: record.pauses,
      status: record.status,
    }));

    const plans = await escalation.sweep({ tenantId: tenant.id, tickets, policies, now });
    raised += plans.length;
    perTenant.push({ tenant: tenant.slug, tickets: tickets.length, raised: plans.length });
  }

  return NextResponse.json({ status: "ok", raised, tenants: perTenant });
}
