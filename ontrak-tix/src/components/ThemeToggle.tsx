"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OnTrak — the theme switch.  THE canonical copy.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every product ships this byte-identical as `src/components/ThemeToggle.tsx`
 * (the copies are checked by `theme/tests/test_theme_copies.py`), together with
 * `ontrak-theme.css` and `ontrak-theme.js`. A switch that looks or behaves
 * differently in one product than in the next is the kind of drift the family
 * theme exists to prevent, and it is the easiest kind to introduce by hand.
 *
 * TWO AXES, ONE CONTROL PEOPLE LOOK FOR.
 *
 *   light / dark / system   the switch in the corner — what everyone means by
 *                           "dark mode".
 *   scheme                  `desk` (violet — the desk and the training range) or
 *                           `operations` (graphite — the consoles). Set once by
 *                           the deployment, remembered per browser, and switched
 *                           here too because an operator may genuinely prefer one.
 *
 * The state does not live in React. It lives on the document, written by
 * `window.OntrakTheme`, which the head snippet has *already* run before this
 * component hydrates. Reading from the document is what stops a page from
 * rendering one theme and then changing its mind a frame later — the visible
 * flash that makes a late dark mode worse than none. So this component only ever
 * *reflects* the document and *asks* the document to change.
 */

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";

interface ThemeApi {
  mode: () => Mode;
  scheme: () => string;
  setMode: (mode: Mode) => Mode;
  setScheme: (scheme: string) => string;
  cycle: () => Mode;
}

declare global {
  interface Window {
    OntrakTheme?: ThemeApi;
  }
}

const LABELS: Record<Mode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [scheme, setScheme] = useState<string>("");

  useEffect(() => {
    const api = window.OntrakTheme;
    if (!api) return;
    setMode(api.mode());
    setScheme(api.scheme());
    const onChange = () => {
      setMode(api.mode());
      setScheme(api.scheme());
    };
    // The script fires this when the preference changes in another tab (or from a
    // second control on the same page), so the switch never shows a stale state.
    window.addEventListener("ontrak:theme", onChange);
    return () => window.removeEventListener("ontrak:theme", onChange);
  }, []);

  // Before hydration there is no state to render, and rendering a guess would
  // either flash or disagree with the document. The switch appears one frame late
  // and never wrong.
  if (mode === null) return null;

  const choose = (next: Mode) => {
    window.OntrakTheme?.setMode(next);
    setMode(next);
  };

  return (
    <div className="ot-theme" role="group" aria-label="Colour theme">
      {(Object.keys(LABELS) as Mode[]).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={mode === key}
          title={key === "system" ? "Follow this computer's setting" : `${LABELS[key]} theme`}
          onClick={() => choose(key)}
        >
          <Icon mode={key} />
          {LABELS[key]}
        </button>
      ))}
      <button
        type="button"
        title={
          scheme === "operations"
            ? "Switch to the desk palette (violet)"
            : "Switch to the operations palette (graphite)"
        }
        onClick={() => {
          const next = window.OntrakTheme?.setScheme(scheme === "operations" ? "desk" : "operations");
          if (next) setScheme(next);
        }}
      >
        {scheme === "operations" ? "Operations" : "Desk"}
      </button>
    </div>
  );
}

function Icon({ mode }: { mode: Mode }) {
  if (mode === "light") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
         strokeLinecap="round" aria-hidden="true">
      <rect x="2.6" y="4" width="18.8" height="13" rx="2" />
      <path d="M8.5 20.4h7" />
    </svg>
  );
}
