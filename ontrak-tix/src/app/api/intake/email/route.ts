/**
 * Inbound-email webhook (M0 integration example).
 *
 * A provider — Mailgun, Postmark, an IMAP-to-HTTP bridge — POSTs one message as
 * JSON here. The route does three things and decides nothing else:
 *
 *   1. authenticate the caller with the shared secret (`Authorization: Bearer`
 *      or `x-ontrak-secret`), failing closed when the secret is unset;
 *   2. resolve the tenant (`?tenant=<slug>` or `x-ontrak-tenant`);
 *   3. hand the payload to the `WebhookTransport`, which runs it through the
 *      same worker, intake rules, audit trail and dedupe ledger as every other
 *      channel.
 *
 * Status codes are policy in `intake-webhook.ts` (pure and unit-tested): 202 for
 * a ticket opened or appended, 200 for an idempotent redelivery or a recorded
 * rejection, 500 when the provider should retry.
 *
 * See `docs/email-intake.md` for provider setup and the IMAP-polling variant.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "../../../../lib/db";
import { EmailWorker, PrismaIntakeStore, type IntakePrismaClient } from "../../../../lib/email-worker";
import { WebhookTransport } from "../../../../lib/email-transport";
import {
  WEBHOOK_SECRET_ENV,
  extractSecret,
  secretsMatch,
  tenantSlug,
  webhookReply,
} from "../../../../lib/intake-webhook";
import { ticketServices } from "../../../../lib/ticket-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env[WEBHOOK_SECRET_ENV] ?? null;
  if (!secretsMatch(extractSecret(request.headers), expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const slug = tenantSlug(
    request.nextUrl.searchParams.get("tenant"),
    request.headers.get("x-ontrak-tenant"),
  );
  if (!slug) {
    return NextResponse.json({ error: "Missing tenant (use ?tenant=<slug> or the x-ontrak-tenant header)." }, { status: 400 });
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

  // The worker resolves the sender to a requester and writes through the normal
  // ticket service, so the same access rules and audit trail apply.
  const worker = new EmailWorker(
    ticketServices().service,
    new PrismaIntakeStore(prisma as unknown as IntakePrismaClient),
  );
  const outcome = await new WebhookTransport(worker, tenant.id).receive(body);

  const reply = webhookReply(outcome);
  return NextResponse.json(reply.body, { status: reply.status });
}
