#!/usr/bin/env bash
# OnTrak — one-shot bootstrap.
#
# Installs the attribution-guard hooks, creates the virtualenv, installs the Python
# dependencies and seeds .env from .env.example. Safe to re-run: it never overwrites
# an existing .env, and re-running only re-installs what is missing.
#
# OnTrak has no root-level compose stack: the student range runs on the host through
# Incus (see infra/bootstrap-host.sh) and the browser console runs through the
# operator's Guacamole deployment (see deploy/guacamole/).
set -euo pipefail

APP="$(basename "$(pwd)")"
VENV=".venv"

echo "==> ${APP} bootstrap"

# ── attribution guard hooks ───────────────────────────────────────────────────
if [ -d .githooks ]; then
  git config core.hooksPath .githooks
  echo "==> attribution guard hooks installed (.githooks)"
fi

# ── .env ─────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "==> .env created from .env.example — fill in the real values"
  fi
else
  echo "==> .env already present, left untouched"
fi

# ── python environment ────────────────────────────────────────────────────────
PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "!! ${PYTHON} not found — install Python 3.11 or newer" >&2
  exit 1
fi

if [ ! -d "$VENV" ]; then
  echo "==> creating ${VENV}"
  "$PYTHON" -m venv "$VENV"
fi

echo "==> installing dependencies"
"${VENV}/bin/pip" install --quiet --upgrade pip
"${VENV}/bin/pip" install --quiet -r requirements.txt
"${VENV}/bin/pip" install --quiet -e .

# ── optional: PowerShell, for validating guest scripts locally ────────────────
if command -v pwsh >/dev/null 2>&1; then
  echo "==> pwsh found: guest scripts can be syntax-checked locally"
else
  echo "==> pwsh not found (optional): scenario scripts are only parsed at template build"
fi

echo
echo "==> done. Next:"
echo "    make demo        # full student flow, no hypervisor needed"
echo "    make serve       # student portal (needs the secrets in .env)"
echo "    make check       # host readiness, including Incus and KVM"
echo
echo "    Building real Windows templates needs a host: infra/bootstrap-host.sh"
