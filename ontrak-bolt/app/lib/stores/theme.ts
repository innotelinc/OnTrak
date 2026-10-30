import { atom } from 'nanostores';
import { logStore } from './logs';
import { getThemeMode, getThemeScheme, THEMES, themeFor, type Scheme, type Theme, type ThemeMode } from '~/types/theme';

export type { Theme } from '~/types/theme';

export const kTheme = 'bolt_theme';

export function themeIsDark() {
  return getThemeMode(themeStore.get()) === 'dark';
}

export const DEFAULT_THEME = 'unity-desk-light';

export const themeStore = atom<Theme>(initStore());

function isTheme(value: string | null): value is Theme | 'dark' {
  return value === 'dark' || THEMES.some(({ id }) => id === value);
}

/**
 * What the document already says, which is what Unity decided before React started.
 *
 * `public/unity-theme.js` runs in the head, so `data-scheme` and `data-mode` are
 * final by the time this module is evaluated. Reading them is what keeps the first
 * render on the palette the page is already painted in — the same reason Unity's own
 * switch reads the document rather than a React state.
 *
 * A stored Bolt palette still wins, so the settings screen's choice survives a
 * reload. A value stored before the migration (`dark-dracula`, `light-solarized`)
 * is not a palette any more; it contributes only its mode, which is dropped onto the
 * document's scheme — a dark preference is a preference, a retired palette is not.
 */
function initStore(): Theme {
  if (import.meta.env.SSR) {
    return DEFAULT_THEME;
  }

  const root = document.querySelector('html');
  const scheme = (root?.getAttribute('data-scheme') as Scheme | null) ?? 'desk';
  const storedTheme = localStorage.getItem(kTheme);

  if (isTheme(storedTheme)) {
    return storedTheme === 'dark' ? themeFor(scheme, 'dark') : storedTheme;
  }

  const mode: ThemeMode =
    root?.getAttribute('data-mode') === 'dark' ||
    (!root?.getAttribute('data-mode') && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark'
      : 'light';

  return themeFor(scheme, mode);
}

/**
 * Ask Unity to change, then follow it.
 *
 * Unity is the one owner of the two axes, so a palette chosen here is applied by
 * calling `window.UnityTheme` and letting the `unity:theme` event come back — see
 * `app/theme/unity-sync.ts`. `data-theme` (Bolt's own attribute, which its `dark:`
 * variants are compiled against) is set here as well so it is right in the same
 * frame as the palette, not one event later.
 */
export function setTheme(newTheme: Theme | 'dark') {
  const mode = getThemeMode(newTheme);
  const scheme = getThemeScheme(newTheme);

  themeStore.set(newTheme);

  localStorage.setItem(kTheme, newTheme);
  localStorage.setItem(`bolt_theme_${mode}`, newTheme);

  const root = document.querySelector('html');
  root?.setAttribute('data-theme', mode);
  root?.setAttribute('data-color-theme', mode);

  try {
    window.UnityTheme?.setMode(mode);
    window.UnityTheme?.setScheme(scheme);
  } catch (error) {
    /* A blocked origin or an older page: the palette above still applies. */
  }

  // Update user profile if it exists
  try {
    const userProfile = localStorage.getItem('bolt_user_profile');

    if (userProfile) {
      const profile = JSON.parse(userProfile);
      profile.theme = newTheme;
      localStorage.setItem('bolt_user_profile', JSON.stringify(profile));
    }
  } catch (error) {
    console.error('Error updating user profile theme:', error);
  }

  logStore.logSystem(`Theme changed to ${newTheme}`);
}

/** light ↔ dark, on the scheme that is already on screen. */
export function toggleTheme() {
  const current = themeStore.get();
  const scheme = getThemeScheme(current);
  const targetMode: ThemeMode = getThemeMode(current) === 'dark' ? 'light' : 'dark';

  setTheme(themeFor(scheme, targetMode));
}
