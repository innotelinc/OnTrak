import type { Metadata } from "next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { portalConfig } from "@/lib/config";
import { readSession } from "@/lib/session";

import "./globals.css";

/**
 * OnTrak Unity — the front door.
 *
 * The theme's *decision* is made before the first paint and not by React: a theme
 * applied during hydration is a white flash on a dark screen, which is the one
 * detail everybody notices about a dark mode that was added later.
 *
 * The script is `/unity-theme.js`, a plain `public/` asset loaded by a blocking
 * `<script src>` — blocking on purpose, because that is what makes it run before
 * the first paint. It is a byte-identical copy of the canonical
 * `theme/unity-theme.js` (checked by `make theme`), served from `public/` because
 * the runtime image is Next's standalone output, which contains no `src/`: a
 * `readFileSync` against the source tree works in development and throws ENOENT in
 * the container, which is exactly the bug this comment exists to prevent.
 */

export const metadata: Metadata = {
  title: "OnTrak Unity",
  description: "OnTrak Unity — one sign-in and one front door for the OnTrak products",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const config = portalConfig();
  // Read here rather than in each page so the masthead can always answer the two
  // questions a person asks when a permission looks wrong: "who does it think I am"
  // and "can I make it look again". The role shown is the re-derived one — see
  // `withCurrentRole` in `session.ts`.
  const session = await readSession();
  return (
    <html lang="en" data-scheme="operations" suppressHydrationWarning>
      <head>
        {/*
          The default *before* the shared script runs: this app is a console, so
          its house scheme is the graphite one. A product that prefers the desk's
          violet sets `desk` here and changes nothing else.
        */}
        <script
          dangerouslySetInnerHTML={{ __html: 'window.UNITY_DEFAULT_SCHEME = "operations";' }}
        />
        <script src="/unity-theme.js" />
      </head>
      <body>
        <div className="page">
          <header className="masthead">
            <a className="masthead__brand" href="/">
              <strong>OnTrak Unity</strong>
              <span>{config.baseDomain}</span>
            </a>
            <div className="masthead__tools">
              {session ? (
                <span className="masthead__account">
                  <span className="masthead__who">{session.email}</span>
                  <span className="ot-pill">{session.role}</span>
                </span>
              ) : null}
              {session ? (
                // A group membership change is the one thing the portal cannot work
                // out on its own, and the only place it lives is the provider. So
                // this re-runs the same handshake — no second mechanism, and no
                // password, because the provider's own session is still there.
                <a
                  className="masthead__link"
                  href={`/api/sso/start?next=${encodeURIComponent("/")}`}
                  title="Ask the provider for your groups again. Use this after being added to a group."
                >
                  Refresh permissions
                </a>
              ) : null}
              <ThemeToggle />
            </div>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>OnTrak Unity</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
