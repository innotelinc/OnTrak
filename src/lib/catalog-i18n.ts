/**
 * The catalogue's own copy, in more than one language (2.3).
 *
 * The interface has a dictionary and a scenario has an overlay; the catalogue card is the
 * third kind of text, because it is staff-written metadata stored in columns rather than in
 * a definition. Until 2.3 those columns were English-only, so a Spanish cohort read a
 * translated console under an English title.
 *
 * Two decisions, both the same as the scenario overlay's:
 *
 *   1. **Fallback is per field, not per row.** A scenario with a translated summary but no
 *      translated title reads as a mixture rather than a blank line — and a blank title is
 *      worse than an English one.
 *   2. **A blank string is not a translation.** Whitespace falls back, so a half-finished
 *      translation cannot erase copy the authored column still holds.
 *
 * There is one non-default locale, so the columns are named for it (`titleEs`, `summaryEs`)
 * rather than a locale-keyed table; a second language is a migration and a branch here, not
 * a different shape.
 */

import { resolveLocale } from "./i18n";

/** The columns a catalogue card is drawn from. */
export interface CatalogTextColumns {
  title: string;
  summary: string;
  titleEs?: string | null;
  summaryEs?: string | null;
}

export interface CatalogText {
  title: string;
  summary: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The card's copy as a reader of `locale` should see it.
 *
 * English (and any locale without its own column) returns the authored columns, even on a
 * row whose Spanish columns are filled.
 */
export function catalogText(row: CatalogTextColumns, locale: string): CatalogText {
  if (resolveLocale(locale) !== "es") return { title: row.title, summary: row.summary };
  return {
    title: text(row.titleEs) ?? row.title,
    summary: text(row.summaryEs) ?? row.summary,
  };
}
