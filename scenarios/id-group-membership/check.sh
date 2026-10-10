#!/usr/bin/env bash
# Grading. Four facts about the directory, read from the directory itself.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

IDP_STATE=/var/lib/ontrak-idp/directory.json
IDP_PY="$(cd "$(dirname "$0")/../.." && pwd)/lib/idp.py"
IDP="python3 $IDP_PY --state $IDP_STATE"

MOVERS=marco.silva
CONTRACTOR=c.nguyen

# Objective: added-to-new-group
$IDP in-group "$MOVERS" finance >/dev/null 2>&1
added=$?
memberships="$($IDP show-user "$MOVERS" 2>/dev/null | grep -i '^groups:' | tr '\n' ' ')"
ontrak_check "added-to-new-group" "$([ "$added" -eq 0 ] && echo true || echo false)" \
    "${MOVERS}: ${memberships:-no such account}"

# Objective: removed-from-old-group
$IDP in-group "$MOVERS" warehouse >/dev/null 2>&1
still_in=$?
ontrak_check "removed-from-old-group" "$([ "$still_in" -ne 0 ] && echo true || echo false)" \
    "$([ "$still_in" -ne 0 ] && echo 'warehouse access removed' || echo 'still a member of warehouse')"

# Objective: kept-required-group
# The third fact, and the one that catches an over-eager clean-up: he still needs
# finance-reporting, so removing both groups is as wrong as removing neither.
$IDP in-group "$MOVERS" finance-reporting >/dev/null 2>&1
kept=$?
ontrak_check "kept-required-group" "$([ "$kept" -eq 0 ] && echo true || echo false)" \
    "$([ "$kept" -eq 0 ] && echo 'finance-reporting still present' || echo 'finance-reporting was removed as well')"

# Objective: contractor-disabled
# Disabled, specifically. A locked account is a hold that anyone with the right console
# rights can lift, which is not what a finished contract means.
status="$($IDP status "$CONTRACTOR" 2>/dev/null)"
ontrak_check "contractor-disabled" "$([ "$status" = "disabled" ] && echo true || echo false)" \
    "${CONTRACTOR} status=${status:-missing} (needs disabled; locked is a hold, not an offboarding)"

# Reported, not scored: the review is easier to trust when the changes carry reasons.
reasoned="$(python3 $IDP_PY --state "$IDP_STATE" audit-count --min-reason 10 2>/dev/null)"
if [ "${reasoned:-0}" -eq 0 ]; then
    ontrak_step "note: no audit entry has a reason yet — pass --reason when you change access"
fi

ontrak_report
