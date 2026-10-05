/**
 * `GET /api/v1/webhook-deliveries` — what this deployment tried to tell you.
 * `POST /api/v1/webhook-deliveries` — send the ones that did not arrive again.
 *
 *   GET  /api/v1/webhook-deliveries?status=FAILED
 *   POST /api/v1/webhook-deliveries                 retries pending + failed
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *
 * A webhook is only as good as its exceptions. The consumer that was down does
 * not know what it missed, and the operator who was not watching cannot say
 * whether "the integration is broken" or "that one attempt was" — this is the
 * page that answers both, from the sender's side, with the attempt's own id.
 *
 * The retry is triggered by a person rather than a timer. An automatic loop
 * would make every grading wait on the slowest consumer, and a retry nobody can
 * see is a retry nobody can stop.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { retryPendingDeliveries, webhookRuntime } from "@/lib/webhook-delivery";
import { apiAccess } from "../_access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Everything except `body`, which is the payload the consumer already has. */
const DELIVERY_SELECT = {
  eventId: true,
  event: true,
  attemptId: true,
  url: true,
  transport: true,
  status: true,
  attempts: true,
  lastStatus: true,
  lastError: true,
  createdAt: true,
  deliveredAt: true,
} as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const params = request.nextUrl.searchParams;
  const status = (params.get("status") ?? "").trim().toUpperCase();
  const rawLimit = Number((params.get("limit") ?? "").trim());
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 50;

  const [deliveries, outstanding, runtime] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      select: DELIVERY_SELECT,
    }),
    prisma.webhookDelivery.count({ where: { status: { in: ["PENDING", "FAILED"] } } }),
    Promise.resolve(webhookRuntime()),
  ]);

  return NextResponse.json({
    deliveries,
    /** How many still need attention, regardless of the page above. */
    outstanding,
    // "Nothing is being sent" and "everything was sent" are different answers to
    // the same empty list, so the configuration is stated rather than implied.
    configured: runtime.notifier !== null,
    url: runtime.config?.url ?? null,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const rawLimit = Number((request.nextUrl.searchParams.get("limit") ?? "").trim());
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;

  const runtime = webhookRuntime();
  if (!runtime.notifier) {
    return NextResponse.json(
      { error: "No webhook consumer is configured, so there is nothing to retry." },
      { status: 409 },
    );
  }

  const results = await retryPendingDeliveries(limit, runtime);
  return NextResponse.json({
    attempted: results.length,
    delivered: results.filter((result) => result.status === "DELIVERED").length,
    results,
  });
}
