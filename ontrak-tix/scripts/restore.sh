#!/usr/bin/env bash
#
# OnTrak Tix — database restore.
#
# The other half of `backup.sh`, and written to the same rule: it verifies before
# it touches anything, and it refuses to run by accident.
#
#   DATABASE_URL=postgresql://… scripts/restore.sh backups/ontrak-tix-…dump [--yes]
#
# A restore is destructive — it drops and rebuilds the objects it finds — so it
# asks for `--yes` unless `ONTRAK_TIX_RESTORE_CONFIRM=1` is set. That is not
# ceremony: the runbook's whole point is that restoring is a decision somebody
# made, at a moment they can point to, not a command that was in the history.
#
# Exit codes:
#   0  restored
#   1  refused or could not run (no DATABASE_URL, no checksum, confirmation missing)
#   2  pg_restore reported an inconsistent result

set -euo pipefail

DUMP="${1:-}"
shift || true
CONFIRM=0
for arg in "$@"; do
  [[ "$arg" == "--yes" ]] && CONFIRM=1
done

if [[ -z "$DUMP" ]]; then
  echo "usage: restore.sh <path-to-.dump> [--yes]" >&2
  exit 1
fi
if [[ ! -f "$DUMP" ]]; then
  echo "restore: no such file: ${DUMP}" >&2
  exit 1
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "restore: DATABASE_URL is not set" >&2
  exit 1
fi

# Verify the dump against the checksum `backup.sh` left beside it, when it is
# there. A dump without a checksum can still be restored, but it is said out loud
# rather than passed over in silence: the difference between "verified" and "we
# hoped" matters most at the moment somebody is restoring.
SUM="${DUMP%.dump}.sha256"
if [[ -f "$SUM" ]]; then
  if ! (cd "$(dirname "$DUMP")" && sha256sum --check --status "$(basename "$SUM")"); then
    echo "restore: the dump does not match ${SUM}; refusing to restore a corrupt backup" >&2
    exit 1
  fi
  echo "restore: checksum verified against $(basename "$SUM")"
else
  echo "restore: WARNING — no checksum file beside the dump; the file is unverified" >&2
fi

if [[ "$CONFIRM" != "1" && "${ONTRAK_TIX_RESTORE_CONFIRM:-0}" != "1" ]]; then
  echo "restore: this drops and rebuilds objects in the target database." >&2
  echo "restore: re-run with --yes (or set ONTRAK_TIX_RESTORE_CONFIRM=1) to proceed." >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "restore: pg_restore is not on PATH (install the postgresql-client package)" >&2
  exit 1
fi

echo "restore: restoring ${DUMP}"
# `--clean --if-exists` makes the restore idempotent against a database that
# already has the schema — a re-run is a re-run, not a pile of duplicate-object
# errors that hide the real one. `--single-transaction` means a failure leaves the
# database as it was rather than half-restored.
if ! pg_restore --clean --if-exists --no-owner --no-privileges \
  --single-transaction --dbname "$DATABASE_URL" "$DUMP"; then
  echo "restore: pg_restore reported an error" >&2
  exit 2
fi

echo "restore: ok — run 'npx prisma migrate deploy' if the dump predates a migration"
