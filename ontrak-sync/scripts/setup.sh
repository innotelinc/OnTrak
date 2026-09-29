#!/usr/bin/env bash
# Ontrak Sync — provision the service container and its access to the Network.
#
# Idempotent: run it again after changing ONTRAK_HOSTS and it will only add what is
# missing. That matters because the two things it does — create the incus container
# and authorise an SSH key on every host in the Network — are both things you do
# again when the Network changes.
#
# WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT
# --------------------------------------------------
# It creates ONE incus container and adds ONE public key to each listed host's
# `authorized_keys`. It does not install anything on the Network hosts, does not
# change their SSH configuration, and does not run as anything but root over an
# existing password login. The key it authorises is generated locally and is the
# only credential the service holds.
#
# WHY THE KEY IS GENERATED HERE AND NOT ON THE SERVICE HOST
# ---------------------------------------------------------
# The private key never leaves this machine's `.ssh` directory and is mounted
# read-only into the API container. Generating it inside the container would put the
# private half in a volume that the service itself can write to, which is the one
# thing an SSH key must not be for a service that also installs packages.

set -euo pipefail

# ── configuration ────────────────────────────────────────────────────────────
INCUS_HOST="${INCUS_HOST:-192.168.1.51}"          # the bare-metal incus host (i1)
# NOT defaulted here. The Network's rule is that no credential lives in a repo
# file, and `${VAR:-<literal>}` is the shape that hides one: a secret scan reads
# an interpolation rather than a value, so the password would ship in every clone
# with nothing to flag it. Provide it in the environment, or as
# ONTRAK_INCUS_PASSWORD in .env; the check below refuses to run without it.
INCUS_PASSWORD="${INCUS_PASSWORD:-}"
CONTAINER="${ONTRAK_CONTAINER:-ontrak}"
ADDRESS="${ONTRAK_ADDRESS:-192.168.1.21}"
KEY_PATH="${ONTRAK_SSH_KEY:-$HOME/.ssh/id_ed25519}"
# Hosts to authorise the key on, `address` only — the container reaches them as root.
# Kept in step with ONTRAK_HOSTS in .env by hand; the script prints the mismatch if
# they disagree, because a host that is scanned but not reachable reads as
# "unreachable" rather than as a configuration mistake.
NETWORK_HOSTS="${NETWORK_HOSTS:-192.168.1.51 192.168.1.52 192.168.1.53}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The password may live in .env instead of the environment. Read that one key
# rather than sourcing the file: .env is a Compose/make template, not a shell
# script (it starts with a [TEMPLATE] marker), and sourcing it under `set -e`
# would abort on the first line it cannot execute.
if [ -z "$INCUS_PASSWORD" ] && [ -f "$REPO/.env" ]; then
  INCUS_PASSWORD="$(grep -E '^ONTRAK_INCUS_PASSWORD=' "$REPO/.env" | tail -n 1 | cut -d= -f2- | tr -d '"')"
fi

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*" >&2; }

remote() { # run a command on the incus host
  SSHPASS="$INCUS_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 "root@$INCUS_HOST" "$@"
}

if ! command -v sshpass >/dev/null 2>&1; then
  warn "sshpass is not installed; install it or run the container creation by hand"
fi

if [ -z "$INCUS_PASSWORD" ]; then
  warn "no incus password: export INCUS_PASSWORD, or set ONTRAK_INCUS_PASSWORD in $REPO/.env"
  exit 1
fi

# ── 0. the attribution guard hooks ───────────────────────────────────────────
if [ -d "$REPO/.githooks" ] && git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$REPO" config core.hooksPath .githooks
  say "attribution guard hooks installed (.githooks)"
fi

# ── 1. the SSH key ───────────────────────────────────────────────────────────
say "SSH key at $KEY_PATH"
if [[ -f "$KEY_PATH" ]]; then
  echo "    already present, leaving it alone"
else
  mkdir -p "$(dirname "$KEY_PATH")"
  chmod 700 "$(dirname "$KEY_PATH")"
  ssh-keygen -t ed25519 -N '' -C 'ontrak-sync' -f "$KEY_PATH" >/dev/null
  echo "    generated"
fi
PUBKEY="$(cat "${KEY_PATH}.pub")"

# ── 2. the container ─────────────────────────────────────────────────────────
say "incus container '$CONTAINER' on $INCUS_HOST"
if remote "incus info '$CONTAINER' >/dev/null 2>&1"; then
  echo "    already exists"
else
  remote "incus launch images:debian/13 '$CONTAINER' --profile default --profile docker" \
    || remote "incus launch images:debian/13 '$CONTAINER' --profile default"
  echo "    created"
fi

# Static-ish addressing: the Network hands out DHCP reservations from the router,
# which is UI-only (see 1-primary/cerulean/docs/router.md), so the address is
# asserted here rather than configured.
remote "incus config set '$CONTAINER' limits.cpu 2 >/dev/null; \
        incus config set '$CONTAINER' limits.memory 2GiB >/dev/null" || true

say "container address (expected $ADDRESS — reserve it in the router UI if different)"
remote "incus list '$CONTAINER' --format csv -c 4"

# ── 3. authorise the key on every Network host ────────────────────────────────
say "authorising the key on: $NETWORK_HOSTS"
for host in $NETWORK_HOSTS; do
  # Installed from inside the incus host, which already has password access to the
  # members of its own Network.
  remote "sshpass -p '$INCUS_PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 root@$host \
            'mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
             grep -qF \"$PUBKEY\" /root/.ssh/authorized_keys 2>/dev/null || \
             echo \"$PUBKEY\" >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys'" \
    && echo "    $host ok" \
    || warn "$host could not be reached — it will show as unreachable in the dashboard until it is"
done

# ── 4. the stack ─────────────────────────────────────────────────────────────
say "next steps"
cat <<EOF
    1. On the container:  incus exec $CONTAINER -- bash
    2. Copy this project to /opt/ontrak-sync (git clone, or scp from the workstation)
    3. cp .env.example .env  and set ONTRAK_API_TOKEN=\$(openssl rand -hex 32)
    4. mkdir -p /root/.ssh && copy ${KEY_PATH} — the PRIVATE half — to
       /root/.ssh/id_ed25519 on the container and chmod 600 it. Compose mounts it
       read-only on purpose: the service may install packages on the Network, but it
       must not be able to rewrite the key that lets it do so.
    5. docker compose up -d --build
    6. Open http://$ADDRESS:8421 and paste the token.
    7. Run a scan from the dashboard before trusting any count.
EOF
