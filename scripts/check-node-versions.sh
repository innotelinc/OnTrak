#!/usr/bin/env bash
# check-node-versions.sh — every app container runs the Node its package declares.
#
# The base image and `engines.node` are two statements of one fact, and a deploy is
# where they meet. Move the family to a new Node and one service whose image was not
# rebuilt keeps serving on the old runtime: `docker compose up -d` reports "Started",
# the healthcheck passes, and the only thing that differs is the runtime underneath —
# so the failure arrives later, as an API the old Node does not have, in production,
# on a request nobody connects to the deploy.
#
# `up` therefore cannot answer the question. This asks the containers themselves:
# `node -v` from inside each one, compared with the major in the `engines.node` of the
# package the service is built from. A service that is not running is a failure too —
# it is not evidence of anything, and a deploy should say so rather than skip it.
#
# What it covers is the family stack (`docker-compose.all.yml`) and its long-running
# app services: the preview stack is a separate deploy (`docker-compose.preview.yml`),
# and the migrate/seed one-shots exit before anyone could ask them.
#
# Usage: scripts/check-node-versions.sh
# Exit:  0 every app container matches; 1 at least one disagrees or is not running.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

compose=(docker compose -f docker-compose.all.yml)

# Service and the directory whose package.json governs it — the build context the
# service is built from. g0dm0d3 and engineer-portal share one image and are listed
# twice on purpose: the check is about containers, not about images. `bolt-sso` is not
# here: it is a stock proxy image with no Node of its own to compare, which is exactly
# why `tests/node-version-check.test.ts` derives this list from the compose file's
# Node-based services rather than trusting the table.
read -r -d '' services <<'EOF'
training-app .
tix-app ontrak-tix
sentinel-app ontrak-sentinel
genie-app ontrak-genie
bolt-app ontrak-bolt
portal-app ontrak-portal
sync-web ontrak-sync/web
g0dm0d3 g0dm0d3
engineer-portal g0dm0d3
EOF

# The major a package declares, read out of its `engines` block. Kept to sed rather than
# node: this runs on the deployment host, and the whole point is to ask the *containers*
# what they run — not to depend on the host having a Node of its own.
declared_major() {
  local range
  range=$(sed -n '/"engines"/,/}/p' "$1/package.json" |
    sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -1)
  printf '%s' "$range" | grep -oE '[0-9]+' | head -1
}

failed=0
printf '%-18s %-10s %s\n' service running declares
while read -r service dir; do
  [ -n "${service:-}" ] || continue

  want=$(declared_major "$dir")
  if [ -z "$want" ]; then
    printf '%-18s %-10s %s\n' "$service" "-" "no engines.node in $dir/package.json"
    failed=1
    continue
  fi

  id=$("${compose[@]}" ps -q "$service" 2>/dev/null | head -1)
  if [ -z "$id" ]; then
    printf '%-18s %-10s %s\n' "$service" "not up" "v${want}.x expected"
    failed=1
    continue
  fi

  # Checked for shape, not just for emptiness: `docker exec` can answer on stdout with
  # its own failure ("executable file not found in $PATH") when the container has no
  # node at all, and reading that as a version turns the report into noise.
  running=$(docker exec "$id" node -v 2>/dev/null | head -1 | tr -d '[:space:]')
  if ! printf '%s' "$running" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+'; then
    printf '%-18s %-10s %s\n' "$service" "no node" "v${want}.x expected"
    failed=1
    continue
  fi

  version=${running#v}
  major=${version%%.*}
  if [ "$major" != "$want" ]; then
    printf '%-18s %-10s %s\n' "$service" "v${version}" "MISMATCH — declares >=${want}"
    failed=1
  else
    printf '%-18s %-10s %s\n' "$service" "v${version}" "ok"
  fi
done <<< "$services"

if [ "$failed" -ne 0 ]; then
  echo "check-node-versions: at least one container is not on the Node its package declares" >&2
  exit 1
fi
