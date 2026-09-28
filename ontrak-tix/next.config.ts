import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Prisma ships native binaries that must not be bundled.
  serverExternalPackages: ["@prisma/client"],
  experimental: {
    serverActions: {
      // Evidence artifacts are uploaded through a server action, and Next's
      // default cap is 1 MB — well under the size of a log bundle or a screen
      // recording. This is the framework's ceiling for the whole body, so it is
      // set to the largest artifact the service will accept
      // (`EVIDENCE_ARTIFACT_MAX_BYTES` in `object-lock-rules.ts`); anything above
      // it is refused by the service, with a message that says so.
      bodySizeLimit: "64mb",
    },
  },
};

export default nextConfig;
