import type { Metadata } from "next";

import { Shell } from "@/components/Shell";
import { SessionProvider } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: "Ontrak Sync",
  description: "Package and container update monitoring for the Innotel estate",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* The provider is inside `<body>` and outside the shell on purpose: the
            shell needs the identity to decide whether to draw itself at all, and
            the login page has to be able to sign somebody in without it. */}
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
