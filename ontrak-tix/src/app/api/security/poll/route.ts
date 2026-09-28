/**
 * Scheduled security-alert poll (M2).
 *
 * Some vendors push (the webhook at `/api/security/ingest`); others only expose
 * an API to pull from. A cron hits this endpoint to drain one tenant's source
 * through the same connector, rules, dedupe ledger and audit trail as the push
 * path:
 *
 *   curl -X POST -H "Authorization: Bearer $ONTRAK_TIX_CRON_SECRET" \
 *        "https://desk.example/api/security/poll?tenant=acme"
 *
 * The tenant is required, not inferred: a vendor feed belongs to one tenant, and
 * ingesting one tenant's alerts into another would be a data-leak-shaped bug.
 * The source comes from the deployment's environment
 * (`ONTRAK_TIX_ALERT_SOURCE_URL`, `_TOKEN`, `_ACK_URL`); when it is unset the
 * route says so plainly rather than reporting a silent success.
 *
 * It is safe to run as often as you like: an alert already taken is folded by
 * its `dedupeKey`, so a poll that overlaps a previous one duplicates nothing.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, securityAlertServicesFor } from "../../../../lib/db";
import { ESCALATION_CRON_SECRET_ENV } from "../../../../lib/escalation-service";
import { extractSecret, secretsMatch, WEBHOOK_SECRET_ENV } from "../../../../lib/intake-webhook";
import {
  HttpAlertSource,
  SecurityAlertConnector,
  VendorAlertPoller,
  alertSourceConfigFromEnv,
} from "../../../../lib/security-alert-connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ALERTS_PER_POLL = 50;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same secret as the other schedulers, so one cron credential drives them all.
  const expected = process.env[ESCALATION_CRON_SECRET_ENV] ?? process.env[WEBHOOK_SECRET_ENV] ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const slug = request.nextUrl.searchParams.get("tenant")?.trim();
  if (!slug) {
    return NextResponse.json({ error: "A tenant is required: use ?tenant=<slug>." }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });

  const config = alertSourceConfigFromEnv();
  if (!config) {
    return NextResponse.json(
      { error: "No vendor alert source is configured (set ONTRAK_TIX_ALERT_SOURCE_URL)." },
      { status: 503 },
    );
  }

  const connector = new SecurityAlertConnector(securityAlertServicesFor(), tenant.id);
  const source = new HttpAlertSource(config);
  const poller = new VendorAlertPoller(connector, source);

  let result;
  try {
    result = await poller.poll(MAX_ALERTS_PER_POLL);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The alert source could not be reached." }, { status: 502 });
  }

  const created = result.outcomes.filter((entry) => entry.outcome?.kind === "created").length;
  const duplicates = result.outcomes.filter((entry) => entry.outcome?.kind === "duplicate").length;
  const rejected = result.outcomes.filter((entry) => entry.outcome === null).length;

  return NextResponse.json({
    status: "ok",
    tenant: slug,
    fetched: result.outcomes.length,
    ingested: created,
    duplicates,
    rejected,
    deferred: result.deferred,
  });
}
