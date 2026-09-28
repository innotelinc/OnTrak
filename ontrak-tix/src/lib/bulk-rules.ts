/**
 * Bulk action rules (M0/M1): acting on many tickets at once from the inbox.
 *
 * A bulk write is not one transaction — each ticket is still validated against
 * the same lifecycle and access rules as a single edit, and some will be
 * skipped (an illegal transition, a ticket that moved on). So the honest shape
 * is a *summary*: how many applied, and why the rest were skipped. This module
 * is that selection hygiene and summary, kept pure so the behaviour is tested
 * without a browser or a database.
 */

/** A ceiling on one bulk write, so a mistyped select-all cannot run away. */
export const MAX_BULK = 100;

export interface BulkOutcome {
  ticketId: string;
  ok: boolean;
  /** The service's refusal reason, when it did not apply. */
  error?: string;
}

export interface BulkSummary {
  requested: number;
  applied: number;
  skipped: number;
  failures: { ticketId: string; error: string }[];
}

/**
 * Clean a selection: trim, drop empties, de-duplicate (a repeated id would
 * otherwise be applied twice), and cap. Order is preserved so the first-selected
 * ticket is the first attempted.
 */
export function normalizeBulkIds(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_BULK) break;
  }
  return ids;
}

/** Roll per-ticket outcomes into the counts and the first few reasons. */
export function summarizeBulk(outcomes: readonly BulkOutcome[], maxReasons = 3): BulkSummary {
  const failures = outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => ({ ticketId: outcome.ticketId, error: outcome.error ?? "Could not be updated." }));
  return {
    requested: outcomes.length,
    applied: outcomes.filter((outcome) => outcome.ok).length,
    skipped: failures.length,
    failures: failures.slice(0, maxReasons),
  };
}

/** The one-line flash a bulk write redirects with. */
export function bulkFlashMessage(summary: BulkSummary, verb: string): string {
  const head = `${summary.applied} ticket${summary.applied === 1 ? "" : "s"} ${verb}`;
  if (summary.skipped === 0) return head;
  const reason = summary.failures[0]?.error ?? "not permitted";
  return `${head}; ${summary.skipped} skipped (${reason})`;
}
