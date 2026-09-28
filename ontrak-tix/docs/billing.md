# Time, rates and invoices

An MSP is paid for hours, so M4 adds the part a ticket system usually leaves to a
spreadsheet: what was worked, what it is worth, and what has already been
invoiced. This guide covers the ledger, the rate cards that price it, and the
invoice that cannot be issued twice.

## The model

| Model | What it is |
| --- | --- |
| `RateCard` | a price: a currency, an hourly rate in **cents**, and the rounding the desk bills in. `clientId` null is the desk's own default card |
| `TimeEntry` | an hour (or minute) of work: which ticket, which client, who, which day, how many minutes, chargeable or not — plus **the price it was logged at** |

The rules are pure in [`src/lib/time-rules.ts`](../src/lib/time-rules.ts); the
service is [`src/lib/time-service.ts`](../src/lib/time-service.ts) with its Prisma
adapter in [`src/lib/time-store-prisma.ts`](../src/lib/time-store-prisma.ts); the
CSV is [`src/lib/invoice-csv.ts`](../src/lib/invoice-csv.ts). The console is
[`/time`](../src/app/(desk)/time/page.tsx), and time is logged where the work is
— on the ticket itself.

## The price is written down, not looked up

Logging an entry resolves the rate **once** and stores the answer on the row: the
minutes charged, the rate in cents, the rounding that produced them, and the
currency. Everything else follows from that:

- A card that changes in March cannot restate what February cost.
- A card that is **deleted** cannot turn last quarter's invoice into a guess.
- A correction — the desk typed 20 minutes and meant 40 — re-derives the charge
  from the entry's own snapshot, not from today's card.

The rate ladder has two rungs, because a price with four rungs of precedence is a
price nobody can predict: the **client's own card**, then the **desk's default**.
The resolution reports which rung won, in the same shape as the SLA ladder
("the client's own rate card: Northwind agreed").

**Rounding is a contract term, not a display detail.** `incrementMinutes` is 0
(exact), 1, 5, 6, 10, 15, 30 or 60, and each *entry* is rounded up once to that
increment. Three 20-minute visits on a 15-minute increment bill 90 minutes,
because each visit is a separate charge the client can see — and the invoice total
is the sum of those charges, never a rate applied to a summed pile of minutes, so
the invoice and the ledger can never disagree.

Billable work with **no card** still logs. It carries no rate, so the invoice
leaves it off and the ledger counts it under *unpriced*: an hour the desk forgot
to price is a problem to fix, not a discount nobody mentioned.

## Who may do what

| Act | Needs |
| --- | --- |
| Log time, correct or remove your own | `ticket:update` |
| Correct or remove somebody else's | `ticket:update` **and** `queue:manage` |
| Write a rate card, issue an invoice | `queue:manage` |
| Read the ledger | `ticket:read:any`, scoped by the client scope |

Time is scoped like the worklist: an agent cannot log hours against a client they
do not serve, whether they named the client or reached it through a ticket id
they guessed. Work with **no client** is the desk's own time — visible to every
agent and billable, just not to a client.

## Issuing an invoice is two steps, on purpose

1. **POST `/time` → "Issue invoice for …".** The service gathers the uninvoiced,
   billable entries for the period, groups them into lines (one per ticket, rate
   and currency), **stamps every entry with the reference**, and writes the totals
   to the audit chain (`time.invoice.export`). It refuses when there is nothing to
   bill, so a stray click cannot put a reference on the record.
2. **GET `/time/export?ref=…`.** A *read* of what step 1 recorded. Following the
   link twice — from an email, a bookmark, a colleague — cannot bill anything
   again, because the download does not decide anything.

An entry on an issued invoice is **frozen**: the service refuses to change it or
remove it, and says so in the words the remedy needs — *"That time is on invoice
INV-20260920-9C1F3A. Issue a credit note instead of changing it."* A correction to
something already billed is a credit note because that is what it is; a desk that
can quietly edit an invoice cannot answer a client who kept a copy.

The CSV writes money as a decimal with the currency in its own column (never
`$1,234.50`, which a spreadsheet reads as text), hours as decimal hours, and names
the people who did the work on each line — an invoice line that names the labour
is a defensible one. It also states what it left out, so the desk can chase the
unpriced hours rather than the client having to ask.

## Tax

A `TaxRule` is a label and a rate in **basis points** (8.25% is `825`), owned by
a client or by the desk — field-for-field the same shape as a rate card, because
the two resolve the same way and one of them having a different notion of "the
desk's default" would be a bug waiting to be written.

Two properties matter:

1. **Tax is charged on the labour subtotal, not line by line.** The tax on an
   invoice is the rate applied once, so the arithmetic a client checks on the page
   is the arithmetic that produced it.
2. **The rate is snapshotted onto the entries it priced** (`taxCents`,
   `taxRateBasisPoints`) at the moment the invoice is issued. A rate changed in
   April cannot restate what March was charged, and `issued()` reports the rate
   that produced the invoice rather than today's rule. That is why a `TaxRule`
   can simply be edited, with no versioning of its own.

A rate above 100% is refused as a typo, and a zero rate is *a rate* — an exempt
client is charged nothing on the record, which is a different thing from a client
with no rule at all.

## Credit notes

An issued invoice is history: its entries are frozen and a correction is not an
edit. A mistake is therefore corrected with a `CreditNote` — new money moving,
with a reference of its own (`CN-YYYYMMDD-XXXXXX`), the invoice it answers, an
amount, a reason, and the actor who issued it.

The refusal is the feature:

- **A credit may not exceed what the invoice still owes.** The ceiling is what is
  *left*, not the whole invoice, so partial credits work — and the same money
  cannot be credited twice, because the sum of prior notes is taken before the
  decision.
- **A credit needs a reason somebody can read back**, at least a sentence.

`issued(ref)` returns the invoice *and* its standing — charged, credited,
outstanding — so the ledger never shows a total that ignores what has already
been given back.

## Retainers

A `Retainer` is money a client paid up front for a period. Invoices issued inside
that period draw on it, and what each entry drew is recorded on the entry
(`retainerId`) rather than on a running balance.

The balance is therefore always **derived**: funded minus what the entries
carrying the retainer's id have drawn. A stored counter would be a second copy of
the ledger, and the second copy is the one that goes stale.

- A retainer is money in **one currency**, so it only absorbs invoices
  denominated in it.
- **One retainer per client per period**: a second for the same window is refused,
  because two balances for one period is a question with two answers.
- When a retainer runs out, the rest of the invoice stays payable, and the invoice
  says which part the retainer covered.

## Currencies

**One invoice per currency.** Entries are grouped by the currency they were
priced in and each group is issued its own document with its own reference. A
period that spans two currencies therefore produces two invoices for one client —
said out loud when it happens, rather than collapsed into a total nobody can pay.

- Each line carries its currency, and `invoiceTotals().mixedCurrencies` is a guard
  now rather than a supported state.
- `invoice({ …, currency })` issues one document for one currency, for a desk that
  bills them separately.
- The CSV states `Subtotal`, then `Tax` (with its rate), then `Amount due`, in
  that order, as decimals — never one number that hides which of the three it is.

## What is not here yet

- **Tax, discounts and credit notes.** An invoice is a statement of hours and
  rates. VAT/sales tax, retainers, prepaid blocks and the credit note itself are
  not modelled; the audit event and the frozen entries are the hooks a real
  accounting layer would use.
- **One tax line per invoice.** Tax is charged on the labour subtotal by a
  single rule (a client's own, or the desk's default). Two jurisdictions on one
  invoice, or tax that differs per line, needs per-line tax codes — and this
  deliberately does not guess at them.
- **No partial credit on a single line.** A credit note is an amount against an
  invoice; it does not name which line was wrong, so reconciling a credit back to
  its line is a reader's job rather than the record's.
- **A retainer does not stop at the invoice.** When a retainer is exhausted the
  rest of an invoice is payable, which the invoice says — but there is no
  "draw from the retainer first and top it up automatically" behaviour, and no
  expiry that returns an unspent balance to the ledger.
- **Approval and budgeting.** Nobody approves a timesheet, and there is no
  per-client budget or hours cap to bill against.
- **Sync with an accounting system.** The export is a CSV a person sends; there is
  no push to an invoicing product, and no reconciliation back from one.
- **Non-billable reasons.** A non-billable entry records that it was not charged
  and why in words; there is no taxonomy to report on ("warranty", "goodwill",
  "internal").
