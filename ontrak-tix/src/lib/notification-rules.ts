/**
 * Notification rules (M1): who sees a notice, and what it says.
 *
 * Notices are addressed to an *audience* rather than a user id, because the SLA
 * ladder names a role (`AGENT`/`DISPATCHER`/`MANAGER`) and the desk's staffing
 * changes far more often than its ladder. The service fans an audience out to
 * the roles that may see it; this module is that mapping, plus the in-app and
 * email copy, kept pure so both are tested without a mail server.
 */

import type { Role } from "./access-rules";
import type { EscalationAudience } from "./escalation-rules";

export interface NotificationRecord {
  id: string;
  tenantId: string;
  audience: EscalationAudience;
  /** e.g. `sla.escalation`. */
  kind: string;
  title: string;
  body: string;
  ticketId: string | null;
  ticketRef: string | null;
  /** Idempotency key — the escalation's own dedupe key. */
  dedupeKey: string;
  /** The escalation ladder rung, when the notice came from one. */
  level: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationDraft {
  audience: EscalationAudience;
  kind: string;
  title: string;
  body: string;
  ticketId: string | null;
  ticketRef: string | null;
  dedupeKey: string;
  level: number | null;
}

/**
 * The audiences a role is allowed to see. An admin acts as the manager and
 * oversees every rung; a dispatcher sees only dispatcher notices; an agent only
 * agent notices. A requester sees none — SLA internals are staff work product.
 */
export function visibleAudiencesFor(role: Role): EscalationAudience[] {
  switch (role) {
    case "ADMIN":
      return ["AGENT", "DISPATCHER", "MANAGER"];
    case "DISPATCHER":
      return ["DISPATCHER"];
    case "AGENT":
      return ["AGENT"];
    default:
      return [];
  }
}

/** Whether any notification could ever be visible to this role. */
export function receivesNotifications(role: Role): boolean {
  return visibleAudiencesFor(role).length > 0;
}

/** The in-app notice for a raised escalation rung. */
export function notificationForEscalation(input: {
  tenantId: string;
  ticketId: string;
  ticketRef: string;
  audience: EscalationAudience;
  label: string;
  reason: string;
  dedupeKey: string;
  level: number;
}): NotificationDraft {
  return {
    audience: input.audience,
    kind: "sla.escalation",
    title: `${input.label}: ${input.ticketRef}`,
    body: input.reason,
    ticketId: input.ticketId,
    ticketRef: input.ticketRef,
    dedupeKey: input.dedupeKey,
    level: input.level,
  };
}

/* -------------------------------------------------------------------------- */
/*  Per-user preferences                                                      */
/* -------------------------------------------------------------------------- */

/** The escalation ladder's rungs; a preference filters on this range. */
export const NOTIFICATION_MIN_LEVEL = 1;
export const NOTIFICATION_MAX_LEVEL = 3;

/**
 * A staff member's in-app notification preference. The audience a notice is
 * addressed to is a *role* decision; this is the personal one — "don't show me
 * anything below level 2", or "mute me entirely".
 */
export interface NotificationPreference {
  tenantId: string;
  userId: string;
  /** Only notices at this ladder level or above are shown (1 = everything). */
  minLevel: number;
  /** Mute in-app notices for this user without changing their role's audience. */
  muted: boolean;
  updatedAt: string;
}

/** The preference a user has before they ever change one: everything, unmuted. */
export function defaultPreference(tenantId: string, userId: string, now: string): NotificationPreference {
  return { tenantId, userId, minLevel: NOTIFICATION_MIN_LEVEL, muted: false, updatedAt: now };
}

/** Coerce an arbitrary form value to a valid ladder level. */
export function clampMinLevel(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return NOTIFICATION_MIN_LEVEL;
  return Math.min(NOTIFICATION_MAX_LEVEL, Math.max(NOTIFICATION_MIN_LEVEL, Math.trunc(parsed)));
}

/** Whether a preference lets a notice through. A notice with no level passes. */
export function shouldDeliver(preference: NotificationPreference, notification: Pick<NotificationRecord, "level">): boolean {
  if (preference.muted) return false;
  if (notification.level === null) return true;
  return notification.level >= preference.minLevel;
}

export interface EmailMessage {
  subject: string;
  text: string;
}

/**
 * The email digest copy for a batch of notices. Grouped by ticket so one busy
 * ticket does not flood the inbox with one mail per rung.
 */
export function renderNotificationDigest(notifications: readonly NotificationRecord[], appName = "OnTrak Tix"): EmailMessage {
  const count = notifications.length;
  const subject = count === 1 ? `[${appName}] ${notifications[0].title}` : `[${appName}] ${count} SLA escalations`;
  const lines = notifications.map((notification) => `• ${notification.title}\n  ${notification.body}`);
  return {
    subject,
    text: [`${count} SLA escalation${count === 1 ? "" : "s"} need attention:`, "", ...lines, "", "Open the inbox to triage."].join("\n"),
  };
}

/** The mail copy for a single notice. */
export function renderNotificationEmail(notification: NotificationRecord, appName = "OnTrak Tix"): EmailMessage {
  return {
    subject: `[${appName}] ${notification.title}`,
    text: `${notification.title}\n\n${notification.body}\n\nTicket: ${notification.ticketRef ?? notification.ticketId ?? "—"}`,
  };
}
