import path from "node:path";

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

const nextConfig: NextConfig = {
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
