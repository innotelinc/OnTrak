import type { Metadata } from "next";

import { portalConfig } from "@/lib/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "OnTrak",
  description: "One sign-in for the OnTrak family: training, the desk, identity and estate updates",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = portalConfig();
  return (
    <html lang="en">
      <body>
        <div className="page">
          <header className="masthead">
            <a className="masthead__brand" href="/">
              <strong>OnTrak</strong>
              <span>TrainingOps</span>
            </a>
            <span className="masthead__where faint">{config.baseDomain}</span>
          </header>
          <main>{children}</main>
          <footer className="footer faint">
            <span>
              OnTrak is the TrainingOps platform of the Innotel Labs family —
              training, the desk and the evidence, with one identity layer.
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
