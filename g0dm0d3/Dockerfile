# G0DM0D3 — no dependencies, so the image is the runtime and three files.
#
# The app is ESM and reads its page at start-up, so `src/` and `public/` ship
# together; there is nothing to install and nothing to compile.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY package.json ./
COPY src ./src
COPY public ./public

# Nothing here writes to disk, so the process runs as the image's own user.
USER node

EXPOSE 8080

# The same liveness path the family portal probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "src/app.js"]
