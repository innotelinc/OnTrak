"use client";

/**
 * The theme switch.
 *
 * Two axes, and only one of them is a control people look for: light/dark/system
 * is the switch in the corner, and the *scheme* (desk — the violet family the
 * training range and the desk use; operations — the graphite family the consoles
 * use) is set once by the deployment and remembered per browser. Both are written
 * by `window.OntrakTheme`, which the head snippet has already run, so this
 * component never owns the state — the document does. That is what keeps a page
 * from rendering one theme and then changing its mind.
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
    <div className="theme" role="group" aria-label="Colour theme">
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
        title={scheme === "operations"
          ? "Switch to the desk palette (violet)"
          : "Switch to the operations palette (graphite)"}
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
