# syntax=docker/dockerfile:1

# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Bolt — container image.
#
# The stages are upstream's (see README.md, *Provenance*), and they are kept
# rather than rewritten because the way a React Router + Vite app is pruned for a
# runtime image is not something to re-invent per fork:
#
#   build             installs from the lockfile, builds SSR (for Node) + client
#   bolt-ai-production the image that is served: build/, node_modules/, the
#                     package manifest, and `pnpm run dockerstart`
#
# WHAT IS DIFFERENT, AND WHY
# --------------------------
#   * The header, the image's default port and the healthcheck are the family's
#     business, not upstream's: 3500 is the port this product reserves beside Genie
#     (3400), Tix (3001), the training range (3000) and Sentinel (8787).
#   * **There is no `pnpm prune --prod` stage.** Upstream has one, and it produces
#     an image that cannot start: `dockerstart` is `vite preview`, and `vite` is a
#     devDependency, so the prune removes the very command the container is told to
#     run — `sh: 1: vite: not found`, then a container that restarts until something
#     notices. `vite preview` also loads `vite.config.ts`, whose imports
#     (`@vitejs/plugin-react`, the cloudflare plugin) are devDependencies too, so
#     keeping only `vite` would still fail one step later. The image therefore keeps
#     the full dependency tree: bigger, and the only version that serves. Fixing it
#     properly means moving the build toolchain into `dependencies`, which changes
#     the lockfile and is a fork of upstream's manifest — not a Dockerfile edit.
#   * It runs as root, deliberately. `corepack prepare pnpm` runs in the build
#     stage as root and lands the shim in `/root/.cache/node/corepack`; dropping to
#     `node` here would make corepack fetch pnpm again at *runtime*, from a network
#     the deployment may not give it — a container that starts and then fails to
#     run the command it was built for. The app writes nothing to disk: projects
#     live in the browser (IndexedDB) and in the WebContainer, so there is no
#     volume for a non-root user to own. The trade is stated rather than hidden.
#
# Build (usually via `docker compose up`):
#   cd ontrak-bolt && docker build --target bolt-ai-production -t innotel/ontrak-bolt:main .
# ═══════════════════════════════════════════════════════════════════════════

# ---- build stage ----
# Node 24, not upstream's 22: the family declares one major in every package's
# `engines.node` (`tests/node-version-check.test.ts` refuses two), and the deploy
# compares each container's `node -v` against the package that built it. A product on
# its own major is the one container where a runtime-only failure shows up first.
FROM node:24-bookworm-slim AS build
WORKDIR /app

# CI-friendly env
ENV HUSKY=0
ENV CI=true

# Use pnpm
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Ensure git is available for build and runtime scripts
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Accept (optional) build-time public URL for Remix/Vite (Coolify can pass it)
ARG VITE_PUBLIC_APP_URL
ENV VITE_PUBLIC_APP_URL=${VITE_PUBLIC_APP_URL}

# Build the SSR bundle for Node, not for workerd.
#
# Without this the image starts and serves a page, and every server route that reads
# its own configuration answers from an empty `process.env` — see the note in
# `vite.config.ts`. `BUILD_TARGET=node` drops the Cloudflare plugin for this build
# only, which is what makes `OPENAI_LIKE_API_KEY` from the container's environment
# mean anything.
ENV BUILD_TARGET=node

# Install deps efficiently
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch

# Copy source and build
COPY . .
# install with dev deps (needed to build)
RUN pnpm install --offline --frozen-lockfile

# Build the Remix app (SSR + client)
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- production stage ----
#
# `FROM build` rather than from a pruned copy, deliberately: see the note on the
# prune in this file's header. Pruning here removes `vite`, which is what the
# container runs.
FROM build AS bolt-ai-production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173
ENV HOST=0.0.0.0

# Non-sensitive build arguments
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX

# Set non-sensitive environment variables
ENV WRANGLER_SEND_METRICS=false \
    VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX} \
    RUNNING_IN_DOCKER=true

# Model credentials are injected at runtime (see `.env.example`): this app talks to
# the estate's gateway through `OPENAI_LIKE_API_BASE_URL` and `OPENAI_LIKE_API_KEY`,
# and no key is ever baked into the image.

# Install curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Copy built files
COPY --from=build /app/build /app/build
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/wrangler.jsonc /app/wrangler.jsonc

# The boot-time steps that give the worker the deployment's model settings — see
# `docker-entrypoint.sh`. The resolver is the family's, copied from Genie so the
# `vault://` grammar has one implementation; the renderer is what puts the result
# where a Worker build can read it. Without either, the container is configured and
# the app can see none of it.
COPY --from=build /app/scripts/render-worker-vars.mjs /app/scripts/render-worker-vars.mjs
COPY --from=build /app/scripts/vault-env.mjs /app/scripts/vault-env.mjs
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

# Pre-configure wrangler to disable metrics
RUN mkdir -p /root/.config/.wrangler && \
    echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json

EXPOSE 5173

# Healthcheck for deployment platforms
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:5173/ || exit 1

# Render the worker's bindings from the environment, then serve.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "run", "dockerstart"]
