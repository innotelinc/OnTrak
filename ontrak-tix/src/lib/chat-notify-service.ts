/**
 * Chat notification service (M6): the rooms the desk posts to, and whether it
 * managed to.
 *
 * `chat-notify-rules.ts` decides everything — the provider, the URL, the message,
 * the escaping. This file registers channels, renders the message for each
 * provider, makes the one outbound request and records the outcome. Three choices
 * worth stating out loud:
 *
 *  - **A delivery row exists before the attempt, not after.** Same reason as a
 *    webhook's: an event that arrived while the process was dying is still visible
 *    as one that was due, and "did you tell the channel?" is answered from the
 *    record rather than from the state of a ticket that has since changed.
 *  - **The message is rendered once per channel, and the bytes are kept.** Slack's
 *    Block Kit and Teams' MessageCard are different payloads for one message, so the
 *    rendering is per channel — and the payload written to the delivery row is what
 *    was actually posted, so a dispute is settled from the log.
 *  - **A chat channel needs no signing secret.** There is nothing to sign *with*:
 *    Slack authenticates the *destination* (the URL contains its own token) and not
 *    the sender, which is the opposite of our webhook API, where the receiver has to
 *    be able to prove the body came from us. Stated here so nobody adds a header
 *    that no provider checks and mistakes it for a security control.
 *
 * Registering a channel is `tenant:manage`: it decides where a customer's ticket
 * text is posted, which is the same weight as deciding who administers the tenant.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  CHAT_MAX_ATTEMPTS,
  CHAT_TIMEOUT_MS,
  channelsFor,
  chatProviderLabel,
  renderPayload,
  testChatMessage,
  ticketChatMessage,
  validateChatChannel,
  type ChatChannelRecord,
  type ChatDeliveryEvent,
  type ChatDeliveryRecord,
  type ChatProvider,
  type ChatEvent,
  type ChatMessage,
} from "./chat-notify-rules";
import type { ServiceResult } from "./ticket-service";
import { DELIVERY_MAX_ATTEMPTS, applyDeliveryAttempt, deliveryDue, type DeliveryStatus } from "./webhook-rules";
import type { TransportOutcome } from "./webhook-service";

/* -------------------------------------------------------------------------- */
/*  Ports                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatStore {
  insertChannel(record: ChatChannelRecord): Promise<void>;
  findChannel(tenantId: string, channelId: string): Promise<ChatChannelRecord | null>;
  findChannelByName(tenantId: string, name: string): Promise<ChatChannelRecord | null>;
  listChannels(tenantId: string): Promise<ChatChannelRecord[]>;
  updateChannel(record: ChatChannelRecord): Promise<void>;
  removeChannel(tenantId: string, channelId: string): Promise<void>;

  insertDelivery(record: ChatDeliveryRecord): Promise<void>;
  updateDelivery(record: ChatDeliveryRecord): Promise<void>;
  findDelivery(tenantId: string, deliveryId: string): Promise<ChatDeliveryRecord | null>;
  listDeliveries(
    tenantId: string,
    filter?: { channelId?: string; status?: DeliveryStatus; limit?: number },
  ): Promise<ChatDeliveryRecord[]>;
  /** Every delivery owed an attempt now or later, oldest first. */
  listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<ChatDeliveryRecord[]>;
}

/**
 * One HTTP POST, as a port.
 *
 * The webhook service's transport is structurally identical, and deliberately not
 * the same object: a chat transport sends no signature, and sharing one class would
 * mean every future change to one is a change to the other.
 */
export interface ChatTransport {
  send(request: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<TransportOutcome>;
}

/** The real transport: one `fetch`, with the same timeout discipline as a webhook. */
export class FetchChatTransport implements ChatTransport {
  async send(request: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<TransportOutcome> {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      // A provider's error page is not our data; the body is drained so the socket
      // can be reused and never read back to a person.
      await response.text().catch(() => "");
      return { statusCode: response.status, error: null };
    } catch (error) {
      return { statusCode: null, error: error instanceof Error ? error.message : "the request failed" };
    }
  }
}

export interface ChatNotifyIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemChatNotifyIds(): ChatNotifyIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface RegisterChannelInput {
  provider?: string;
  name?: string;
  url?: string;
  events?: readonly string[];
}

/** What an event carries about the ticket it is about. */
export interface TicketChatData {
  ref: string;
  subject: string;
  status: string;
  priority: string;
}

export interface NotifyResult {
  event: ChatEvent;
  /** How many channels asked for it, so zero is a real, visible answer. */
  channels: number;
  deliveries: { deliveryId: string; channelId: string; status: DeliveryStatus; statusCode: number | null }[];
}

export interface DeliveryOverview {
  delivery: ChatDeliveryRecord;
  channelName: string | null;
  provider: ChatProvider | null;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class ChatNotifyService {
  constructor(
    private readonly store: ChatStore,
    private readonly transport: ChatTransport,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ChatNotifyIds = systemChatNotifyIds(),
    /**
     * This deployment's own base URL, so a message can link to the ticket.
     *
     * Read once at construction from the environment rather than per message: a
     * deployment that does not know its own address sends a message without a link,
     * which is honest, instead of one with a made-up host.
     */
    private readonly baseUrl: string | null = null,
  ) {}

  /* ------------------------------------------------------------ channels */

  async register(actor: Actor, input: RegisterChannelInput): Promise<ServiceResult<ChatChannelRecord>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };

    const issues = validateChatChannel(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name!.trim();
    if (await this.store.findChannelByName(actor.tenantId, name)) {
      return { ok: false, error: `A channel called “${name}” already exists.` };
    }

    const channel: ChatChannelRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      provider: input.provider!.trim().toUpperCase() as ChatProvider,
      name,
      url: input.url!.trim(),
      events: [...(input.events ?? [])] as ChatEvent[],
      enabled: true,
      createdBy: actor.id,
      createdAt: this.ids.now(),
      disabledAt: null,
    };
    await this.store.insertChannel(channel);

    // The provider and the *name*, never the URL: the URL is a credential — anybody
    // holding it can post into that room — so it is not written to a log that is read
    // by people who may not post.
    await this.append(actor, "chat.channel.create", channel.id, {
      name: channel.name,
      provider: channel.provider,
      events: channel.events,
    });
    return { ok: true, value: channel };
  }

  async list(actor: Actor): Promise<ServiceResult<ChatChannelRecord[]>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };
    const channels = await this.store.listChannels(actor.tenantId);
    return { ok: true, value: channels.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async setEnabled(actor: Actor, channelId: string, enabled: boolean): Promise<ServiceResult<ChatChannelRecord>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };

    const channel = await this.store.findChannel(actor.tenantId, channelId);
    if (!channel) return { ok: false, error: "That channel does not exist." };

    const next: ChatChannelRecord = { ...channel, enabled, disabledAt: enabled ? null : this.ids.now() };
    await this.store.updateChannel(next);
    await this.append(actor, enabled ? "chat.channel.enable" : "chat.channel.disable", next.id, {
      name: next.name,
      provider: next.provider,
    });
    return { ok: true, value: next };
  }

  async remove(actor: Actor, channelId: string): Promise<ServiceResult<{ id: string }>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };

    const channel = await this.store.findChannel(actor.tenantId, channelId);
    if (!channel) return { ok: false, error: "That channel does not exist." };

    await this.store.removeChannel(actor.tenantId, channel.id);
    // The deliveries stay, so the log still answers "did we tell that room?" about a
    // channel that no longer exists — which is exactly when somebody asks.
    await this.append(actor, "chat.channel.remove", channel.id, { name: channel.name, provider: channel.provider });
    return { ok: true, value: { id: channel.id } };
  }

  /**
   * Post one test message, now.
   *
   * The single most useful thing a console can offer for this integration: a webhook
   * URL that was pasted slightly wrong fails *silently* in a chat product — nobody
   * notices a message that never arrived — so the way to find out is to make it
   * arrive while somebody is watching, and to see the provider's answer in the log.
   */
  async sendTest(actor: Actor, channelId: string): Promise<ServiceResult<{ delivery: ChatDeliveryRecord; outcome: TransportOutcome }>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };

    const channel = await this.store.findChannel(actor.tenantId, channelId);
    if (!channel) return { ok: false, error: "That channel does not exist." };

    const message = testChatMessage({ channelName: channel.name, url: this.ticketLink(null) });
    const delivery = await this.record(channel, message);
    const after = await this.attempt(delivery, channel);
    await this.append(actor, "chat.channel.test", channel.id, {
      name: channel.name,
      provider: channel.provider,
      status: after.status,
      statusCode: after.lastStatusCode,
      error: after.lastError,
    });
    return { ok: true, value: { delivery: after, outcome: { statusCode: after.lastStatusCode, error: after.lastError } } };
  }

  /* ---------------------------------------------------------- delivering */

  /**
   * Tell every channel that asked for this event.
   *
   * Silence is not a failure here: a tenant with no channels gets zero deliveries,
   * and that is a real answer worth returning rather than an error. Each channel gets
   * its own row and its own outcome, so one room's broken webhook is not another
   * room's missing message.
   */
  async notify(tenantId: string, event: ChatEvent, data: TicketChatData): Promise<NotifyResult> {
    const channels = channelsFor(await this.store.listChannels(tenantId), event);
    const results: NotifyResult["deliveries"] = [];

    for (const channel of channels) {
      const message = ticketChatMessage({
        event,
        ref: data.ref,
        subject: data.subject,
        status: data.status,
        priority: data.priority,
        url: this.ticketLink(data.ref),
      });
      const delivery = await this.record(channel, message);
      const after = await this.attempt(delivery, channel);
      results.push({
        deliveryId: after.id,
        channelId: channel.id,
        status: after.status,
        statusCode: after.lastStatusCode,
      });
    }

    return { event, channels: channels.length, deliveries: results };
  }

  /**
   * Attempt every delivery that is due — the sweep behind the console's button and a
   * scheduler's call. Safe to run as often as you like: nothing not due is in the
   * worklist.
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
      const channel = await this.store.findChannel(delivery.tenantId, delivery.channelId);
      // A channel that has been removed or switched off stops the retry here rather
      // than being retried forever; the row keeps its last state so the log says what
      // happened instead of pretending nothing did.
      if (!channel || !channel.enabled) continue;
      const after = await this.attempt(delivery, channel);
      if (after.status === "DELIVERED") delivered += 1;
      else if (after.status === "EXHAUSTED") exhausted += 1;
      else retrying += 1;
    }
    return { considered: due.length, delivered, retrying, exhausted };
  }

  /* ---------------------------------------------------------------- log */

  async listDeliveries(
    actor: Actor,
    filter: { channelId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<ServiceResult<DeliveryOverview[]>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };

    const rows = await this.store.listDeliveries(actor.tenantId, filter);
    const channels = await this.store.listChannels(actor.tenantId);
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return {
      ok: true,
      value: rows.map((delivery) => ({
        delivery,
        channelName: byId.get(delivery.channelId)?.name ?? null,
        provider: byId.get(delivery.channelId)?.provider ?? null,
      })),
    };
  }

  async findDelivery(actor: Actor, deliveryId: string): Promise<ServiceResult<ChatDeliveryRecord>> {
    if (!hasPermission(actor.role, "tenant:manage")) return { ok: false, error: "You do not manage notification channels." };
    const delivery = await this.store.findDelivery(actor.tenantId, deliveryId);
    if (!delivery) return { ok: false, error: "That delivery does not exist." };
    return { ok: true, value: delivery };
  }

  /* ---------------------------------------------------------- internals */

  /** The row, written before the attempt so a crash mid-post is still visible. */
  private async record(channel: ChatChannelRecord, message: ChatMessage): Promise<ChatDeliveryRecord> {
    const delivery: ChatDeliveryRecord = {
      id: this.ids.id(),
      tenantId: channel.tenantId,
      channelId: channel.id,
      event: message.event,
      payload: renderPayload(channel.provider, message),
      status: "PENDING",
      attemptCount: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: null,
      createdAt: this.ids.nowMs(),
    };
    await this.store.insertDelivery(delivery);
    return delivery;
  }

  private async attempt(delivery: ChatDeliveryRecord, channel: ChatChannelRecord): Promise<ChatDeliveryRecord> {
    const outcome = await this.transport.send({
      url: channel.url,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Both providers accept an explicit user agent, and a room's audit trail is
        // easier to read when the poster identifies itself.
        "user-agent": "OnTrak-Tix/1.0 (+chat-notifications)",
      },
      body: delivery.payload,
      timeoutMs: CHAT_TIMEOUT_MS,
    });

    const next = applyDeliveryAttempt(delivery, { statusCode: outcome.statusCode, error: outcome.error }, this.ids.nowMs());
    await this.store.updateDelivery(next);

    // One event per attempt, so the chain answers "how many times did we tell them,
    // and when?" — and an exhausted delivery is visible as several events rather than
    // as one row that changed.
    await this.append(
      { id: "system:chat-notify", tenantId: delivery.tenantId, role: "ADMIN" },
      next.status === "DELIVERED" ? "chat.delivered" : "chat.delivery_failed",
      next.id,
      {
        channelId: channel.id,
        provider: channel.provider,
        event: next.event,
        attempt: next.attemptCount,
        maxAttempts: CHAT_MAX_ATTEMPTS,
        statusCode: next.lastStatusCode,
        error: next.lastError,
        status: next.status,
        nextAttemptAt: next.nextAttemptAt === null ? null : new Date(next.nextAttemptAt).toISOString(),
      },
    );
    return next;
  }

  /** Where a person opens the ticket, when this deployment knows its own address. */
  private ticketLink(ref: string | null): string | null {
    if (!this.baseUrl) return null;
    const root = this.baseUrl.replace(/\/+$/, "");
    return ref ? `${root}/tickets/${encodeURIComponent(ref)}` : root;
  }

  private async append(actor: Actor, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "ChatChannel",
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** The provider's own name, for a console that prints one. */
export { chatProviderLabel };

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryChatStore implements ChatStore {
  private readonly channels = new Map<string, ChatChannelRecord>();
  private readonly deliveries = new Map<string, ChatDeliveryRecord>();

  async insertChannel(record: ChatChannelRecord): Promise<void> {
    this.channels.set(record.id, structuredClone(record));
  }

  async findChannel(tenantId: string, channelId: string): Promise<ChatChannelRecord | null> {
    const found = this.channels.get(channelId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findChannelByName(tenantId: string, name: string): Promise<ChatChannelRecord | null> {
    const wanted = name.trim().toLowerCase();
    const found = [...this.channels.values()].find(
      (entry) => entry.tenantId === tenantId && entry.name.trim().toLowerCase() === wanted,
    );
    return found ? structuredClone(found) : null;
  }

  async listChannels(tenantId: string): Promise<ChatChannelRecord[]> {
    return [...this.channels.values()].filter((entry) => entry.tenantId === tenantId).map((entry) => structuredClone(entry));
  }

  async updateChannel(record: ChatChannelRecord): Promise<void> {
    this.channels.set(record.id, structuredClone(record));
  }

  async removeChannel(tenantId: string, channelId: string): Promise<void> {
    const found = this.channels.get(channelId);
    if (found && found.tenantId === tenantId) this.channels.delete(channelId);
  }

  async insertDelivery(record: ChatDeliveryRecord): Promise<void> {
    this.deliveries.set(record.id, structuredClone(record));
  }

  async updateDelivery(record: ChatDeliveryRecord): Promise<void> {
    this.deliveries.set(record.id, structuredClone(record));
  }

  async findDelivery(tenantId: string, deliveryId: string): Promise<ChatDeliveryRecord | null> {
    const found = this.deliveries.get(deliveryId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async listDeliveries(
    tenantId: string,
    filter: { channelId?: string; status?: DeliveryStatus; limit?: number } = {},
  ): Promise<ChatDeliveryRecord[]> {
    return [...this.deliveries.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .filter((entry) => (filter.channelId === undefined ? true : entry.channelId === filter.channelId))
      .filter((entry) => (filter.status === undefined ? true : entry.status === filter.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 50)
      .map((entry) => structuredClone(entry));
  }

  async listDueDeliveries(tenantId: string | null, nowMs: number, limit: number): Promise<ChatDeliveryRecord[]> {
    return [...this.deliveries.values()]
      .filter((entry) => (tenantId === null ? true : entry.tenantId === tenantId))
      .filter((entry) => deliveryDue(entry, nowMs))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }
}

/** Kept beside the webhook's, so a reader comparing the two sees the same number. */
export { DELIVERY_MAX_ATTEMPTS, CHAT_MAX_ATTEMPTS };
export type { ChatDeliveryEvent };
