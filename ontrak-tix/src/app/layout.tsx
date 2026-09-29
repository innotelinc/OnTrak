import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "OnTrak Tix",
  description: "Ticketing and service management for IT desks and MSPs — an Innotel Labs product.",
};

/**
 * The root layout.
 *
 * The theme's *decision* is made before the first paint and not by React: a theme
 * applied during hydration is a white flash on a dark screen, which is the one
 * detail everybody notices about a dark mode that was added later.
 *
 * `/unity-theme.js` is a plain `public/` asset loaded by a blocking `<script src>`
 * — blocking on purpose, because that is what makes it run before the first paint.
 * It is a byte-identical copy of the canonical `theme/unity-theme.js` (checked by
 * `make theme`), served from `public/` because the runtime image is Next's
 * standalone output, which contains no `src/`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scheme="desk" suppressHydrationWarning>
      <head>
        {/* The default *before* the shared script runs: the desk's house scheme is
            the violet one, so a fresh browser lands on the palette Tix has always
            used and a person can still switch to the operations palette. */}
        <script
          dangerouslySetInnerHTML={{ __html: 'window.UNITY_DEFAULT_SCHEME = "desk";' }}
        />
        <script src="/unity-theme.js" />
      </head>
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
