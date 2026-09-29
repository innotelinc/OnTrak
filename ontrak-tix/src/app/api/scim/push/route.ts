/**
 * Scheduled outbound provisioning (M2).
 *
 * A cron — `curl -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" …`
 * — hits this endpoint, and every tenant's people are pushed to the identity
 * provider. Without it the push only happens when an administrator presses the
 * button, which means a new colleague cannot sign in until somebody remembers to.
 *
 *   POST /api/scim/push            # every tenant
 *   POST /api/scim/push?tenant=acme
 *
 * It is safe to schedule aggressively, and that is a property of the sync rather
 * than of this route: a person the provider already matches is planned as a no-op,
 * so a quiet run writes nothing at all — no provider writes, no audit entries, and
 * nothing for anybody to clean up afterwards.
 *
 * **An unconfigured deployment is `503`, not a cheerful `200` with zeroes.** A
 * scheduler's job is to notice that a sync stopped happening, and a run that
 * reports success while pushing nowhere is exactly the failure it cannot see.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, scimSyncServicesFor } from "../../../../lib/db";
import { extractSecret, secretsMatch } from "../../../../lib/intake-webhook";
import type { ScimSyncOutcome } from "../../../../lib/scim-sync-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The secret a scheduler signs with. Falls back to the webhook secret. */
const CRON_SECRET_ENV = "ONTRAK_TIX_CRON_SECRET";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[CRON_SECRET_ENV] ?? process.env.ONTRAK_TIX_WEBHOOK_SECRET ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const service = scimSyncServicesFor();
  if (!service.configured()) {
    // Fails loudly and with the variables to set, because this is the one state a
    // scheduler has to be able to tell apart from a completed run.
    return NextResponse.json(
      {
        error:
          "No outbound identity provider is configured. Set ONTRAK_TIX_SCIM_BASE_URL and ONTRAK_TIX_SCIM_TOKEN.",
      },
      { status: 503 },
    );
  }

  const slug = request.nextUrl.searchParams.get("tenant");
  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
  if (slug && tenants.length === 0) {
    return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });
  }

  const results: { tenant: string; outcome: ScimSyncOutcome | null; error: string | null }[] = [];
  let failed = 0;

  for (const tenant of tenants) {
    const pushed = await service.pushTenant(tenant.id);
    if (!pushed.ok) {
      // One tenant's refusal must not abandon the rest: a broken connector for one
      // desk is not a reason for every other desk to stop syncing.
      failed += 1;
      results.push({ tenant: tenant.slug, outcome: null, error: pushed.error });
      continue;
    }
    results.push({ tenant: tenant.slug, outcome: pushed.value, error: null });
  }

  const totals = results.reduce(
    (sum, entry) => ({
      created: sum.created + (entry.outcome?.created ?? 0),
      updated: sum.updated + (entry.outcome?.updated ?? 0),
      deactivated: sum.deactivated + (entry.outcome?.deactivated ?? 0),
      unchanged: sum.unchanged + (entry.outcome?.unchanged ?? 0),
      failures: sum.failures + (entry.outcome?.failures.length ?? 0),
    }),
    { created: 0, updated: 0, deactivated: 0, unchanged: 0, failures: 0 },
  );

  return NextResponse.json({
    status: failed > 0 ? "partial" : "ok",
    tenants: results.map((entry) => ({
      slug: entry.tenant,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.outcome
        ? {
            total: entry.outcome.total,
            created: entry.outcome.created,
            updated: entry.outcome.updated,
            deactivated: entry.outcome.deactivated,
            unchanged: entry.outcome.unchanged,
            // The people the provider refused, with its own words. A run that
            // reports "12 checked, 0 changed" while silently dropping two people
            // is the outcome worth surfacing.
            failures: entry.outcome.failures,
          }
        : {}),
    })),
    totals,
  });
}
