"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_LOCALE, translate, type Locale } from "./i18n";
import { messagesFor } from "./locales";

/**
 * Client-side translations.
 *
 * Server components get their translator from `i18n-server.ts`, but a client
 * component cannot read a cookie. A server component wraps the subtree in
 * `LocaleProvider` with the resolved locale, and the client component calls
 * `useTranslator()`. The dictionaries are shared, so both sides use the exact
 * same keys.
 */

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export type ClientTranslator = (key: string, vars?: Record<string, string | number>) => string;

export function useTranslator(): ClientTranslator {
  const locale = useContext(LocaleContext);
  return useMemo(() => {
    const messages = messagesFor(locale);
    return (key, vars) => translate(messages, key, vars);
  }, [locale]);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
