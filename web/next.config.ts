import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output is for the container image only. `next start` (what
  // `npm run dev`/`make` use locally) does not support it and warns on every boot,
  // so it stays off unless the Dockerfile asks for it via ONTRAK_STANDALONE=1.
  output: process.env.ONTRAK_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
};

export default nextConfig;
