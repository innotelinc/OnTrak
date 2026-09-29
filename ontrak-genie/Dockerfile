# --- build ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:22-alpine
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

# `run_command` runs inside this image (compose sets AGENT_SANDBOX=host, since
# this container is already the boundary), so it needs what the workspace itself
# expects: a shell, git for the diff view, ripgrep to search, and python3 for a
# Python project.
RUN apk add --no-cache bash git ripgrep python3 py3-pip \
    && mkdir -p /workspace /data

EXPOSE 3400
CMD ["node", "dist/server.js"]
