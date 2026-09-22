#!/usr/bin/env bash
# ============================================================================
# OnTrak — one command, anywhere.
#
#   ./start.sh              bootstrap this machine, then start OnTrak
#   ./start.sh up           the full stack (needs a local Incus host)
#   ./start.sh serve        the real portal on this host, no containers
#   ./start.sh stop         stop whatever is running
#
# `start.sh <anything>` is `make <anything>`, after installing what the machine
# is missing. It exists so that a checkout carried onto a new box needs exactly
# one thing to be remembered: this filename.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  set -- run
fi

# Install what this machine lacks, and build the Python environment. Idempotent:
# a second run is a couple of checks and nothing else.
bash scripts/setup.sh

if command -v make >/dev/null 2>&1; then
  exec make "$@"
fi

# No make and it could not be installed: the two things worth doing directly are
# still here, and the rest explains itself.
VENV_PY=".venv/bin/python"
case "$1" in
  run | serve)
    [ -x "$VENV_PY" ] || { echo "start.sh: no Python environment; re-run after installing python3 + make" >&2; exit 1; }
    exec "$VENV_PY" -m ontrak serve
    ;;
  *)
    echo "start.sh: 'make' is not installed, so './start.sh $1' cannot run." >&2
    echo "  install make (see the output above) to use ./start.sh <target>." >&2
    exit 2
    ;;
esac
