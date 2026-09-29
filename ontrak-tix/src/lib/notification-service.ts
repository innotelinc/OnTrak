/**
 * Notification service (M1): in-app notices plus an email digest.
 *
 * The SLA sweep calls `notifyEscalation`, which stores the in-app notice and
 * hands the mail copy to an `EmailSender`. Storing is deduped on the
 * `(tenant, dedupeKey, audience)` key, so a repeated sweep cannot double-notify
 * even if the escalation store somehow replayed a rung.
 *
 * Email is a port: production wires a real transport, while the default
 * `ConsoleEmailSender` prints the message so a local sweep is observable without
 * SMTP. Nothing here decides *who* is notified — that is `notification-rules`.
 */

import { randomUUID } from "node:crypto";

import type { Actor, Role } from "./access-rules";
import {
  clampMinLevel,
  defaultPreference,
  notificationForEscalation,
  renderNotificationEmail,
  shouldDeliver,
  visibleAudiencesFor,
  type NotificationDraft,
  type NotificationPreference,
  type NotificationRecord,
} from "./notification-rules";
import type { EscalationAudience } from "./escalation-rules";
import type { SlaEscalationRecord } from "./escalation-service";
import type { RuleNotice } from "./rule-intake";

export interface NotificationStore {
  listForTenant(tenantId: string): Promise<NotificationRecord[]>;
  /** Returns `false` when the notice already existed (the dedupe key is unique). */
  insert(record: NotificationRecord): Promise<boolean>;
  markRead(tenantId: string, id: string, at: string): Promise<void>;
  markAllRead(tenantId: string, audiences: readonly EscalationAudience[], at: string): Promise<void>;
}

/** Per-user in-app preferences. Missing means "show everything, unmuted". */
export interface NotificationPreferenceStore {
  get(tenantId: string, userId: string): Promise<NotificationPreference | null>;
  save(preference: NotificationPreference): Promise<void>;
}

/** The email port. A real transport implements this; the default just logs. */
export interface EmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Prints the digest to the server log — useful for local development. */
export class ConsoleEmailSender implements EmailSender {
  async send(message: { to: string; subject: string; text: string }): Promise<void> {
    console.info(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
  }
}

export interface NotificationIds {
  id(): string;
  now(): string;
}

export function systemNotificationIds(): NotificationIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export class NotificationService {
  constructor(
    private readonly store: NotificationStore,
    private readonly email: EmailSender | null = null,
    private readonly ids: NotificationIds = systemNotificationIds(),
    private readonly preferences: NotificationPreferenceStore | null = null,
  ) {}

  /** Raise the in-app notice for an escalation rung and email the audience. */
  async notifyEscalation(record: SlaEscalationRecord): Promise<NotificationRecord> {
    const draft = notificationForEscalation({
      tenantId: record.tenantId,
      ticketId: record.ticketId,
      ticketRef: record.ticketRef,
      audience: record.audience,
      label: record.label,
      reason: record.reason,
      dedupeKey: record.dedupeKey,
      level: record.level,
    });

    return this.raise(draft, record.tenantId, record.raisedAt);
  }

  /**
   * Raise the in-app notice for one rule's `notify` action (M5).
   *
   * Addressed to agents rather than to a named person: a rule files work for the
   * desk, and the desk decides who is watching. The dedupe key is the rule plus
   * the ticket, so the same intake replayed cannot page twice. A macro (M5)
   * reaches staff through here too, so the wording names which of the two it was
   * — a notice that said "Rule" would send the reader to the wrong console.
   */
  async notifyRule(notice: RuleNotice): Promise<NotificationRecord> {
    const label = notice.source === "macro" ? "Macro" : "Rule";
    const key = notice.source === "macro" ? "macro" : "rule";
    return this.raise(
      {
        audience: "AGENT",
        kind: "rule.notify",
        title: `${label} “${notice.ruleName}” on ${notice.ticketRef}`,
        body: notice.value,
        ticketId: notice.ticketId,
        ticketRef: notice.ticketRef,
        dedupeKey: `${key}.notify:${notice.ruleId}:${notice.ticketId}`,
        level: null,
      },
      notice.tenantId,
      this.ids.now(),
    );
  }

  /**
   * Raise the on-call page for a rule's `escalate` action (M5).
   *
   * It does not lift an SLA rung: the ladder belongs to the clock, and a rule has
   * no clock reading to claim for it. What it does is what the hazard text
   * promises — it pages whoever is on call — so it is addressed to managers and
   * pinned to the first rung, where a per-user level filter cannot swallow it.
   */
  async notifyRuleEscalation(notice: RuleNotice): Promise<NotificationRecord> {
    const label = notice.source === "macro" ? "Macro" : "Rule";
    const key = notice.source === "macro" ? "macro" : "rule";
    const raised = notice.source === "macro" ? "A macro" : "A rule";
    return this.raise(
      {
        audience: "MANAGER",
        kind: "rule.escalate",
        title: `${label} escalation: ${notice.ticketRef}`,
        body: `${notice.value || `${raised} escalated this ticket.`} (${label} “${notice.ruleName}”.)`,
        ticketId: notice.ticketId,
        ticketRef: notice.ticketRef,
        dedupeKey: `${key}.escalate:${notice.ruleId}:${notice.ticketId}`,
        level: 1,
      },
      notice.tenantId,
      this.ids.now(),
    );
  }

  /**
   * Store one notice and mail it, best-effort.
   *
   * The store's dedupe key is the guard: a replayed event must not re-mail the
   * audience, and a mail transport that is down must never undo the notice.
   */
  private async raise(draft: NotificationDraft, tenantId: string, at: string): Promise<NotificationRecord> {
    const notification: NotificationRecord = { id: this.ids.id(), tenantId, ...draft, createdAt: at, readAt: null };
    const created = await this.store.insert(notification);

    if (created && this.email) {
      const message = renderNotificationEmail(notification);
      // The audience label stands in for the real recipient list until a user
      // directory is wired; the send is best-effort and never blocks the sweep.
      await this.email.send({ to: `${draft.audience.toLowerCase()}@desk`, ...message }).catch(() => undefined);
    }

    return notification;
  }

  /**
   * The notices visible to an actor: their role's audiences, narrowed by their
   * personal preference, newest first. A muted user sees nothing (and the
   * unread badge stays at zero) without losing the underlying notices.
   */
  async listFor(actor: Actor): Promise<{ notifications: NotificationRecord[]; unread: number; preference: NotificationPreference }> {
    const preference = await this.preferenceFor(actor);
    const audiences = visibleAudiencesFor(actor.role);
    if (audiences.length === 0 || preference.muted) return { notifications: [], unread: 0, preference };

    const all = await this.store.listForTenant(actor.tenantId);
    const notifications = all
      .filter((notification) => audiences.includes(notification.audience) && shouldDeliver(preference, notification))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { notifications, unread: notifications.filter((notification) => notification.readAt === null).length, preference };
  }

  /** The actor's stored preference, or the all-on default. */
  async preferenceFor(actor: Actor): Promise<NotificationPreference> {
    const stored = await this.preferences?.get(actor.tenantId, actor.id);
    return stored ?? defaultPreference(actor.tenantId, actor.id, this.ids.now());
  }

  /** Persist a preference, clamping the level so a crafted form cannot widen it. */
  async savePreference(actor: Actor, input: { minLevel: unknown; muted: boolean }): Promise<NotificationPreference> {
    const preference: NotificationPreference = {
      tenantId: actor.tenantId,
      userId: actor.id,
      minLevel: clampMinLevel(input.minLevel),
      muted: input.muted === true,
      updatedAt: this.ids.now(),
    };
    if (this.preferences) await this.preferences.save(preference);
    return preference;
  }

  async markRead(actor: Actor, id: string): Promise<void> {
    await this.store.markRead(actor.tenantId, id, this.ids.now());
  }

  async markAllRead(actor: Actor): Promise<void> {
    await this.store.markAllRead(actor.tenantId, visibleAudiencesFor(actor.role), this.ids.now());
  }
}

/** Whether notifications can be shown at all for a role. */
export function roleSeesNotifications(role: Role): boolean {
  return visibleAudiencesFor(role).length > 0;
}

/** An in-memory preference store for tests and local development. */
export class MemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  private readonly preferences = new Map<string, NotificationPreference>();

  async get(tenantId: string, userId: string): Promise<NotificationPreference | null> {
    const found = this.preferences.get(`${tenantId}:${userId}`);
    return found ? structuredClone(found) : null;
  }

  async save(preference: NotificationPreference): Promise<void> {
    this.preferences.set(`${preference.tenantId}:${preference.userId}`, structuredClone(preference));
  }
}

/** An in-memory store for tests and local development. */
export class MemoryNotificationStore implements NotificationStore {
  private readonly records = new Map<string, NotificationRecord>();

  async listForTenant(tenantId: string): Promise<NotificationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .map((record) => structuredClone(record));
  }

  async insert(record: NotificationRecord): Promise<boolean> {
    const key = `${record.tenantId}:${record.dedupeKey}:${record.audience}`;
    const existing = [...this.records.values()].find(
      (candidate) => `${candidate.tenantId}:${candidate.dedupeKey}:${candidate.audience}` === key,
    );
    if (existing) return false;
    this.records.set(record.id, structuredClone(record));
    return true;
  }

  async markRead(tenantId: string, id: string, at: string): Promise<void> {
    const record = this.records.get(id);
    if (record?.tenantId === tenantId) this.records.set(id, { ...record, readAt: at });
  }

  async markAllRead(tenantId: string, audiences: readonly EscalationAudience[], at: string): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.tenantId === tenantId && audiences.includes(record.audience) && record.readAt === null) {
        this.records.set(id, { ...record, readAt: at });
      }
    }
  }
}
