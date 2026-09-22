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
SUDOERS_DIR=/etc/sudoers.d

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

mkdir -p "$SUDOERS_DIR"
chmod 750 "$SUDOERS_DIR"

# The broken drop-in. Two faults in one file, both realistic: a line that is not a
# valid sudoers specification, and a mode sudo will refuse to read anyway.
cat > "$SUDOERS_DIR/50-helpdesk" <<'SUDOERS'
# Added by the helpdesk on-call, 2026-08 — "quick fix so we can restart things"
%helpdesk ALL=(root) NOPASSWD: /usr/bin/systemctl
%helpdesk ALL=(root) NOPASSWD /usr/bin/journalctl
SUDOERS
chmod 644 "$SUDOERS_DIR/50-helpdesk"

# Confirm the fault is observable: visudo must fail, and sudo must refuse.
if visudo -c -q >/dev/null 2>&1; then
    ontrak_step "WARNING: visudo still passes; the syntax fault was not applied"
else
    ontrak_step "confirmed: visudo rejects the policy"
fi

ontrak_step "sudo -l output: $(sudo -n -l 2>&1 | head -n 1)"

# What the image already grants, recorded before the student touches anything.
#
# ``no-blanket-rule`` exists to catch the shortcut this scenario is about — "give
# them everything" instead of one delegated command. But the images *ship* that
# shape: Ubuntu's /etc/sudoers grants `%admin ALL=(ALL) ALL`, and the Incus image
# adds `ubuntu ALL=(ALL) NOPASSWD:ALL` in /etc/sudoers.d/90-incus. A check that
# scans the policy and reports every match therefore fails a student who did the
# work perfectly, and tells them they wrote a rule they have never seen.
#
# So the state of the policy *before* the exercise is recorded here, beside the
# scripts, and grading judges the difference. Same idea as the Windows scenarios
# recording Defender's real state for the check to report honestly.
BLANKET_PATTERN='NOPASSWD:[[:space:]]*ALL|NOPASSWD:[[:space:]]+/[^,]*\*|\(ALL\)[[:space:]]+ALL'
BLANKET_BASELINE="$(cd "$(dirname "$0")" && pwd)/blanket-baseline.txt"

# Asserted on its own line rather than inline in the pipeline below. In a pipeline
# the failing stage is a subshell: an unbound variable there kills only that stage,
# the pipeline still "succeeds", the redirect leaves an empty baseline, and the
# check reads that as "this image ships no blanket rules" — the false positive comes
# straight back, behind a build that reported success. This runs in *this* shell, so
# a mistake stops the build instead.
: "${SUDOERS_DIR:?the sudo drop-in directory}"
# LC_ALL=C on both sides of the comparison: `comm` needs one collation, and the
# build and the grading run are not guaranteed to agree on a locale.
grep -rEn "$BLANKET_PATTERN" /etc/sudoers "$SUDOERS_DIR" 2>/dev/null |
    grep -v '^Binary' | LC_ALL=C sort >"$BLANKET_BASELINE"
ontrak_step "blanket rules the image already had: $(wc -l <"$BLANKET_BASELINE" | tr -d ' ') ($(head -n 1 "$BLANKET_BASELINE"))"

# The scenario is only honest if the file that exists is the file that breaks sudo.
ontrak_require "the broken drop-in exists" test -s /etc/sudoers.d/50-helpdesk
ontrak_require "the sudo policy is rejected by visudo" bash -c '! visudo -c -q >/dev/null 2>&1'
ontrak_require "the ops group exists" ontrak_group_exists "$OPS_GROUP"
ontrak_require "the ops user exists" ontrak_user_exists "$OPS_USER"
ontrak_require "no ops delegation is in place yet" \
    test "$(grep -rl 'ops ALL' "$SUDOERS_DIR" 2>/dev/null | wc -l)" = "0"

ontrak_setup_ok "sudoers broken in /etc/sudoers.d/50-helpdesk; ops delegation absent"
