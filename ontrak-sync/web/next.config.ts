import path from "node:path";
import { networkInterfaces } from "node:os";

import type { NextConfig } from "next";

/**
 * Ontrak Sync — Next configuration.
 *
 * `root` and `outputFileTracingRoot` are pinned to this directory, and that is a
 * consequence of where the app lives rather than a preference. This package is
 * now `ontrak/ontrak-sync/web` — inside the OnTrak monorepo, which is itself a
 * Next.js application with its own `postcss.config.mjs`, `src/middleware.ts` and
 * `package-lock.json`. Next infers its workspace root by walking *up* looking for
 * a lockfile, found the monorepo's, and started compiling the monorepo's
 * middleware and resolving the monorepo's PostCSS plugin from inside this build —
 * which fails, and would have failed just as loudly in the image.
 *
 * Pinning the root to the directory Next is actually serving keeps the two apps
 * from reaching into each other. `process.cwd()` is that directory in every way
 * this is run (`npm run build` from `web/`, and the Dockerfile's `WORKDIR /app`),
 * and a config file that has to know its own absolute path should get it from the
 * process rather than from `import.meta`, which the config loader transpiles.
 */
const here = path.resolve(process.cwd());

/**
 * Dev-only cross-origin allowlist.
 *
 * This one line is why the dashboard's hot-reload socket works. Next 16 gates every
 * dev request that carries an `Origin` through this list, and a WebSocket handshake
 * *always* carries one — so with no list configured the HMR socket at `/_next/hmr`
 * answers `Unauthorized`, Chromium reports `ERR_INVALID_HTTP_RESPONSE`, and the
 * console fills with a failed handshake and a reconnect every second while the page
 * itself quietly keeps working. The socket is also what a dev server is *for*: without
 * it every edit means a manual reload, and the failing handshake is the first thing a
 * reader of the console sees.
 *
 * The default is the host's own non-internal IPv4 addresses plus loopback, because the
 * dashboard is reached from a LAN address as often as from the machine it runs on —
 * `localhost` alone is not the same host as `127.0.0.1` to this check, which is exactly
 * how the Playwright default address hits the refusal. Override with a comma-separated
 * `ONTRAK_ALLOWED_DEV_ORIGINS` when the app is reached through a name that is neither
 * (a tunnel host, for example). This has no effect in production.
 */
function detectedDevOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
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
  allowedDevOrigins: configuredOrigins.length > 0 ? configuredOrigins : detectedDevOrigins(),
  reactStrictMode: true,
  // Standalone output is for the container image only. `next start` (what
  // `npm run dev`/`make` use locally) does not support it and warns on every boot,
  // so it stays off unless the Dockerfile asks for it via ONTRAK_STANDALONE=1.
  output: process.env.ONTRAK_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  turbopack: { root: here },
  outputFileTracingRoot: here,
};

export default nextConfig;
