#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# consolidate-to-family.sh — make the family stack the *one* Sentinel.
#
# Sentinel can be run two ways: as its own stack (`ontrak-sentinel`, project
# `ontrak-sentinel`, `make sentinel-up`) or as a product in the family stack
# (`docker-compose.all.yml`, project `ontrak-family`, `make all-up`). Both bind
# the same host ports — 8787 for HTTP, 5434 for Postgres, 5514 for Guard's
# syslog listener — so only one can ever serve, and running the family copy
# against *fresh* volumes is not a cutover: it mints a second signing key and
# starts an empty directory, which invalidates every token in the wild and makes
# every existing sign-in unknown. That is a rotating-secret incident, not a
# no-op.
#
# This script is the cutover. It quiesces the standalone stack, copies its
# database and its signing key into the family stack's volumes, brings the
# family Sentinel up, and verifies that the key and the directory arrived. The
# standalone's volumes are left untouched — they are the rollback.
#
#   # 1. Look, change nothing
#   ontrak-sentinel/scripts/consolidate-to-family.sh --check
#
#   # 2. Cut over (stops the standalone, copies, starts the family's)
#   ontrak-sentinel/scripts/consolidate-to-family.sh
#
#   # 3. Once the new Sentinel is confirmed serving, retire the old project
#   ontrak-sentinel/scripts/consolidate-to-family.sh --retire
#
# Running it twice is safe: the copy is a full overwrite of the family volumes, and
the family Sentinel is stopped first so Postgres is not reading a directory that
is being replaced underneath it.
#
# Overridable, for a host that names its projects differently:
#   SENTINEL_STANDALONE_PROJECT  (default: ontrak-sentinel)
#   SENTINEL_FAMILY_PROJECT      (default: ontrak-family)
#   SENTINEL_COPY_IMAGE          (default: postgres:16-alpine, already local)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

STANDALONE_PROJECT="${SENTINEL_STANDALONE_PROJECT:-ontrak-sentinel}"
FAMILY_PROJECT="${SENTINEL_FAMILY_PROJECT:-ontrak-family}"
COPY_IMAGE="${SENTINEL_COPY_IMAGE:-postgres:16-alpine}"

STANDALONE_COMPOSE="${ROOT}/ontrak-sentinel/docker-compose.yml"
FAMILY_COMPOSE="${ROOT}/docker-compose.all.yml"

SRC_DB="${STANDALONE_PROJECT}_ontrak-sentinel-db"
SRC_KEYS="${STANDALONE_PROJECT}_ontrak-sentinel-keys"
DST_DB="${FAMILY_PROJECT}_ontrak-family-sentinel-db"
DST_KEYS="${FAMILY_PROJECT}_ontrak-family-sentinel-keys"

say() { printf '  %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

check_only=0
retire=0
keep_family_db=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    --retire) retire=1 ;;
    --keep-family-db) keep_family_db=1 ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
[ -f "$FAMILY_COMPOSE" ] || die "family compose file not found: $FAMILY_COMPOSE"

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# sha256 of the volume's signing key, or empty when the volume has none yet.
key_sha() {
  docker run --rm -v "$1:/k:ro" "$COPY_IMAGE" \
    sh -c 'sha256sum /k/signing-key.pem 2>/dev/null | cut -d" " -f1' 2>/dev/null || true
}

# Identity count from a *running* Postgres that already holds this volume.
count_in() {
  docker exec "$1" psql -U ontrak -d sentinel -tAc 'select count(*) from "Identity"' 2>/dev/null || true
}

# Full, ownership-preserving overwrite of $2 from $1.
copy_volume() {
  local from="$1" to="$2"
  docker run --rm -v "${from}:/from:ro" -v "${to}:/to" "$COPY_IMAGE" \
    sh -c 'find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; cp -a /from/. /to/'
}

echo "Sentinel consolidation → the family stack"
say "standalone project : $STANDALONE_PROJECT"
say "family project     : $FAMILY_PROJECT"
say "database           : $SRC_DB → $DST_DB"
say "signing key        : $SRC_KEYS → $DST_KEYS"

volume_exists "$SRC_DB" || die "source database volume '$SRC_DB' does not exist — nothing to migrate"
volume_exists "$SRC_KEYS" || die "source signing-key volume '$SRC_KEYS' does not exist — a cutover needs the key that is already published"

src_key="$(key_sha "$SRC_KEYS")"
[ -n "$src_key" ] || die "source key volume has no signing-key.pem"
dst_key="$(key_sha "$DST_KEYS")"
say "source key sha256  : ${src_key:0:16}…"
if [ -n "$dst_key" ]; then
  say "family key sha256  : ${dst_key:0:16}…"
fi
if [ -n "$dst_key" ] && [ "$dst_key" = "$src_key" ]; then
  ok "the family already holds this exact key — the copy will be a no-op"
fi

src_count="$(count_in "${STANDALONE_PROJECT}-db-1")"
[ -n "$src_count" ] && say "standalone directory: ${src_count} identities"

if [ "$keep_family_db" = "1" ] && [ -n "$dst_key" ]; then
  dst_count="$(count_in "${FAMILY_PROJECT}-sentinel-db-1")"
  if [ -n "$dst_count" ] && [ "$dst_count" != "0" ]; then
    die "--keep-family-db: the family database already holds ${dst_count} identities; refusing to overwrite"
  fi
fi

if [ "$check_only" = "1" ]; then
  ok "check only — nothing changed"
  exit 0
fi

# ── 1. Quiesce the standalone so the database is copied at rest ──────────────
if docker ps --format '{{.Names}}' | grep -qx "${STANDALONE_PROJECT}-app-1"; then
  say "stopping the standalone stack so Postgres is copied at rest…"
  docker compose -p "$STANDALONE_PROJECT" -f "$STANDALONE_COMPOSE" stop >/dev/null
  ok "standalone stopped (its volumes are the rollback)"
else
  say "standalone is not running — copying the database as it stands"
fi

# ── 2. Ensure the family volumes exist, then copy ────────────────────────────
# The destination must not be *in use* while it is replaced: overwriting the
# files under a running Postgres is how a cutover becomes a corruption. Stop the
# family Sentinel as well, so a re-run (or a cutover over a half-started copy)
# replaces a directory nothing is reading.
if docker ps --format '{{.Names}}' | grep -qE "^${FAMILY_PROJECT}-sentinel-(app|db)-1$"; then
  say "stopping the family Sentinel so its volumes are not in use during the copy…"
  docker compose -p "$FAMILY_PROJECT" -f "$FAMILY_COMPOSE" stop sentinel-app sentinel-db >/dev/null 2>&1 || true
fi
for v in "$DST_DB" "$DST_KEYS"; do
  volume_exists "$v" || { docker volume create "$v" >/dev/null; say "created $v"; }
done

say "copying the signing key…"
copy_volume "$SRC_KEYS" "$DST_KEYS"
say "copying the database…"
copy_volume "$SRC_DB" "$DST_DB"
ok "copied"

# ── 3. Bring the family Sentinel up ──────────────────────────────────────────
say "starting the family Sentinel (sentinel-db → migrate → signing-key → app)…"
# `--force-recreate`: a container left in `Created` by an earlier aborted `up`
# can carry a stale (or absent) network attachment, and then the migrate service
# cannot resolve `sentinel-db` and dies with P1001. Recreating from the current
# file is what makes the cutover reproducible rather than dependent on how the
# last attempt happened to stop.
( cd "$ROOT" && docker compose -p "$FAMILY_PROJECT" -f "$FAMILY_COMPOSE" up -d --force-recreate sentinel-app ) >/dev/null
ok "family Sentinel started"

# ── 4. Verify the cutover ────────────────────────────────────────────────────
new_key="$(key_sha "$DST_KEYS")"
[ "$new_key" = "$src_key" ] || die "signing key did not arrive ($new_key ≠ $src_key) — the family is signing with the wrong key; stop it and restore from the standalone volumes"

new_count=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  new_count="$(count_in "${FAMILY_PROJECT}-sentinel-db-1")"
  [ -n "$new_count" ] && break
  sleep 3
done
if [ -n "$src_count" ] && [ -n "$new_count" ] && [ "$src_count" != "$new_count" ]; then
  die "the family directory holds ${new_count} identities, the standalone has ${src_count} — cutover incomplete; investigate before retiring anything"
fi
[ -n "$new_count" ] && ok "the family directory holds ${new_count} identities"
ok "the family Sentinel is signing with the published key"

echo
ok "cutover done — the family stack now owns Sentinel (:8787, :5434, :5514)"
say "verify it answers, then retire the duplicate:"
say "  curl -fsS http://127.0.0.1:8787/.well-known/openid-configuration  # issuer must be the real one"
say "  ontrak-sentinel/scripts/consolidate-to-family.sh --retire"

if [ "$retire" = "1" ]; then
  say "retiring the standalone project (its volumes are kept)…"
  docker compose -p "$STANDALONE_PROJECT" -f "$STANDALONE_COMPOSE" down >/dev/null
  ok "standalone containers removed; volumes $SRC_DB and $SRC_KEYS kept as the rollback"
fi
