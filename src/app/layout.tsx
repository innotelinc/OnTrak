import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-code",
  display: "swap",
});

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "OnTrak IT Support Training";

export const metadata: Metadata = {
  title: {
    default: `${appName} — hands-on IT support training`,
    template: `%s · ${appName}`,
  },
  description:
    "An open source platform for practicing real IT support work: graded Linux, Windows and Office scenarios in the browser, timed and completed on any device.",
  applicationName: appName,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: appName,
    statusBarStyle: "default",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5ff" },
    { media: "(prefers-color-scheme: dark)", color: "#100c22" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

/**
 * The theme is applied before the first paint by `/unity-theme.js`, a plain
 * `public/` asset loaded by a blocking `<script src>`. Blocking is the point: a
 * theme decided during hydration is a white flash on a dark screen, which is the
 * one detail everybody notices about a dark mode that was added later.
 *
 * The range used to carry its own inline snippet and its own localStorage key; it
 * now ships the shared script byte-for-byte (`make theme` proves it), so a person's
 * light/dark choice follows them across every OnTrak product instead of being
 * relearned in each one.
 */

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The locale lives in a cookie, so the document's language attribute can
  // match the UI the user actually sees rather than being fixed to English.
  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);

  return (
    <html
      lang={locale}
      data-scheme="desk"
      suppressHydrationWarning
      className={`${outfit.variable} ${jakarta.variable} ${jetbrains.variable}`}
    >
      <head>
        {/* The default *before* the shared script runs: the range is a learning
            product, so its house scheme is the violet desk one. */}
        <script
          dangerouslySetInnerHTML={{ __html: 'window.UNITY_DEFAULT_SCHEME = "desk";' }}
        />
        <script src="/unity-theme.js" />
      </head>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
