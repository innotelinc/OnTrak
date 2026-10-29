# --- build ---
FROM node:24-alpine AS build
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
FROM node:24-alpine AS runtime
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

# `genie` on PATH.
#
# The package has declared this binary since 0.3.0 (`"bin": {"genie":
# "dist/cli/main.js"}`), but nothing installs the package's own bin links:
# `npm ci` installs *dependencies*, and the image copies `dist/` in by hand. So
# the CLI existed, ran, and could not be invoked by the name every document and
# the RE portal use. One symlink makes the declared interface real.
RUN chmod +x dist/cli/main.js && ln -sf /app/dist/cli/main.js /usr/local/bin/genie
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
# around a missing tool.  # `fuse3` + `sshfs` + `openssh-client` + `sshpass` are what a **remote folder**
  # needs: the mount is an `sshfs` mount, so it needs the `sshfs` binary, the
  # `fusermount3` helper that comes with `fuse3`, the `ssh` it runs underneath, and
  # `sshpass` for the password case (`sshfsCommand` passes the secret through
  # `SSHPASS` rather than the command line). Installed here rather than left to the
  # run-time `apk add` above, because a container that is recreated loses whatever
  # was installed into its writable layer — a mounted folder would then fail as
  # "sshfs: not found" on a deployment that had been working.
  RUN apk add --no-cache bash git ripgrep python3 py3-pip \
          curl wget jq make gcc g++ musl-dev python3-dev libffi-dev openssl-dev \
          unzip tar xz ca-certificates openssl \
          fuse3 sshfs openssh-client sshpass \
      && chmod +x /app/docker-entrypoint.sh \
      && mkdir -p /workspace /data

# --- REA (reverse engineering), and the MCP server it registers -------------
#
# The console speaks MCP (see `src/mcp.ts`), and REA is the first server it has: a
# reverse-engineering toolkit whose 200-odd tools let a turn answer questions about
# a *shipped* artifact — a binary, an Electron app, an APK, firmware — instead of
# only about source it already has.
#
# Everything needed is installed here rather than at run time, for the reason the
# sshfs block below gives: this image is recreated on every deploy, and a container
# that lost its `rea` on the way would look like a broken skill. That includes the
# prerequisites REA checks for itself:
#
#   * `procps` — REA refuses to launch an analysis child unless `ps -axo` works,
#     which is how it verifies process ownership on Linux. Alpine's busybox `ps`
#     does not accept `-axo`, so without this every native launch is refused with a
#     capability error that reads like a missing engine;
#   * a **full JDK** — Ghidra is Java, and REA checks for the JDK rather than the
#     runtime: its headless pipeline wants the development tools that ship with it.
#     `jre-headless` is smaller and was measured to fail that check with
#     "accepted a 64-bit full JDK 21 or newer", which is a provider that looks
#     installed and then refuses every native launch.
#
# `gcompat` (with `libstdc++`) is what makes Ghidra's decompiler run here at all:
# the helper binaries it ships are linked against glibc, and on Alpine's musl their
# loader is missing — the failure reads "Exec failed, error: 2 (No such file or
# directory)" for a file that plainly exists. Measured: without these, Ghidra
# imports a binary and then every decompile fails; with them, the same import
# decompiles.
RUN apk add --no-cache procps openjdk21-jdk gcompat libstdc++
# Named explicitly as well as found on PATH: a process started with a scrubbed
# environment (a sandbox, a service manager) finds `java` by this variable or not
# at all, and REA treats a missing one as an unusable Ghidra.
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk

# The analyser itself, and the two things that make its installation *count*:
#
#   * its bundled skill is copied where the entrypoint seeds deployment skills from,
#     so `reverse-engineer-anything` is available to every account with nothing to
#     install — and it is copied from the *installed package*, so it always matches
#     the version pinned here;
#   * `/root/.agents/mcp.json` is the shared path the agent ecosystem writes MCP
#     registrations to, and the path this console reads (`MCP_CONFIG_PATHS`). Seeding
#     it in the image means a freshly created container is already registered, and a
#     person re-running `rea setup` later only has to agree to what it proposes.
ARG REA_AGENTS_VERSION=6.7.0
RUN npm install -g --no-fund --no-audit "rea-agents@${REA_AGENTS_VERSION}" \
 && mkdir -p /opt/genie-default-skills /root/.agents \
 && cp -a /usr/local/lib/node_modules/rea-agents/skills/reverse-engineer-anything \
          /opt/genie-default-skills/ \
 && printf '%s\n' '{ "mcpServers": { "rea": { "command": "rea", "args": ["--mcp"] } } }' \
          > /root/.agents/mcp.json \
 && rea --version

# Ghidra, the native-analysis engine REA expects by default. Downloaded at build
# time because a 400 MB tarball per container start is a worse trade than a larger
# image, and pinned to a release REA names as verified rather than to "latest".
#
# `GHIDRA_INSTALL_DIR` is the variable REA reads; the symlink means the version
# appears once here and nowhere else.
ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_BUILD=20260921
RUN curl -fsSL -o /tmp/ghidra.zip \
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip" \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && rm -f /tmp/ghidra.zip \
 && ln -s "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra
ENV GHIDRA_INSTALL_DIR=/opt/ghidra

# This deployment's own default skills. Copied over the analyser's one above, so a
# name collision is resolved in favour of the file that is reviewed in this
# repository; the entrypoint is what puts them in front of the accounts.
COPY default-skills /opt/genie-default-skills/

# This image's node is musl, and the PTY prebuild REA installs above is linked
# against glibc: a gcompat shim lets it load, and then `forkpty` faults the MCP
# server on the first captured command. The hotfix installs the pipe-aware
# backend from morluto/rea#7046 and rewires the two spawn sites in the packaged
# 6.7.0 tree; it is last so the layers above stay cached. See
# rea-capture-hotfix/README.md for what it touches and why it fails closed.
COPY rea-capture-hotfix /tmp/rea-capture-hotfix
RUN node /tmp/rea-capture-hotfix/install.mjs /usr/local/lib/node_modules/rea-agents \
 && rm -rf /tmp/rea-capture-hotfix

EXPOSE 3400
# The entrypoint resolves any `vault://` values (a no-op with none), then execs
# the server — so a reference that cannot be resolved stops the container.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
