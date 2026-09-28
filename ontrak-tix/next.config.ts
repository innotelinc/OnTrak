import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Prisma ships native binaries that must not be bundled.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
