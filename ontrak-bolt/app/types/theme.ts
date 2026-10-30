/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PALETTES — Unity's six rendered states, not Bolt's thirty.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream ships a theme shop: `light-solarized`, `dark-dracula`, `dark-matrix`
 * and twenty-seven more, each a block of `--bolt-elements-*` overrides. They were
 * replaced here rather than kept, for two reasons.
 *
 * The first is that a palette is a product decision, and in this family it has
 * already been made: Unity owns the appearance of every Innotel app with two axes,
 * `data-scheme` (desk · operations · soc) and `data-mode` (light · dark). A second
 * opinion in one app is exactly the drift `theme/tests/test_theme_copies.py` exists
 * to stop.
 *
 * The second is honest: `app/styles/unity-bridge.scss` re-points every
 * `--bolt-elements-*` token at a Unity token, so the upstream palettes no longer
 * paint anything. Leaving the list in place would have been a settings grid of
 * thirty swatches that changed nothing — a worse outcome than a shorter list.
 *
 * So the list below is the cross product of the two Unity axes. Picking one sets
 * both: the scheme on `<html>` (through `window.UnityTheme`) and the mode. The
 * `colors` triple is only the swatch the settings and onboarding screens draw
 * (canvas, brand-soft, brand) — it is never used to paint the app.
 */

export const THEMES = [
  { id: 'unity-desk-light', name: 'Desk · light', scheme: 'desk', mode: 'light', colors: ['#f7f6fb', '#ece8ff', '#5f3fe6'] },
  { id: 'unity-desk-dark', name: 'Desk · dark', scheme: 'desk', mode: 'dark', colors: ['#100c22', '#2a2154', '#9b83ff'] },
  {
    id: 'unity-operations-light',
    name: 'Operations · light',
    scheme: 'operations',
    mode: 'light',
    colors: ['#f4f6f8', '#e6f0ff', '#1f6feb'],
  },
  {
    id: 'unity-operations-dark',
    name: 'Operations · dark',
    scheme: 'operations',
    mode: 'dark',
    colors: ['#0b1015', '#16243a', '#2f81f7'],
  },
  { id: 'unity-soc-light', name: 'Security ops · light', scheme: 'soc', mode: 'light', colors: ['#f2f5f9', '#e0edfb', '#0f6fd1'] },
  { id: 'unity-soc-dark', name: 'Security ops · dark', scheme: 'soc', mode: 'dark', colors: ['#04080f', '#0a2c36', '#22c7e0'] },
] as const;

export type Scheme = 'desk' | 'operations' | 'soc';
export type Theme = (typeof THEMES)[number]['id'] | 'dark';
export type ThemeMode = 'light' | 'dark';

/**
 * The mode a palette renders in.
 *
 * Upstream derived this from a `dark-` prefix; the ids here end in the mode, so it
 * is a suffix test. `'dark'` is still accepted: it is a value old browsers have in
 * `localStorage` from before the migration, and `isTheme` admits it, so refusing it
 * here would turn a stored preference into a runtime error.
 */
export function getThemeMode(theme: Theme | string): ThemeMode {
  return theme === 'dark' || theme.endsWith('-dark') || theme.endsWith('dark') ? 'dark' : 'light';
}

/** The scheme a palette belongs to. An unknown id falls back to the family default. */
export function getThemeScheme(theme: Theme | string): Scheme {
  return THEMES.find((entry) => entry.id === theme)?.scheme ?? 'desk';
}

/** The palette for a scheme/mode pair, which is what a scheme switch needs. */
export function themeFor(scheme: Scheme, mode: ThemeMode): Theme {
  const found = THEMES.find((entry) => entry.scheme === scheme && entry.mode === mode);

  return (found?.id ?? 'unity-desk-light') as Theme;
}
