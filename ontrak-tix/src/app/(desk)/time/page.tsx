import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { clientServicesFor, timeServicesFor } from "../../../lib/db";
import { entryAmountCents, formatLoggedMinutes, formatMoney } from "../../../lib/time-rules";
import { correctTimeAction, issueInvoiceAction, removeTimeAction } from "../../actions/time";

export const metadata = { title: "Time" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-2.5 py-1.5 text-sm text-ink";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** First of the month, so the default period is the one people bill. */
function periodStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/**
 * The time ledger (M4): what the desk worked, what it is worth, and the invoices
 * it has issued.
 *
 * The period on screen is the period that gets billed — the filter the reader
 * set is carried into the invoice form rather than typed twice, because the two
 * disagreeing is how an hour gets billed to the wrong month.
 */
export default async function TimePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; from?: string; to?: string; flash?: string; error?: string; invoice?: string }>;
}) {
  const actor = await requireActor();
  // Time is a desk-wide ledger; a requester has no business seeing it.
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = first(params.from) || periodStart(today);
  const to = first(params.to) || today;
  // No filter and "every client" are the same view, so the form's own default is
  // what a bare `/time` shows — and a redirect back to the ledger cannot land on
  // a filter that matches nothing.
  const selection = first(params.client) || "all";

  // "all" is the whole scope; "desk" is the work with no client on it, which is
  // still billable — it is the desk's own time rather than a client's.
  const filters = selection === "all" ? {} : { clientId: selection === "desk" ? null : selection };

  const service = timeServicesFor();
  const [clients, ledger, split, invoices, cards] = await Promise.all([
    clientServicesFor().list(actor),
    service.entries(actor, { ...filters, from, to }),
    service.split(actor, { ...filters, from, to }),
    service.invoices(actor),
    service.rateCards(actor),
  ]);

  const entries = ledger.ok ? ledger.value : [];
  const totals = split.ok
    ? split.value
    : { entries: 0, minutes: 0, billableMinutes: 0, nonBillableMinutes: 0, billedMinutes: 0, amountCents: 0, currency: null, unpriced: 0, billablePercent: null };
  const scope = clients.ok ? clients.value.map((entry) => entry.client) : [];
  const invoiceRef = first(params.invoice);
  const canBill = hasPermission(actor.role, "queue:manage");
  const names = new Map(scope.map((client) => [client.id, client.name]));
  const cardOf = (clientId: string | null) => cards.ok ? cards.value.find((card) => card.clientId === clientId) : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Time</h1>
        <p className="text-sm text-ink-soft">
          Hours worked, what they are worth, and the invoices issued against them. {totals.entries} entr
          {totals.entries === 1 ? "y" : "ies"} in {from} → {to}.
        </p>
      </div>

      {first(params.flash) ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{first(params.flash)}</p>
      ) : null}
      {first(params.error) ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {first(params.error)}
        </p>
      ) : null}
      {invoiceRef ? (
        <p className="text-sm text-ink-soft">
          <a
            href={`/time/export?ref=${encodeURIComponent(invoiceRef)}`}
            className="font-semibold text-brand hover:underline"
          >
            Download {invoiceRef} as CSV
          </a>
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-line bg-surface p-4" method="get">
        <label className="text-sm font-medium text-ink">
          Client
          <select name="client" defaultValue={selection} className={`block ${inputClass}`}>
            <option value="all">every client in scope</option>
            <option value="desk">the desk (no client)</option>
            {scope.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-ink">
          From
          <input name="from" type="date" defaultValue={from} className={`block ${inputClass}`} />
        </label>
        <label className="text-sm font-medium text-ink">
          To
          <input name="to" type="date" defaultValue={to} className={`block ${inputClass}`} />
        </label>
        <button type="submit" className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-soft">
          Show period
        </button>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl2 border border-line bg-surface p-4">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Logged</p>
          <p className="mt-1 font-display text-2xl font-semibold text-ink">{formatLoggedMinutes(totals.minutes)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {formatLoggedMinutes(totals.nonBillableMinutes)} not chargeable
          </p>
        </div>
        <div className="rounded-xl2 border border-line bg-surface p-4">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Billable share</p>
          <p className="mt-1 font-display text-2xl font-semibold text-ink">{percent(totals.billablePercent)}</p>
          <p className="mt-1 text-xs text-ink-faint">{formatLoggedMinutes(totals.billableMinutes)} chargeable</p>
        </div>
        <div className="rounded-xl2 border border-line bg-surface p-4">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Billable value</p>
          <p className="mt-1 font-display text-2xl font-semibold text-ink">{formatMoney(totals.amountCents, totals.currency)}</p>
          <p className="mt-1 text-xs text-ink-faint">{formatLoggedMinutes(totals.billedMinutes)} as billed (after rounding)</p>
        </div>
        <div className="rounded-xl2 border border-line bg-surface p-4">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Unpriced</p>
          <p className="mt-1 font-display text-2xl font-semibold text-ink">{totals.unpriced}</p>
          <p className="mt-1 text-xs text-ink-faint">chargeable entries with no rate card</p>
        </div>
      </div>

      {canBill ? (
        <section aria-label="Issue an invoice" className="space-y-2 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold text-ink">Issue an invoice</h2>
          <p className="text-xs text-ink-faint">
            Issues the period on screen for{" "}
            {selection === "all" ? "the desk's own time (no client)" : selection === "desk" ? "the desk" : names.get(selection) ?? selection}
            . Every entry it covers is stamped with the reference and frozen: a correction after that is a credit note, not
            an edit, so the same hour cannot be billed twice.
          </p>
          <form action={issueInvoiceAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="clientId" value={selection === "all" || selection === "desk" ? "" : selection} />
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="to" value={to} />
            <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
              Issue invoice for {from} → {to}
            </button>
          </form>
          {cards.ok && cards.value.length === 0 ? (
            <p className="text-xs text-amber">
              No rate card exists yet, so nothing can be priced. Write one on the client&apos;s page (or the desk&apos;s own)
              first.
            </p>
          ) : null}
        </section>
      ) : null}

      {invoices.ok && invoices.value.length > 0 ? (
        <section aria-label="Issued invoices" className="rounded-xl2 border border-line bg-surface p-5">
          <h2 className="font-display text-sm font-semibold text-ink">Issued invoices</h2>
          <ul className="mt-2 divide-y divide-line">
            {invoices.value.map((invoice) => (
              <li key={invoice.ref} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <a href={`/time/export?ref=${encodeURIComponent(invoice.ref)}`} className="font-mono text-xs font-semibold text-brand hover:underline">
                  {invoice.ref}
                </a>
                <span className="text-ink-soft">
                  {invoice.entries} entr{invoice.entries === 1 ? "y" : "ies"} · {formatMoney(invoice.amountCents, invoice.currency)}
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">issued {invoice.issuedAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Logged time" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">Logged time</h2>
        {entries.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">
            Nothing is logged in this period. Time is logged on the ticket it belongs to.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {entries.map((entry) => {
              const amount = entryAmountCents(entry);
              const home = `/time?client=${encodeURIComponent(selection)}&from=${from}&to=${to}`;
              return (
                <li key={entry.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <time className="font-mono text-[11px] text-ink-faint" dateTime={entry.workDate}>
                      {entry.workDate}
                    </time>
                    {entry.ticketRef ? (
                      <a href={`/inbox/${entry.ticketId}`} className="font-mono text-[11px] font-semibold text-brand hover:underline">
                        {entry.ticketRef}
                      </a>
                    ) : (
                      <span className="text-[11px] text-ink-faint">the desk</span>
                    )}
                    <span className="text-ink-soft">{entry.clientId ? names.get(entry.clientId) ?? entry.clientId : "no client"}</span>
                    <span className="font-semibold text-ink">{formatLoggedMinutes(entry.minutes)}</span>
                    {entry.billedMinutes !== null && entry.billedMinutes !== entry.minutes ? (
                      <span className="text-xs text-ink-faint">billed {formatLoggedMinutes(entry.billedMinutes)}</span>
                    ) : null}
                    <span className={entry.billable ? "text-xs text-teal" : "text-xs text-ink-faint"}>
                      {entry.billable ? (entry.rateCentsPerHour === null ? "unpriced" : formatMoney(amount ?? 0, entry.currency)) : "non-billable"}
                    </span>
                    {entry.invoiceRef ? (
                      <a href={`/time/export?ref=${encodeURIComponent(entry.invoiceRef)}`} className="text-[11px] text-ink-faint hover:text-brand">
                        {entry.invoiceRef}
                      </a>
                    ) : null}
                    {entry.note ? <span className="truncate text-xs text-ink-soft">{entry.note}</span> : null}
                  </div>

                  {entry.invoicedAt === null ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-brand">Correct</summary>
                      <div className="mt-1.5 space-y-1.5">
                        <form action={correctTimeAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="entryId" value={entry.id} />
                          <label className="text-xs text-ink-soft">
                            Minutes
                            <input name="minutes" type="number" min={1} step={1} defaultValue={entry.minutes} className={`block w-20 ${inputClass}`} />
                          </label>
                          <label className="min-w-40 flex-1 text-xs text-ink-soft">
                            Note
                            <input name="note" defaultValue={entry.note ?? ""} className={`block w-full ${inputClass}`} />
                          </label>
                          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-ink-soft">
                            <input name="billable" type="checkbox" defaultChecked={entry.billable} />
                            Chargeable
                          </label>
                          <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                            Save
                          </button>
                        </form>
                        <form action={removeTimeAction}>
                          <input type="hidden" name="entryId" value={entry.id} />
                          <input type="hidden" name="home" value={home} />
                          <button type="submit" className="text-[11px] text-pink hover:underline">
                            Remove this entry
                          </button>
                        </form>
                      </div>
                    </details>
                  ) : (
                    <p className="mt-0.5 text-[11px] text-ink-faint">On {entry.invoiceRef}: frozen. Credit it rather than editing it.</p>
                  )}

                  {cards.ok && entry.billable && entry.rateCentsPerHour === null && cardOf(entry.clientId) ? (
                    <p className="mt-0.5 text-[11px] text-amber">
                      A rate card now covers this client — the entry priced at nothing because none did when it was logged.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
