#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — one-shot bootstrap: guard hooks, .env files, dependencies.
#
# Deliberately small and idempotent: running it twice is safe, and it never
# overwrites an existing .env (that file holds a deployment's own values and a
# bootstrap has no business rewriting a secret it did not generate).
#
# It installs the attribution/secret guard by pointing git at .githooks, which
# is what makes the local hooks real — a copied .githooks directory that git has
# not been told about guards nothing.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Ensure the Genie workspace host directory is ready before any container mounts
# it. This is the host-side half of the EACCES fix for mkdir /workspace/accounts:
# the Incus host maps a device here and it can come up owned by nobody:nogroup
# (UID 65534), which is outside the user-namespace range and therefore unwritable.
# See scripts/ensure-genie-workspace.sh and the entrypoint safety net.
bash "$ROOT/scripts/ensure-genie-workspace.sh" || true

# Install the systemd units that keep the workspace fix permanent: the init
# service runs before Docker starts (catches device re-mounts on reboot), and
# the daily timer is a backstop for any case the boot-time check misses.
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
if command -v systemctl >/dev/null 2>&1 && [ -d "$SYSTEMD_DIR" ]; then
  for unit in genie-workspace-init.service genie-workspace-check.service genie-workspace-check.timer; do
    src="$ROOT/scripts/systemd/$unit"
    if [ -f "$src" ]; then
      cp "$src" "$SYSTEMD_DIR/" 2>/dev/null || true
      systemctl daemon-reload 2>/dev/null || true
      systemctl enable "$unit" 2>/dev/null && echo "  enabled $unit"
    fi
  done
fi

echo "==> OnTrak bootstrap"

echo "--> guard hooks"
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "    core.hooksPath = $(git config core.hooksPath)"

echo "--> environment files"
for dir in . ontrak-tix; do
  if [ -f "$dir/.env.example" ]; then
    if [ -f "$dir/.env" ]; then
      echo "    $dir/.env exists — left alone"
    else
      cp "$dir/.env.example" "$dir/.env"
      echo "    created $dir/.env from the template"
    fi
  fi
done

echo "--> dependencies"
npm install

cat <<'DONE'

Next:
  make db && make setup && make dev        # the training app
  make tix-setup tix-db tix-schema tix-dev # the service desk

Before deploying anything, replace every placeholder secret in the .env files
(AUTH_SECRET, TIX_AUTH_SECRET, the webhook/cron/assurance secrets). A production
deployment resolves them from Cerulean Vault — see .env.example.

DONE
