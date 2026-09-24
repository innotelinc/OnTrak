#!/usr/bin/env bash
# Fault: the log flood nobody rotated.
#
# A vendor's debugging session on Saturday turned the export service's logging
# up to debug "temporarily" and — so the log would be kept while they looked at
# it — the rotation config for that log was moved out of /etc/logrotate.d. The
# debugging finished; neither change was put back. The log grew until the
# filesystem holding /var/log was full, and the nightly export to the file
# server has failed every night since with "No space left on device".
#
# Reversible by: truncating or rotating /var/log/vendor-export/export.log
#                restoring /etc/logrotate.d/vendor-export (or an equivalent)
#                returning export.conf's log_level to its normal value
#
# The flood is simulated at a size a lab filesystem can carry (32 MB, not the
# 32 GB of the story). The mechanism — an unbounded log and the full disk it
# causes — is the real one.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

APP_DIR=/opt/vendor-export
CONF=$APP_DIR/export.conf
LOG_DIR=/var/log/vendor-export
LOG=$LOG_DIR/export.log
ROTATE_LIVE=/etc/logrotate.d/vendor-export
ROTATE_OFF=$APP_DIR/logrotate.conf.off
FLOOD_MB=32

# Deterministic starting point even if the template was built twice.
rm -rf "$APP_DIR" "$LOG_DIR"
rm -f "$ROTATE_LIVE"
mkdir -p "$APP_DIR" "$LOG_DIR" /etc/logrotate.d

# The service's configuration. log_level=debug *is* the weekend's change.
cat > "$CONF" <<'CONF'
# vendor-export — the nightly export to fileserver.ontrak.lab
destination=fileserver.ontrak.lab:/exports
schedule=02:15
log_level=debug
CONF

# ...and the rotation config it depends on, moved aside "temporarily" to keep the
# log whole while the debugging happened. This is the file the ticket is about:
# correct, complete, and sitting where logrotate will never read it.
cat > "$ROTATE_OFF" <<'ROTATE'
/var/log/vendor-export/export.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
}
ROTATE

# The flood: days of debug logging that nobody rotated.
printf '2026-09-20 02:15:00 INFO export started\n' > "$LOG"
head -c "$((FLOOD_MB * 1024 * 1024))" /dev/zero | tr '\000' 'x' >> "$LOG"
chown root:root "$CONF" "$ROTATE_OFF" "$LOG"
chmod 644 "$CONF" "$ROTATE_OFF"
chmod 640 "$LOG"

ontrak_step "flood log: $(du -h "$LOG" | cut -f1) at $LOG"
ontrak_step "log_level in $CONF: $(grep '^log_level=' "$CONF")"
ontrak_step "rotation config: $(ontrak_file_exists "$ROTATE_LIVE" && echo in place || echo "moved aside to $ROTATE_OFF")"
ontrak_step "free space on the log filesystem: $(ontrak_free_disk_pct "$LOG_DIR")%"

ontrak_require "the flood log is in place and large" \
    test "$(stat -c %s "$LOG")" -gt "$((FLOOD_MB * 1024 * 1024 / 2))"
ontrak_require "the rotation config is out of logrotate's reach" \
    test -f "$ROTATE_OFF" -a ! -e "$ROTATE_LIVE"
ontrak_require "the debug flood is on" ontrak_file_contains "$CONF" 'log_level=debug'

ontrak_setup_ok "unrotated flood log left behind; the weekend's temporary changes are both still in place"
