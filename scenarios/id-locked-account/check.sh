#!/usr/bin/env bash
# Grading. Reads the directory itself, so any correct sequence of commands passes —
# the CLI, the HTTP API, or editing the state file by hand.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

IDP_STATE=/var/lib/ontrak-idp/directory.json
IDP_PY="$(cd "$(dirname "$0")/../.." && pwd)/lib/idp.py"
IDP="python3 $IDP_PY --state $IDP_STATE"

USER_ID=aisha.khan

# Objective: account-unlocked
# Active *and* with the counter cleared: an account left at 5 failed attempts re-locks
# on the next typo, which is the difference between "unlocked" and "fixed".
status="$($IDP status "$USER_ID" 2>/dev/null)"
attempts="$(python3 -c "
import json, sys
try:
    data = json.load(open('$IDP_STATE'))
except Exception:
    print('?'); sys.exit()
user = next((u for u in data.get('users', []) if u.get('id') == '$USER_ID'), None)
print(user.get('failed_attempts', '?') if user else 'missing')
" 2>/dev/null)"
unlocked=false
if [ "$status" = "active" ] && [ "$attempts" = "0" ]; then
    unlocked=true
fi
ontrak_check "account-unlocked" "$unlocked" \
    "status=${status:-missing} failed_attempts=${attempts:-?} (needs active and 0)"

# Objective: memberships-intact
# The unlock must not have cost her access. This catches "delete and recreate", which
# looks like a fix and silently removes two group memberships.
missing_groups=""
for group in finance finance-reporting; do
    $IDP in-group "$USER_ID" "$group" >/dev/null 2>&1 || missing_groups="$missing_groups $group"
done
ontrak_check "memberships-intact" "$([ -z "$missing_groups" ] && echo true || echo false)" \
    "$([ -z "$missing_groups" ] && echo 'finance and finance-reporting both present' || printf 'no longer in:%s' "$missing_groups")"

# Objective: stale-session-revoked
# No live session for the account at all — revoked, expired or removed are all fine.
active="$($IDP has-active-session "$USER_ID" 2>/dev/null)"
ontrak_check "stale-session-revoked" "$([ "$active" = "no" ] && echo true || echo false)" \
    "a session is still live: ${active:-unknown} (list-sessions / revoke-session)"

# Objective: change-audited
# An unlock recorded with a reason of at least five characters. The reason is the point:
# "unlock" with no reason is not an audit trail an identity review accepts.
audited="$(python3 $IDP_PY --state "$IDP_STATE" audit-count \
    --action unlock --target "$USER_ID" --min-reason 5 2>/dev/null)"
ontrak_check "change-audited" "$([ "${audited:-0}" -ge 1 ] && echo true || echo false)" \
    "unlock audit entries with a reason: ${audited:-0} (pass --reason when you change access)"

ontrak_report
