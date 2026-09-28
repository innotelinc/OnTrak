"use client";

import { usePathname } from "next/navigation";
import { setLocale } from "@/app/actions/locale";
import { LOCALES, localeLabel, type Locale } from "@/lib/i18n";

/** Language switch. Submits on change; works without client JS via the fallback button. */
export function LocaleToggle({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname();

  return (
    <form action={setLocale} className="flex items-center">
      <input type="hidden" name="back" value={pathname ?? "/"} />
      <label htmlFor="locale-select" className="sr-only">
        {label}
      </label>
      <select
        id="locale-select"
        name="locale"
        defaultValue={locale}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="rounded-full border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition hover:text-brand"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {localeLabel(option)}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="ml-1 text-xs font-semibold text-brand">
          Go
        </button>
      </noscript>
    </form>
  );
}
