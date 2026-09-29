import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Metadata } from "next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { portalConfig } from "@/lib/config";

import "./globals.css";

/**
 * OnTrak Unity — the front door.
 *
 * The theme's *decision* is made before the first paint, by the snippet inlined
 * below, and not by React: a theme applied during hydration is a white flash on a
 * dark screen, which is the one detail everybody notices about a dark mode that
 * was added later. The snippet is the shared `theme/ontrak-theme.js`, read from
 * disk at build time so the bytes that run here are the bytes the other products
 * ship — not a hand-copied summary of them.
 */
const themeScript = readFileSync(join(process.cwd(), "src/theme/ontrak-theme.js"), "utf8");

export const metadata: Metadata = {
  title: "OnTrak Unity",
  description: "OnTrak Unity — one sign-in and one front door for the OnTrak products",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = portalConfig();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
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
