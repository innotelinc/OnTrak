/**
 * Scheduled SLA report snapshot (M1).
 *
 * The exportable form of the report is a download; its *scheduled* form is this
 * endpoint. A weekly cron — `curl -X POST -H "Authorization: Bearer
 * $ONTRAK_TIX_CRON_SECRET" ...` — walks every tenant, builds the same report the
 * `/reports` page renders, and writes its headline numbers to the hash-chained
 * audit log as a `report.sla.snapshot` event. That makes each week's attainment
 * figure part of the tamper-evident history, not a screenshot someone has to
 * remember to take.
 *
 * No email: the snapshot is returned in the response and persisted in the audit
 * chain. A transport can be layered on later without changing this contract.
 *
 *   POST /api/sla/report             # every tenant
 *   POST /api/sla/report?tenant=acme
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "../../../../lib/db";
import { ticketServices } from "../../../../lib/ticket-server";
import { buildSlaReport, reportSnapshot, type SlaReportSnapshot } from "../../../../lib/report-rules";
import { PrismaSlaPolicyStore, type SlaPolicyPrismaClient } from "../../../../lib/sla-store-prisma";
import { ESCALATION_CRON_SECRET_ENV } from "../../../../lib/escalation-service";
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
  const policyStore = new PrismaSlaPolicyStore(prisma as unknown as SlaPolicyPrismaClient);
  const now = new Date().toISOString();
  const perTenant: { tenant: string; snapshot: SlaReportSnapshot }[] = [];

  for (const tenant of tenants) {
    const [tickets, policies] = await Promise.all([
      services.store.listTickets(tenant.id),
      policyStore.listForTenant(tenant.id),
    ]);
    const report = buildSlaReport(tickets, policies, now);
    const snapshot = reportSnapshot(report, now);

    await services.audit.append({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      at: now,
      actor: "system:sla-report",
      action: "report.sla.snapshot",
      targetType: "tenant",
      targetId: tenant.id,
      detail: snapshot as unknown as Record<string, unknown>,
    });

    perTenant.push({ tenant: tenant.slug, snapshot });
  }

  return NextResponse.json({ status: "ok", generatedAt: now, tenants: perTenant });
}
