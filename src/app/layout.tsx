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
 * Applies the stored color scheme before first paint so the page never
 * flashes the wrong theme.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('ontrak-training-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t===null&&d)){document.documentElement.classList.add('dark')}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The locale lives in a cookie, so the document's language attribute can
  // match the UI the user actually sees rather than being fixed to English.
  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);

  return (
    <html lang={locale} suppressHydrationWarning className={`${outfit.variable} ${jakarta.variable} ${jetbrains.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
