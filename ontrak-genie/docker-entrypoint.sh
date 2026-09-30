#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# OnTrak Genie — Docker entrypoint
# Resolves Cerulean Vault `vault://` references, then starts the server.
# ═══════════════════════════════════════════════════════════════
set -e

# ── SecretOps (Cerulean Vault) — boot-time reference resolution ─────────
# `.env` values may be `vault://<mount>/<path>#<key>` references (the same
# grammar Cerulean/Onyx/Atlas/Zeus/Distro resolve, docs/stack.md). Resolve them
# BEFORE boot so every consumer reads the plain value from process.env.
#
# Plain values are left untouched; a reference that cannot be resolved aborts the
# container instead of booting with a literal `vault://` value or a stale
# credential. Always run the resolver — with no references it is a silent no-op —
# and check its status explicitly so an unresolvable reference fails the
# container rather than being masked by `eval` exiting 0 on an empty
# substitution.
#
# VAULT_* env (see .env.example):
#   VAULT_ADDR / VAULT_TOKEN (or VAULT_TOKEN_FILE) / VAULT_PREFIX /
#   VAULT_NAMESPACE / VAULT_SKIP_VERIFY / VAULT_CACERT
VAULT_KEYS="OMNIROUTE_API_KEY WEB_TOKEN CONTROL_INTERNAL_TOKEN AGENT_OFFLINE_KEY ONTRAK_OIDC_CLIENT_SECRET ONTRAK_OIDC_SESSION_SECRET"
# shellcheck disable=SC2086  # VAULT_KEYS is a space-separated key list for word splitting
VAULT_EXPORTS="$(node /app/scripts/vault-env.mjs $VAULT_KEYS)" || exit 1
if [ -n "$VAULT_EXPORTS" ]; then
  eval "$VAULT_EXPORTS"
fi

exec "$@"
