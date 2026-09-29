# Ontrak Sync dashboard.
#
# Three stages: dependencies are cached separately so editing a page does not
# reinstall node_modules; the build runs with the API base baked in, because Next
# inlines `NEXT_PUBLIC_*` at build time and discovering that at runtime produces a
# dashboard that talks to localhost.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The default is the address the API is published on inside the compose network, so
# the shipped image works without the operator knowing to set anything.
ARG NEXT_PUBLIC_ONTRAK_API=http://localhost:8420
ENV NEXT_PUBLIC_ONTRAK_API=$NEXT_PUBLIC_ONTRAK_API
ENV ONTRAK_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8421
# HOSTNAME has to be set here. Next's standalone server binds to `$HOSTNAME`, and
# Docker sets that variable to the container ID, so leaving it unset makes the
# server listen on a name that resolves to the container's own address — reachable
# through the published port, but refused from `127.0.0.1`. The healthcheck probes
# loopback, so without this line the container starts cleanly and then reports
# unhealthy forever. The official Next image pins it for the same reason.
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8421
CMD ["node", "server.js"]
