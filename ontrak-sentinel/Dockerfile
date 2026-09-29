# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Sentinel — container image.
#
# Three stages, matching the other two products:
#
#   deps     installs the locked dependency tree once, cached on the lockfile
#   builder  generates the Prisma client and applies nothing — it is also the
#            stage the one-shot `migrate` compose service runs in, because it is
#            the one carrying the Prisma CLI and the `prisma/migrations/` tree
#   runner   the image that is actually served: the service, the source it is
#            compiled from, and the generated client, as a non-root user
#
# Sentinel differs from the other two in one way that shapes this file: it is a
# plain TypeScript service with no bundler and no Next.js build step, so there is
# nothing that emits a self-contained server to copy. It runs its own source
# through `tsx`, which is also what a developer runs and what the test suite
# imports from — so the image serves the code that was tested rather than a
# separate compilation of it. `tsc` here is a typechecker (`noEmit`), not a
# compiler, and its imports are extensionless, which Node's own ESM loader
# cannot resolve without adding `.js` to every import in the tree. That is why
# the runner keeps the dependency tree instead of a pruned one.
#
# Build (usually via `docker compose up`):
#   cd ontrak-sentinel && docker build --target runner -t ontrak-sentinel .
# ═══════════════════════════════════════════════════════════════════════════

FROM node:20-alpine AS base

WORKDIR /app

# Prisma's query engine links against OpenSSL, which Alpine does not ship by
# default. Without this the client fails at import with a missing-libssl error
# rather than a useful message.
RUN apk add --no-cache openssl

# ── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── Generate ────────────────────────────────────────────────────────────────
# The closest thing Sentinel has to a build. `prisma generate` reads the
# datasource block, so the variable must exist even though nothing connects: this
# stage never opens a connection to this address. The real URL arrives at run
# time. Generated here — on Alpine — so the engine it fetches is the musl one the
# runner needs.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV DATABASE_URL=$DATABASE_URL
RUN npx prisma generate

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production

# The service reads its own names, not Next's PORT/HOSTNAME. The host in
# particular has to be 0.0.0.0: the default is 127.0.0.1, which inside a
# container is the container's own loopback and would make the provider
# unreachable from anywhere else.
ENV SENTINEL_HOST=0.0.0.0
ENV SENTINEL_PORT=8787

RUN addgroup --system --gid 1001 sentinel \
 && adduser --system --uid 1001 sentinel

# `node_modules` comes from the builder rather than `deps` for one reason: it is
# where `prisma generate` wrote the client and its query engine.
COPY --from=builder --chown=sentinel:sentinel /app/node_modules ./node_modules
COPY --from=builder --chown=sentinel:sentinel /app/package.json ./package.json
COPY --from=builder --chown=sentinel:sentinel /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=sentinel:sentinel /app/src ./src
COPY --from=builder --chown=sentinel:sentinel /app/scripts ./scripts

# `prisma/` is deliberately not copied: migrations are applied by the `migrate`
# service, which runs in the builder stage, and the generated client needs
# neither the schema nor the migration history to serve a request.

USER sentinel
EXPOSE 8787

# `--import tsx` is the loader form, so this does not depend on the shape of the
# `tsx` bin shim that npm happens to generate.
CMD ["node", "--import", "tsx", "scripts/serve.ts"]
