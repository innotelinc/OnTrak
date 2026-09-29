/**
 * The time panel on a ticket (M4).
 *
 * Where the work happens is where the hours should be logged — an agent who has
 * to leave the ticket to record what it cost will record it tomorrow, or not at
 * all. Presentational: the price, the permission and the frozen-after-invoicing
 * rule are the service's.
 */

import type { TimeEntryRecord } from "../lib/time-rules";
import { formatLoggedMinutes, formatMoney, entryAmountCents } from "../lib/time-rules";

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-2 py-1 text-xs text-ink";

export function TicketTime({
  ticketId,
  entries,
  today,
  canLog,
  logAction,
  removeAction,
}: {
  /** The ticket the hours belong to — the form posts it, so the client and the
   *  reference are derived server-side rather than typed here. */
  ticketId: string;
  entries: TimeEntryRecord[];
  /** Today, `YYYY-MM-DD`, so the date field defaults to the day it is. */
  today: string;
  canLog: boolean;
  logAction?: (formData: FormData) => Promise<void>;
  removeAction?: (formData: FormData) => Promise<void>;
}) {
  const worked = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const billableMinutes = entries.filter((entry) => entry.billable).reduce((sum, entry) => sum + entry.minutes, 0);
  const amountByCurrency = new Map<string, number>();
  for (const entry of entries) {
    const amount = entryAmountCents(entry);
    if (amount === null || entry.currency === null) continue;
    amountByCurrency.set(entry.currency, (amountByCurrency.get(entry.currency) ?? 0) + amount);
  }

  return (
    <section aria-label="Time on this ticket" className="rounded-xl2 border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">Time</h3>
        <span className="text-xs text-ink-soft">
          {entries.length === 0
            ? "Nothing logged yet."
            : `${formatLoggedMinutes(worked)} logged · ${formatLoggedMinutes(billableMinutes)} billable`}
        </span>
        {[...amountByCurrency].map(([currency, cents]) => (
          <span key={currency} className="ml-auto text-xs font-semibold text-ink">
            {formatMoney(cents, currency)}
          </span>
        ))}
      </div>

      {entries.length > 0 ? (
        <ul className="mt-3 divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
              <time className="font-mono text-[11px] text-ink-faint" dateTime={entry.workDate}>
                {entry.workDate}
              </time>
              <span className="font-semibold text-ink">{formatLoggedMinutes(entry.minutes)}</span>
              {entry.billedMinutes !== null && entry.billedMinutes !== entry.minutes ? (
                <span className="text-ink-faint">→ billed {formatLoggedMinutes(entry.billedMinutes)}</span>
              ) : null}
              <span className={entry.billable ? "text-ok" : "text-ink-faint"}>{entry.billable ? "billable" : "non-billable"}</span>
              {entry.billable && entry.rateCentsPerHour === null ? <span className="text-attention">unpriced</span> : null}
              {entry.invoiceRef ? <span className="text-ink-faint">on {entry.invoiceRef}</span> : null}
              {entry.note ? <span className="truncate text-ink-soft">{entry.note}</span> : null}
              {removeAction && entry.invoicedAt === null ? (
                <form action={removeAction} className="ml-auto">
                  <input type="hidden" name="entryId" value={entry.id} />
                  <input type="hidden" name="home" value={`/inbox/${entry.ticketId ?? ""}`} />
                  <button type="submit" className="text-[11px] text-bad hover:underline">
                    Remove
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canLog && logAction ? (
        <form action={logAction} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <label className="text-xs text-ink-soft">
            Day worked
            <input name="workDate" type="date" required defaultValue={today} className={`block ${inputClass}`} />
          </label>
          <label className="text-xs text-ink-soft">
            Minutes
            <input name="minutes" type="number" min={1} step={1} required placeholder="30" className={`block w-20 ${inputClass}`} />
          </label>
          <label className="flex items-center gap-1.5 pb-1 text-xs text-ink-soft">
            <input name="billable" type="checkbox" defaultChecked />
            Chargeable
          </label>
          <label className="min-w-40 flex-1 text-xs text-ink-soft">
            What was done (optional)
            <input name="note" placeholder="e.g. rebuilt the print queue" className={`block w-full ${inputClass}`} />
          </label>
          <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
            Log time
          </button>
        </form>
      ) : null}
    </section>
  );
}
