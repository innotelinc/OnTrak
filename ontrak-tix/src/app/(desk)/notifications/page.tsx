import { requireActor } from "../../../lib/session";
import { notificationServicesFor } from "../../../lib/db";
import { roleSeesNotifications } from "../../../lib/notification-service";
import { NOTIFICATION_MAX_LEVEL, NOTIFICATION_MIN_LEVEL } from "../../../lib/notification-rules";
import { NotificationList } from "../../../components/NotificationList";
import { readAllNotificationsAction, readNotificationAction, saveNotificationPreferenceAction } from "../../actions/tickets";

export const metadata = { title: "Notifications" };

const LEVELS = Array.from({ length: NOTIFICATION_MAX_LEVEL - NOTIFICATION_MIN_LEVEL + 1 }, (_, i) => NOTIFICATION_MIN_LEVEL + i);

/**
 * Staff notifications: the in-app side of SLA escalations. The same notices are
 * emailed by the sweep; this page is where an agent acknowledges them and sets
 * how much they personally want to see.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string }>;
}) {
  const actor = await requireActor();
  const { flash } = await searchParams;
  const { notifications, unread, preference } = await notificationServicesFor().listFor(actor);
  const seesNotifications = roleSeesNotifications(actor.role);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Notifications</h1>
          <p className="text-sm text-ink-soft">
            {!seesNotifications
              ? "Your role does not receive desk notifications."
              : preference.muted
                ? "In-app notifications are muted."
                : unread === 0
                  ? "Nothing needs your attention."
                  : `${unread} unread escalation${unread === 1 ? "" : "s"}.`}
          </p>
        </div>
        {unread > 0 ? (
          <form action={readAllNotificationsAction}>
            <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
              Mark all read
            </button>
          </form>
        ) : null}
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}

      {seesNotifications ? (
        <form action={saveNotificationPreferenceAction} className="flex flex-wrap items-end gap-3 rounded-xl2 border border-line bg-surface p-4">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-ink">Show escalations from level</span>
            <select
              name="minLevel"
              defaultValue={String(preference.minLevel)}
              className="rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink"
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  L{level}
                  {level === NOTIFICATION_MIN_LEVEL ? " (everything)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="muted" defaultChecked={preference.muted} className="size-4 accent-brand" />
            Mute in-app notifications
          </label>
          <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
            Save preference
          </button>
        </form>
      ) : null}

      <NotificationList
        notifications={notifications}
        readAction={readNotificationAction}
        emptyMessage={
          preference.muted
            ? "In-app notifications are muted. Raise the level or unmute to see new notices."
            : "No notifications yet. SLA escalations appear here as they are raised."
        }
      />
    </div>
  );
}
