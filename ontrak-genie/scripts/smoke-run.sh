#!/usr/bin/env bash
#
# Run the browser checks against a console this script starts.
#
#   scripts/smoke-run.sh                 # ui:smoke, then layout:check
#   scripts/smoke-run.sh ui              # only ui:smoke
#   KEEP=1 scripts/smoke-run.sh          # leave the workspace and the logs behind
#   SIGNED_IN=1 scripts/smoke-run.sh ui  # a console behind sign-in, with a session
#                                        # cookie — the deployment's own shape
#
# `npm run check` runs `ui:smoke` against whatever console is already at
# `AGENT_UI_URL` — 127.0.0.1:3400 by default — which is the right thing on a
# workstation that has one running and the wrong thing in CI, where there is
# nothing at all: the checks were simply never run there. This starts the two
# things they need, on scratch directories, and stops them again:
#
#   * `scripts/fake-gateway.mjs`, so the console has a gateway that answers
#     (there is no model on a runner, and the checks that need one skip);
#   * `dist/server.js` with a workspace of its own, a seed file to look at, two
#     skills in the panel, and a turn through the console's own chat route so the
#     change list has something in it — written by the stand-in gateway's
#     `write_file` call, so the request framing, the guard and the snapshot all run
#     for real.
#
# `dist/` has to be built first (`npm run build`), and a browser has to be on the
# machine; both checks skip for lack of one rather than failing.
#
# Ports: `PORT` (3400, then upwards) for the console and `GATEWAY_PORT` (20128, then
# upwards) for the stand-in. A port that is already answering is skipped rather than
# used, because a workstation usually has the deployment's console on 3400 and a real
# gateway on 20128; an explicitly named port is an error when it is taken instead.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

PORT_ASKED="${PORT:-}"
GATEWAY_ASKED="${GATEWAY_PORT:-}"
# With SIGNED_IN the console has no shared token at all: the gate is a session
# cookie, which is exactly what `AGENT_UI_COOKIE` exists for.
SIGNED_IN="${SIGNED_IN:-0}"
# Generated per run rather than written down: this console lives on loopback for the
# length of the check, and a literal value in a tracked file is what the estate's
# secret scanner is there to refuse.
SESSION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
WEB_TOKEN="${WEB_TOKEN:-$([ "$SIGNED_IN" = "1" ] && echo "" || echo smoke-token)}"
WHICH="${1:-all}"
KEEP="${KEEP:-0}"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# An explicit port is used as given — refusing loudly beats quietly moving, because
# "I need it on 3400" is a request about that port.
pick_port() {
  local asked="$1" first="$2" last="$3" name="$4" port
  if [ -n "$asked" ]; then
    if ! port_free "$asked"; then
      echo "::error::$name port $asked is already in use — name another port or stop what is on it" >&2
      exit 1
    fi
    echo "$asked"
    return
  fi
  for port in $(seq "$first" "$last"); do
    if port_free "$port"; then
      echo "$port"
      return
    fi
  done
  echo "::error::no free $name port between $first and $last" >&2
  exit 1
}

PORT="$(pick_port "$PORT_ASKED" 3400 3419 PORT)"
GATEWAY_PORT="$(pick_port "$GATEWAY_ASKED" 20128 20147 GATEWAY_PORT)"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/genie-smoke-run-XXXXXX")"
WORKSPACE="$SCRATCH/workspace"
DATA="$WORKSPACE/.agent"
SKILLS="$DATA/skills"
mkdir -p "$WORKSPACE/src" "$SKILLS/shared/bought-in" "$SKILLS/hand-written"
printf 'print("hello")\n' > "$WORKSPACE/src/app.py"
printf 'A workspace for the browser checks.\n' > "$WORKSPACE/README.md"

# Two skills, so the panel has rows to draw and both sides of the remove rule are
# visible: one in the account's own lane carrying the provenance an install leaves
# (removable), and one written straight into the deployment's lane (not). With no
# control plane the account's lane is `<data>/skills/shared`, the fallback
# `accountSkillsDir()` documents; if that ever changes, this seeding stops producing
# a removable row rather than failing the check.
printf -- '---\nname: bought-in\ndescription: An installed skill, as the panel draws one.\n---\n\nFollow it.\n' \
  > "$SKILLS/shared/bought-in/SKILL.md"
printf '{"repo":"acme/skills","ref":"main","path":"bought-in/SKILL.md","installedAt":"2026-01-01T00:00:00.000Z","files":1}\n' \
  > "$SKILLS/shared/bought-in/.source.json"
printf -- '---\nname: hand-written\ndescription: A skill somebody wrote here by hand.\n---\n\nMine.\n' \
  > "$SKILLS/hand-written/SKILL.md"

gateway_pid=""
console_pid=""
# A failing run keeps its scratch directory, because the only thing that explains a
# failure is in it: what the console printed and what the gateway was asked for.
cleanup() {
  local status=$?
  [ -n "$console_pid" ] && kill "$console_pid" 2>/dev/null || true
  [ -n "$gateway_pid" ] && kill "$gateway_pid" 2>/dev/null || true
  if [ "$KEEP" = "1" ] || [ "$status" != "0" ]; then
    echo "kept $SCRATCH (exit $status) — console.log, gateway.log, seed.sse"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2" tries=100
  while [ "$tries" -gt 0 ]; do
    if curl -sf -m 2 -o /dev/null "$url"; then return 0; fi
    tries=$((tries - 1))
    sleep 0.2
  done
  echo "::error::$name never answered at $url" >&2
  return 1
}

echo "== stand-in gateway on $GATEWAY_PORT =="
GATEWAY_PORT="$GATEWAY_PORT" FAKE_GATEWAY_WRITE_FIRST="notes.md" \
  node scripts/fake-gateway.mjs > "$SCRATCH/gateway.log" 2>&1 &
gateway_pid=$!
wait_for "http://127.0.0.1:$GATEWAY_PORT/v1/models" "the stand-in gateway"

echo "== console on $PORT$([ "$SIGNED_IN" = "1" ] && echo " (behind sign-in)" || true) =="
HOST=127.0.0.1 PORT="$PORT" WEB_TOKEN="$WEB_TOKEN" \
  AGENT_WORKSPACE="$WORKSPACE" AGENT_DATA_DIR="$DATA" \
  AGENT_SANDBOX=host AGENT_APPROVAL=off AGENT_HEALTH_INTERVAL_MS=0 \
  AGENT_MODEL=fake/model AGENT_FALLBACK_MODELS= \
  OMNIROUTE_URL="http://127.0.0.1:$GATEWAY_PORT/v1" OMNIROUTE_API_KEY="" \
  ONTRAK_OIDC_ISSUER="${ONTRAK_OIDC_ISSUER:-https://idp.invalid}" \
  ONTRAK_OIDC_CLIENT_ID="ontrak-genie" \
  ONTRAK_OIDC_SESSION_SECRET="$SESSION_SECRET" \
  node dist/server.js > "$SCRATCH/console.log" 2>&1 &
console_pid=$!
# `/health` is the family's liveness path. It is unauthenticated by design, so this
# waits on the console itself rather than on the token it is about to be given.
wait_for "http://127.0.0.1:$PORT/health" "the console"
grep -E 'status|auth' "$SCRATCH/console.log" | tail -2 || true

# One credential, in whichever form this console accepts: a bearer token, or the
# session cookie a signed-in one wants. Minted here with the same secret the console
# was given, which is how the deployment's own gate can be driven without a browser
# to sign in with.
AUTH_HEADER=(-H "Authorization: Bearer $WEB_TOKEN")
if [ "$SIGNED_IN" = "1" ]; then
  export AGENT_UI_COOKIE="$(ONTRAK_OIDC_SESSION_SECRET="$SESSION_SECRET" node --input-type=module -e '
import { SESSION_COOKIE, mintSession } from "./dist/oidc.js";
const value = mintSession({ sub: "sub-smoke", email: "smoke@example.com", name: "Smoke Runner" });
process.stdout.write(`${SESSION_COOKIE}=${encodeURIComponent(value)}`);
')"
  AUTH_HEADER=(-H "Cookie: $AGENT_UI_COOKIE")
fi

echo "== seeding one change through the chat route =="
curl -sf -N -m 60 \
  "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
  -d '{"maxSteps":4,"message":"Create notes.md and stop."}' \
  "http://127.0.0.1:$PORT/api/chat" > "$SCRATCH/seed.sse"
grep -q '"type":"done"' "$SCRATCH/seed.sse" || {
  echo "::error::the seeding turn did not finish" >&2
  tail -5 "$SCRATCH/seed.sse" >&2
  exit 1
}
test -f "$WORKSPACE/notes.md" || { echo "::error::the seeding turn wrote no file" >&2; exit 1; }
echo "seeded notes.md"

export AGENT_UI_URL="http://127.0.0.1:$PORT"
# `WEB_TOKEN` unset rather than empty under SIGNED_IN, so `ui:smoke` cannot fall
# back to a bearer header the console would refuse anyway.
if [ "$SIGNED_IN" = "1" ]; then unset WEB_TOKEN; else export WEB_TOKEN; fi

if [ "$WHICH" = "ui" ] || [ "$WHICH" = "all" ]; then
  echo "== ui:smoke =="
  npm run ui:smoke
fi

if [ "$WHICH" = "layout" ] || [ "$WHICH" = "all" ]; then
  echo "== layout:check =="
  npm run layout:check
fi

echo "browser checks done"
