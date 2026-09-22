#!/usr/bin/env bash
# ontrak-common.sh
#
# Shared helpers for OnTrak scenarios that target Linux guests. Source it at the
# top of every setup.sh / check.sh:
#
#     . "$(dirname "$0")/../../lib/ontrak-common.sh"
#
# Contract (identical to the PowerShell library, so the grader, the scoring maths
# and the ticket rubric are platform-independent):
#   * check.sh calls `ontrak_check <objective> <true|false> "<detail>"` once per
#     objective declared in scenario.yaml, then `ontrak_report` exactly once.
#   * setup.sh ends with `ontrak_setup_ok`. The template build refuses to snapshot
#     a scenario whose setup did not confirm success, so a half-applied fault can
#     never reach a student.
#
# Everything here is POSIX-ish bash with no dependencies beyond coreutils,
# shadow-utils and procps, which every distribution in the catalogue ships.

# Must match ontrak/scenarios.py
ONTRAK_JSON_BEGIN='###ONTRAK-JSON-BEGIN###'
ONTRAK_JSON_END='###ONTRAK-JSON-END###'
ONTRAK_SETUP_OK_MARKER='ONTRAK-SETUP-OK'

# Where this library was sourced from, captured while the shell still knows
# (the caller's $0 is the scenario script, not this file). The marker file
# therefore lands in the guest's work directory, next to lib/ and scenarios/.
_ontrak_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONTRAK_SETUP_OK_FILE="${_ontrak_lib_dir%/lib}/setup-ok.txt"

_ONTRAK_CHECKS=()

# ---------------------------------------------------------------- reporting --
ontrak_step() {
    # Progress line. Safe on stdout: the grader only reads between the markers.
    printf '[ontrak] %s\n' "$*"
}

ontrak_check() {
    # ontrak_check <objective-id> <true|false> [detail]
    local objective="$1" passed="$2" detail="${3:-}"
    case "$(printf '%s' "$passed" | tr '[:upper:]' '[:lower:]')" in
        true|yes|1|pass|passed) passed='true' ;;
        *) passed='false' ;;
    esac
    _ONTRAK_CHECKS+=("${objective}|${passed}|${detail}")
}

_ontrak_json_escape() {
    # Escape a string for a JSON document. Newlines/tabs/CRs are flattened: a
    # multi-line detail would otherwise have to survive a payload the grader
    # parses with json.loads(), and a stray control character there costs the
    # whole attempt.
    awk 'BEGIN {
        while ((getline line) > 0) {
            if (NR > 1) printf "\\n"
            gsub(/\\/, "\\\\", line)
            gsub(/"/, "\\\"", line)
            gsub(/\t/, " ", line)
            gsub(/\r/, "", line)
            printf "%s", line
        }
    }'
}

ontrak_report() {
    # Emit the grading payload between the markers. Must be called exactly once.
    local entry objective passed detail first=1
    printf '%s\n' "$ONTRAK_JSON_BEGIN"
    printf '{"checks":['
    for entry in "${_ONTRAK_CHECKS[@]:-}"; do
        [ -z "$entry" ] && continue
        objective="${entry%%|*}"
        rest="${entry#*|}"
        passed="${rest%%|*}"
        detail="${rest#*|}"
        [ "$first" -eq 0 ] && printf ','
        first=0
        printf '{"objective":"%s","passed":%s,"detail":"%s"}' \
            "$(printf '%s' "$objective" | _ontrak_json_escape)" \
            "$passed" \
            "$(printf '%s' "$detail" | _ontrak_json_escape)"
    done
    printf ']}\n'
    printf '%s\n' "$ONTRAK_JSON_END"
}

ontrak_setup_ok() {
    # Confirm fault injection finished. Required at the end of setup.sh.
    #
    # The confirmation is written twice on purpose: to stdout, where the template
    # build reads it, and to a file beside this library. A scenario is allowed to
    # break the transport it is being injected over -- a fault that re-addresses
    # the interface can end the very session running this script -- so the file is
    # what the build falls back to when stdout never arrives.
    [ -n "${1:-}" ] && printf 'setup note: %s\n' "$1"
    printf '%s\n' "$ONTRAK_SETUP_OK_MARKER"
    {
        printf '%s\n' "$ONTRAK_SETUP_OK_MARKER"
        [ -n "${1:-}" ] && printf '%s\n' "$1"
    } >"$ONTRAK_SETUP_OK_FILE" 2>/dev/null || true
    return 0
}

ontrak_require() {
    # ontrak_require "<what should be true>" <command> [args...]
    #
    # Abort *without* printing the success marker. The template build refuses to
    # snapshot a scenario whose setup did not confirm, so a fault that could not be
    # injected fails the build instead of reaching a student as an unfixable ticket.
    local description="${1:-}"
    shift
    if "$@"; then
        return 0
    fi
    printf '[ontrak] injection failed: %s\n' "$description" >&2
    printf '[ontrak] the fault was NOT applied; not reporting setup success\n' >&2
    exit 1
}

# -------------------------------------------------------------------- files --
ontrak_file_exists() {
    [ -f "${1:-}" ]
}

ontrak_dir_exists() {
    [ -d "${1:-}" ]
}

ontrak_file_contains() {
    # ontrak_file_contains <path> <extended-regex>
    [ -f "${1:-}" ] && grep -Eq -- "${2:-}" "$1"
}

ontrak_dir_empty() {
    [ -d "${1:-}" ] && [ -z "$(ls -A "$1" 2>/dev/null)" ]
}

ontrak_free_disk_pct() {
    # Percentage of free space on the filesystem holding $1.
    local target="${1:-/}"
    df -P "$target" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print 100-$5}'
}

# -------------------------------------------------------------- permissions --
ontrak_mode_of() {
    # Octal permission bits, e.g. 644. Uses stat so it is correct on every ls
    # variant (busybox ls, GNU ls and BSD ls disagree on --format).
    stat -c '%a' "${1:-}" 2>/dev/null
}

ontrak_perm_is() {
    # ontrak_perm_is <path> <octal> — mode matches exactly.
    local want="${1:-}" got
    got="$(ontrak_mode_of "${2:-$1}")"
    [ -n "$got" ] || return 1
    # Compare the low three digits: a setuid/setgid/sticky bit should not make a
    # 755 directory look wrong.
    [ "$((10#${got: -3}))" = "$((10#$want))" ]
}

ontrak_world_writable() {
    # True when "other" has write permission (the classic 777 audit finding).
    # The bits are 4/2/1, so write is bit 2 of the last octal digit: 5 (r-x) is *not*
    # world-writable even though 5 >= 2, which is the trap a naive comparison falls into.
    local mode others
    mode="$(ontrak_mode_of "${1:-}")"
    [ -n "$mode" ] || return 1
    others=$(( (10#${mode: -3}) % 10 ))
    [ $(( others & 2 )) -eq 2 ]
}

ontrak_is_executable() {
    [ -x "${1:-}" ]
}

ontrak_world_readable() {
    # True when "other" has read permission (the classic data-exposure finding).
    local mode others
    mode="$(ontrak_mode_of "${1:-}")"
    [ -n "$mode" ] || return 1
    others=$(( (10#${mode: -3}) % 10 ))
    [ $(( others & 4 )) -eq 4 ]
}

ontrak_dir_traversable() {
    # True when a plain user (not root) can enter the directory: o+x or g+x.
    local mode others group
    mode="$(ontrak_mode_of "${1:-}")"
    [ -n "$mode" ] || return 1
    others=$(( (10#${mode: -3}) % 10 ))
    group=$(( (10#${mode: -3}) / 10 % 10 ))
    [ $(( others & 1 )) -eq 1 ] || [ $(( group & 1 )) -eq 1 ]
}

# ---------------------------------------------------------------- ownership --
ontrak_owner_of() {
    stat -c '%U' "${1:-}" 2>/dev/null
}

ontrak_group_of() {
    stat -c '%G' "${1:-}" 2>/dev/null
}

ontrak_owned_by() {
    # ontrak_owned_by <path> <user>[:<group>]
    local path="${1:-}" want_user="${2%%:*}" want_group="${2#*:}"
    [ "$(ontrak_owner_of "$path")" = "$want_user" ] || return 1
    if [ "${2#*:}" != "${2%%:*}" ]; then
        [ "$(ontrak_group_of "$path")" = "$want_group" ] || return 1
    fi
    return 0
}

ontrak_owner_is_root() {
    [ "$(ontrak_owner_of "${1:-}")" = "root" ]
}

# --------------------------------------------------------- users and groups --
ontrak_user_exists() {
    id -u "${1:-}" >/dev/null 2>&1
}

ontrak_group_exists() {
    getent group "${1:-}" >/dev/null 2>&1
}

ontrak_user_in_group() {
    # ontrak_user_in_group <user> <group>
    id -nG "${1:-}" 2>/dev/null | tr ' ' '\n' | grep -qx -- "${2:-}"
}

ontrak_user_primary_group() {
    id -gn "${1:-}" 2>/dev/null
}

ontrak_user_locked() {
    # True when the account's password is locked ("!" / "*" in /etc/shadow).
    passwd -S "${1:-}" 2>/dev/null | awk '{print $2}' | grep -q '^L$'
}

ontrak_user_has_password() {
    # True when a usable (non-locked, non-empty) password hash is set.
    local state
    state="$(passwd -S "${1:-}" 2>/dev/null | awk '{print $2}')"
    [ "$state" = "P" ]
}

ontrak_user_shell() {
    getent passwd "${1:-}" 2>/dev/null | awk -F: '{print $7}'
}

ontrak_user_home() {
    getent passwd "${1:-}" 2>/dev/null | awk -F: '{print $6}'
}

ontrak_user_password_never_expires() {
    local name="${1:-}" max
    max="$(chage -l "$name" 2>/dev/null | awk -F: '/Maximum number of days/ {gsub(/ /,"",$2); print $2}')"
    [ "$max" = "99999" ] || [ "$max" = "-1" ]
}

# --------------------------------------------------------------------- sudo --
ontrak_user_can_sudo() {
    # ontrak_user_can_sudo <user> — is the user allowed to sudo at all?
    sudo -n -l -U "${1:-}" >/dev/null 2>&1
}

ontrak_sudo_rule_present() {
    # ontrak_sudo_rule_present <user> <needle> — the user's effective sudo
    # policy mentions <needle> (a command path or a tag like NOPASSWD).
    local user="${1:-}" needle="${2:-}" policy
    command -v sudo >/dev/null 2>&1 || return 1
    policy="$(sudo -n -l -U "$user" 2>/dev/null)"
    printf '%s\n' "$policy" | grep -q -- "$needle"
}

ontrak_sudoers_valid() {
    # A syntax error in /etc/sudoers.d locks everyone out of sudo, so this is
    # worth checking before and after any sudo change.
    command -v visudo >/dev/null 2>&1 || return 0
    visudo -c -q >/dev/null 2>&1
}

# ---------------------------------------------------------------- services --
ontrak_service_active() {
    systemctl is-active --quiet "${1:-}" 2>/dev/null \
        || service "${1:-}" status >/dev/null 2>&1
}

ontrak_service_enabled() {
    systemctl is-enabled --quiet "${1:-}" 2>/dev/null
}

# -------------------------------------------------------------- resources ----
ontrak_cpu_load() {
    # 1-minute load average scaled by CPU count, as a percentage. Mirrors the
    # Windows helper's intent: a machine that is merely busy is not "broken".
    local load cpus
    load="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
    cpus="$(nproc 2>/dev/null || echo 1)"
    [ -n "$load" ] || { echo -1; return; }
    awk -v l="$load" -v c="$cpus" 'BEGIN { printf "%d\n", (l / c) * 100 }'
}

ontrak_top_cpu_process() {
    ps -eo comm,pcpu --sort=-pcpu 2>/dev/null | awk 'NR==2 {print $1}'
}

ontrak_process_running() {
    pgrep -x -- "${1:-}" >/dev/null 2>&1 || pgrep -f -- "${1:-}" >/dev/null 2>&1
}

# ------------------------------------------------------------ write-ups ------
ontrak_report_field() {
    # ontrak_report_field <path> "<Field>" [min-length]
    #
    # The same contract as the PowerShell helper: a "Field: value" line whose
    # value is at least min-length characters. Stops "rebooted and it worked"
    # earning documentation marks.
    local path="${1:-}" field="${2:-}" min="${3:-15}" value
    [ -f "$path" ] || return 1
    value="$(awk -v f="$field" '
        {
            line = $0
            gsub(/^[ \t]+/, "", line)
            if (tolower(line) ~ ("^" tolower(f) "[ \t]*:")) {
                sub(/^[^:]*:[ \t]*/, "", line)
                print line
            }
        }' "$path" | tail -n 1)"
    [ -n "$value" ] || return 1
    [ "${#value}" -ge "$min" ]
}

ontrak_any_report_field() {
    # ontrak_any_report_field <path> <field1> <field2> ... — at least one field
    # with a non-trivial value (accepts alternative wording from the student).
    local path="$1"; shift
    local field
    for field in "$@"; do
        ontrak_report_field "$path" "$field" && return 0
    done
    return 1
}
