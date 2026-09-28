import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

/**
 * Dev-only cross-origin allowlist.
 *
 * Next dev rejects requests whose Origin is not the local host, which makes
 * server actions fail with "Failed to fetch" when the app is opened from a LAN
 * address or a tunnel. Rather than hardcode one machine's IP, this detects the
 * host's non-internal IPv4 addresses at config load and always allows localhost.
 *
 * Override with a comma-separated `ONTRAK_ALLOWED_DEV_ORIGINS` when the app is
 * reached through a name that is not one of those addresses (a tunnel host, for
 * example). This has no effect in production.
 */
function detectedDevOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) origins.add(iface.address);
    }
  }
  return [...origins];
}

const configuredOrigins = (process.env.ONTRAK_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The container build asks for a self-contained server (`.next/standalone`)
  // so the image needs only the files serving actually uses, not the whole
  // dependency tree. It is opt-in because that server also requires
  // `.next/static` and `public/` to be copied *inside* it — which the Dockerfile
  // does and a checkout does not, so running it from source would serve pages
  // without their assets. Not set, the build is byte-for-byte what it was.
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  allowedDevOrigins: configuredOrigins.length > 0 ? configuredOrigins : detectedDevOrigins(),
  experimental: {
    // Scenario definitions and attempt snapshots are JSON blobs; allow generous bodies.
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
