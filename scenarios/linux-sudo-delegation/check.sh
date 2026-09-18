#!/usr/bin/env bash
# Grading. Validates the policy as sudo itself would, then reads the *effective*
# rule set for a member of ops, so any correct arrangement passes: one drop-in, a
# group rule, or a per-user rule.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

OPS_USER=dana.ops
SUDOERS_DIR=/etc/sudoers.d

# Objective: sudoers-valid
visudo_out="$(visudo -c 2>&1)"
visudo_status=$?
ontrak_check "sudoers-valid" "$([ "$visudo_status" -eq 0 ] && echo true || echo false)" \
    "$(printf '%s' "$visudo_out" | tail -n 2 | tr '\n' ' ')"

# Objective: delegation-present
# The effective policy for a real member of the group. This is the check a reviewer
# would run, and it is deliberately not a grep of the file the student was told to
# write: a rule in the wrong file, or with the wrong mode, does not work in sudo and
# must not earn marks here.
delegation_ok=false
delegation_detail="sudo cannot evaluate the policy"
if [ "$visudo_status" -eq 0 ] && command -v sudo >/dev/null 2>&1; then
    policy="$(sudo -n -l -U "$OPS_USER" 2>&1)"
    if printf '%s' "$policy" | grep -Eq 'NOPASSWD:.*systemctl[[:space:]]+restart[[:space:]]+nginx'; then
        delegation_ok=true
        delegation_detail="ops may restart nginx without a password"
    else
        match="$(printf '%s' "$policy" | grep -i 'systemctl' | head -n 1)"
        if [ -n "$match" ]; then
            delegation_detail="systemctl is delegated but not 'restart nginx' as NOPASSWD: ${match}"
        else
            delegation_detail="no systemctl rule for $OPS_USER"
        fi
    fi
fi
ontrak_check "delegation-present" "$delegation_ok" "$delegation_detail"

# Objective: no-blanket-rule
# A blanket NOPASSWD:ALL is the shortcut this scenario exists to catch. Both the
# classic (ALL) and command form are matched.
blanket="$(grep -rEn 'NOPASSWD:[[:space:]]*ALL|NOPASSWD:[[:space:]]+/[^,]*\*|\(ALL\)[[:space:]]+ALL' \
    /etc/sudoers "$SUDOERS_DIR" 2>/dev/null | grep -v '^Binary' | head -n 5)"
ontrak_check "no-blanket-rule" "$([ -z "$blanket" ] && echo true || echo false)" \
    "$([ -z "$blanket" ] && echo 'no blanket ALL rule present' || printf 'blanket rule: %s' "$(printf '%s' "$blanket" | head -n 1)")"

# Objective: dropin-hygiene
# Every real drop-in must be 0440 and free of a dot in its name, or sudo ignores it —
# which students experience as "my rule did not work" with no error. README (shipped
# by the distribution at 0644) and dotfiles are excluded because sudo ignores them
# by design.
bad_dropins=""
for file in "$SUDOERS_DIR"/*; do
    [ -e "$file" ] || continue
    name="$(basename "$file")"
    case "$name" in
        README|.*) continue ;;
    esac
    mode="$(ontrak_mode_of "$file")"
    if [ "$mode" != "440" ] || case "$name" in *.*) true ;; *) false ;; esac; then
        bad_dropins="$bad_dropins ${name}(${mode})"
    fi
done
ontrak_check "dropin-hygiene" "$([ -z "$bad_dropins" ] && echo true || echo false)" \
    "$([ -z "$bad_dropins" ] && echo 'every drop-in is 0440 with a sudo-safe name' || printf 'not 0440 or not a valid drop-in name:%s' "$bad_dropins")"

ontrak_report
