#!/usr/bin/env bash
# OnTrak — fill in the secrets a local stack needs, without ever inventing a
# value that is already there.
#
#   bash scripts/secrets.sh           # ./.env from ./.env.example, blanks filled
#   bash scripts/secrets.sh .env.ci   # any other file
#
# Rules:
#   * a key that is missing          → appended, generated
#   * a key that is present and empty → filled
#   * a key that already has a value  → left alone (a `vault://` reference counts
#     as a value: this script must never quietly replace one with a local secret)
#
# The generated values are local-development values. Production secrets come
# from Cerulean Vault, by reference (see .env.example).
set -euo pipefail

ENV_FILE="${1:-.env}"
EXAMPLE=".env.example"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$EXAMPLE" ]; then
    cp "$EXAMPLE" "$ENV_FILE"
    echo "==> ${ENV_FILE} created from ${EXAMPLE}"
  else
    : >"$ENV_FILE"
    echo "==> ${ENV_FILE} created (no ${EXAMPLE} to copy)"
  fi
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "!! openssl not found: install it, or fill in the blanks in ${ENV_FILE} by hand" >&2
  exit 1
fi

# fill <KEY> <bytes> <note>
fill() {
  local key="$1" bytes="$2" note="${3:-}" value
  if grep -qE "^${key}=" "$ENV_FILE"; then
    if grep -qE "^${key}=[^[:space:]]" "$ENV_FILE"; then
      printf '   %-32s already set, left alone\n' "$key"
      return 0
    fi
    value="$(openssl rand -hex "$bytes")"
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
  else
    value="$(openssl rand -hex "$bytes")"
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
  printf '   %-32s generated%s\n' "$key" "${note:+ (${note})}"
}

echo "==> generating local secrets in ${ENV_FILE}"
# Signs portal session cookies. Rotating it logs every student out; nothing else
# breaks, which is why this one is safe to regenerate.
fill ONTRAK_PORTAL__SECRET 32
# The instructor account. Printed here only as "generated" — read it back out of
# the file (or `ontrak user seed-admin` to set your own).
fill ONTRAK_PORTAL__ADMIN_PASSWORD 16
# Exactly 32 hex characters: Guacamole's JSON auth rejects anything else, and it
# must be identical in the portal and the gateway.
fill ONTRAK_GUAC__SECRET_KEY 16
# Local admin password inside the training machines (WinRM/SSH). Baked into the
# images at build time, so change it before you build them, not after.
fill ONTRAK_GUEST__PASSWORD 12

echo
echo "==> done. ${ENV_FILE} is gitignored; never commit it."
echo "    next: make up      (portal on http://localhost:8080, console on :8080/guacamole/)"
