/**
 * Scheduled retention sweep (M3).
 *
 * A retention date is only a promise if something eventually acts on it. The
 * lock rules decide *whether* an artifact may go (`planRetentionSweep` uses the
 * same `objectPurgeDecision` an administrator's manual purge does); this endpoint
 * is the scheduler that carries the decision out — purging the bytes, stamping
 * the tombstone, and writing both the per-artifact audit event and one event for
 * the run itself, so a sweep that found nothing is on the record too.
 *
 * It is authenticated with the same secret as the SLA sweep, and it is safe to
 * schedule daily or hourly: a purged artifact is excluded from the worklist
 * (its `purgedAt` is set), so running it twice purges nothing the second time.
 *
 *   POST /api/incidents/retention-sweep             # every tenant
 *   POST /api/incidents/retention-sweep?tenant=acme
 *   POST /api/incidents/retention-sweep?dryRun=1    # report, change nothing
 *
 * A legal hold stops it in both directions — it blocks an artifact whose window
 * has closed just as firmly as one still inside it — and the report says what it
 * left alone and why.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, incidentDocsServicesFor } from "../../../../lib/db";
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

  const dryRun = ["1", "true", "yes"].includes((request.nextUrl.searchParams.get("dryRun") ?? "").toLowerCase());
  const docs = incidentDocsServicesFor();

  let purged = 0;
  let bytesFreed = 0;
  const perTenant: { tenant: string; considered: number; purged: number; retained: number; held: number }[] = [];
  const skipped: string[] = [];

  for (const tenant of tenants) {
    const result = await docs.sweepRetention(tenant.id, { dryRun });
    if (!result.ok) {
      // One tenant without storage does not fail the others' sweep.
      skipped.push(`${tenant.slug}: ${result.error}`);
      continue;
    }
    purged += result.value.purged;
    bytesFreed += result.value.bytesFreed;
    perTenant.push({
      tenant: tenant.slug,
      considered: result.value.considered,
      purged: result.value.purged,
      retained: result.value.retained,
      held: result.value.held,
    });
  }

  return NextResponse.json({ status: "ok", dryRun, purged, bytesFreed, tenants: perTenant, ...(skipped.length ? { skipped } : {}) });
}
