# --- build ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
# Named, like Portal's and Sync's, because `--target` is how CI and publish
# build the stage that ships — an unnamed final stage cannot be asked for, and
# the build fails rather than quietly producing the wrong thing.
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3400 \
    AGENT_WORKSPACE=/workspace \
    AGENT_DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
# The Vault resolver and the entrypoint that runs it. `scripts/` is otherwise
# dockerignored (see .dockerignore); this is the one file from it the image needs.
COPY scripts/vault-env.mjs ./scripts/vault-env.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# `run_command` runs inside this image (compose sets AGENT_SANDBOX=host, since
# this container is already the boundary), so it carries the toolchain a real
# workspace expects rather than the shell and git the console itself needs. The
# agent is asked to build, test and *run* what it writes — a missing `curl` or
# `make` then looks like a bug in the agent's work rather than a thin image. The
# compilers and `-dev` headers are here for the same reason: without them a
# `pip install` of anything with a C extension, or an `npm install` that falls
# back to node-gyp, fails in a way that reads as the project's fault.
#
# Anything still missing can be installed at run time: this image is Alpine, has
# network, and the container runs as root, so `apk add <pkg>` (or `pip`/`npm`)
# works — the system prompt tells the agent to do exactly that rather than work
# around a missing tool.
RUN apk add --no-cache bash git ripgrep python3 py3-pip \
        curl wget jq make gcc g++ musl-dev python3-dev libffi-dev openssl-dev \
        unzip tar xz ca-certificates openssl \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /workspace /data

EXPOSE 3400
# The entrypoint resolves any `vault://` values (a no-op with none), then execs
# the server — so a reference that cannot be resolved stops the container.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
