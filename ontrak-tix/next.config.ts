import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The container build asks for a self-contained server (`.next/standalone`)
  // so the image needs only the files serving actually uses, not the whole
  // dependency tree. It is opt-in because that server also requires
  // `.next/static` and `public/` to be copied *inside* it — which the Dockerfile
  // does and a checkout does not, so running it from source would serve pages
  // without their assets. Not set, the build is byte-for-byte what it was.
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  // Tix lives inside the training app's repository, so Next would otherwise
  // walk up, find that package.json and treat it as the workspace root —
  // nesting the standalone server under `.next/standalone/ontrak-tix/` and
  // making the layout depend on the build context. Pinning tracing to this
  // directory keeps the output at `.next/standalone/server.js` whether the
  // build runs here, from the repo root, or inside the container.
  outputFileTracingRoot: path.join(__dirname),
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
