#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — build and publish every product image.
#
#   make publish-images                                  # build, tag, push
#   make publish-images PUSH=0                           # build and tag, push nothing
#   make publish-images VERSION=0.2.0                    # override every product's version
#   make publish-images REGISTRY=ghcr.io/someoneelse     # publish somewhere else
#
# The local twin of `.github/workflows/publish.yml`, and deliberately the same
# shape: the same products, the same serving stage per product, and the same tags
# (`<version>`, `<major>.<minor>`, `latest`, `sha-<commit>`). CI publishes when a
# release is cut; this publishes when somebody has a tree they want an image of —
# which is what a deployment that *pulls* rather than builds needs, and what the
# prod overlays now expect.
#
# **The version comes from each product's own source**, never from an argument the
# operator has to remember: the training app, Tix, Sentinel, Genie, Portal and
# Sync's dashboard keep it in `package.json`, and Sync's API keeps it in
# `ontrak/__init__.py`. One place per product is what stops this script disagreeing
# with what the product reports about itself. `VERSION` overrides all of them at
# once, for a rebuild that must not renumber anything.
#
# Training, Tix and Sentinel each publish **two** images: the serving stage and the
# migration stage. Both are needed, and the second is not optional plumbing — the
# migration runs in the `builder` stage because that is the stage carrying the
# Prisma CLI and the schema tree, and the serving image deliberately leaves them
# out. A deployment that could only pull the serving image would have to build the
# migration on the host, which is exactly what pulling was meant to avoid.
#
# The commit tag is the full SHA, matching `publish.yml`'s `format=long`: it is the
# one tag that cannot be overwritten by a later build.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:-ghcr.io/innotelinc}"
PUSH="${PUSH:-1}"
VERSION_OVERRIDE="${VERSION:-}"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# repository | build context | serving stage | where the version lives
#
# The stage is named rather than left to "whichever FROM is last", for the reason
# `publish.yml` gives: the products do not agree on what they call it (`runner`
# here, `runtime` in Genie and Portal), and an unnamed target publishes whatever
# happens to be at the bottom of the file after the next Dockerfile edit.
SPECS=(
  "ontrak-training|.|runner|pkg:."
  "ontrak-training-migrate|.|builder|pkg:."
  "ontrak-tix|ontrak-tix|runner|pkg:ontrak-tix"
  "ontrak-tix-migrate|ontrak-tix|builder|pkg:ontrak-tix"
  "ontrak-sentinel|ontrak-sentinel|runner|pkg:ontrak-sentinel"
  "ontrak-sentinel-migrate|ontrak-sentinel|builder|pkg:ontrak-sentinel"
  "ontrak-genie|ontrak-genie|runtime|pkg:ontrak-genie"
  "ontrak-portal|ontrak-portal|runtime|pkg:ontrak-portal"
  "ontrak-sync-api|ontrak-sync/backend||py:ontrak-sync/backend/ontrak/__init__.py"
  "ontrak-sync-web|ontrak-sync/web|runtime|pkg:ontrak-sync/web"
)

version_of() {
  case "$1" in
    pkg:*) node -p "require('$ROOT/${1#pkg:}/package.json').version" ;;
    py:*)  sed -n 's/^__version__ = "\([^"]*\)".*/\1/p' "$ROOT/${1#py:}" ;;
    *)     echo "unknown version source: $1" >&2; return 1 ;;
  esac
}

# Not best-effort: every tag is supposed to say which commit produced it, and a
# `sha-` tag that means nothing is worse than no tag at all.
SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:12}"

echo "==> publishing to $REGISTRY (push=$PUSH, commit $SHORT)"

for spec in "${SPECS[@]}"; do
  IFS='|' read -r repo context target vspec <<<"$spec"
  version="${VERSION_OVERRIDE:-$(version_of "$vspec")}"
  minor="${version%.*}"

  refs=(
    "$REGISTRY/$repo:$version"
    "$REGISTRY/$repo:$minor"
    "$REGISTRY/$repo:latest"
    "$REGISTRY/$repo:sha-$SHA"
  )
  tagargs=()
  for r in "${refs[@]}"; do tagargs+=(-t "$r"); done

  args=(-f "$context/Dockerfile")
  if [ -n "$target" ]; then args+=(--target "$target"); fi

  # Sync's dashboard inlines NEXT_PUBLIC_* at build time, so the API address is a
  # build argument and not something the deployment can change afterwards. Default
  # is EMPTY, meaning the browser calls `/api/*` on its own origin and the Next route
  # handler forwards it — the same-origin shape the family deployment needs, and the
  # only one under which the session cookie belongs to a single hostname. Set
  # ONTRAK_PUBLIC_API to publish the cross-origin LAN twin instead.
  case "$repo" in
    ontrak-sync-web) args+=(--build-arg "NEXT_PUBLIC_ONTRAK_API=${ONTRAK_PUBLIC_API-}") ;;
  esac

  printf '\n--> %s:%s (context %s, stage %s)\n' "$repo" "$version" "$context" "${target:-default}"
  docker build "${args[@]}" "${tagargs[@]}" "$context"

  if [ "$PUSH" = "1" ]; then
    for r in "${refs[@]}"; do
      if ! docker push "$r"; then
        echo "push failed for $r" >&2
        echo "if this is an auth failure:  gh auth token | docker login ${REGISTRY%%/*} -u <user> --password-stdin" >&2
        exit 1
      fi
    done
  fi
  echo "    tagged: $version, $minor, latest, sha-$SHORT"
done

cat <<DONE

==> done
Run on a deployment, in the product's own directory:

  ONTRAK_<PRODUCT>_IMAGE_TAG=<version>   # e.g. ONTRAK_SENTINEL_IMAGE_TAG=0.1.0

then \`make <product>-prod-up\`, which pulls these images instead of building them.
DONE
