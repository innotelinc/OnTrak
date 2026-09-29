/**
 * Webhook rules (M6): who we deliver to, what we say, and what we do when nobody
 * answers.
 *
 * A webhook is the one place this product makes a request *outward*, on its own
 * initiative, to an address a customer typed. That makes four things decisions
 * rather than plumbing:
 *
 *  1. **The URL is registered, not supplied per event.** It is checked once, at
 *     registration — `https`, or `http` only on a loopback address — so an
 *     outbound request is never sent to an origin nobody agreed to. An
 *     unregistered-by-construction URL is how a webhook feature becomes an SSRF
 *     tool.
 *  2. **Every delivery is signed, and the signed string includes a timestamp.**
 *     `HMAC-SHA256(secret, "{timestamp}.{body}")`, as a header beside the
 *     timestamp itself — so a receiver can (a) prove the body came from us and
 *     (b) refuse a replay of one it has already seen. A signature over the body
 *     alone is replayable forever.
 *  3. **The events are a closed set.** "Send me everything" is how an integration
 *     receives fields it does not understand and a change we make becomes its
 *     outage.
 *  4. **A delivery log is a state machine, not a log line.** `PENDING` gave way to
 *     `DELIVERED`, `RETRYING` with the instant of the next attempt, or
 *     `EXHAUSTED` — and the states are named so a support engineer can read the
 *     table without knowing the code. Retries back off exponentially and *stop*:
 *     an endpoint that has been down for a day is not going to be fixed by the
 *     next attempt, and a queue that grows without bound is its own outage.
 *
 * Pure: no clock, no crypto, no `fetch`. The HMAC is computed by the service and
 * the clock is handed in, so the retry arithmetic is tested without waiting for a
 * retry.
 */

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

/** What a subscription may ask for. Closed, so a new event is a deliberate act. */
export const WEBHOOK_EVENTS = ["ticket.created", "ticket.updated", "ticket.replied"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Every event, for a console that offers them all. */
export function allWebhookEvents(): readonly WebhookEvent[] {
  return WEBHOOK_EVENTS;
}

/* -------------------------------------------------------------------------- */
/*  Endpoints                                                                 */
/* -------------------------------------------------------------------------- */

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_NAME_MAX = 120;
export const WEBHOOK_URL_MAX = 2_000;
export const WEBHOOK_EVENTS_MAX = WEBHOOK_EVENTS.length;

/** The headers a receiver checks. Ours, and stable, because it will check them. */
export const SIGNATURE_HEADER = "x-ontrak-signature";
export const EVENT_HEADER = "x-ontrak-event";
export const TIMESTAMP_HEADER = "x-ontrak-timestamp";
export const DELIVERY_HEADER = "x-ontrak-delivery";

/**
 * A registered destination for events.
 *
 * `secret` is the one field in this product that is **stored in the clear**, and
 * the reason is stated rather than hidden: an HMAC cannot be computed from a hash,
 * so a signing secret has to be recoverable. It is therefore a credential the
 * deployment must encrypt at rest, it is shown once at registration, and it is
 * rotatable — the same trade-off every webhook provider makes, made explicitly.
 */
export interface WebhookEndpointRecord {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  events: readonly WebhookEvent[];
  secret: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface WebhookIssue {
  field: string;
  message: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Whether we would deliver to this URL at all.
 *
 * The same rule the OIDC redirect URIs and the SAML ACS URLs get, for the same
 * reason: a plain-`http` destination puts the payload — which is a customer's
 * ticket text — on the wire in the clear. A fragment is refused because it is
 * never sent to the server, so the payload would be signed and then dropped.
 */
export function isRegistrableWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

export function validateWebhookEndpoint(input: {
  name?: string;
  url?: string;
  events?: readonly string[];
}): WebhookIssue[] {
  const issues: WebhookIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A name is required, so somebody can tell this endpoint from the others." });
  else if (name.length > WEBHOOK_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${WEBHOOK_NAME_MAX} characters.` });
  }

  const url = input.url?.trim() ?? "";
  if (!url) issues.push({ field: "url", message: "A URL is required." });
  else if (url.length > WEBHOOK_URL_MAX) {
    issues.push({ field: "url", message: `The URL may be at most ${WEBHOOK_URL_MAX} characters.` });
  } else if (!isRegistrableWebhookUrl(url)) {
    issues.push({ field: "url", message: `“${url}” is not a URL we deliver to: https, or http on a loopback address.` });
  }

  const events = input.events ?? [];
  if (events.length === 0) issues.push({ field: "events", message: "At least one event is required." });
  if (new Set(events).size !== events.length) {
    issues.push({ field: "events", message: "The same event is listed twice." });
  }
  for (const event of events) {
    if (!isWebhookEvent(event)) issues.push({ field: "events", message: `“${event}” is not an event this API emits.` });
  }

  return issues;
}

/** Whether an endpoint asked for this event. A disabled endpoint asks for nothing. */
export function endpointsFor(
  endpoints: readonly WebhookEndpointRecord[],
  event: WebhookEvent,
): WebhookEndpointRecord[] {
  return endpoints.filter((endpoint) => endpoint.enabled && endpoint.events.includes(event));
}

/* -------------------------------------------------------------------------- */
/*  Signing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The exact string a delivery's signature covers.
 *
 * The timestamp comes **first**, so a receiver that checks it does so over bytes
 * it has already authenticated — and a replay of a captured delivery carries the
 * original timestamp, which is the thing it then refuses.
 */
export function signaturePayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

/** The `X-OnTrak-Signature` value. The `v1=` prefix is there to be changeable. */
export function signatureHeader(hexDigest: string): string {
  return `v1=${hexDigest}`;
}

/** A delivery's request headers, given a body and the instant it is sent. */
export function deliveryHeaders(input: {
  event: WebhookEvent;
  deliveryId: string;
  nowSeconds: number;
  signatureHex: string;
}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    [SIGNATURE_HEADER]: signatureHeader(input.signatureHex),
    [EVENT_HEADER]: input.event,
    [TIMESTAMP_HEADER]: String(input.nowSeconds),
    [DELIVERY_HEADER]: input.deliveryId,
  };
}

/* -------------------------------------------------------------------------- */
/*  Delivery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a delivery stands. Named for what a support engineer would ask: "did it
 * arrive, is it still trying, or did we give up?"
 */
export const DELIVERY_STATUSES = ["PENDING", "DELIVERED", "RETRYING", "EXHAUSTED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface WebhookDeliveryRecord {
  id: string;
  tenantId: string;
  endpointId: string;
  event: WebhookEvent;
  /** The exact bytes that were signed and sent, kept so a dispute has an answer. */
  payload: string;
  status: DeliveryStatus;
  attemptCount: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  /** `null` until something was answered; a timeout is not a status code. */
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
}

/** How many times we try before calling it exhausted. Five, over about half a day. */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** The first retry's delay. */
export const DELIVERY_BASE_BACKOFF_SECONDS = 30;
/** The ceiling, so the fifth attempt is not scheduled for next week. */
export const DELIVERY_MAX_BACKOFF_SECONDS = 6 * 60 * 60;
/** How long the HTTP request may take before it counts as a failure. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The delay before attempt number `attempt` (1-based).
 *
 * Exponential from `DELIVERY_BASE_BACKOFF_SECONDS` and capped, with no jitter:
 * jitter is a defence against synchronized retries across *many* connections, and
 * this product retries one delivery per endpoint on a schedule a person can read
 * back. A delay nobody can predict is a delay nobody can debug.
 */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(DELIVERY_BASE_BACKOFF_SECONDS * 2 ** exponent, DELIVERY_MAX_BACKOFF_SECONDS);
}

/** The whole retry schedule, for documentation and for a test that pins it. */
export function retrySchedule(): { attempt: number; delaySeconds: number }[] {
  return Array.from({ length: DELIVERY_MAX_ATTEMPTS - 1 }, (_, index) => ({
    attempt: index + 2,
    delaySeconds: retryDelaySeconds(index + 1),
  }));
}

/** Whether an HTTP status means "delivered". 2xx, and nothing else. */
export function isDeliverySuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** One attempt's outcome, as the transport reports it. */
export interface DeliveryAttempt {
  /** Absent when the request never produced a response (a timeout, a refusal). */
  statusCode?: number | null;
  error?: string | null;
}

/**
 * The fields the delivery state machine reads and writes.
 *
 * Structural rather than `WebhookDeliveryRecord` itself, because a chat channel
 * (`chat-notify-rules.ts`) retries outward with exactly this discipline and has a
 * `channelId` instead of an `endpointId`. One state machine, two destinations —
 * "did our message arrive?" should have one answer in this product.
 */
export interface DeliveryAttemptState {
  status: DeliveryStatus;
  attemptCount: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  /** `null` until something was answered; a timeout is not a status code. */
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  deliveredAt: number | null;
}

/**
 * Fold one attempt into a delivery.
 *
 * The three outcomes are the three a person would name: it arrived; it did not,
 * and we will try again at a stated time; it did not, and we have stopped. A
 * failure that is *not* final always carries the instant of the next attempt, so
 * the delivery log answers "when?" without a caller doing backoff arithmetic.
 */
export function applyDeliveryAttempt<T extends DeliveryAttemptState>(
  record: T,
  attempt: DeliveryAttempt,
  nowMs: number,
): T {
  const attemptCount = record.attemptCount + 1;
  const firstAttemptAt = record.firstAttemptAt ?? nowMs;
  const base = {
    ...record,
    attemptCount,
    firstAttemptAt,
    lastAttemptAt: nowMs,
    lastStatusCode: attempt.statusCode ?? null,
    lastError: attempt.error ? attempt.error.slice(0, 500) : null,
  };

  if (attempt.statusCode != null && isDeliverySuccess(attempt.statusCode)) {
    return { ...base, status: "DELIVERED", deliveredAt: nowMs, nextAttemptAt: null, lastError: null } as T;
  }

  if (attemptCount >= DELIVERY_MAX_ATTEMPTS) {
    return { ...base, status: "EXHAUSTED", nextAttemptAt: null, deliveredAt: null } as T;
  }

  return {
    ...base,
    status: "RETRYING",
    deliveredAt: null,
    nextAttemptAt: nowMs + retryDelaySeconds(attemptCount) * 1000,
  } as T;
}

/** Whether a delivery is due. `PENDING` is due immediately; a retry waits its turn. */
export function deliveryDue(record: Pick<DeliveryAttemptState, "status" | "nextAttemptAt">, nowMs: number): boolean {
  if (record.status === "PENDING") return true;
  if (record.status !== "RETRYING") return false;
  return record.nextAttemptAt !== null && nowMs >= record.nextAttemptAt;
}

/* -------------------------------------------------------------------------- */
/*  The event envelope                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The JSON body we sign and send.
 *
 * Versioned and self-describing, so a receiver can dispatch on `type` without
 * guessing from the shape of `data`, and so the envelope can gain a field without
 * changing what the existing ones mean. The payload rides under `data` rather
 * than at the top level for the same reason: an event's own fields will never
 * collide with the envelope's.
 */
export function eventEnvelope(input: {
  id: string;
  type: WebhookEvent;
  tenantId: string;
  at: string;
  data: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type,
    api_version: "v1",
    tenant_id: input.tenantId,
    created_at: input.at,
    data: input.data,
  });
}
