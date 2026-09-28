/**
 * Invoice CSV (M4): the artefact an MSP actually sends.
 *
 * Pure and tested, like the SLA report CSV, and it reuses that file's RFC 4180
 * escaping — a client name with a comma in it has to survive the trip. Two
 * deliberate choices:
 *
 *  - **Money is written as a decimal, never as cents and never formatted.** A
 *    spreadsheet that reads `$1,234.50` is a spreadsheet with a text column; the
 *    currency is its own column so the numbers stay numbers.
 *  - **Hours are written as decimal hours.** Billing systems take `1.25`, not
 *    `1h 15m`, and the minutes-billed column is there for anyone reconciling
 *    against the ledger.
 */

import { csvRow } from "./report-csv";
import type { Invoice } from "./time-rules";

export interface InvoiceCsvOptions {
  generatedAt: string;
  appName?: string;
  /** The name of the client the invoice is for, since the CSV is what they see. */
  clientName?: string;
  /** The name or id of the ticket, when a line has one. */
  ticketRefOf?: (line: Invoice["lines"][number]) => string;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

export function buildInvoiceCsv(invoice: Invoice, options: InvoiceCsvOptions): string {
  const { generatedAt, clientName, appName = "OnTrak Tix" } = options;
  const client = clientName ?? invoice.clientId ?? "the desk";

  const lines: string[] = [
    csvRow([`${appName} invoice ${invoice.ref}`]),
    csvRow(["Client", client]),
    csvRow(["Period", invoice.from ?? "", invoice.to ?? ""]),
    csvRow(["Issued", invoice.issuedAt]),
    csvRow(["Currency", invoice.totals.currency ?? ""]),
    invoice.totals.mixedCurrencies ? csvRow(["Warning", "This invoice mixes currencies."]) : "",
    "",
    csvRow(["Ticket", "Description", "Rate per hour", "Currency", "Billed minutes", "Billed hours", "Amount", "Entries", "Worked by"]),
  ];

  for (const line of invoice.lines) {
    lines.push(
      csvRow([
        options.ticketRefOf ? options.ticketRefOf(line) : line.ticketRef ?? "",
        line.description,
        line.rateCentsPerHour === null ? "" : money(line.rateCentsPerHour),
        line.currency ?? "",
        line.billedMinutes,
        hours(line.billedMinutes),
        money(line.amountCents),
        line.entries,
        line.userIds.join(" "),
      ]),
    );
  }

  lines.push(
    "",
    csvRow(["Total", "", "", invoice.totals.currency ?? "", invoice.totals.billedMinutes, hours(invoice.totals.billedMinutes), money(invoice.totals.amountCents), invoice.totals.entries]),
    "",
    csvRow(["Generated", generatedAt]),
  );

  // What the invoice left out, said on the invoice rather than in a private note:
  // time logged before a rate card existed is the desk's to chase, not the
  // client's to be surprised by.
  if (invoice.skipped.unpriced > 0 || invoice.skipped.alreadyInvoiced > 0) {
    lines.push(
      csvRow([
        "Not billed",
        `${invoice.skipped.unpriced} unbillable (no rate)`,
        `${invoice.skipped.alreadyInvoiced} already invoiced`,
        `${invoice.skipped.nonBillable} not chargeable`,
      ]),
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}
