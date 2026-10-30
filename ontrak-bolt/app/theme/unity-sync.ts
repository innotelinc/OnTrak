/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The one place Bolt listens to Unity.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unity's switch (`app/components/ThemeToggle.tsx`) writes `data-mode` and
 * `data-scheme` on `<html>` and fires `unity:theme`. The palette follows on its own
 * — `app/styles/unity-bridge.scss` points every Bolt token at a Unity token — but
 * two things do not:
 *
 *   `data-theme`       Bolt's own light/dark attribute, which its `dark:` utilities
 *                      are compiled against (`uno.config.ts`). It has to move with
 *                      the mode or half the app keeps the old one.
 *   the theme store    the editor and diff viewer ask `getThemeMode(themeStore)` for
 *                      a syntax theme, so a stale store is a light editor in a dark
 *                      window.
 *
 * This module is the bridge for both, and it is deliberately one-way: it reacts to
 * Unity and never asks it to change. The other direction lives in
 * `app/lib/stores/theme.ts`, where picking a palette calls `window.UnityTheme` — so
 * there is exactly one owner of the appearance (Unity) and no event loop between
 * the two.
 */

import { themeStore } from '~/lib/stores/theme';
import { themeFor, type Scheme, type ThemeMode } from '~/types/theme';

/**
 * The part of the theme API this module uses.
 *
 * It is read through a cast rather than by augmenting `Window`: the canonical
 * `ThemeToggle` already declares that global, and a second module declaring it again
 * with a narrower shape is a type error in TypeScript — which is exactly the kind of
 * thing that would push somebody to edit the one file that has to stay byte-identical.
 */
interface ThemeApi {
  scheme: () => string;
  isDark: () => boolean;
}

function themeApi(): ThemeApi | undefined {
  return (window as unknown as { UnityTheme?: ThemeApi }).UnityTheme;
}

/**
 * Read what Unity has decided and put the document and the store in step.
 *
 * Returns a teardown function, so it can be called from an effect. On the server —
 * and in the frame before the script has run — it is a no-op rather than a guess:
 * a wrong first paint is the flash the family theme exists to avoid.
 */
export function syncUnityTheme(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const apply = () => {
    const unity = themeApi();
    const root = document.documentElement;

    if (!unity) {
      return;
    }

    const scheme = unity.scheme() as Scheme;
    const mode: ThemeMode = unity.isDark() ? 'dark' : 'light';

    root.setAttribute('data-theme', mode);
    root.setAttribute('data-color-theme', mode);

    const next = themeFor(scheme, mode);

    if (themeStore.get() !== next) {
      themeStore.set(next);
    }
  };

  apply();
  window.addEventListener('unity:theme', apply);

  return () => window.removeEventListener('unity:theme', apply);
}
