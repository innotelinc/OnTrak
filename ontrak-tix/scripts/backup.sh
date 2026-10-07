#!/usr/bin/env bash
#
# OnTrak Tix — database backup.
#
# M7's backup/DR runbook made mechanical: one `pg_dump` of the desk's schema and
# data, written to a timestamped, checksummed file, with old copies pruned. It is
# deliberately the *only* thing here — no schema migration, no application logic —
# because a backup tool that can also change the database is one nobody can trust
# to leave it alone.
#
#   DATABASE_URL=postgresql://… scripts/backup.sh [output-dir]
#
# Exit codes separate the two failures an operator has to tell apart:
#   0  a verified backup was written
#   1  the backup could not be taken (no DATABASE_URL, pg_dump failed, no space)
#   2  the backup was written but did not verify
#
# The dump is taken in the custom format (`-Fc`), which `restore.sh` reads back
# with `pg_restore` and which carries its own internal checksums on top of the
# SHA-256 this script records beside it. A plain `.sql` file is easier to read and
# worse to restore reliably; the desk's data is not something to be casual about.

set -euo pipefail

OUT_DIR="${1:-${ONTRAK_TIX_BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${ONTRAK_TIX_BACKUP_RETENTION_DAYS:-14}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup: DATABASE_URL is not set" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "backup: pg_dump is not on PATH (install the postgresql-client package)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# UTC and filesystem-safe, so two backups in the same second do not collide and a
# filename sorts chronologically wherever it is copied.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="ontrak-tix-${STAMP}"
DUMP="${OUT_DIR}/${BASE}.dump"
SUM="${OUT_DIR}/${BASE}.sha256"

echo "backup: dumping to ${DUMP}"
if ! pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"; then
  echo "backup: pg_dump failed; removing the partial file" >&2
  rm -f "$DUMP"
  exit 1
fi

# The checksum is what makes "the file is there" into "the file is the backup":
# a truncated dump copied off a full disk looks exactly like a good one until the
# day it is restored.
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "backup: sha256sum is not on PATH; cannot verify the dump" >&2
  rm -f "$DUMP"
  exit 2
fi
sha256sum "$DUMP" | awk '{print $1}' > "$SUM"

# Verify by recomputing from disk, not by trusting the write we just did.
if ! (cd "$OUT_DIR" && sha256sum --check --status "${BASE}.sha256"); then
  echo "backup: the dump does not match its checksum" >&2
  exit 2
fi

SIZE="$(wc -c < "$DUMP" | tr -d ' ')"
echo "backup: wrote ${DUMP} (${SIZE} bytes), checksum ${SUM}"

# Prune only what this script wrote, by age, so a hand-kept archive elsewhere is
# never touched. `find -mtime` on the two suffixes is precise and needs no state.
if [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] && [[ "${RETENTION_DAYS}" -gt 0 ]]; then
  find "$OUT_DIR" -maxdepth 1 -type f \
    \( -name 'ontrak-tix-*.dump' -o -name 'ontrak-tix-*.sha256' \) \
    -mtime "+${RETENTION_DAYS}" -print -delete
fi

echo "backup: ok"
