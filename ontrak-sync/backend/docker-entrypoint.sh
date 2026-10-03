#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# OnTrak Sync API — Cerulean Vault (SecretOps) boot-time entrypoint.
#
# Resolves `vault://<mount>/<path>#<key>` values in the environment before
# uvicorn boots, so the API reads plain values from os.environ. Plain values are
# untouched. Keys are auto-detected (any variable whose value starts with
# `vault://`), so a new secret needs no edit here.
#
# A reference that cannot be resolved aborts the container instead of booting
# with a literal `vault://` value that looks configured and is not.
# ═══════════════════════════════════════════════════════════════
set -e

VAULT_KEYS="$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=vault:\/\/.*/\1/p' | tr '\n' ' ')"
if [ -n "${VAULT_KEYS% }" ]; then
  # shellcheck disable=SC2086
  VAULT_EXPORTS="$(python3 /app/scripts/vault_env.py $VAULT_KEYS)" || {
    echo "!!! vault_env resolution failed — refusing to boot with unresolved vault:// refs" >&2
    exit 1
  }
  if [ -n "$VAULT_EXPORTS" ]; then
    # shellcheck disable=SC2086
    eval "$VAULT_EXPORTS"
    # shellcheck disable=SC2086
    export $VAULT_KEYS
  fi
fi

exec "$@"