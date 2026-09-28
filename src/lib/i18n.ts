/**
 * A small, dependency-free translation layer.
 *
 * The app is not fully localised yet; this is the groundwork. Messages live in
 * `src/lib/locales/*` as plain dictionaries of `key -> template`, and the
 * active locale is stored in a cookie. Everything here is pure and synchronous,
 * so it works in server components, client components and tests alike.
 *
 * Templates may interpolate `{name}` placeholders.
 */

export type Locale = "en" | "es";

export const LOCALES: readonly Locale[] = ["en", "es"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "ontrak_locale";

/** Human label for a locale, shown in its own language. */
export function localeLabel(locale: Locale): string {
  switch (locale) {
    case "es":
      return "Español";
    case "en":
    default:
      return "English";
  }
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Coerce any stored/query value to a supported locale, defaulting to English. */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Replace `{key}` placeholders, leaving unknown ones visible rather than blank. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * Translate a key. A missing key returns the key itself (so gaps are obvious in
 * the UI rather than silently empty), which also makes the function total and
 * safe to call with dynamic keys.
 */
export function translate(
  messages: Record<string, string>,
  key: string,
  vars?: Record<string, string | number>,
): string {
  return interpolate(messages[key] ?? key, vars);
}
