import type { Locale } from "../i18n";
import { en, type MessageKey, type Messages } from "./en";
import { es } from "./es";

const DICTIONARIES: Record<Locale, Messages> = { en, es };

/** The dictionary for a locale. */
export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

export { en, es };
export type { MessageKey, Messages };
