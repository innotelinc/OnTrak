import { useStore } from '@nanostores/react';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import xtermStyles from '@xterm/xterm/css/xterm.css?url';
import { useEffect } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, type LinksFunction } from 'react-router';
import { cssTransition, ToastContainer } from 'react-toastify';

import reactToastifyStyles from 'react-toastify/dist/ReactToastify.css?url';
import { ClientOnly } from 'remix-utils/client-only';

import 'virtual:uno.css';

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: '/favicon.svg',
    type: 'image/svg+xml',
  },
  /*
   * Unity's palette, bundled ahead of the app's own stylesheet so the bridge that
   * maps Bolt's tokens onto it (`app/styles/unity-bridge.scss`) resolves. It is the
   * byte-identical copy from the family theme, checked by
   * `theme/tests/test_theme_copies.py`.
   */
  { rel: 'stylesheet', href: unityStyles },
  { rel: 'stylesheet', href: reactToastifyStyles },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  { rel: 'stylesheet', href: xtermStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
  {
    rel: 'preconnect',
    href: 'https://unpkg.com',
  },
  {
    rel: 'dns-prefetch',
    href: 'https://unpkg.com',
  },
];

const inlineThemeCode = stripIndents`
  setTutorialKitTheme();

  function setTutorialKitTheme() {
    try {
      const options = JSON.parse(localStorage.getItem('bolt_interface_options') || '{}');
      const root = document.documentElement;
      root.dataset.accentIntensity = String(typeof options.accentIntensity === 'number' ? options.accentIntensity : 50);
      root.style.setProperty('--interface-accent-strength', String(typeof options.accentIntensity === 'number' ? options.accentIntensity : 50) + '%');
      root.dataset.cornerRadius = ['sharp', 'soft', 'round'].includes(options.cornerRadius) ? options.cornerRadius : 'soft';
      root.dataset.compactMode = String(Boolean(options.compactMode));
      root.dataset.animatedTransitions = String(options.animatedTransitions !== false);
    } catch {}
    /*
     * The mode comes from Unity, which has already run in the head (/unity-theme.js)
     * and has already decided between a stored preference and the machine's. Bolt's
     * own data-theme attribute is only what its dark: utilities are compiled against,
     * so it is set *from* Unity here rather than from Bolt's old palette key: a page
     * that painted dark and then became light once React hydrated is the flash the
     * family theme is built to avoid.
     */
    const unityDark = window.UnityTheme
      ? window.UnityTheme.isDark()
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const mode = unityDark ? 'dark' : 'light';
    document.querySelector('html')?.setAttribute('data-theme', mode);
    document.querySelector('html')?.setAttribute('data-color-theme', mode);
  }
`;

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useStore(themeStore);

  /*
   * Bolt's `data-theme` follows Unity's mode (see `app/theme/unity-sync.ts`), and the
   * store follows the palette — so the editor, the diff viewer and the `dark:`
   * utilities all agree with the colours `unity-bridge.scss` painted. The effect
   * returns the listener's teardown.
   */
  useEffect(() => syncUnityTheme(), []);

  useEffect(() => {
    const mode = getThemeMode(theme);
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.setAttribute('data-color-theme', mode);
  }, [theme]);

  /*
   * The theme script applies saved browser preferences before hydration. Both
   * attributes rendered here say light or dark, because both now mean *mode*: the
   * palette is Unity's (`data-scheme`), not a per-palette name of this app's own.
   */
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={getThemeMode(theme)}
      data-color-theme={getThemeMode(theme)}
      className="w-full h-full"
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/*
          The theme decision, before the first paint: `unity-theme.js` applies the
          stored mode and scheme directly to `<html>` and is loaded blocking, so
          there is no frame in which the app renders in the wrong palette. Both
          attributes it writes are read by `unity-sync.ts` once React hydrates.
        */}
        <script src="/unity-theme.js" />
        <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
      </head>
      <body className="w-full h-full">
        {/*
          The app boots a WebContainer and reads IndexedDB/localStorage, so it is
          genuinely client-only. `ClientOnly` renders `fallback` on the server and
          on the first client render (keeping hydration in sync), then swaps in the
          real tree once mounted.
        */}
        <ClientOnly fallback={<div className="w-full h-full" />}>
          {() => <DndProvider backend={HTML5Backend}>{children}</DndProvider>}
        </ClientOnly>
        <ToastContainer
          closeButton={({ closeToast }) => {
            return (
              <button className="Toastify__close-button" onClick={closeToast}>
                <div className="i-ph:x text-lg" />
              </button>
            );
          }}
          icon={({ type }) => {
            switch (type) {
              case 'success': {
                return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
              }
              case 'error': {
                return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
              }
            }

            return undefined;
          }}
          position="bottom-right"
          pauseOnFocusLoss
          transition={toastAnimation}
          autoClose={3000}
        />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

import { journeys, observeWebVitals } from './lib/performance/metrics';
import { prebootWebContainer } from './lib/performance/webcontainer-optimizer';
import { logStore } from './lib/stores/logs';
import { themeStore } from './lib/stores/theme';
import { syncUnityTheme } from './theme/unity-sync';
import { getThemeMode } from './types/theme';
import unityStyles from './theme/unity-theme.css?url';
import globalStyles from './styles/index.scss?url';
import { stripIndents } from './utils/stripIndent';

export default function App() {
  const theme = useStore(themeStore);

  useEffect(() => {
    // Mark app launch start
    journeys.appLaunch.start();
    journeys.appLaunch.reactHydrated();

    logStore.logSystem('Application initialized', {
      theme,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Start Web Vitals observation
    observeWebVitals();

    // Pre-boot WebContainer in background
    prebootWebContainer();

    // Initialize debug logging with improved error handling
    import('./utils/debugLogger')
      .then(({ debugLogger }) => {
        /*
         * The debug logger initializes itself and starts disabled by default
         * It will only start capturing when enableDebugMode() is called
         */
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });

    // Mark app as interactive
    journeys.appLaunch.interactive({
      theme,
      performance: {
        navigation: performance.getEntriesByType('navigation')[0],
      },
    });
  }, []);

  /*
   * React Router applies the root route's `Layout` export itself, wrapping this
   * component. Rendering `<Layout>` here as well would nest a second
   * `<html>/<head>/<body>` inside the first, which React reports as invalid DOM
   * nesting and duplicate-element mounts. Remix v2 required the explicit wrap;
   * React Router 8 does not.
   */
  return <Outlet />;
}
