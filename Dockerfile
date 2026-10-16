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
#
# `setpriv` is the util-linux one, deliberately shadowing BusyBox's applet of the
# same name: the entrypoint drops from root to `VAULT_DROP_UID` with
# `setpriv --reuid= --regid= --init-groups`, and BusyBox's setpriv has no uid/gid
# options at all (capabilities only), so it exits 1 with
# `unrecognized option: reuid=1001` and every container fails to start. The
# package is named `setpriv`, not `util-linux-misc`.
RUN apk add --no-cache openssl setpriv

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

# The gids that own the host's Incus socket (`incus-admin`, 988) and `/dev/kvm`
# (`kvm`, 993), declared here *as well as* in compose's `group_add`, for one
# reason: the entrypoint resolves its Vault secrets as root and then
# `setpriv --init-groups` drops to `nextjs`, and that step recomputes the
# supplementary groups from this file. A group added only by Docker is therefore
# discarded at exactly the moment the server starts — the process ends up unable
# to open the daemon socket or KVM, which reads as `hypervisor: false` with no
# explanation. Naming them here is what makes the membership survive the drop.
#
# The second is called `host-kvm` and not `kvm` because the Alpine base already
# has a `kvm` group at gid 34; only the *gid* is checked against the device, so a
# distinct name carrying the host's 993 is what shares `/dev/kvm`.
RUN addgroup --system --gid 988 incus-admin \
 && addgroup --system --gid 993 host-kvm \
 && addgroup nextjs incus-admin \
 && addgroup nextjs host-kvm

# The lab's control plane drives a hypervisor by running the `incus` CLI
# (`src/lib/lab/incus.ts` spawns it, and `IncusClient.available()` probes it), so
# the client has to exist in this image. The *client* alone is what is needed, as it
# runs no daemon of its own. A single-host deployment reaches the daemon over the
# unix socket compose mounts at `/var/lib/incus/unix.socket`; pointed at a remote —
# which is what this deployment does, via `ONTRAK_INCUS__REMOTE` — it needs the
# client's *trust* configuration instead, which compose mounts read-only. Without the
# binary the lab opens reporting `hypervisor: false` and refuses to start a machine.
RUN apk add --no-cache incus-client

# The standalone output inlines the server and its traced dependencies, but not
# these two, which Next deliberately keeps outside it.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The ported lab's shipped data: the scenario catalogue, the lesson library and
# the site settings, as JSON under `src/lib/lab/data/`. `dataset.ts` reads them
# from `process.cwd()` at runtime (`shippedDataDir`), and Next's standalone output
# keeps nothing outside `.next/` — so without this copy the lab opens and then
# reports `ENOENT ... /app/src/lib/lab/data/catalog.json`. These are data, not
# code: the app imports no module from this directory, which is exactly why the
# tracer cannot see it and it has to be named here.
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/lab/data ./src/lib/lab/data
# Cerulean Vault (SecretOps): the resolver and the entrypoint that runs it before
# the server boots. The entrypoint runs as root (the image drops to `nextjs`
# after resolving) because this stack's Vault token is only readable by root.
COPY scripts/vault-env.mjs ./scripts/vault-env.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Uploaded software packages and image bundles. Compose mounts a named volume
# over `storage/` so a rebuild never discards what a deployment has uploaded;
# creating it here, owned by the app user, is what makes that volume writable.
RUN mkdir -p storage/packages storage/uploads \
 && chown -R nextjs:nodejs storage

# HOME has to be set alongside the drop, because `setpriv` changes the uid, the gid
# and the supplementary groups and leaves HOME exactly as it found it — and Docker
# hands a container that starts as root HOME=/root. So the service ran as uid 1001
# with HOME=/root, which it cannot read, and for the lab that is fatal rather than
# cosmetic: the `incus` client loads `$HOME/.config/incus/config.yml` before it does
# anything else, so *every* call — `IncusClient.available()`'s `incus --version`
# probe included — exited 1 with
#   Failed to load configuration: ... /root/.config/incus/config.yml: permission denied
# The lab then opened reporting `hypervisor: false` and refused every machine, on a
# host whose Incus daemon was answering normally. Pointing HOME at the service
# account's own home (which `adduser` above created, owned by `nextjs`) is the fix.
ENV HOME=/home/nextjs
# The entrypoint runs as root so it can read the root-only Vault token, resolves
# `vault://` values, then drops to `nextjs` (uid 1001) before serving.
ENV VAULT_DROP_UID=1001
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
