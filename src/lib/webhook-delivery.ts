/**
 * Webhook delivery, on the record.
 *
 * The send is the easy part; the promise a webhook makes to an operator is that
 * "we told your consumer" is a claim they can check. So every delivery is a row
 * before it is an HTTP request: the row is created while the outcome is unknown
 * and settled with what came back. A crash between the two leaves a PENDING row
 * that names its event, which is exactly the thing that cannot be discovered
 * from a log line.
 *
 * One row per event, keyed by the event's own id, so a retry updates the row it
 * belongs to instead of inventing a second delivery of the same fact. Nothing
 * here throws at the caller: grading has already happened and must not be undone
 * by a consumer that is not answering.
 */

import { prisma } from "./db";
import { recordAudit } from "./audit";
import {
  notifierFromConfig,
  webhookConfigFromEnv,
  describeWebhook,
  type SendOutcome,
  type WebhookConfig,
  type WebhookNotifier,
} from "./webhook-client";
import { buildGradedEvent, type GradedEventInput, type WebhookEvent } from "./webhook-rules";

export type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "SKIPPED";

export interface DeliveryResult {
  eventId: string;
  status: DeliveryStatus;
  error: string | null;
}

export interface WebhookRuntime {
  config: WebhookConfig | null;
  notifier: WebhookNotifier | null;
}

let cached: WebhookRuntime | undefined;

/**
 * The deployment's webhook, read once.
 *
 * Reading the environment on every grading would be cheap but the *log line*
 * is not: an operator should see the configuration decision once at startup,
 * not once per attempt, and "no consumer configured" must not look like a
 * failure repeated in a log.
 */
export function webhookRuntime(): WebhookRuntime {
  if (cached) return cached;
  const config = webhookConfigFromEnv(process.env);
  const notifier = notifierFromConfig(config);
  cached = { config, notifier };
  console.log(`[webhook] ${describeWebhook(config)}${config && !config.secret ? "" : "."}`);
  return cached;
}

/** Test seam: forget the memoised runtime. */
export function resetWebhookRuntime(): void {
  cached = undefined;
}

/**
 * Deliver one grading fact, or record why it was not delivered.
 *
 * The row is written first so a delivery that times out still leaves evidence,
 * and `attempts` counts the tries rather than the successes — a consumer that
 * was down for an hour is visible as five attempts, not as one sent message.
 */
export async function deliverGradedEvent(
  input: GradedEventInput,
  deliveredAt: Date = new Date(),
  runtime: WebhookRuntime = webhookRuntime(),
): Promise<DeliveryResult> {
  const event = buildGradedEvent(input, deliveredAt.toISOString());

  if (!runtime.notifier) {
    return { eventId: event.id, status: "SKIPPED", error: null };
  }

  await prisma.webhookDelivery.upsert({
    where: { eventId: event.id },
    create: {
      eventId: event.id,
      event: event.event,
      attemptId: input.attemptId,
      url: runtime.config?.url ?? "",
      transport: runtime.notifier.name,
      status: "PENDING",
      body: event as unknown as object,
    },
    // A retry must not reset the count, so the update is deliberately empty.
    update: {},
  });

  const outcome = await runtime.notifier.send(event);
  await settle(event.id, outcome);

  await recordAudit({
    action: "attempt.webhook",
    targetType: "attempt",
    targetId: input.attemptId,
    detail: {
      eventId: event.id,
      event: event.event,
      delivered: outcome.ok,
      status: outcome.status,
      error: outcome.error,
    },
  });

  return { eventId: event.id, status: outcome.ok ? "DELIVERED" : "FAILED", error: outcome.error };
}

/**
 * Send the pending or failed deliveries again.
 *
 * Deliberately manual and bounded: an automatic retry loop inside a request
 * would make grading slower for everybody to help one consumer, and a retry
 * that a person triggers is a retry a person can stop.
 */
export async function retryPendingDeliveries(
  limit = 20,
  runtime: WebhookRuntime = webhookRuntime(),
): Promise<DeliveryResult[]> {
  if (!runtime.notifier) return [];

  const rows = await prisma.webhookDelivery.findMany({
    where: { status: { in: ["PENDING", "FAILED"] } },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, limit)),
  });

  const results: DeliveryResult[] = [];
  for (const row of rows) {
    const outcome = await runtime.notifier.send(row.body as unknown as WebhookEvent);
    await settle(row.eventId, outcome);
    results.push({ eventId: row.eventId, status: outcome.ok ? "DELIVERED" : "FAILED", error: outcome.error });
  }

  if (results.length > 0) {
    await recordAudit({
      action: "webhook.retry",
      targetType: "webhook",
      targetId: null,
      detail: {
        attempted: results.length,
        delivered: results.filter((result) => result.status === "DELIVERED").length,
      },
    });
  }
  return results;
}

async function settle(eventId: string, outcome: SendOutcome): Promise<void> {
  try {
    await prisma.webhookDelivery.update({
      where: { eventId },
      data: {
        status: outcome.ok ? "DELIVERED" : "FAILED",
        attempts: { increment: 1 },
        lastStatus: outcome.status,
        lastError: outcome.error,
        deliveredAt: outcome.ok ? new Date() : null,
      },
    });
  } catch (error) {
    console.error("[webhook] could not settle delivery", eventId, error);
  }
}

/** The recent deliveries an operator or a consumer reads back. */
export async function recentDeliveries(limit = 50) {
  return prisma.webhookDelivery.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
  });
}
