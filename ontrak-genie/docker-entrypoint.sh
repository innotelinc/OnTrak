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
VAULT_KEYS="OMNIROUTE_API_KEY WEB_TOKEN CONTROL_INTERNAL_TOKEN AGENT_OFFLINE_KEY ONTRAK_OIDC_CLIENT_SECRET ONTRAK_OIDC_SESSION_SECRET PREVIEW_CLAIM_TOKEN ENTITLEMENTS_API_TOKEN AGENT_GIT_TOKEN"
# shellcheck disable=SC2086  # VAULT_KEYS is a space-separated key list for word splitting
VAULT_EXPORTS="$(node /app/scripts/vault-env.mjs $VAULT_KEYS)" || exit 1
if [ -n "$VAULT_EXPORTS" ]; then
  eval "$VAULT_EXPORTS"
fi

# ── Deployment skills ───────────────────────────────────────────────────
# The accounts' skills live in the data volume (`/data/skills`), which outlives
# this container and is therefore *older* than the image on every deploy. The image
# carries the skills a deployment ships with — the analyser's own instructions and
# this repo's additions — in `/opt/genie-default-skills`, and they are copied in
# here rather than at build time because a build cannot write into a volume.
#
# The copy is idempotent and it owns only what it placed: a name the image does not
# ship is left exactly as the operator or an account left it, and a name the image
# *does* ship is refreshed only when its contents actually changed — which is what
# makes an updated image update the skill, instead of a silent once-ever copy.
SKILL_SEED=/opt/genie-default-skills
if [ -d "$SKILL_SEED" ]; then
  mkdir -p /data/skills
  for src in "$SKILL_SEED"/*; do
    [ -d "$src" ] || continue
    name=$(basename "$src")
    dest="/data/skills/$name"
    sum=$(find "$src" -type f -exec sha256sum {} + | sort -k2 | sha256sum | cut -d' ' -f1)
    if [ -f "$dest/.image-sum" ] && [ "$(cat "$dest/.image-sum")" = "$sum" ]; then
      continue
    fi
    rm -rf "$dest"
    cp -a "$src" "$dest"
    printf '%s\n' "$sum" > "$dest/.image-sum"
    echo "skills: installed $name"
  done
fi

exec "$@"
