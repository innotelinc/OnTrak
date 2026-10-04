#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# OnTrak — Cerulean Vault (SecretOps) boot-time entrypoint.
#
# Resolves `vault://<mount>/<path>#<key>` values in the environment before the
# server boots, so every consumer reads the plain value from process.env and no
# application code knows about references. Plain values are untouched.
#
# The keys are auto-detected: any variable whose value starts with `vault://`
# is resolved. That keeps this file identical across products, so a new secret
# needs no entrypoint edit — only a `vault://` value and a seeded Vault path.
#
# A reference that cannot be resolved aborts the container instead of booting
# with a literal `vault://` value that looks configured and is not.
#
# VAULT_DROP_UID: when set and running as root, drop to that uid before exec
# (for images whose service runs unprivileged but whose Vault token is only
# readable by root).
# ═══════════════════════════════════════════════════════════════
set -e

VAULT_KEYS="$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=vault:\/\/.*/\1/p' | tr '\n' ' ')"
if [ -n "${VAULT_KEYS% }" ]; then
  # shellcheck disable=SC2086
  VAULT_EXPORTS="$(node /app/scripts/vault-env.mjs $VAULT_KEYS)" || {
    echo "!!! vault-env resolution failed — refusing to boot with unresolved vault:// refs" >&2
    exit 1
  }
  if [ -n "$VAULT_EXPORTS" ]; then
    # shellcheck disable=SC2086
    eval "$VAULT_EXPORTS"
    # shellcheck disable=SC2086
    export $VAULT_KEYS
  fi
fi

if [ -n "${VAULT_DROP_UID:-}" ] && [ "$(id -u)" = "0" ]; then
  # Alpine ships a BusyBox applet also named `setpriv`, and it has no uid/gid
  # options at all -- only --dump/--inh-caps/--ambient-caps/--nnp. Reaching it
  # means the drop cannot happen, and the container dies with
  # `setpriv: unrecognized option: reuid=1001` plus a page of BusyBox usage,
  # which reads like a bad argument rather than a missing package. Refuse with
  # the actual remedy instead.
  if ! setpriv --reuid="$VAULT_DROP_UID" --regid="$VAULT_DROP_UID" --init-groups --inh-caps=-all true 2>/dev/null; then
    if ! setpriv --help 2>&1 | grep -q -- '--reuid'; then
      echo "!!! /bin/setpriv is BusyBox's applet, which cannot drop uid/gid." >&2
      echo "!!! Install the util-linux one: apk add --no-cache setpriv" >&2
      echo "!!! (Refusing to boot as root, which is what VAULT_DROP_UID exists to prevent.)" >&2
      exit 1
    fi
  fi
  exec setpriv --reuid="$VAULT_DROP_UID" --regid="$VAULT_DROP_UID" --init-groups --inh-caps=-all "$@"
fi
exec "$@"
