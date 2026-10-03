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
# `public/` is where the shared theme's script lives (`unity-theme.js`), served at
# the product root by the adapter. Without this the console's five pages render with
# no stylesheet and no colour switch, and the only sign of it is one warning line in
# the startup log — the CSS copy under `src/theme/` is in the image either way, which
# is exactly what makes the omission easy to miss.
COPY --from=builder --chown=sentinel:sentinel /app/public ./public
# Cerulean Vault (SecretOps): the resolver and the entrypoint that runs it before
# the server boots. The entrypoint runs as root (the image drops to `sentinel`
# after resolving) because this stack's Vault token is only readable by root.
COPY --from=builder --chown=sentinel:sentinel /app/scripts/vault-env.mjs ./scripts/vault-env.mjs
COPY --from=builder --chown=sentinel:sentinel /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# `prisma/` is deliberately not copied: migrations are applied by the `migrate`
# service, which runs in the builder stage, and the generated client needs
# neither the schema nor the migration history to serve a request.

# Where a stack keeps its signing key. Creating it here, owned by the service user,
# is what makes a named volume mounted over it writable by the one-shot `signing-key`
# service and readable by the provider itself — the same reason the other two images
# create their blob and evidence directories.
RUN mkdir -p /run/sentinel && chown sentinel:sentinel /run/sentinel

# The entrypoint runs as root so it can read the root-only Vault token, resolves
# `vault://` values, then drops to `sentinel` (uid 1001) before serving.
ENV VAULT_DROP_UID=1001
EXPOSE 8787
ENTRYPOINT ["./docker-entrypoint.sh"]
# `--import tsx` is the loader form, so this does not depend on the shape of the
# `tsx` bin shim that npm happens to generate.
CMD ["node", "--import", "tsx", "scripts/serve.ts"]
