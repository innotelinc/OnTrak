#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak Bolt — ask Coolify to deploy, without waiting for a push.
#
#   COOLIFY_DEPLOY_WEBHOOK='https://…/api/v1/deploy?uuid=…' \
#   COOLIFY_TOKEN='…' scripts/deploy-coolify.sh
#
#   scripts/deploy-coolify.sh --dry-run          # print the request, send nothing
#   scripts/deploy-coolify.sh --force            # rebuild without the build cache
#
# This is the local twin of the last step in `.gitea/workflows/publish.yml`, and it
# is the same request: Coolify's deploy webhook is an authenticated GET, the URL names
# the resource and the bearer token authorises the action. It exists because the
# things one actually wants to redeploy — a changed environment variable, a rollback
# to an older `sha-` tag, a registry credential that has just been added — are not
# pushes, and waiting for a commit to trigger a deploy would be inventing one.
#
# The URL and token come from Coolify: **application → Webhooks → Deploy Webhook
# (auth required)**, and **Keys & Tokens → API Tokens** (a deploy-only token is
# enough). README.md, *Deploying from Gitea through Coolify*, has the walk-through.
#
# Note what this cannot do: the webhook does not choose an image tag. The tag is the
# resource's `ONTRAK_BOLT_IMAGE` variable, so a rollback changes that variable in
# Coolify and then runs this script — see README.md, *Rolling back*.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

WEBHOOK="${COOLIFY_DEPLOY_WEBHOOK:-}"
TOKEN="${COOLIFY_TOKEN:-}"
FORCE="false"
DRY_RUN=0

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) WEBHOOK="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --force) FORCE="true"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy-coolify: unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "deploy-coolify: $*" >&2; exit 2; }

[ -n "$WEBHOOK" ] || die "COOLIFY_DEPLOY_WEBHOOK is not set (application → Webhooks → Deploy Webhook)"
[ -n "$TOKEN" ] || die "COOLIFY_TOKEN is not set (Keys & Tokens → API Tokens, deploy permission)"

case "$WEBHOOK" in
  http://*|https://*) ;;
  *) die "the webhook must be an http(s) URL, got: $WEBHOOK" ;;
esac

# `force` is a query parameter on the deploy endpoint; add it only if the copied URL
# does not already carry one, so the two ways of asking cannot disagree.
case "$WEBHOOK" in
  *force=*) endpoint="$WEBHOOK" ;;
  *\?*) endpoint="$WEBHOOK&force=$FORCE" ;;
  *) endpoint="$WEBHOOK?force=$FORCE" ;;
esac

if [ "$DRY_RUN" = 1 ]; then
  echo "deploy-coolify: GET $endpoint"
  echo "deploy-coolify: authorization: Bearer <COOLIFY_TOKEN>"
  exit 0
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

echo "deploy-coolify: asking Coolify to deploy (force=$FORCE)"
code="$(curl -sS -m 60 -o "$body" -w '%{http_code}' -X GET "$endpoint" -H "Authorization: Bearer $TOKEN")" || {
  die "the request did not complete — is 192.168.1.93 reachable from here?"
}

# The response names the deployment Coolify queued; showing it means the operator can
# find the run in the dashboard without guessing which one was just asked for.
cat "$body"; echo

case "$code" in
  200|201|202)
    echo "deploy-coolify: Coolify accepted the deployment ($code)."
    echo "deploy-coolify: watch it under the application's Deployments — accepted is not healthy."
    ;;
  401|403)
    die "Coolify answered $code — the token is wrong, expired, or lacks the deploy permission."
    ;;
  404)
    die "Coolify answered 404 — the uuid in the webhook does not name a resource on this instance."
    ;;
  *)
    die "Coolify answered $code."
    ;;
esac
