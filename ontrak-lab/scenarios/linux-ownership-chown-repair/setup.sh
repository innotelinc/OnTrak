#!/usr/bin/env bash
# Fault: a rebuild left the site tree, its log file and an old archive owned by
# root (and, for the archive, by a uid that no longer exists), while the service
# runs as www-data.
#
# Reversible by: chown -R www-data:www-data /srv/www/site
#                chown www-data /var/log/ontrak-web/app.log
#                rm /srv/www/site/uploads/old-backup.tar

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

SITE=/srv/www/site
LOG_DIR=/var/log/ontrak-web
SERVICE_USER=www-data
ORPHAN_UID=4242

# The service account exists in every Debian/Ubuntu image; create it if a minimal
# image trimmed it, so the scenario is about ownership and not about a missing user.
if ! ontrak_user_exists "$SERVICE_USER"; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
fi

mkdir -p "$SITE"/{uploads,assets,conf} "$LOG_DIR"

cat > "$SITE/index.html" <<'HTML'
<!doctype html><title>OnTrak intranet</title><h1>Intranet</h1>
HTML
printf 'body { font-family: system-ui; }\n' > "$SITE/assets/site.css"
printf 'upload_dir=%s\n' "$SITE/uploads" > "$SITE/conf/app.ini"
printf 'old backup, kept "just in case"\n' > "$SITE/uploads/old-backup.tar"

# The fault: everything root-owned, including the service's log.
chown -R root:root "$SITE"
printf 'boot: application started\n' > "$LOG_DIR/app.log"
chown root:root "$LOG_DIR/app.log"
chmod 640 "$LOG_DIR/app.log"

# An orphan: an archive belonging to a uid with no account. This is what offboarding
# without checking looks like, and you cannot chown it "back" to a name that is gone.
chown -R "$ORPHAN_UID:$ORPHAN_UID" "$SITE/uploads/old-backup.tar" 2>/dev/null || true

# Keep the documented constraint true at the start, so "permissions-intact" is
# measuring the student's repair rather than the injection.
find "$SITE" -type d -exec chmod 755 {} +
find "$SITE" -type f -exec chmod 644 {} +
chmod 640 "$LOG_DIR/app.log"

ontrak_step "site owner: $(ontrak_owner_of "$SITE") (expected root — the fault)"
ontrak_step "log owner:  $(ontrak_owner_of "$LOG_DIR/app.log") (expected root — the fault)"
ontrak_step "orphan files under $SITE: $(find "$SITE" -nouser 2>/dev/null | wc -l)"

ontrak_require "the service account exists" ontrak_user_exists "$SERVICE_USER"
ontrak_require "the site tree is root-owned" ontrak_owner_is_root "$SITE"
ontrak_require "the log file is root-owned" ontrak_owner_is_root "$LOG_DIR/app.log"
ontrak_require "there is an orphaned file to find" \
    test "$(find "$SITE" -nouser 2>/dev/null | wc -l)" -gt 0

ontrak_setup_ok "ownership injected (service runs as $SERVICE_USER, orphan uid $ORPHAN_UID)"
