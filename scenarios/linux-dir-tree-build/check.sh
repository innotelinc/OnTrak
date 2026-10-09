#!/usr/bin/env bash
# Grading. Checks the layout the change request asked for, by path and by mode, so
# any sequence of commands that produces the right tree passes.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

PROJECTS=/srv/projects
ROOT="$PROJECTS/alpha"
README="$ROOT/README.md"

# Objective: tree-created
missing=""
for dir in "$ROOT" "$ROOT/src" "$ROOT/tests" "$ROOT/docs"; do
    [ -d "$dir" ] || missing="$missing $dir"
done
ontrak_check "tree-created" "$([ -z "$missing" ] && echo true || echo false)" \
    "$([ -z "$missing" ] && echo 'all four directories present' || printf 'missing:%s' "$missing")"

# Objective: docs-restricted
docs_mode="$(ontrak_mode_of "$ROOT/docs")"
ontrak_check "docs-restricted" "$(ontrak_perm_is 750 "$ROOT/docs" && echo true || echo false)" \
    "docs mode is ${docs_mode:-missing} (wanted 750)"

# Objective: readme-present
# A file with something in it that names the project. An empty placeholder is not a
# README, and "the file exists" is what a careless check would settle for.
readme_ok=false
readme_detail="no README.md at the project root"
if ontrak_file_exists "$README"; then
    words="$(wc -w < "$README" | tr -d ' ')"
    if [ "${words:-0}" -ge 3 ] && grep -qi 'alpha' "$README"; then
        readme_ok=true
        readme_detail="${words} words, mentions the project name"
    else
        readme_detail="${words:-0} words and does not name the project (needs both)"
    fi
fi
ontrak_check "readme-present" "$readme_ok" "$readme_detail"

# Objective: junk-removed
ontrak_check "junk-removed" "$(ontrak_dir_exists "$PROJECTS/junk" && echo false || echo true)" \
    "$(ontrak_dir_exists "$PROJECTS/junk" && echo 'still present' || echo 'removed')"

# Constraint from the ticket, reported but not scored: the student was told to leave
# the rest of /srv alone.
if [ -d "$PROJECTS/junk" ]; then
    ontrak_step "note: /srv/projects/junk is still there; the ticket asked for it to be removed"
fi

ontrak_report
