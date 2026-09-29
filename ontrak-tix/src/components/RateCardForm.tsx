/**
 * Rate card authoring (M4).
 *
 * One card per client, so this is a "save" rather than a "add another" — saving
 * replaces, because two cards for one client is two prices for one hour. The
 * rate is typed as money and stored as cents, and the rounding choice is spelled
 * out in words ("bill in 15-minute units") rather than left as a number to
 * interpret.
 *
 * Presentational: the permission and the validation are the service's.
 */

import { RATE_INCREMENTS, formatMoney, type RateCardRecord } from "../lib/time-rules";

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-2 py-1 text-xs text-ink";

/** `0` and `1` are the two increments that are not a rounding rule but a policy. */
function incrementLabel(minutes: number): string {
  if (minutes === 0) return "exactly what was worked";
  if (minutes === 1) return "to the minute";
  return `in ${minutes}-minute units (rounded up)`;
}

export function RateCardForm({
  action,
  removeAction,
  clientId = null,
  card,
}: {
  action: (formData: FormData) => Promise<void>;
  removeAction?: (formData: FormData) => Promise<void>;
  clientId?: string | null;
  card?: RateCardRecord;
}) {
  return (
    <div className="space-y-1.5 rounded-xl2 border border-line/70 bg-surface-muted/40 p-2.5">
      <p className="text-[11px] font-semibold text-ink-soft">
        {card ? (
          <>
            Rate card: {card.name} — {formatMoney(card.hourlyRateCents, card.currency)}/hour, billed{" "}
            {incrementLabel(card.incrementMinutes)}
          </>
        ) : (
          "No rate card here yet, so this work logs unpriced."
        )}
      </p>

      <form action={action} className="flex flex-wrap items-end gap-2">
        {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
        <label className="text-xs text-ink-soft">
          Card name
          <input name="name" required defaultValue={card?.name ?? ""} placeholder="e.g. Standard support" className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Currency
          <input
            name="currency"
            required
            maxLength={3}
            defaultValue={card?.currency ?? "USD"}
            className={`block w-16 uppercase ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Per hour
          <input
            name="hourlyRate"
            type="number"
            min={0}
            step="0.01"
            required
            defaultValue={card ? (card.hourlyRateCents / 100).toFixed(2) : ""}
            placeholder="145.00"
            className={`block w-24 ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Rounding
          <select name="incrementMinutes" defaultValue={String(card?.incrementMinutes ?? 0)} className={`block ${inputClass}`}>
            {RATE_INCREMENTS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {incrementLabel(minutes)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
          {card ? "Save rate card" : "Set rate card"}
        </button>
      </form>

      {card && removeAction ? (
        <form action={removeAction}>
          <input type="hidden" name="cardId" value={card.id} />
          <button type="submit" className="text-[11px] text-bad hover:underline">
            Remove this rate card
          </button>
        </form>
      ) : null}
    </div>
  );
}
