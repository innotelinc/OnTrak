#!/usr/bin/env bash
# Grading. Three outcomes, read from the machine: the space is back, the log is
# bounded again by *some* legitimate door, and the weekend's temporary change is
# cleaned up. Two doors close the second one — rotation back where logrotate
# reads it (the durable fix) or the debug flood turned off (what stops the
# growth) — because both are defensible answers to "this cannot happen again".

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

APP_DIR=/opt/vendor-export
CONF=$APP_DIR/export.conf
LOG_DIR=/var/log/vendor-export
LOG=$LOG_DIR/export.log
ROTATE_OFF=$APP_DIR/logrotate.conf.off
MAX_BYTES=8388608

# Objective: log-space-reclaimed
# The size on disk is what "full" feels like. Truncating and rotating both fix
# it; renaming or deleting-and-recreating does not if the bytes stay allocated.
size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
if [ "$size" -le "$MAX_BYTES" ]; then
    ontrak_check "log-space-reclaimed" "true" "the flood log is ${size} bytes"
else
    ontrak_check "log-space-reclaimed" "false" "the flood log is still ${size} bytes (must be at most 8 MB)"
fi

# Objective: log-bounded
# Door one: some logrotate config names this log's directory — the durable fix,
# wherever the student put the stanza (logrotate.d or logrotate.conf itself).
# Door two: the flood is off — the service's log_level is no longer debug.
bounded=false
bounded_detail="nothing bounds the log: no rotation config names $LOG_DIR and the debug flood is still on"
rotation=""
for candidate in /etc/logrotate.d/* /etc/logrotate.conf; do
    [ -f "$candidate" ] || continue
    if ontrak_file_contains "$candidate" "$LOG_DIR"; then
        rotation="$candidate"
        break
    fi
done
if [ -n "$rotation" ]; then
    bounded=true
    bounded_detail="rotation configured for $LOG_DIR in $rotation"
elif [ -f "$CONF" ] && ! ontrak_file_contains "$CONF" 'log_level=debug'; then
    bounded=true
    bounded_detail="the flood is off: export.conf's log_level is no longer debug"
fi
ontrak_check "log-bounded" "$bounded" "$bounded_detail"

# Objective: weekend-change-undone
# The moved-aside copy: restoring it to /etc/logrotate.d clears this (door one
# above covers it too), and so does replacing it and binning the copy. Leaving
# it where it is fails this one — the ticket asked what changed and to undo it.
if [ -e "$ROTATE_OFF" ]; then
    ontrak_check "weekend-change-undone" "false" "the moved-aside copy is still at $ROTATE_OFF"
else
    ontrak_check "weekend-change-undone" "true" "the temporary change is cleaned up"
fi

# Reported but not scored: where the space actually stands, so a write-up can
# quote a number instead of an impression.
ontrak_step "free space on the log filesystem: $(ontrak_free_disk_pct "$LOG_DIR")%"

ontrak_report
