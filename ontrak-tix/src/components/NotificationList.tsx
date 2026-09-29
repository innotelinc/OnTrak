/**
 * Notification list (M1): the staff in-app notices, as a pure renderer.
 *
 * Split out of the page so the markup — unread state, the audience chip and the
 * ticket link — can be rendered and asserted in tests without a session or a
 * database.
 */

import type { NotificationRecord } from "../lib/notification-rules";

export interface NotificationListProps {
  notifications: NotificationRecord[];
  /** When supplied, each unread notice gets a "Mark read" button. */
  readAction?: (formData: FormData) => Promise<void>;
  emptyMessage?: string;
}

export function NotificationList({ notifications, readAction, emptyMessage }: NotificationListProps) {
  if (notifications.length === 0) {
    return (
      <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
        {emptyMessage ?? "No notifications yet. SLA escalations appear here as they are raised."}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
      {notifications.map((notification) => (
        <li key={notification.id} className={`px-4 py-3 ${notification.readAt === null ? "bg-attention/8" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-faint">
              {notification.audience}
            </span>
            {notification.level !== null ? (
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-faint">
                L{notification.level}
              </span>
            ) : null}
            {notification.readAt === null ? (
              <span className="rounded-full bg-attention/10 px-2 py-0.5 text-[11px] font-semibold text-attention">Unread</span>
            ) : null}
            <time className="ml-auto text-[11px] text-ink-faint" dateTime={notification.createdAt}>
              {notification.createdAt}
            </time>
          </div>
          <p className="mt-1 font-semibold text-ink">{notification.title}</p>
          <p className="mt-0.5 text-sm text-ink-soft">{notification.body}</p>
          <div className="mt-2 flex items-center gap-3">
            {notification.ticketId ? (
              <a href={`/inbox/${notification.ticketId}`} className="text-xs font-semibold text-brand hover:underline">
                Open {notification.ticketRef ?? "ticket"}
              </a>
            ) : null}
            {readAction && notification.readAt === null ? (
              <form action={readAction}>
                <input type="hidden" name="id" value={notification.id} />
                <button type="submit" className="text-xs font-semibold text-ink-faint hover:text-ink">
                  Mark read
                </button>
              </form>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
