/**
 * Webhook service (M6): subscriptions, deliveries and the log that says what
 * happened to each one.
 *
 * `webhook-rules.ts` decides everything; this file registers endpoints, signs
 * payloads, makes the one outbound request and records the outcome. Four choices
 * worth stating out loud:
 *
 *  - **A subscription is created before an event can reach it, and its secret is
 *    shown once.** The secret is stored (an HMAC cannot be computed from a hash —
 *    see the note in `webhook-rules.ts`) and returned exactly once, so a customer
 *    has to keep it, and a console cannot leak it later.
 *  - **A delivery row exists before the attempt, not after.** If the process dies
 *    mid-request, the log still shows a delivery that was due — which is the
 *    difference between an integration that can be reconciled and one that
 *    silently drops events.
 *  - **The payload is the bytes that were signed.** It is stored on the delivery
 *    row, so "what did you send us?" is answered from the record rather than
 *    reconstructed from the current state of a ticket that has since changed.
 *  - **The transport is a port.** `FetchWebhookTransport` is the only thing that
 *    touches the network, so every decision here — signing, retry arithmetic, the
 *    log — is tested without one, and a queue or a worker replaces the transport
 *    without the rules changing.
 *
 * Registering an endpoint is `tenant:manage`: it decides where a customer's ticket
 * text is sent, which is the same weight as deciding who may administer the tenant.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
  WEBHOOK_SECRET_PREFIX,
  applyDeliveryAttempt,
  deliveryDue,
  deliveryHeaders,
  endpointsFor,
  eventEnvelope,
  validateWebhookEndpoint,
  type DeliveryStatus,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEvent,
} from "./webhook-rules";
import type { ServiceResult } from "./ticket-service";

/* -------------------------------------------------------------------------- */
/*  The ports                                                                 */
/* -------------------------------------------------------------------------- */

export interface WebhookStore {
  insertEndpoint(record: WebhookEndpointRecord): Promise<void>;
  findEndpoint(tenantId: string, endpointId: string): Promise<WebhookEndpointRecord | null>;
  findEndpointByName(tenantId: string, name: string): Promise<WebhookEndpointRecord | null>;
  listEndpoints(tenantId: string): Promise<WebhookEndpointRecord[]>;
  updateEndpoint(record: WebhookEndpointRecord): Promise<void>;
  removeEndpoint(tenantId: string, endpointId: string): Promise<void>;

  insertDelivery(record: WebhookDeliveryRecord): Promise<void>;
  updateDelivery(record: WebhookDeliveryRecord): Promise<void>;
  findDelivery(tenantId: string, deliveryId: string): Promise<WebhookDeliveryRecord | null>;
  listDeliveries(
    tenantId: string,
    filter?: { endpointId?: string; status?: DeliveryStatus; limit?: number },
  ): Promise<WebhookDeliveryRecord[]>;
  /** Every delivery that is owed an attempt now or later, oldest first. */
  listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<WebhookDeliveryRecord[]>;
}

/** What one HTTP attempt produced. `statusCode` is absent when nothing answered. */
export interface TransportOutcome {
  statusCode: number | null;
  error: string | null;
}

export interface WebhookTransport {
  send(request: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<TransportOutcome>;
}

export interface WebhookIds {
  id(): string;
  /** A signing secret, generated once and shown once. */
  secret(): string;
  now(): string;
  nowMs(): number;
}

export function systemWebhookIds(): WebhookIds {
  const mint = () => randomUUID();
  return {
    id: mint,
    secret: () => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/** The digest a receiver recomputes. Shared with the test that verifies a delivery. */
export function webhookSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * The real transport: one `fetch` with a cap on how long it may take.
 *
 * A timeout is a failure like any other, and it is recorded as one — with `null`
 * as the status code, because nothing answered and pretending otherwise would put
 * a number in the log that no server ever sent.
 */
export class FetchWebhookTransport implements WebhookTransport {
  async send(request: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<TransportOutcome> {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      // The body is drained so the connection can be reused; it is not read, read
      // back to a customer, or trusted — a receiver's error page is not our data.
      await response.text().catch(() => "");
      return { statusCode: response.status, error: null };
    } catch (error) {
      return { statusCode: null, error: error instanceof Error ? error.message : "the request failed" };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface RegisterWebhookInput {
  name?: string;
  url?: string;
  events?: readonly string[];
}

export interface CreatedWebhookEndpoint {
  endpoint: WebhookEndpointRecord;
  secret: string;
}

export interface EmitResult {
  event: WebhookEvent;
  /** How many endpoints asked for it (so zero is a real, visible answer). */
  endpoints: number;
  deliveries: { deliveryId: string; endpointId: string; status: DeliveryStatus; statusCode: number | null }[];
}

export interface DeliveryOverview {
  delivery: WebhookDeliveryRecord;
  /** `null` when the endpoint has since been removed, which the log still shows. */
  endpointName: string | null;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class WebhookService {
  constructor(
    private readonly store: WebhookStore,
    private readonly transport: WebhookTransport,
    private readonly audit: AuditSink | null = null,
    private readonly ids: WebhookIds = systemWebhookIds(),
  ) {}

  /* ----------------------------------------------------------- endpoints */

  async register(actor: Actor, input: RegisterWebhookInput): Promise<ServiceResult<CreatedWebhookEndpoint>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };

    const issues = validateWebhookEndpoint(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name!.trim();
    if (await this.store.findEndpointByName(actor.tenantId, name)) {
      return { ok: false, error: `An endpoint called “${name}” already exists.` };
    }

    const secret = this.ids.secret();
    const endpoint: WebhookEndpointRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      name,
      url: input.url!.trim(),
      events: [...(input.events ?? [])] as WebhookEvent[],
      secret,
      enabled: true,
      createdBy: actor.id,
      createdAt: this.ids.now(),
      disabledAt: null,
    };

    await this.store.insertEndpoint(endpoint);
    // The events and the URL, never the secret: the audit trail is read by people
    // who are not allowed to sign as this endpoint.
    await this.append(actor, "webhook.endpoint.create", endpoint.id, {
      name: endpoint.name,
      url: endpoint.url,
      events: endpoint.events,
    });
    return { ok: true, value: { endpoint, secret } };
  }

  async list(actor: Actor): Promise<ServiceResult<WebhookEndpointRecord[]>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };
    const endpoints = await this.store.listEndpoints(actor.tenantId);
    return { ok: true, value: endpoints.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Switch an endpoint on or off without losing its history. */
  async setEnabled(actor: Actor, endpointId: string, enabled: boolean): Promise<ServiceResult<WebhookEndpointRecord>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };

    const endpoint = await this.store.findEndpoint(actor.tenantId, endpointId);
    if (!endpoint) return { ok: false, error: "That endpoint does not exist." };

    const next: WebhookEndpointRecord = {
      ...endpoint,
      enabled,
      disabledAt: enabled ? null : this.ids.now(),
    };
    await this.store.updateEndpoint(next);
    await this.append(actor, enabled ? "webhook.endpoint.enable" : "webhook.endpoint.disable", next.id, { name: next.name });
    return { ok: true, value: next };
  }

  /**
   * Replace the signing secret. Returns the new one, once.
   *
   * Rotation is the reason a secret is worth having: a customer who thinks theirs
   * leaked needs to be able to change it without deleting and re-creating the
   * subscription and losing its delivery history.
   */
  async rotateSecret(actor: Actor, endpointId: string): Promise<ServiceResult<CreatedWebhookEndpoint>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };

    const endpoint = await this.store.findEndpoint(actor.tenantId, endpointId);
    if (!endpoint) return { ok: false, error: "That endpoint does not exist." };

    const next: WebhookEndpointRecord = { ...endpoint, secret: this.ids.secret() };
    await this.store.updateEndpoint(next);
    await this.append(actor, "webhook.endpoint.rotate_secret", next.id, { name: next.name });
    return { ok: true, value: { endpoint: next, secret: next.secret } };
  }

  async remove(actor: Actor, endpointId: string): Promise<ServiceResult<{ id: string }>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };

    const endpoint = await this.store.findEndpoint(actor.tenantId, endpointId);
    if (!endpoint) return { ok: false, error: "That endpoint does not exist." };

    await this.store.removeEndpoint(actor.tenantId, endpoint.id);
    // The deliveries stay, so the log still answers "did we tell you?" about an
    // endpoint that no longer exists — which is exactly when somebody asks.
    await this.append(actor, "webhook.endpoint.remove", endpoint.id, { name: endpoint.name, url: endpoint.url });
    return { ok: true, value: { id: endpoint.id } };
  }

  /* --------------------------------------------------------- delivering */

  /**
   * Record and attempt one event.
   *
   * A delivery row is written **before** the request, so an event that arrived
   * while the process was dying is still visible as one that was due. Every
   * endpoint that asked for the event gets its own row and its own outcome: one
   * customer's broken receiver is not another's missing event.
   */
  async emit(tenantId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<EmitResult> {
    const endpoints = endpointsFor(await this.store.listEndpoints(tenantId), event);
    const results: EmitResult["deliveries"] = [];

    for (const endpoint of endpoints) {
      const nowMs = this.ids.nowMs();
      const delivery: WebhookDeliveryRecord = {
        id: this.ids.id(),
        tenantId,
        endpointId: endpoint.id,
        event,
        payload: eventEnvelope({ id: this.ids.id(), type: event, tenantId, at: this.ids.now(), data }),
        status: "PENDING",
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastError: null,
        nextAttemptAt: null,
        deliveredAt: null,
        createdAt: nowMs,
      };
      await this.store.insertDelivery(delivery);

      const after = await this.attempt(delivery, endpoint);
      results.push({
        deliveryId: after.id,
        endpointId: endpoint.id,
        status: after.status,
        statusCode: after.lastStatusCode,
      });
    }

    return { event, endpoints: endpoints.length, deliveries: results };
  }

  /**
   * Attempt every delivery that is due — the sweep behind `POST /api/v1/webhooks/sweep`.
   *
   * Safe to run as often as you like: a delivery that is not due is not in the
   * worklist, and one that has succeeded is not either. `tenantId` narrows it, so
   * the same code runs for one tenant on demand and for all of them on a schedule.
   */
  async deliverDue(
    tenantId: string | null,
    limit = 50,
  ): Promise<{ considered: number; delivered: number; retrying: number; exhausted: number }> {
    const nowMs = this.ids.nowMs();
    const due = await this.store.listDueDeliveries(tenantId, nowMs, limit);

    let delivered = 0;
    let retrying = 0;
    let exhausted = 0;
    for (const delivery of due) {
      if (!deliveryDue(delivery, nowMs)) continue;
      const endpoint = await this.store.findEndpoint(delivery.tenantId, delivery.endpointId);
      // An endpoint that has been removed stops the delivery here rather than
      // being retried forever. The row keeps its last state, so the log says what
      // happened instead of pretending nothing did.
      if (!endpoint || !endpoint.enabled) continue;
      const after = await this.attempt(delivery, endpoint);
      if (after.status === "DELIVERED") delivered += 1;
      else if (after.status === "EXHAUSTED") exhausted += 1;
      else retrying += 1;
    }
    return { considered: due.length, delivered, retrying, exhausted };
  }

  private async attempt(delivery: WebhookDeliveryRecord, endpoint: WebhookEndpointRecord): Promise<WebhookDeliveryRecord> {
    const nowMs = this.ids.nowMs();
    const timestampSeconds = Math.floor(nowMs / 1000);
    const signature = webhookSignature(endpoint.secret, `${timestampSeconds}.${delivery.payload}`);

    const outcome = await this.transport.send({
      url: endpoint.url,
      headers: deliveryHeaders({
        event: delivery.event,
        deliveryId: delivery.id,
        nowSeconds: timestampSeconds,
        signatureHex: signature,
      }),
      body: delivery.payload,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });

    const next = applyDeliveryAttempt(
      delivery,
      { statusCode: outcome.statusCode, error: outcome.error },
      nowMs,
    );
    await this.store.updateDelivery(next);

    // One event per attempt, so the chain answers "how many times did we tell
    // them, and when?" — and a delivery that exhausts is visible as five events,
    // not as one row that changed.
    await this.append(
      { id: `system:webhook`, tenantId: delivery.tenantId, role: "ADMIN" },
      next.status === "DELIVERED" ? "webhook.delivered" : "webhook.delivery_failed",
      next.id,
      {
        endpointId: endpoint.id,
        event: next.event,
        attempt: next.attemptCount,
        maxAttempts: DELIVERY_MAX_ATTEMPTS,
        statusCode: next.lastStatusCode,
        error: next.lastError,
        status: next.status,
        nextAttemptAt: next.nextAttemptAt === null ? null : new Date(next.nextAttemptAt).toISOString(),
      },
    );
    return next;
  }

  /* -------------------------------------------------------- the log */

  /** The delivery log, newest first, with the endpoint's name for a human to read. */
  async listDeliveries(
    actor: Actor,
    filter: { endpointId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<ServiceResult<DeliveryOverview[]>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };

    const rows = await this.store.listDeliveries(actor.tenantId, filter);
    const endpoints = await this.store.listEndpoints(actor.tenantId);
    const names = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
    return {
      ok: true,
      value: rows.map((delivery) => ({ delivery, endpointName: names.get(delivery.endpointId) ?? null })),
    };
  }

  async findDelivery(actor: Actor, deliveryId: string): Promise<ServiceResult<WebhookDeliveryRecord>> {
    if (!actorHasPermission(actor, "tenant:manage")) return { ok: false, error: "You do not manage webhook endpoints." };
    const delivery = await this.store.findDelivery(actor.tenantId, deliveryId);
    if (!delivery) return { ok: false, error: "That delivery does not exist." };
    return { ok: true, value: delivery };
  }

  /* --------------------------------------------------------- internals */

  private async append(actor: Actor, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "WebhookDelivery",
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryWebhookStore implements WebhookStore {
  private readonly endpoints = new Map<string, WebhookEndpointRecord>();
  private readonly deliveries = new Map<string, WebhookDeliveryRecord>();

  async insertEndpoint(record: WebhookEndpointRecord): Promise<void> {
    this.endpoints.set(record.id, structuredClone(record));
  }

  async findEndpoint(tenantId: string, endpointId: string): Promise<WebhookEndpointRecord | null> {
    const found = this.endpoints.get(endpointId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findEndpointByName(tenantId: string, name: string): Promise<WebhookEndpointRecord | null> {
    const wanted = name.trim().toLowerCase();
    const found = [...this.endpoints.values()].find(
      (entry) => entry.tenantId === tenantId && entry.name.trim().toLowerCase() === wanted,
    );
    return found ? structuredClone(found) : null;
  }

  async listEndpoints(tenantId: string): Promise<WebhookEndpointRecord[]> {
    return [...this.endpoints.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .map((entry) => structuredClone(entry));
  }

  async updateEndpoint(record: WebhookEndpointRecord): Promise<void> {
    this.endpoints.set(record.id, structuredClone(record));
  }

  async removeEndpoint(tenantId: string, endpointId: string): Promise<void> {
    const found = this.endpoints.get(endpointId);
    if (found && found.tenantId === tenantId) this.endpoints.delete(endpointId);
  }

  async insertDelivery(record: WebhookDeliveryRecord): Promise<void> {
    this.deliveries.set(record.id, structuredClone(record));
  }

  async updateDelivery(record: WebhookDeliveryRecord): Promise<void> {
    this.deliveries.set(record.id, structuredClone(record));
  }

  async findDelivery(tenantId: string, deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const found = this.deliveries.get(deliveryId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async listDeliveries(
    tenantId: string,
    filter: { endpointId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<WebhookDeliveryRecord[]> {
    return [...this.deliveries.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .filter((entry) => (filter.endpointId === undefined ? true : entry.endpointId === filter.endpointId))
      .filter((entry) => (filter.status === undefined ? true : entry.status === filter.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 50)
      .map((entry) => structuredClone(entry));
  }

  async listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<WebhookDeliveryRecord[]> {
    return [...this.deliveries.values()]
      .filter((entry) => (tenantId === null ? true : entry.tenantId === tenantId))
      .filter((entry) => deliveryDue(entry, nowMs))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }
}
