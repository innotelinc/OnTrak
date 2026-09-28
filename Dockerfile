# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# OnTrak IT Support Training — container image.
#
# Three stages, so the running image carries only what serving needs:
#
#   deps     installs the locked dependency tree once, cached on the lockfile
#   builder  generates the Prisma client and runs Next's production build,
#            which emits the self-contained server at `.next/standalone`
#            (see `output` in next.config.ts). This stage keeps the full
#            dependency tree, so it is also what the one-shot `migrate` and
#            `seed` compose services run in.
#   runner   the image that is actually served: the standalone server, the
#            static assets and the traced Prisma client, as a non-root user.
#
# OnTrak Tix builds the same way from its own Dockerfile. The two are separate
# images on purpose — the products deploy independently.
#
# Build (usually via `docker compose up`, which supplies the args):
#   docker build --target runner -t ontrak-training .
# ═══════════════════════════════════════════════════════════════════════════

FROM node:20-alpine AS base

# Next writes anonymous telemetry unless told not to; a build should be quiet.
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Prisma's query engine links against OpenSSL, which Alpine does not ship by
# default. Without this the client fails at import with a missing-libssl error
# rather than a useful message.
RUN apk add --no-cache openssl

# ── Dependencies ────────────────────────────────────────────────────────────
# Copied alone so the layer only rebuilds when the lockfile actually changes.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ask Next for the self-contained server the runner stage serves (see `output`
# in next.config.ts). Set in this stage rather than `base` so it cannot leak
# into the runtime image.
ENV NEXT_STANDALONE=1

# `next build` inlines NEXT_PUBLIC_* at build time — they are compiled into the
# client bundle, not read at run time, so they must be present *here* or the
# image ships the fallbacks in the source. Compose passes them as build args.
ARG NEXT_PUBLIC_APP_NAME="OnTrak IT Support Training"
ARG NEXT_PUBLIC_ALLOW_SELF_REGISTRATION="true"
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=$NEXT_PUBLIC_ALLOW_SELF_REGISTRATION

# `prisma generate` reads the datasource block, so the variable must exist even
# though nothing connects: the build never opens a connection to this address.
# The real URL arrives at run time, from the environment. Kept as an ARG so a
# deployment mirroring an air-gapped registry can point it somewhere harmless.
ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"
ENV DATABASE_URL=$DATABASE_URL

# Runs the project's own build script (`prisma generate && next build`).
RUN npm run build

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production
# The standalone server reads HOSTNAME/PORT. 0.0.0.0 rather than localhost so
# the port is reachable from outside the container's own loopback.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user. Next's standalone server has no need for root, and an
# uploaded package should never be able to overwrite the application.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# The standalone output inlines the server and its traced dependencies, but not
# these two, which Next deliberately keeps outside it.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Uploaded software packages and image bundles. Compose mounts a named volume
# over `storage/` so a rebuild never discards what a deployment has uploaded;
# creating it here, owned by the app user, is what makes that volume writable.
RUN mkdir -p storage/packages storage/uploads \
 && chown -R nextjs:nodejs storage

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
