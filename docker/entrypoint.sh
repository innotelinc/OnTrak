#!/usr/bin/env bash
# ============================================================================
# OnTrak container entrypoint.
#
#   docker run --rm -p 8080:8080 --env-file .env ontrak              # portal
#   docker run --rm ontrak demo run --students 3                     # a class, in memory
#   docker run --rm ontrak doctor                                    # preflight
#   docker run --rm -it ontrak bash                                  # a shell
#
# Anything that is not a bare verb is handed straight to the CLI, so
# `docker run ontrak catalog list` works exactly like `ontrak catalog list` on a
# host. The only work this script does on the way in is the work a boot needs:
# make the state and media directories exist (they may be fresh volumes) and, if
# a password was supplied, make sure the instructor account exists.
# ============================================================================
set -euo pipefail

cd /app

log() { printf 'ontrak: %s\n' "$*" >&2; }

STATE_DIR="${ONTRAK_PATHS__STATE:-state}"
MEDIA_DIR="${ONTRAK_PATHS__MEDIA:-media}"

# Fresh named volumes mount empty and root-owned; the app expects both to exist.
mkdir -p "$STATE_DIR" "$MEDIA_DIR" 2>/dev/null || true

command="${1:-serve}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  serve|demo-serve)
    # Seeding is idempotent (upsert), and only runs when a password was actually
    # supplied — otherwise the CLI would invent a random one and print it into
    # the container log, where it does nobody any good.
    if [ "${ONTRAK_ENTRYPOINT_SKIP_INIT:-0}" != "1" ] && [ -n "${ONTRAK_PORTAL__ADMIN_PASSWORD:-}" ]; then
      python3 -m ontrak user seed-admin
    fi
    log "starting the portal on ${ONTRAK_PORTAL__HOST:-0.0.0.0}:${ONTRAK_PORTAL__PORT:-8080}"
    exec python3 -m ontrak serve
    ;;
  demo)
    exec python3 -m ontrak demo "$@"
    ;;
  bash|sh)
    exec "$command" "$@"
    ;;
  *)
    # `doctor`, `catalog list`, `scenario validate`, `pool status`, … — the CLI
    # is the interface, so no second copy of it lives here.
    exec python3 -m ontrak "$command" "$@"
    ;;
esac
