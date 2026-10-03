# OnTrak Portal — the family's front door.
#
# Two stages, so editing a page does not reinstall node_modules. There is no
# database and no migration step: the portal stores nothing, which is the whole
# reason it is safe to restart at any moment.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV ONTRAK_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
# Nothing is baked in from the environment on purpose: every address this portal
# uses (the base domain, its own public URL, the provider, the sibling products) is
# read at RUNTIME. A portal whose tiles are decided at build time is a portal you
# cannot move between `ontrak.innotel.us` and a lab domain without rebuilding —
# and unlike the dashboard's API address, none of these have to be inlined into the
# client bundle, because every page here renders on the server.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3300
# HOSTNAME has to be set here. Next's standalone server binds to `$HOSTNAME`, and
# Docker sets that variable to the container ID, so leaving it unset makes the
# server listen on a name that resolves to the container's own address — reachable
# through the published port, but refused from `127.0.0.1`, where the healthcheck
# probes. The container would start cleanly and then report unhealthy forever.
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Cerulean Vault (SecretOps): the resolver and the entrypoint that runs it before
# the server boots, so `vault://` values in .env are plain values by the time
# Node reads them. `scripts/` is otherwise copied only where needed.
COPY scripts/vault-env.mjs ./scripts/vault-env.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3300
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
