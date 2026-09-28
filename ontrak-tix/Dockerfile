# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Tix — container image.
#
# Three stages, so the running image carries only what serving needs:
#
#   deps     installs the locked dependency tree once, cached on the lockfile
#   builder  generates the Prisma client and runs Next's production build,
#            which emits the self-contained server at `.next/standalone`
#            (see `output` in next.config.ts). This stage keeps the full
#            dependency tree, so it is also what the one-shot `migrate` and
#            `seed` compose services run in — Tix is schema-first, so
#            "migrate" here means `prisma db push`.
#   runner   the image that is actually served: the standalone server, the
#            static assets and the traced Prisma client, as a non-root user.
#
# Build (usually via `docker compose up`):
#   cd ontrak-tix && docker build --target runner -t ontrak-tix .
# ═══════════════════════════════════════════════════════════════════════════

FROM node:20-alpine AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Prisma's query engine links against OpenSSL, which Alpine does not ship by
# default. Without this the client fails at import with a missing-libssl error
# rather than a useful message.
RUN apk add --no-cache openssl

# ── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Tix ships no `public/` directory yet, and Next only copies one if it exists —
# so create it, or the runner's COPY below has nothing to copy. It also means a
# static asset added later is served without anyone having to remember this
# Dockerfile.
RUN mkdir -p public

# Ask Next for the self-contained server the runner stage serves (see `output`
# in next.config.ts). Set in this stage rather than `base` so it cannot leak
# into the runtime image.
ENV NEXT_STANDALONE=1

# Tix has no NEXT_PUBLIC_* configuration, so the build needs no build args
# beyond this one. `prisma generate` reads the datasource block, so the
# variable must exist even though nothing connects: the build never opens a
# connection to this address. The real URL arrives at run time.
ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
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

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Attachment bytes and incident evidence. Both are written at run time, and the
# evidence directory sits under object-lock retention, so compose mounts a
# named volume over each one — losing either on a rebuild would lose records a
# deployment is obliged to keep. Creating them here, owned by the app user, is
# what makes those volumes writable.
RUN mkdir -p .ontrak-tix-blobs .ontrak-tix-evidence \
 && chown -R nextjs:nodejs .ontrak-tix-blobs .ontrak-tix-evidence

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
