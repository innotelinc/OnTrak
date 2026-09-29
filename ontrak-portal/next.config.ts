import path from "node:path";

import type { NextConfig } from "next";

/**
 * `root` and `outputFileTracingRoot` are pinned to this directory because this app
 * lives inside a monorepo that is *itself* a Next.js application. Next infers its
 * workspace root by walking up looking for a lockfile, finds the monorepo's, and
 * starts compiling the monorepo's middleware and resolving the monorepo's PostCSS
 * plugin from inside this build — which fails. Pinning the root keeps the four
 * apps in this repository from reaching into each other.
 *
 * `process.cwd()` is that directory in every way this is run: `npm run build` from
 * the package, and the Dockerfile's `WORKDIR /app`.
 */
const here = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output is for the container image only; `next start` does not
  // support it and warns on every boot, so it is opt-in via the Dockerfile.
  output: process.env.ONTRAK_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  turbopack: { root: here },
  outputFileTracingRoot: here,
  // The portal links out to the family rather than embedding it, and it holds no
  // third-party assets, so there is nothing to allow-list here on purpose.
};

export default nextConfig;
