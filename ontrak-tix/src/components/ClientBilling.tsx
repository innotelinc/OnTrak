/**
 * Client branding, tax and retainer authoring (M4).
 *
 * Three presentational forms, each one owning a single client-scoped fact:
 *
 *  - **Branding** — the name, colour, logo and voice a client is shown in. The
 *    colour is offered as a colour input *and* a hex field, because the rule that
 *    matters is not "is it pretty" but "can it be read", and the console says
 *    which of those two the current value fails.
 *  - **Tax** — a label and a rate, per client or for the desk. One rule per
 *    owner, so this saves rather than accumulates.
 *  - **Retainer** — money paid up front for a period. The balance is shown
 *    beside it, derived from the invoices that have drawn on it.
 *
 * Nothing here decides anything: the permission, the validation and the balance
 * are the service's.
 */

import { MIN_ACCENT_CONTRAST, type ClientBrandingRecord } from "../lib/client-branding-rules";
import { formatRate, type TaxRuleRecord } from "../lib/billing-rules";

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-2 py-1 text-xs text-ink";

export function BrandingForm({
  action,
  clientId,
  clientName,
  branding,
}: {
  action: (formData: FormData) => Promise<void>;
  clientId: string;
  clientName: string;
  branding?: ClientBrandingRecord;
}) {
  return (
    <details className="rounded-xl2 border border-line/70 bg-surface-muted/40 p-2.5">
      <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
        {branding
          ? `Branding: ${branding.displayName} in ${branding.accentColor}`
          : `Branding: ${clientName} is shown as the desk — give them their own`}
      </summary>
      <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="clientId" value={clientId} />
        <label className="text-xs text-ink-soft">
          Shown as
          <input name="displayName" required defaultValue={branding?.displayName ?? clientName} className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Accent colour
          <input
            name="accentColor"
            required
            pattern="#[0-9a-fA-F]{6}"
            placeholder="#3aa0ff"
            defaultValue={branding?.accentColor ?? "#3aa0ff"}
            className={`block w-24 font-mono ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Reply-to address
          <input
            name="supportEmail"
            type="email"
            defaultValue={branding?.supportEmail ?? ""}
            placeholder="their-service-desk@example.com"
            className={`block ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Logo URL (https or a data: image)
          <input name="logoUrl" defaultValue={branding?.logoUrl ?? ""} placeholder="https://…/logo.svg" className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Signature on their notices
          <textarea
            name="signature"
            rows={2}
            defaultValue={branding?.signature ?? ""}
            className={`block w-72 ${inputClass}`}
          />
        </label>
        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
          {branding ? "Save branding" : "Set branding"}
        </button>
      </form>
      <p className="mt-1 text-[11px] text-ink-faint">
        A colour has to stay readable on the portal background — at least {MIN_ACCENT_CONTRAST}:1 — and a logo has to be an image
        the page can render, never a URL it has to trust.
      </p>
    </details>
  );
}

export function TaxRuleForm({
  action,
  removeAction,
  clientId = null,
  rule,
}: {
  action: (formData: FormData) => Promise<void>;
  removeAction?: (formData: FormData) => Promise<void>;
  clientId?: string | null;
  rule?: TaxRuleRecord;
}) {
  return (
    <div className="space-y-1.5 rounded-xl2 border border-line/70 bg-surface-muted/40 p-2.5">
      <p className="text-[11px] font-semibold text-ink-soft">
        {rule
          ? `Tax: ${rule.label} at ${formatRate(rule.rateBasisPoints)}`
          : clientId
            ? "No tax rule of their own; the desk's default applies."
            : "No default tax rule."}
      </p>
      <form action={action} className="flex flex-wrap items-end gap-2">
        {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
        <label className="text-xs text-ink-soft">
          Label
          <input name="label" required defaultValue={rule?.label ?? ""} placeholder="e.g. State sales tax" className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Rate (%)
          <input
            name="ratePercent"
            type="number"
            min={0}
            max={100}
            step="0.01"
            required
            defaultValue={rule ? (rule.rateBasisPoints / 100).toFixed(2) : ""}
            placeholder="8.25"
            className={`block w-20 ${inputClass}`}
          />
        </label>
        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
          {rule ? "Save tax rule" : "Set tax rule"}
        </button>
      </form>
      {rule && removeAction ? (
        <form action={removeAction}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <button type="submit" className="text-[11px] text-pink hover:underline">
            Remove this tax rule
          </button>
        </form>
      ) : null}
    </div>
  );
}

export function RetainerForm({
  action,
  clientId,
  currency,
}: {
  action: (formData: FormData) => Promise<void>;
  clientId: string;
  currency: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = new Date(Date.parse(`${today.slice(0, 4)}-12-31T00:00:00.000Z`)).toISOString().slice(0, 10);

  return (
    <details className="rounded-xl2 border border-line/70 bg-surface-muted/40 p-2.5">
      <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
        Retainers — money paid up front, drawn down by the invoices inside the period
      </summary>
      <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="clientId" value={clientId} />
        <label className="text-xs text-ink-soft">
          Funded
          <input name="funded" type="number" min={0} step="0.01" required placeholder="5000.00" className={`block w-24 ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Currency
          <input name="currency" required maxLength={3} defaultValue={currency} className={`block w-16 uppercase ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          From
          <input name="periodStart" type="date" required defaultValue={today} className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          To
          <input name="periodEnd" type="date" required defaultValue={yearEnd} className={`block ${inputClass}`} />
        </label>
        <label className="text-xs text-ink-soft">
          Note
          <input name="note" placeholder="e.g. Q4 pre-paid block" className={`block ${inputClass}`} />
        </label>
        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
          Record retainer
        </button>
      </form>
      <p className="mt-1 text-[11px] text-ink-faint">
        A retainer in one currency only draws down invoices in that currency, and the balance is always derived from the ledger
        rather than stored — so it cannot drift from the invoices it describes.
      </p>
    </details>
  );
}
