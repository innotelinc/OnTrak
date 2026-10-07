#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — stamp the images a build just produced with the commit that built them.
#
#   scripts/tag-build-images.sh innotel/ontrak-genie:main
#   docker compose -f docker-compose.all.yml config --images | scripts/tag-build-images.sh
#
# The dev and family stacks tag their images with a moving name (`main`) because
# that is what a development stack follows — and a moving tag is exactly what
# cannot say which tree an image came from. Two builds of two commits are then
# the same tag, so a container can be left running an image older than the
# checkout beside it with nothing on screen saying so; that is not hypothetical,
# it is how the `0.2.0` pin behaved before this existed. This adds the one tag a
# later build cannot overwrite — `sha-<commit>`, the same rule
# `scripts/publish-images.sh` and `.github/workflows/publish.yml` already use —
# so every build stays identifiable afterwards and no build is anonymous.
#
# Refs come from the arguments, or from stdin when there are none, which is the
# shape `docker compose config --images` has. The two are treated differently on
# purpose: an argument is a ref the caller has already chosen and is stamped as
# given, while a piped compose list also carries base images somebody else
# published — so only ones under `PREFIX` are stamped, because tagging a
# `postgres:16-alpine` as this tree's would be a claim about an image this tree
# did not build.
#
# Not best-effort. Every tag here is supposed to say which commit produced it,
# and a `sha-` tag that means nothing is worse than no tag at all, so a run that
# stamps nothing is a failure rather than a quiet success.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${IMAGE_PREFIX:-innotel/}"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHORT="${SHA:0:12}"

refs=()
explicit=0
if [ "$#" -gt 0 ]; then
  refs=("$@")
  explicit=1
else
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    case "$line" in
      "$PREFIX"*) refs+=("$line") ;;
    esac
  done
fi

stamped=0
if [ "${#refs[@]}" -gt 0 ]; then
  for ref in "${refs[@]}"; do
    case "$ref" in
      *:*) ;;
      *)
        echo "tag-build-images: not an image:tag reference: $ref" >&2
        exit 2
        ;;
    esac
    # A ref that is not here is a name a build target did not produce — a compose
    # file can name four product images while a target built one of them. That is
    # a note, not a failure: naming it and moving on keeps the tag honest without
    # making every partial build fail. A ref the caller asked for by hand is
    # different, and is an error, because there the caller is stating it exists.
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      if [ "$explicit" -eq 1 ]; then
        echo "tag-build-images: no such image: $ref" >&2
        exit 1
      fi
      echo "    skipped ${ref} (not built here)"
      continue
    fi
    docker tag "$ref" "${ref%:*}:sha-$SHA"
    echo "    stamped ${ref%:*}:sha-$SHORT"
    stamped=$((stamped + 1))
  done
fi

if [ "$stamped" -eq 0 ]; then
  if [ "$explicit" -eq 1 ]; then
    echo "tag-build-images: nothing to stamp" >&2
  else
    echo "tag-build-images: no $PREFIX image in the list it was given" >&2
  fi
  exit 1
fi

echo "==> stamped $stamped image(s) as sha-$SHORT"
