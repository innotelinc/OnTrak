#!/usr/bin/env bash
# Grading. Reads the live filesystem rather than a recorded answer, so any correct
# fix passes — octal chmod, symbolic chmod, or an equivalent ACL-free repair.
#
# Contract: ontrak_check once per objective, then ontrak_report once.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

APP_DIR=/srv/app
SCRIPT_FILE="$APP_DIR/deploy.sh"
EXPORT_FILE="$APP_DIR/payroll-export.csv"
CACHE_DIR="$APP_DIR/cache"

script_mode="$(ontrak_mode_of "$SCRIPT_FILE")"
export_mode="$(ontrak_mode_of "$EXPORT_FILE")"
cache_mode="$(ontrak_mode_of "$CACHE_DIR")"
app_mode="$(ontrak_mode_of "$APP_DIR")"

# Objective: deploy-executable
# 750 exactly: the owner and group may run it, nobody else. A mode that also grants
# write to the group (770) would let a compromised group member change the nightly
# deployment, so this is checked as an exact value rather than as "has +x".
deploy_ok=false
if ontrak_perm_is 750 "$SCRIPT_FILE"; then
    deploy_ok=true
fi
ontrak_check "deploy-executable" "$deploy_ok" \
    "mode is ${script_mode:-missing} (wanted 750: owner and group run it, nobody else)"

# Objective: export-private
# 600 exactly. "Not world readable" is not enough for payroll data: the group here is
# root, so group-read means anyone who can sudo reads salaries.
export_ok=false
if ontrak_perm_is 600 "$EXPORT_FILE"; then
    export_ok=true
fi
ontrak_check "export-private" "$export_ok" \
    "mode is ${export_mode:-missing} (wanted 600: owner only)"

# Objective: cache-not-world-writable
# Two halves: write removed from "other", and the directory still traversable — a
# 700 "fix" would lock the service out and pass a naive check.
cache_ok=false
if [ -n "$cache_mode" ] && ! ontrak_world_writable "$CACHE_DIR" && ontrak_dir_traversable "$CACHE_DIR"; then
    cache_ok=true
fi
ontrak_check "cache-not-world-writable" "$cache_ok" \
    "mode is ${cache_mode:-missing} (world-writable must be gone, still traversable)"

# Objective: deploy-runs
# End-to-end: run the script the way the scheduler would, as root, with a timeout.
run_ok=false
run_detail="not executable, so it was not run"
if [ -x "$SCRIPT_FILE" ]; then
    output="$(timeout 60 "$SCRIPT_FILE" 2>&1)"
    status=$?
    if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -q 'deploy: complete'; then
        run_ok=true
        run_detail="exit 0 and reported completion"
    else
        run_detail="exit ${status}: $(printf '%s' "$output" | tail -n 2 | tr '\n' ' ')"
    fi
fi
ontrak_check "deploy-runs" "$run_ok" "$run_detail"

# Not an objective, but the ticket says "do not widen anything else". If the student
# chmod -R 777'd the directory to make the script run, the objectives above still
# fail on their own terms — this line just makes the reason legible.
if [ -n "$app_mode" ] && [ "$app_mode" != "755" ]; then
    ontrak_step "note: $APP_DIR mode is $app_mode (it was 755 before the fault)"
fi

ontrak_report
