#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Bolt — push this product to the estate's Gitea.
#
#   scripts/push-to-gitea.sh                 # commit first, then push ontrak-bolt
#   scripts/push-to-gitea.sh --dry-run       # show what would be pushed
#   scripts/push-to-gitea.sh --force         # after a rewrite (rebase, squash)
#
# `gitlab.innotel.us` holds this product in its **own** repository,
# `innotelinc/ontrak-bolt`, while this checkout is the family monorepo and keeps its
# history there. So the push is a `git subtree split`: the `ontrak-bolt/` directory
# becomes the root of the Gitea repository, with its commits intact, and the rest of
# the family never appears in it. That is what lets the workflows in
# `ontrak-bolt/.gitea/workflows/` sit at the root of the deployed repository instead
# of in a subdirectory a forge would not read.
#
# The split is deterministic: an unchanged subtree produces the same commits, so the
# push fast-forwards and does not need `--force`. `--force` is only for the case the
# history actually moved — a rebase or a squash of something already pushed — and it
# is deliberately a flag rather than the default.
#
# Requires `git subtree` (ships with git's contrib; `apt install git-subtree`,
# `brew install git-subtree`, or MSYS2's `git-subtree` package).
#
# Environment:
#   GITEA_URL    the repository's clone URL (default below)
#   REMOTE       the local remote name to add/use (default `gitea`)
#   BRANCH       the branch to push to (default `main`)
#   PREFIX       the directory to split out, relative to the repo root (default `ontrak-bolt`)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

GITEA_URL="${GITEA_URL:-https://gitlab.innotel.us/innotelinc/ontrak-bolt.git}"
REMOTE="${REMOTE:-gitea}"
BRANCH="${BRANCH:-main}"
PREFIX="${PREFIX:-ontrak-bolt}"
FORCE=0
DRY_RUN=0

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) GITEA_URL="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "push-to-gitea: unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "push-to-gitea: $*" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
cd "$ROOT"

# ── uncommitted work ───────────────────────────────────────────────────────
# The split reads commits, never the working tree, so this is a warning rather than
# a failure — but it is the failure people actually hit: the files are on disk, the
# push succeeds, and the deployed repository is missing them.
if [ -n "$(git status --porcelain -- "${PREFIX:-.}")" ]; then
  echo "push-to-gitea: warning: ${PREFIX:-.}/ has uncommitted changes; only commits are pushed." >&2
fi

# ── the remote ─────────────────────────────────────────────────────────────
current_url=""
if current_url="$(git remote get-url "$REMOTE" 2>/dev/null)"; then
  if [ "$current_url" != "$GITEA_URL" ]; then
    echo "push-to-gitea: note: remote '$REMOTE' is $current_url (keeping it; pass --url to change the target)" >&2
  fi
else
  echo "push-to-gitea: adding remote '$REMOTE' -> $GITEA_URL"
  if [ "$DRY_RUN" = 0 ]; then
    git remote add "$REMOTE" "$GITEA_URL"
  fi
fi

# ── what gets pushed ───────────────────────────────────────────────────────
if [ "$PREFIX" = "." ] || [ -z "$PREFIX" ]; then
  # Already a single-product checkout: push the branch as it is.
  ref="HEAD"
  echo "push-to-gitea: pushing $ref (no split) to $REMOTE/$BRANCH"
else
  [ -d "$ROOT/$PREFIX" ] || die "no such directory in this repository: $PREFIX"

  # `git subtree` is a contrib script, so it is either beside git's other helpers or
  # on PATH — checking both is cheaper than running it and reading the usage banner.
  [ -x "$(git --exec-path)/git-subtree" ] || command -v git-subtree >/dev/null 2>&1 \
    || die "git subtree is not installed (apt install git-subtree, or brew install git-subtree)"

  tmp="gitea-split-$$"
  cleanup() { git branch -D "$tmp" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  echo "push-to-gitea: splitting $PREFIX out of $(git rev-parse --short HEAD)"

  # The split walks the whole history and prints a progress line per commit; keep it
  # off the terminal and surface it only if the split actually fails.
  split_log="$(mktemp)"
  if ! git subtree split --prefix="$PREFIX" -b "$tmp" >/dev/null 2>"$split_log"; then
    cat "$split_log" >&2
    rm -f "$split_log"
    die "git subtree split failed"
  fi
  rm -f "$split_log"

  echo "push-to-gitea: $(git rev-list --count "$tmp") commit(s), root: $(git ls-tree --name-only "$tmp" | tr '\n' ' ')"
  git log --oneline -1 "$tmp" | sed 's/^/push-to-gitea: tip: /'
  ref="$tmp"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "push-to-gitea: dry run — would push $ref -> $REMOTE/$BRANCH"
  exit 0
fi

# ── push ───────────────────────────────────────────────────────────────────
# `--force` is opt-in because it is the only step here that can lose something on
# the other side; the split is a local, throwaway branch.
if [ "$FORCE" = 1 ]; then
  echo "push-to-gitea: force-pushing $ref -> $REMOTE/$BRANCH"
  git push --force "$REMOTE" "$ref:refs/heads/$BRANCH"
else
  git push "$REMOTE" "$ref:refs/heads/$BRANCH"
fi

echo "push-to-gitea: pushed to $GITEA_URL ($BRANCH)"
echo "push-to-gitea: Actions runs the checks, then publishes the image and asks Coolify to deploy."
