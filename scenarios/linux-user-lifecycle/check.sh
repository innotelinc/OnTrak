#!/usr/bin/env bash
# Grading. Uses the account database and the filesystem, so any correct sequence
# passes — useradd/usermod, or an equivalent edit of the system files.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

LEAVER=tom.reeves
JOINER=aisha.khan
GROUP=support

# Objective: joiner-created
# Three things, not one: the account, a home directory that actually exists, and a
# login shell. `useradd` without -m is the classic half-done answer.
joiner_detail="account does not exist"
joiner_ok=false
if ontrak_user_exists "$JOINER"; then
    home="$(ontrak_user_home "$JOINER")"
    shell="$(ontrak_user_shell "$JOINER")"
    if [ -n "$home" ] && [ -d "$home" ] && [ -n "$shell" ] && [ "$shell" != "/usr/sbin/nologin" ] && [ "$shell" != "/bin/false" ]; then
        joiner_ok=true
        joiner_detail="account with home $home and shell $shell"
    else
        joiner_detail="account exists but home=${home:-none} (exists: $([ -n "$home" ] && [ -d "$home" ] && echo yes || echo no)) shell=${shell:-none}"
    fi
fi
ontrak_check "joiner-created" "$joiner_ok" "$joiner_detail"

# Objective: group-membership
groups_of="$(id -nG "$JOINER" 2>/dev/null | tr ' ' ',')"
ontrak_check "group-membership" "$(ontrak_user_in_group "$JOINER" "$GROUP" && echo true || echo false)" \
    "$JOINER is in: ${groups_of:-no account} (needs ${GROUP})"

# Objective: leaver-removed
ontrak_check "leaver-removed" "$(ontrak_user_exists "$LEAVER" && echo false || echo true)" \
    "$(ontrak_user_exists "$LEAVER" && echo 'account still exists' || echo 'account gone (id fails)')"

# Objective: no-orphan-files
# Files owned by a uid with no account. The leaver's home and the handover share
# both qualify once the account is deleted, which is exactly why the ticket asks
# about them.
orphans="$(find /srv -xdev \( -nouser -o -nogroup \) 2>/dev/null | head -n 20)"
orphan_count="$(printf '%s\n' "$orphans" | grep -c . || true)"
ontrak_check "no-orphan-files" "$([ "$orphan_count" -eq 0 ] && echo true || echo false)" \
    "orphaned entries under /srv: ${orphan_count}$( [ "$orphan_count" -gt 0 ] && printf ' (e.g. %s)' "$(printf '%s' "$orphans" | head -n 1)" )"

# Reported, not scored: a locked account that still exists is the answer this ticket
# is designed to catch, and the student should see why it fails.
if ontrak_user_exists "$LEAVER" && ontrak_user_locked "$LEAVER"; then
    ontrak_step "note: $LEAVER exists but is locked — offboarding is a removal, not a lock"
fi

ontrak_report
