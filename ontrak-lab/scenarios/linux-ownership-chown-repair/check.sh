#!/usr/bin/env bash
# Grading. Reads ownership off the filesystem, so a recursive chown, a per-file
# chown or a re-own-then-remove all pass.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

SITE=/srv/www/site
LOG_FILE=/var/log/ontrak-web/app.log
SERVICE_USER=www-data

# Objective: site-owned-by-service
# Every entry below the tree, directories and files alike. `find -not -user` is the
# audit query a reviewer would run, so it is the one the grade uses.
stray="$(find "$SITE" -not -user "$SERVICE_USER" 2>/dev/null | head -n 20)"
stray_count="$(printf '%s\n' "$stray" | grep -c . || true)"
site_ok=false
if [ -d "$SITE" ] && [ -z "$stray" ]; then
    site_ok=true
fi
ontrak_check "site-owned-by-service" "$site_ok" \
    "entries not owned by ${SERVICE_USER}: ${stray_count}$( [ "$stray_count" -gt 0 ] && printf ' (e.g. %s)' "$(printf '%s' "$stray" | head -n 1)" )"

# Objective: log-owned-by-service
log_owner="$(ontrak_owner_of "$LOG_FILE")"
log_mode="$(ontrak_mode_of "$LOG_FILE")"
log_ok=false
if [ "$log_owner" = "$SERVICE_USER" ] && [ -n "$log_mode" ] && ! ontrak_world_writable "$LOG_FILE"; then
    log_ok=true
fi
ontrak_check "log-owned-by-service" "$log_ok" \
    "owner=${log_owner:-missing} mode=${log_mode:-missing} (wanted owner ${SERVICE_USER}, not world-writable)"

# Objective: no-orphan-files
# `-nouser` finds entries whose uid has no account. Either repairing or deleting the
# archive is a legitimate answer to "this belongs to someone who left".
orphans="$(find "$SITE" \( -nouser -o -nogroup \) 2>/dev/null | head -n 20)"
orphan_count="$(printf '%s\n' "$orphans" | grep -c . || true)"
ontrak_check "no-orphan-files" "$([ "$orphan_count" -eq 0 ] && echo true || echo false)" \
    "orphaned entries: ${orphan_count}$( [ "$orphan_count" -gt 0 ] && printf ' (e.g. %s)' "$(printf '%s' "$orphans" | head -n 1)" )"

# Objective: permissions-intact
# The ticket's constraint: the service gets access by ownership, not by opening the
# mode. The directory stays traversable and nothing becomes world-writable.
site_mode="$(ontrak_mode_of "$SITE")"
world_writable="$(find "$SITE" -perm -o+w 2>/dev/null | head -n 10)"
perms_ok=false
if ontrak_perm_is 755 "$SITE" && [ -z "$world_writable" ]; then
    perms_ok=true
fi
ontrak_check "permissions-intact" "$perms_ok" \
    "site mode=${site_mode:-missing} (wanted 755), world-writable entries=$(printf '%s\n' "$world_writable" | grep -c . || true)"

ontrak_report
