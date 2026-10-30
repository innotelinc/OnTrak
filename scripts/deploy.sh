#!/usr/bin/env bash
# deploy.sh — bring the family stack up, then prove a capture still works.
#
# `docker compose up -d --build` can only tell you that containers started. The
# failure this guards against is the one that does not show there: REA's MCP
# server died with SIGSEGV on its first `capture_process_scenario` — the glibc PTY
# prebuild under musl — while the g0dm0d3 container reported healthy the whole
# time, so every capture behind an up stack failed quietly. A deploy that ends on
# "container started" therefore ends on a question nobody asked.
#
# So the deploy is not finished until a capture has actually run: the stack comes
# up, then one real turn goes through Genie's `/api/chat` and the agent has to
# choose `capture_process_scenario` and get Evidence back. See
# scripts/genie-capture-smoke.mjs for what that turn checks.
#
# There is deliberately no flag to skip the check. Deploying is a decision about
# what runs in front of people; the evidence that a capture still works is part of
# it, not an extra. `--smoke-only` runs just the check, which is what
# `make capture-smoke` is.
#
# The smoke's exit status decides what happened, and the deploy reports the
# difference rather than a bare "failed":
#
#   1  the capture ran and did not work     → a real deploy failure, right now
#   2  the check could not be attempted     → the stack is probably not listening
#                                             yet, so it is retried until
#                                             DEPLOY_SMOKE_WAIT_SECONDS runs out
#
# Usage: scripts/deploy.sh [--lan] [--smoke-only]
#   --lan         also publish each database on this deployment's LAN address
#                 (adds docker-compose.lan-db.yml, as `make all-up-lan` does)
#   --smoke-only  run the capture check against the running stack and stop there
#
# Environment:
#   GENIE_SMOKE_ACTOR          required; the account the turn is attributed to
#   GENIE_SMOKE_MODEL          optional; defaults to the deployment's own chain
#   DEPLOY_SMOKE_WAIT_SECONDS  how long a stack that is not listening yet gets
#                              before the deploy fails (default 180)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  sed -n '2,37p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

lan=0
smoke_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lan) lan=1 ;;
    --smoke-only) smoke_only=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "deploy: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

compose=(docker compose -f docker-compose.all.yml)
if [ "$lan" -eq 1 ]; then
  compose+=(-f docker-compose.lan-db.yml)
fi

# One turn through Genie's agent, run where GENIE_URL and WEB_TOKEN live. Kept as
# a function rather than a `make capture-smoke` call because make reports every
# failed recipe as status 2, which is exactly the distinction the deploy needs:
# "could not attempt" is retried, "the capture failed" is not.
run_smoke() {
  "${compose[@]}" exec -T \
    -e GENIE_SMOKE_ACTOR="$actor" \
    -e GENIE_SMOKE_MODEL="${GENIE_SMOKE_MODEL:-}" \
    g0dm0d3 node --input-type=module - < scripts/genie-capture-smoke.mjs
}

# Before anything is touched. A deploy that came up and then refused to finish
# would leave an operator looking at a running stack and a failed command, with no
# way to tell whether the new build is serving.
actor="${GENIE_SMOKE_ACTOR:-}"
if [ -z "$actor" ]; then
  cat >&2 <<'EOF'
deploy: name the account the capture's turn belongs to.

  GENIE_SMOKE_ACTOR=you@example.com make all-up
  GENIE_SMOKE_ACTOR=you@example.com make capture-smoke

Genie attributes the turn — and the gateway key that pays for it — to that
account, so it has to be one this deployment can resolve.
EOF
  exit 2
fi

if [ "$smoke_only" -eq 1 ]; then
  run_smoke || exit $?
  exit 0
fi

wait_seconds="${DEPLOY_SMOKE_WAIT_SECONDS:-180}"

# ONYX's sign-in is the one credential in this stack that cannot resolve itself: its
# proxy is a stock image, so its entrypoint is the proxy and there is nothing inside the
# container to turn a `vault://` reference into a value. `onyx-sso/.env` therefore holds
# references, the vault is read here, and the compose file interpolates the result. A
# stack started without this step gets empty credentials and the proxy exits on its own
# config check instead of gating nothing.
# The deployment's own file: `make setup` puts it there from the template, and its
# absence is a deployment that never configured this door, not a reason to stop the
# other five products from coming up. It is a warning here; the proxy itself refuses to
# start without the credentials, so the failure is visible either way.
if [ -f onyx-sso/.env ]; then
  echo "deploy: resolving ONYX's sign-in from Cerulean Vault"
  command -v node >/dev/null 2>&1 || {
    echo "deploy: onyx-sso/.env needs node to resolve (scripts/vault-env.mjs)" >&2
    exit 1
  }
  set -a
  # shellcheck disable=SC1090  # the deployment's own file, not a source file
  . onyx-sso/.env
  set +a
  resolved=$(VAULT_ADDR="${VAULT_ADDR:-http://192.168.1.71:8200}" \
    VAULT_PREFIX="${VAULT_PREFIX:-cerulean}" \
    VAULT_TOKEN_FILE="${VAULT_TOKEN_HOST_FILE:-data/vault/token/ontrak.token}" \
    node scripts/vault-env.mjs \
      OAUTH2_PROXY_CLIENT_ID OAUTH2_PROXY_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET) || {
    echo "deploy: could not resolve ONYX's sign-in from onyx-sso/.env" >&2
    exit 1
  }
  eval "$resolved"
else
  echo "deploy: no onyx-sso/.env — ONYX's sign-in will start without credentials" >&2
  echo "deploy:   cp onyx-sso/.env.example onyx-sso/.env   (then deploy again)" >&2
fi

echo "deploy: starting the family stack"
"${compose[@]}" up -d --build

# An image that was not rebuilt starts and passes its healthcheck on the runtime it was
# built with, so `up` cannot tell a stack that has moved to a new Node from one where a
# service is still on the old one. Ask the containers before serving anything.
echo "deploy: checking every app container runs the Node its package declares"
if ! scripts/check-node-versions.sh; then
  echo "deploy: a container is not on the Node its package declares — rebuild it before serving" >&2
  exit 1
fi

# An up stack is not a listening one: migrations run first and the console takes a
# moment beyond that. The smoke cannot tell "not ready" from "broken", so a deploy
# retries only the former, for a bounded while, instead of turning a slow start
# into a failure or waiting forever on a stack that is never going to answer.
echo "deploy: running a capture through Genie's agent (account ${actor})"
deadline=$((SECONDS + wait_seconds))
while :; do
  status=0
  run_smoke || status=$?
  if [ "$status" -eq 0 ]; then
    break
  fi
  if [ "$status" -ne 2 ]; then
    echo "deploy: the family stack is up, but a capture through the agent failed (status ${status})" >&2
    echo "deploy: re-run the check with 'make capture-smoke GENIE_SMOKE_ACTOR=${actor}' once the cause is fixed" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "deploy: the stack never answered a capture within ${wait_seconds}s" >&2
    "${compose[@]}" logs --no-color --tail 40 g0dm0d3 >&2 || true
    exit 1
  fi
  sleep 5
done

echo "deploy: family stack up and answering captures"
