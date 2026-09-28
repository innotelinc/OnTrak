import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "OnTrak Tix",
  description: "Ticketing and service management for IT desks and MSPs — an Innotel Labs product.",
};

/** The root layout. Styling and the shared component library arrive with the app scaffold. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-muted text-ink antialiased">{children}</body>
    </html>
  );
}
