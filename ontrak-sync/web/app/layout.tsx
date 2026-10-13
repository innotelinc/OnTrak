import type { Metadata } from "next";

import { Shell } from "@/components/Shell";
import { familyDomain } from "@/lib/family";
import { SessionProvider } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: "OnTrak Sync",
  description: "Package and container update monitoring across the Network",
};

/**
 * The root layout.
 *
 * The theme's *decision* is made before the first paint and not by React: a theme
 * applied during hydration is a white flash on a dark screen, which is the one
 * detail everybody notices about a dark mode that was added later. `/unity-theme.js`
 * is a plain `public/` asset loaded by a blocking `<script src>` — blocking on
 * purpose, because that is what makes it run before the first paint — and it is a
 * byte-identical copy of the canonical `theme/unity-theme.js` (checked by
 * `make theme`).
 *
 * The family's own address is read here, once, and handed to the shell: the shell
 * draws the masthead that prints it, and that masthead is a client component which
 * cannot read a server-side variable without disagreeing with the server's markup.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scheme="operations" suppressHydrationWarning>
      <head>
        {/* This app is a console, so its house scheme is the graphite one; a person
            can still switch, and the choice is remembered per browser. */}
        <script
          dangerouslySetInnerHTML={{ __html: 'window.UNITY_DEFAULT_SCHEME = "operations";' }}
        />
        <script src="/unity-theme.js" />
      </head>
      <body>
        {/* The provider is inside `<body>` and outside the shell on purpose: the
            shell needs the identity to decide whether to draw itself at all, and
            the login page has to be able to sign somebody in without it. */}
        <SessionProvider>
          <Shell domain={familyDomain()}>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
