/**
 * Inbound-email webhook plumbing (M0): the pure decisions around a provider
 * delivery, kept out of the route handler so they can be unit-tested without a
 * request, a database or a framework.
 *
 * The route itself only wires these to a `WebhookTransport`. Authenticating the
 * caller, finding the tenant and choosing an HTTP status are policy; the intake
 * rules (accept/reject/dedupe/thread) stay where they belong, in the worker.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { EmailOutcome } from "./email-worker";

/** Set to a long random string; the provider signs deliveries with it. */
export const WEBHOOK_SECRET_ENV = "ONTRAK_TIX_WEBHOOK_SECRET";

/** The bit of a `Headers`-like object this module needs. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Read the shared secret from `Authorization: Bearer …` or `x-ontrak-secret`. */
export function extractSecret(headers: HeaderReader): string | null {
  const authorization = headers.get("authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim() || null;
  }
  return headers.get("x-ontrak-secret")?.trim() || null;
}

/**
 * Constant-time secret comparison. Both values are hashed first so differing
 * lengths cannot leak, and an empty or missing secret never matches — a missing
 * configuration must fail closed.
 */
export function secretsMatch(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The tenant slug, from the query string first, then the `x-ontrak-tenant` header. */
export function tenantSlug(query: string | null, header: string | null): string | null {
  const value = (query ?? header ?? "").trim();
  return value.length > 0 ? value : null;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map a transport outcome onto an HTTP reply.
 *
 * A `null` outcome means the payload was never an email (the route answers 400
 * and does nothing). `failed` is a 500 so the provider retries — the intake
 * ledger makes that retry safe. Everything else is a decision that has already
 * been recorded, so a redelivery is answered idempotently.
 */
export function webhookReply(outcome: EmailOutcome | null): WebhookReply {
  if (!outcome) return { status: 400, body: { error: "Payload was not a parseable email message." } };

  switch (outcome.kind) {
    case "disabled":
      return { status: 503, body: { error: "Email ingestion is disabled." } };
    case "failed":
      return { status: 500, body: { error: outcome.error } };
    case "duplicate":
      return { status: 200, body: { status: "duplicate" } };
    case "rejected":
      return { status: 200, body: { status: "rejected", reason: outcome.reason } };
    case "created":
      return { status: 202, body: { status: "created", ticketId: outcome.ticketId, ref: outcome.ref } };
    case "appended":
      return { status: 202, body: { status: "appended", ticketId: outcome.ticketId } };
  }
}
