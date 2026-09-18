#!/usr/bin/env bash
# Starting state for the access review: the leaver is still fully present, the
# joiner does not exist, and the support group has not been created.
#
# This is an *absence* fault rather than a misconfiguration — the interesting part
# is whether the student notices the orphaned files as well as the account.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

LEAVER=tom.reeves
JOINER=aisha.khan
GROUP=support

# Deterministic: the joiner and the group must not exist.
userdel -r "$JOINER" >/dev/null 2>&1 || true
groupdel "$GROUP" >/dev/null 2>&1 || true

# The leaver, complete with a home directory and files elsewhere on the machine.
if ! ontrak_user_exists "$LEAVER"; then
    useradd -m -s /bin/bash -c 'Tom Reeves' "$LEAVER"
fi
mkdir -p "/home/$LEAVER/notes" /srv/handover
printf 'handover notes from the previous operator\n' > "/home/$LEAVER/notes/handover.md"
printf 'contents of the old share\n' > /srv/handover/old-share-export.txt
chown -R "$LEAVER:$LEAVER" /srv/handover 2>/dev/null || true

ontrak_step "leaver account present: $(ontrak_user_exists "$LEAVER" && echo yes || echo no) (expected yes)"
ontrak_step "joiner account present: $(ontrak_user_exists "$JOINER" && echo yes || echo no) (expected no)"
ontrak_step "support group present:  $(ontrak_group_exists "$GROUP" && echo yes || echo no) (expected no)"
ontrak_step "orphan files under /srv: $(find /srv -xdev -nouser 2>/dev/null | wc -l) (expected 0 until the account is removed)"

# A scenario that injects nothing is worse than one that fails to build: the student
# would be handed a ticket with no fault behind it.
ontrak_require "the leaver's account exists" ontrak_user_exists "$LEAVER"
ontrak_require "the leaver has a home directory" test -d "/home/$LEAVER"
ontrak_require "the joiner's account does not exist" test ! -e "/home/$JOINER"
ontrak_require "there is something under /srv owned by the leaver" \
    test -n "$(find /srv -xdev -user "$LEAVER" 2>/dev/null | head -n 1)"

ontrak_setup_ok "leaver in place, joiner and group absent"
