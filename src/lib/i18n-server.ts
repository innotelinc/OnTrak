import "server-only";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, translate, type Locale } from "./i18n";
import { messagesFor } from "./locales";

/**
 * Server-side locale helpers. Server components and server actions cannot use
 * the client hooks, so these read the locale cookie once and hand back a bound
 * translator. Keeping the lookup here avoids every page re-implementing it.
 */

/** The active locale for the current request. */
export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** A translator bound to the active locale. */
export async function getTranslator(): Promise<Translator> {
  const messages = messagesFor(await currentLocale());
  return (key, vars) => translate(messages, key, vars);
}
