import type { Metadata } from "next";

import { Shell } from "@/components/Shell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Ontrak Sync",
  description: "Package and container update monitoring for the Innotel estate",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
