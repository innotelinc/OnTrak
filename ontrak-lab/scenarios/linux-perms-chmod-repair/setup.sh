#!/usr/bin/env bash
# Fault: a restore dropped the executable bit from the deployment script, left a
# payroll export world-readable, and a careless installer created a cache directory
# as 0777.
#
# Reversible by: chmod 750 deploy.sh, chmod 600 payroll-export.csv,
#                chmod 755 cache
#
# Run as root inside the Linux guest. Contract: inject the fault, confirm it, then
# print ONTRAK-SETUP-OK (via ontrak_setup_ok).

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

APP_DIR=/srv/app

mkdir -p "$APP_DIR/cache"

# --- the deployment script: present, correct content, missing the execute bit ---
cat > "$APP_DIR/deploy.sh" <<'SCRIPT'
#!/usr/bin/env bash
# Nightly deployment for the alpha service.
set -euo pipefail
echo "deploy: starting"
mkdir -p /srv/app/releases
echo "deploy: complete"
SCRIPT
chmod 644 "$APP_DIR/deploy.sh"

# --- the payroll export: data about people, readable by everyone ---
cat > "$APP_DIR/payroll-export.csv" <<'CSV'
employee_id,name,gross_pay
1001,Aisha Khan,41250.00
1002,Tom Reeves,38900.00
CSV
chmod 644 "$APP_DIR/payroll-export.csv"

# --- the cache directory created by an installer as 0777 ---
echo "cache: placeholder" > "$APP_DIR/cache/.keep"
chmod 777 "$APP_DIR/cache"

# The directory itself must stay 755: that is the "do not widen anything else"
# constraint in the ticket, and the check script verifies it is unchanged.
chmod 755 "$APP_DIR"

ontrak_step "deploy.sh mode: $(ontrak_mode_of "$APP_DIR/deploy.sh") (expected 644)"
ontrak_step "export mode:    $(ontrak_mode_of "$APP_DIR/payroll-export.csv") (expected 644)"
ontrak_step "cache mode:     $(ontrak_mode_of "$APP_DIR/cache") (expected 777)"

# Confirm the fault is real: the broken script must not run for us either, and the
# other two have to be in the state the ticket describes.
ontrak_require "deploy.sh is not executable" test ! -x "$APP_DIR/deploy.sh"
ontrak_require "deploy.sh is 644" ontrak_perm_is 644 "$APP_DIR/deploy.sh"
ontrak_require "the export is world-readable" ontrak_world_readable "$APP_DIR/payroll-export.csv"
ontrak_require "the cache directory is world-writable" ontrak_world_writable "$APP_DIR/cache"
ontrak_require "the app directory is 755" ontrak_perm_is 755 "$APP_DIR"
ontrak_step "confirmed: all three permissions are in their broken state"

ontrak_setup_ok "perms injected in $APP_DIR"
