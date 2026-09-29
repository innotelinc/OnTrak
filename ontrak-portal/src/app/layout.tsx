import type { Metadata } from "next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { portalConfig } from "@/lib/config";

import "./globals.css";

/**
 * OnTrak Unity — the front door.
 *
 * The theme's *decision* is made before the first paint and not by React: a theme
 * applied during hydration is a white flash on a dark screen, which is the one
 * detail everybody notices about a dark mode that was added later.
 *
 * The script is `/ontrak-theme.js`, a plain `public/` asset loaded by a blocking
 * `<script src>` — blocking on purpose, because that is what makes it run before
 * the first paint. It is a byte-identical copy of the canonical
 * `theme/ontrak-theme.js` (checked by `make theme`), served from `public/` because
 * the runtime image is Next's standalone output, which contains no `src/`: a
 * `readFileSync` against the source tree works in development and throws ENOENT in
 * the container, which is exactly the bug this comment exists to prevent.
 */

export const metadata: Metadata = {
  title: "OnTrak Unity",
  description: "OnTrak Unity — one sign-in and one front door for the OnTrak products",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = portalConfig();
  return (
    <html lang="en" data-scheme="operations" suppressHydrationWarning>
      <head>
        {/*
          The default *before* the shared script runs: this app is a console, so
          its house scheme is the graphite one. A product that prefers the desk's
          violet sets `desk` here and changes nothing else.
        */}
        <script
          dangerouslySetInnerHTML={{ __html: 'window.ONTRAK_DEFAULT_SCHEME = "operations";' }}
        />
        <script src="/ontrak-theme.js" />
      </head>
      <body>
        <div className="page">
          <header className="masthead">
            <a className="masthead__brand" href="/">
              <strong>OnTrak Unity</strong>
              <span>{config.baseDomain}</span>
            </a>
            <div className="masthead__tools">
              <ThemeToggle />
            </div>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>OnTrak Unity · Innotel Labs</span>
            <span>One identity, every product.</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
