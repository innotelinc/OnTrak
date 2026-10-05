#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# lan-env.sh — provision this host's LAN address into a deployment's `.env`.
#
# The ports this stack publishes have to be named by the *host's* LAN address.
# A docker bridge address (`172.x`) is reachable from the containers on that
# bridge and from nowhere else, and a browser or a gateway off this host can dial
# neither it nor loopback. Genie feels this first, because both the app it runs in
# the preview and the sandbox its commands run in are meant to be reachable — and
# an address that only this host can dial is worse than no address, because it
# gets pasted into a gateway that then cannot connect.
#
# Inside a container the process cannot work the answer out for itself: every
# address it can see is its own bridge address. So the address is handed *in*
# from the host, which is what this does.
#
# The rule is the platform stack's, not a second copy of it. `scripts/stack-lib.sh`
# is a verbatim mirror of `innotel-platform-stack`, `stack_lib_lan_ip` is the
# detection (default-route source address; never loopback, never `172.x`), and
# `stack_lib_agent_net_env` derives the builder network from it. Running this
# twice is safe, and a value set by hand is never overwritten.
#
#   ./scripts/lan-env.sh                     # detect, then write into .env
#   ./scripts/lan-env.sh --print             # show what would be written
#   ./scripts/lan-env.sh --file path/to/.env # provision another env file
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/stack-lib.sh
. "${ROOT}/scripts/stack-lib.sh"

ENV_FILE=".env"
print_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print_only=1 ;;
    --file)
      shift
      ENV_FILE="${1:?--file needs a path}"
      ;;
    -h|--help)
      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) stack_lib_die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$print_only" != "1" ] && [ ! -f "$ENV_FILE" ]; then
  if [ -f "${ENV_FILE}.example" ]; then
    cp "${ENV_FILE}.example" "$ENV_FILE"
    stack_lib_say "created $ENV_FILE from ${ENV_FILE}.example"
  else
    stack_lib_die "$ENV_FILE not found, and there is no ${ENV_FILE}.example to copy."
  fi
fi

# A value already in the file counts as the operator's, and `stack_lib_agent_net_env`
# honours it: loading first is what makes "set it and forget it" true.
if [ -f "$ENV_FILE" ]; then
  stack_lib_load_env "$ENV_FILE"
fi

lan="$(stack_lib_lan_ip)"
if [ -z "$lan" ]; then
  stack_lib_warn "no LAN address detected (only loopback and docker bridges) — leaving $ENV_FILE alone"
  exit 0
fi

mapfile -t pairs < <(stack_lib_agent_net_env)

if [ "$print_only" = "1" ]; then
  stack_lib_say "would provision into $ENV_FILE from this host ($lan):"
  printf '  %s\n' "${pairs[@]}"
  exit 0
fi

# Also provision the builder product's hosting URL so the preview
# console can advertise a reachable address. `GENIE_HOSTING_URL` is only set
# when the file is the Genie `.env` (root or ontrak-genie/) and has no
# operator-set value already — this is the one place a LAN address is
# *derived*, mirroring how `stack_lib_agent_net_env` derives the preview
# address from the sandbox.
# Detect whether this looks like the Genie root or ontrak-genie .env
is_genie_env=0
case "$ENV_FILE" in
  .env|ontrak-genie/.env|*/genie/.env) is_genie_env=1 ;;
esac
if [ "$is_genie_env" = "1" ]; then
  preview_port="${PREVIEW_HOST_PORT:-${ONTRAK_GENIE_PREVIEW_PORT:-5173}}"
  existing_url="$(stack_lib_env_get "$ENV_FILE" "GENIE_HOSTING_URL")"
  if [ -z "$existing_url" ]; then
    stack_lib_env_set "$ENV_FILE" "GENIE_HOSTING_URL" "http://${lan}:${preview_port}"
  fi
fi

# Provision ONTRAK_TIX_BASE_URL for the Tix .env too, so the desk can build
# correct notification links and SSO redirects from this host's LAN address.
case "$ENV_FILE" in
  ontrak-tix/.env) is_tix_env=1 ;;
esac
if [ "${is_tix_env:-0}" = "1" ]; then
  existing_url="$(stack_lib_env_get "$ENV_FILE" "ONTRAK_TIX_BASE_URL")"
  if [ -z "$existing_url" ]; then
    stack_lib_env_set "$ENV_FILE" "ONTRAK_TIX_BASE_URL" "http://${lan}:3001"
  fi
fi

for kv in "${pairs[@]}"; do
  key="${kv%%=*}"
  value="${kv#*=}"
  [ -n "$value" ] || continue
  stack_lib_env_set "$ENV_FILE" "$key" "$value"
done

stack_lib_say "provisioned $ENV_FILE from this host's LAN address ($lan)"
printf '  LAN_IP=%s\n' "$lan"
printf '  the preview answers at http://%s:%s/ and the sandbox holds the same address\n' \
  "$lan" "${ONTRAK_GENIE_PREVIEW_PORT:-5173}"
