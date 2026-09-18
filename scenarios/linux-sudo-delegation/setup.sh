#!/usr/bin/env bash
# Fault: an operator pasted an invalid drop-in into /etc/sudoers.d, so sudo refuses
# to run for everyone. The ops delegation they were trying to add never took effect.
#
# Reversible by: rm /etc/sudoers.d/50-helpdesk (or fixing the line),
#                then adding the ops delegation and running visudo -c.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

OPS_GROUP=ops
OPS_USER=dana.ops

if ! command -v sudo >/dev/null 2>&1; then
    # Minimal images can lack sudo entirely. apt in the lab network, or fall back to
    # the busybox/standalone path; either way the scenario needs the binary.
    (apt-get update -qq && apt-get install -y -qq sudo >/dev/null 2>&1) || true
fi

# The ops group and one member, so the delegation has somebody to be checked against.
groupadd -f "$OPS_GROUP"
if ! ontrak_user_exists "$OPS_USER"; then
    useradd -m -s /bin/bash -c 'Dana Okafor' -G "$OPS_GROUP" "$OPS_USER"
fi

mkdir -p /etc/sudoers.d
chmod 750 /etc/sudoers.d

# The broken drop-in. Two faults in one file, both realistic: a line that is not a
# valid sudoers specification, and a mode sudo will refuse to read anyway.
cat > /etc/sudoers.d/50-helpdesk <<'SUDOERS'
# Added by the helpdesk on-call, 2026-08 — "quick fix so we can restart things"
%helpdesk ALL=(root) NOPASSWD: /usr/bin/systemctl
%helpdesk ALL=(root) NOPASSWD /usr/bin/journalctl
SUDOERS
chmod 644 /etc/sudoers.d/50-helpdesk

# Confirm the fault is observable: visudo must fail, and sudo must refuse.
if visudo -c -q >/dev/null 2>&1; then
    ontrak_step "WARNING: visudo still passes; the syntax fault was not applied"
else
    ontrak_step "confirmed: visudo rejects the policy"
fi

ontrak_step "sudo -l output: $(sudo -n -l 2>&1 | head -n 1)"

# The scenario is only honest if the file that exists is the file that breaks sudo.
ontrak_require "the broken drop-in exists" test -s /etc/sudoers.d/50-helpdesk
ontrak_require "the sudo policy is rejected by visudo" bash -c '! visudo -c -q >/dev/null 2>&1'
ontrak_require "the ops group exists" ontrak_group_exists "$OPS_GROUP"
ontrak_require "the ops user exists" ontrak_user_exists "$OPS_USER"
ontrak_require "no ops delegation is in place yet" \
    test "$(grep -rl 'ops ALL' /etc/sudoers.d 2>/dev/null | wc -l)" = "0"

ontrak_setup_ok "sudoers broken in /etc/sudoers.d/50-helpdesk; ops delegation absent"
