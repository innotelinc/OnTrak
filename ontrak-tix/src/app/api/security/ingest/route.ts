/**
 * Security-telemetry webhook (M2 integration example).
 *
 * An IDS/IPS/SIEM/EDR sensor, or a forwarding bridge in front of one, POSTs one
 * alert as JSON here. The route does three things and decides nothing else:
 *
 *   1. authenticate the caller — the shared secret (`Authorization: Bearer` or
 *      `x-ontrak-secret`), or the HMAC pair OnTrak Sentinel signs with, both failing
 *      closed when their secret is unset;
 *   2. resolve the tenant (`?tenant=<slug>` or `x-ontrak-tenant`);
 *   3. hand the payload to the `SecurityAlertConnector`, which parses the
 *      vendor's field aliases (or reads OnTrak Sentinel natively) and runs it
 *      through the same normalizing rules, dedupe ledger and audit trail as
 *      every other channel.
 *
 * Status codes are policy in `security-alert-connector.ts` (pure and
 * unit-tested): 202 when the alert landed, 200 for an idempotent redelivery,
 * 400 when the payload was never an alert, 500 when the sender should retry.
 *
 * See `docs/security-telemetry.md` for the pipeline and the polling variant.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma, securityAlertServicesFor } from "../../../../lib/db";
import { SecurityAlertConnector, connectorReply } from "../../../../lib/security-alert-connector";
import { tenantSlug, WEBHOOK_SECRET_ENV } from "../../../../lib/intake-webhook";
import { SENTINEL_SIGNING_SECRET_ENV, authorizeIngest } from "../../../../lib/sentinel-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The raw body is read first because the signature is over the bytes that were sent, and a
  // re-serialized object would not verify: a `JSON.parse` then `JSON.stringify` round trip
  // loses key order and number formatting, which is exactly what a signature is there to pin.
  const rawBody = await request.text();

  const authorization = authorizeIngest({
    headers: request.headers,
    rawBody,
    nowSeconds: Math.floor(Date.now() / 1000),
    sharedSecret: process.env[WEBHOOK_SECRET_ENV] ?? null,
    signingSecret: process.env[SENTINEL_SIGNING_SECRET_ENV] ?? null,
  });
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: 401 });
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
    body = rawBody === "" ? null : JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const connector = new SecurityAlertConnector(securityAlertServicesFor(), tenant.id);
  const outcome = await connector.receive(body);

  const reply = connectorReply(outcome);
  return NextResponse.json(reply.body, { status: reply.status });
}
