#!/usr/bin/env bash
# Starting state: the workspace does not exist yet, and a stale copy is in the way.
#
# This scenario is a *service request* rather than a broken machine, so setup owns
# the "before" state rather than a fault: an empty projects directory plus the
# leftover tree the student has to recognise as disposable.

set -uo pipefail

. "$(cd "$(dirname "$0")/../.." && pwd)/lib/ontrak-common.sh"

PROJECTS=/srv/projects

# Deterministic starting point even if the template was built twice.
rm -rf "$PROJECTS"
mkdir -p "$PROJECTS"

# The leftover copy: same kind of content as the project, plus a marker that makes
# "is this safe to delete?" answerable by reading rather than guessing.
mkdir -p "$PROJECTS/junk/copy" "$PROJECTS/junk/notes"
printf 'stale copy of the alpha sources (nobody claims this)\n' > "$PROJECTS/junk/copy/old-src.txt"
printf 'copied 2026-07 by an operator who has since left\n' > "$PROJECTS/junk/notes/HANDOVER.txt"

ontrak_step "projects directory contents: $(ls -A "$PROJECTS" | tr '\n' ' ')"
ontrak_step "alpha exists: $(ontrak_dir_exists "$PROJECTS/alpha" && echo yes || echo no) (expected no)"

ontrak_require "the workspace does not exist yet" test ! -e "$PROJECTS/alpha"
ontrak_require "the stale tree is present" ontrak_dir_exists "$PROJECTS/junk"
ontrak_require "the stale tree is recognisable as stale" \
    ontrak_file_exists "$PROJECTS/junk/notes/HANDOVER.txt"

ontrak_setup_ok "clean slate: only the stale /srv/projects/junk exists"
