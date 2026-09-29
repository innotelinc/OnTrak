/**
 * The outcome sweep (M7) — closing the loop on solved work.
 *
 * A cron hits this with the same secret the other sweeps use. For every tenant it
 * walks the tickets that were resolved and have not been written down, and for each
 * one: authors a knowledgebase article, stores it, and hands the matching practice
 * scenario to OnTrak ITS.
 *
 * It is idempotent by construction — the ticket's marker tag is checked first — so
 * running it every night, or twice by accident, never writes a second article.
 *
 *   POST /api/outcomes/sweep                 # every tenant, up to the cap each
 *   POST /api/outcomes/sweep?tenant=acme
 *   POST /api/outcomes/sweep?limit=100       # how many tickets per tenant
 *
 * `?dry=1` authors the drafts and reports them — the article and the scenario in
 * full — *without writing anything*, which is how somebody decides whether the prose
 * is good enough to turn on.
 */

import { NextResponse, type NextRequest } from "next/server";

import { knowledgeServicesFor, prisma } from "../../../../lib/db";
import { ticketServices } from "../../../../lib/ticket-server";
import { extractSecret, secretsMatch } from "../../../../lib/intake-webhook";
import { ESCALATION_CRON_SECRET_ENV } from "../../../../lib/escalation-service";
import { authorConfig, authorOutcome } from "../../../../lib/ai-author";
import type { OutcomeTranscript } from "../../../../lib/outcome-rules";
import { outcomeActor, previewOutcomes, writeOutcomes, type OutcomeReport } from "../../../../lib/outcome-service";
import { itsConfig } from "../../../../lib/its-client";
import { isOpen } from "../../../../lib/ticket-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How many tickets one tenant's run will look at. A first run should not be a flood. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[ESCALATION_CRON_SECRET_ENV] ?? process.env.ONTRAK_TIX_WEBHOOK_SECRET ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const slug = params.get("tenant");
  const dry = params.get("dry") === "1";
  const requested = Number(params.get("limit") ?? "");
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
  });
  if (slug && tenants.length === 0) {
    return NextResponse.json({ error: `Unknown tenant "${slug}".` }, { status: 404 });
  }

  const services = ticketServices();
  const knowledge = knowledgeServicesFor();
  const its = itsConfig();
  const perTenant: { tenant: string; written: number; skipped: number; refused: number; reports: OutcomeReport[] }[] = [];

  for (const tenant of tenants) {
    const records = await services.store.listTickets(tenant.id);
    // Solved work, newest first, and only work that was actually explained to the
    // customer: a ticket closed without a public reply has no resolution to learn
    // from, and `hasResolution` refuses it here rather than deeper in.
    const resolved = records
      .filter((record) => !isOpen(record.status))
      .sort((a, b) => (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt));

    const transcripts: OutcomeTranscript[] = resolved.slice(0, limit).map((record) => ({
      ref: record.ref,
      subject: record.subject,
      description: record.description,
      priority: record.priority,
      messages: record.messages,
    }));

    if (dry) {
      const reports = await previewOutcomes(transcripts, (transcript) => authorOutcome(transcript));
      perTenant.push({ tenant: tenant.slug, written: 0, skipped: 0, refused: 0, reports });
      continue;
    }

    const reports = await writeOutcomes(transcripts, {
      actor: outcomeActor(tenant.id),
      knowledge,
      author: (transcript) => authorOutcome(transcript),
      its,
    });

    perTenant.push({
      tenant: tenant.slug,
      written: reports.filter((report) => report.status === "written").length,
      skipped: reports.filter((report) => report.status === "skipped").length,
      refused: reports.filter((report) => report.status === "refused").length,
      reports,
    });
  }

  return NextResponse.json({
    dry,
    // Asked of the author itself rather than inferred from a key: a keyless local
    // gateway is configured and enabled, and reporting it as "no model" would have an
    // operator hunting for a key they do not need.
    configured: { its: its.enabled, model: authorConfig().enabled },
    tenants: perTenant,
    written: perTenant.reduce((sum, entry) => sum + entry.written, 0),
  });
}
