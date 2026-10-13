#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — a local Authentik, and the range pointed at it.
#
# The range's sign-in is Authentik's (docs/operations.md "Sign-in"), and in the
# estate that Authentik is Cerulean's. This script stands up the *local* one —
# deploy/authentik/compose.yaml, its own project, its own database — and then
# wires a range running on this machine to it, so a demo has a real OIDC flow
# behind a real login page without the estate being reachable.
#
#   deploy/authentik/setup.sh              # start Authentik and provision OnTrak
#   deploy/authentik/setup.sh --connect    # ... and point the local portal at it
#   deploy/authentik/setup.sh --family     # ... and point the whole family stack
#                                          #     at it too (the checkout this
#                                          #     repository *is*, or
#                                          #     ONTRAK_FAMILY_DIR)
#   deploy/authentik/setup.sh --down       # stop it (the database is kept)
#
# What it does, in order:
#
#   1. detects this host's address, which is the one address the browser and the
#      portal container can both use for the issuer
#   2. generates deploy/authentik/.env on a first run — Postgres password, the
#      Authentik secret key, the bootstrap admin password and API token, the
#      OIDC client secret, and the seed accounts' password. Never overwrites.
#   3. starts the stack and waits for Authentik to report ready
#   4. runs provision.py, which creates the OnTrak application, its OIDC
#      provider, the groups and the seed accounts through the API — and, when
#      the family's client secret exists, a second application for the family
#      stack
#   5. writes deploy/authentik/ontrak-local.env — the four ONTRAK_PORTAL__OIDC_*
#      values, the instructor group, and the address students are sent to
#   6. writes deploy/authentik/family-local.env, the same four ideas for the
#      family stack, and with --family recreates that stack against this
#      Authentik — including Tix's identity connection, which lives in Tix's own
#      database rather than in its environment
#
# Why the host address and not `localhost`: the issuer URL has to resolve, and
# give the same answer, for two different clients — the student's browser and the
# portal container. `localhost` is the *container* to the container and the
# Windows host to the browser, and an issuer is not allowed to depend on who is
# asking. The machine's own address is the one name both can reach.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
# The range-facing values: the four ONTRAK_PORTAL__OIDC_* variables, the group
# whose members are instructors, and the address students are sent to. Written
# last on the compose command line so it wins over the checkout's own .env.
LOCAL_ENV_FILE="$HERE/ontrak-local.env"
# The family's half of the same idea. Not a second file beside this one: the
# family stack is a different compose project in a different checkout, and a
# file that only counts when it is passed on the command line is a stack that
# silently loses its sign-in the next time somebody runs a bare `docker compose
# up`. So these values go into that checkout's own .env, inside a marked block
# that this script owns and rewrites — everything around it is the operator's and
# is left alone.
# The checkout this repository is: the lab is a directory of the family repository
# since 2026-10-13, so its parent *is* the family checkout. This used to name a
# sibling (`../OnTrak`) because the lab was cloned beside it.
FAMILY_DIR="${ONTRAK_FAMILY_DIR:-$(cd "$REPO_ROOT/.." && pwd)}"
FAMILY_ENV_FILE="$FAMILY_DIR/.env"
FAMILY_MARK_BEGIN="# >>> ontrak-local-family (deploy/authentik/setup.sh)"
FAMILY_MARK_END="# <<< ontrak-local-family"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed"
command -v openssl >/dev/null 2>&1 || die "openssl is not installed"


# --------------------------------------------------------------- host address --
# The default-route source is this machine's address on the network that leaves
# the box — the one a browser somewhere else would use. Anything can be forced
# with ONTRAK_LOCAL_HOST (a DNS name, say).
detect_host() {
  if [ -n "${ONTRAK_LOCAL_HOST:-}" ]; then
    printf '%s' "$ONTRAK_LOCAL_HOST"
    return 0
  fi
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
      | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
  fi
  printf '%s' "${ip:-127.0.0.1}"
}


# --------------------------------------------------------------------- secrets --
# One generator, so a value is either in .env or it does not exist yet — never a
# second place a secret is decided. Base64 with the shell-hostile characters
# folded out: these values travel through an env file, compose interpolation and
# a URL.
rand() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }

generate_env() {
  local host port
  host="$(detect_host)"
  port="${ONTRAK_LOCAL_AUTHENTIK_PORT:-9000}"
  umask 077
  cat >"$ENV_FILE" <<EOF
# Generated by deploy/authentik/setup.sh — local development only.
# Gitignored (.gitignore). Delete it to start over with fresh secrets.

# ── the local Authentik itself ──
AUTHENTIK_TAG=${ONTRAK_LOCAL_AUTHENTIK_TAG:-2026.8.3}
AUTHENTIK_HTTP_PORT=$port
# This host's own address, never the wildcard: the compose file publishes the port
# on loopback too, and two mappings of one port may not overlap. See the check that
# reads this value back after `load_env`.
AUTHENTIK_BIND_ADDR=${ONTRAK_LOCAL_AUTHENTIK_BIND:-$host}
PG_PASS=$(rand 36)
AUTHENTIK_SECRET_KEY=$(rand 60)
# The admin account's password (UI) and API token (provisioning). akadmin.
AUTHENTIK_BOOTSTRAP_PASSWORD=$(rand 18)
AUTHENTIK_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)

# ── where this range lives, and the callbacks it answers on ──
ONTRAK_LOCAL_HOST=$host
ONTRAK_LOCAL_OIDC_CLIENT_ID=ontrak
ONTRAK_LOCAL_OIDC_CLIENT_SECRET=$(openssl rand -hex 32)
ONTRAK_LOCAL_OIDC_REDIRECT_URI=http://localhost:8080/oidc/callback,http://127.0.0.1:8080/oidc/callback,http://$host:8080/oidc/callback

# ── the family stack's own client (docker-compose.all.yml) ──
# One client for the whole family, for the reason provision.py gives where it is
# registered: an issuer is an application in Authentik and an application has one
# front-channel provider, while the family compose carries a single
# ONTRAK_OIDC_ISSUER for every product. The provider's redirect URIs are the
# products' published callbacks, which provision.py derives rather than reads.
ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID=ontrak-family
ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET=$(rand 32)
# The family's published ports, which are both the addresses its products are
# reached on and the ports their callbacks are registered under — one list, in
# one place, because a callback the provider was not given is a sign-in that dies
# at its door. `docker-compose.all.yml` publishes exactly these, and it is the
# file to change if any of them ever moves.
ONTRAK_LOCAL_FAMILY_TRAINING_PORT=3000
ONTRAK_LOCAL_FAMILY_TIX_PORT=3001
ONTRAK_LOCAL_FAMILY_PORTAL_PORT=3300
ONTRAK_LOCAL_FAMILY_GENIE_PORT=3400
ONTRAK_LOCAL_FAMILY_SYNC_PORT=8420
# The one desk Tix serves, so its sign-in page shows the SSO button without
# asking for an internal tenant slug (ONTRAK_TIX_DEFAULT_TENANT in the compose).
ONTRAK_LOCAL_FAMILY_TIX_TENANT=acme

# ── the seed accounts provision.py creates ──
ONTRAK_LOCAL_INSTRUCTOR=instructor@ontrak.lab
ONTRAK_LOCAL_STUDENT_DOMAIN=ontrak.lab
ONTRAK_LOCAL_STUDENTS=6
ONTRAK_LOCAL_SEED_PASSWORD=$(rand 12)
EOF
  ok "wrote $ENV_FILE (fresh secrets)"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing — run this script without arguments first"
  set -a
  # shellcheck disable=SC1090  # a generated env file, by design
  . "$ENV_FILE"
  set +a
}

# The family's values, added after the first release of this script. An .env
# written before them has none of them, and re-running generate_env over it would
# rotate the portal's client secret as well — a range that signed people in
# yesterday and refuses them today, over a change nobody asked for. So the
# missing ones are appended, once, and nothing that is already there is touched.
ensure_family_secrets() {
  local keys=(
    ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID
    ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET
    ONTRAK_LOCAL_FAMILY_TRAINING_PORT
    ONTRAK_LOCAL_FAMILY_TIX_PORT
    ONTRAK_LOCAL_FAMILY_PORTAL_PORT
    ONTRAK_LOCAL_FAMILY_GENIE_PORT
    ONTRAK_LOCAL_FAMILY_SYNC_PORT
    ONTRAK_LOCAL_FAMILY_TIX_TENANT
  )
  local missing=() key
  for key in "${keys[@]}"; do
    grep -q "^$key=" "$ENV_FILE" || missing+=("$key")
  done
  [ "${#missing[@]}" -gt 0 ] || return 0

  log "adding the family stack's client to $ENV_FILE (${#missing[@]} value(s) missing)"
  umask 077
  {
    printf '\n# ── the family stack (docker-compose.all.yml) ──\n'
    for key in "${missing[@]}"; do
      case "$key" in
        *_OIDC_CLIENT_ID)     printf '%s=ontrak-family\n' "$key" ;;
        *_OIDC_CLIENT_SECRET) printf '%s=%s\n' "$key" "$(rand 32)" ;;
        *_TRAINING_PORT)      printf '%s=3000\n' "$key" ;;
        *_TIX_PORT)           printf '%s=3001\n' "$key" ;;
        *_PORTAL_PORT)        printf '%s=3300\n' "$key" ;;
        *_GENIE_PORT)         printf '%s=3400\n' "$key" ;;
        *_SYNC_PORT)          printf '%s=8420\n' "$key" ;;
        *_TIX_TENANT)         printf '%s=acme\n' "$key" ;;
        *)                    printf '%s=\n' "$key" ;;
      esac
    done
  } >>"$ENV_FILE"
  ok "family client: ${ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID:-ontrak-family}"
}


# ------------------------------------------------------------------- the stack --
compose() {
  docker compose --env-file "$ENV_FILE" -f "$HERE/compose.yaml" "$@"
}

# Does this authenticated API query answer *rows* yet? An empty `"results":[]` is
# what an Authentik whose worker has not applied its default blueprints answers, and
# what `provision.py` reads as "not there" (it raises rather than waiting).
api_has_results() { # api_has_results <path>
  local body
  body="$(curl -fsS --max-time 4 -H "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}" \
    "http://127.0.0.1:${AUTHENTIK_HTTP_PORT}$1" 2>/dev/null)" || return 1
  [ -n "$body" ] && ! printf '%s' "$body" | grep -q '"results":\[\]'
}

wait_for_ready() {
  local port="$1" deadline=$((SECONDS + 300)) url answered=0
  for url in "http://127.0.0.1:$port/-/health/ready/" "http://127.0.0.1:$port/-/health/live/" "http://127.0.0.1:$port/"; do
    while [ "$SECONDS" -lt "$deadline" ]; do
      if curl -fsS -o /dev/null --max-time 4 "$url" 2>/dev/null; then
        ok "Authentik is answering at $url"
        answered=1
        break 2
      fi
      sleep 3
    done
  done
  [ "$answered" = 1 ] || return 1

  # Answering is not the same as provisionable, and the gap is the first boot's:
  # the provider's authorization flow, the signing key it signs with and the OAuth
  # scope mappings all come from the worker applying Authentik's default blueprints,
  # which happens *after* `/-/health/ready/` starts returning 200. Declared ready and
  # then provisioned from, a first run dies on the first lookup it makes — "neither
  # default provider authorization flow is present" — with the IdP up and healthy,
  # which reads like a broken script rather than an early one. So readiness here means
  # the two artefacts `provision.py` reads by name are readable, not merely that the
  # server answers.
  while [ "$SECONDS" -lt "$deadline" ]; do
    if api_has_results "/api/v3/flows/instances/?slug=default-provider-authorization-implicit-consent" \
      && api_has_results "/api/v3/crypto/certificatekeypairs/?has_key=true"; then
      ok "Authentik's default flows and signing key are in place"
      return 0
    fi
    sleep 3
  done
  warn "Authentik is answering but its default flows are still missing — provisioning will report it"
  return 0
}


# ------------------------------------------------------------------- provision --
provision() {
  # provision.py is stdlib-only, so the system interpreter runs it — but the
  # checkout's venv is used when there is one, because that is what `make setup`
  # left behind and it is the one the rest of the project's scripts use.
  local python="python3"
  if [ -x "$REPO_ROOT/.venv/bin/python" ]; then
    python="$REPO_ROOT/.venv/bin/python"
  fi
  # Authentik is reached on loopback here: this script and the API call it makes
  # are both on the host. The *issuer URL* in ontrak-oidc.env is the host
  # address, because that one is for the browser and the portal container.
  AUTHENTIK_URL="http://127.0.0.1:${AUTHENTIK_HTTP_PORT}" "$python" "$HERE/provision.py"
}


# ------------------------------------------------------------------ the values --
# A compose *env file*, not a shell script to source: `docker compose --env-file`
# reads it while it is still resolving `${...}` in docker-compose.yml, which is
# the only place these can be set. A service's `env_file:` is read later and
# loses to the compose file's own `environment:` block, so it cannot override a
# declared variable — and the portal declares all of these.
# ------------------------------------------------------------------ the family --
# Everything `docker-compose.all.yml` needs to sign people in through this
# Authentik, as a marked block in the family checkout's .env. Values rather than
# a paragraph: the products read the same names they would read in the estate, so
# nothing about them is special-cased for a local IdP except the addresses.
write_family_env() {
  [ -d "$FAMILY_DIR" ] || die "the family checkout is not at $FAMILY_DIR — set ONTRAK_FAMILY_DIR to where it is"
  [ -f "$FAMILY_ENV_FILE" ] || die "$FAMILY_ENV_FILE is missing — copy .env.example in the family checkout first"

  local host="$ONTRAK_LOCAL_HOST"
  local issuer="http://$host:$AUTHENTIK_HTTP_PORT/application/o/${FAMILY_APPLICATION_SLUG:-ontrak-family}/"
  local client_id="${ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID:-ontrak-family}"
  local secret="$ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET"
  # The products' own addresses. A redirect URI is built from these and compared
  # byte for byte by the provider, which is the single most common way a
  # handshake "just does not work": the container's own name is not registered
  # and never can be.
  local training="http://$host:${ONTRAK_LOCAL_FAMILY_TRAINING_PORT:-3000}"
  local tix="http://$host:${ONTRAK_LOCAL_FAMILY_TIX_PORT:-3001}"
  local portal="http://$host:${ONTRAK_LOCAL_FAMILY_PORTAL_PORT:-3300}"
  local genie="http://$host:${ONTRAK_LOCAL_FAMILY_GENIE_PORT:-3400}"
  local sync="http://$host:${ONTRAK_LOCAL_FAMILY_SYNC_PORT:-8420}"

  # The block is owned by this script, so it is replaced rather than appended to:
  # re-running after the client secret rotated (or after this host's address
  # changed) has to leave one answer, not two that disagree.
  local tmp
  tmp="$(mktemp "$FAMILY_ENV_FILE.XXXXXX")"
  awk -v begin="$FAMILY_MARK_BEGIN" -v end="$FAMILY_MARK_END" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$FAMILY_ENV_FILE" >"$tmp"
  # A file ending without a newline would glue the block onto its last line.
  [ -s "$tmp" ] && [ -n "$(tail -c 1 "$tmp")" ] && printf '\n' >>"$tmp"
  umask 077
  cat >>"$tmp" <<EOF
$FAMILY_MARK_BEGIN
# Written by deploy/authentik/setup.sh — the family signed in through the local
# Authentik. Delete this block (and re-run the products) to go back to no SSO.
#
# One client for the whole family, not one per product: an issuer is an
# application in Authentik and an application has one front-channel provider,
# while this compose file carries a single ONTRAK_OIDC_ISSUER for every product.
# The per-product client-id variables below are therefore all this one client id.
# Its redirect URIs are every product's published callback.

# ── the provider ──
ONTRAK_OIDC_ISSUER=$issuer
ONTRAK_OIDC_PROVIDER_NAME=${ONTRAK_LOCAL_OIDC_PROVIDER_NAME:-OnTrak Authentik}
# One mapping per line, and a mapping file cannot carry a blank line: an
# instructor's group becomes the instructor role, and everyone else the default.
ONTRAK_OIDC_ROLE_MAPPINGS=range-instructors=INSTRUCTOR
ONTRAK_OIDC_DEFAULT_ROLE=STUDENT
ONTRAK_OIDC_SCOPES=profile,email,groups

# ── OnTrak Training (:3000) ──
ONTRAK_TRAINING_BASE_URL=$training
ONTRAK_OIDC_CLIENT_ID=$client_id
ONTRAK_OIDC_CLIENT_SECRET=$secret

# ── OnTrak Tix (:3001) ──
# Its client id and issuer live in a row in its own database, not here — the
# secret is the one thing it reads from the environment. setup.sh --family
# writes that row.
ONTRAK_TIX_BASE_URL=$tix
ONTRAK_TIX_DEFAULT_TENANT=${ONTRAK_LOCAL_FAMILY_TIX_TENANT:-acme}
ONTRAK_TIX_OIDC_CLIENT_SECRET=$secret

# ── the family Portal (:3300) ──
ONTRAK_PORTAL_PUBLIC_URL=$portal
ONTRAK_PORTAL_OIDC_CLIENT_ID=$client_id
ONTRAK_PORTAL_OIDC_CLIENT_SECRET=$secret

# ── OnTrak Genie (:3400) ──
# Genie takes its secret and its session secret from ontrak-genie/.env, which the
# compose file also mounts — see this script's notes there.
ONTRAK_OIDC_REDIRECT_URL=$genie/api/auth/callback

# ── OnTrak Sync (:8420) ──
ONTRAK_SYNC_PUBLIC_URL=$sync
ONTRAK_SYNC_OIDC_CLIENT_ID=$client_id
ONTRAK_SYNC_OIDC_CLIENT_SECRET=$secret
$FAMILY_MARK_END
EOF
  # The original keeps its mode; the rewrite is atomic so a reader never sees a
  # half-written .env.
  chmod --reference="$FAMILY_ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$FAMILY_ENV_FILE"
  ok "wrote the family block into $FAMILY_ENV_FILE"

  # The family Portal's session secret, outside the block on purpose.
  #
  # Not IdP wiring — it is the key the portal signs its own session cookie with —
  # but the portal refuses to start a handshake without it ("ONTRAK_PORTAL_SESSION_SECRET
  # is not set. There is no default: a session cookie signed with a placeholder is
  # a session cookie anybody can mint"), so a family wired to an IdP and missing
  # this reads as "single sign-on is broken" when it is one unset variable. Written
  # once and never rewritten: rotating it signs everyone out, which is not what a
  # re-run of this script should do to a desk that is in use.
  if ! grep -q '^ONTRAK_PORTAL_SESSION_SECRET=' "$FAMILY_ENV_FILE" 2>/dev/null; then
    umask 077
    {
      printf '\n# The family Portal session-cookie key — written once by\n'
      printf '# deploy/authentik/setup.sh --family, because the portal will not start a\n'
      printf '# sign-in without it. Rotate it to sign everybody out.\n'
      printf 'ONTRAK_PORTAL_SESSION_SECRET=%s\n' "$(rand 32)"
    } >>"$FAMILY_ENV_FILE"
    ok "set ONTRAK_PORTAL_SESSION_SECRET (the portal refuses a handshake without it)"
  fi

  # Genie's two, into the file the compose file mounts for it. Appended rather
  # than rewritten: that file is Genie's own and holds the gateway's credentials.
  local genie_env="$FAMILY_DIR/ontrak-genie/.env"
  if [ -d "$FAMILY_DIR/ontrak-genie" ]; then
    umask 077
    grep -q '^ONTRAK_OIDC_CLIENT_SECRET=' "$genie_env" 2>/dev/null \
      || printf 'ONTRAK_OIDC_CLIENT_SECRET=%s\n' "$secret" >>"$genie_env"
    grep -q '^ONTRAK_OIDC_SESSION_SECRET=' "$genie_env" 2>/dev/null \
      || printf 'ONTRAK_OIDC_SESSION_SECRET=%s\n' "$(rand 32)" >>"$genie_env"
    ok "wrote Genie's client secret and session secret into $genie_env"
  fi
}


# Tix's identity connection, which is a row and not a variable.
#
# Every other product in the family reads its issuer and client id from the
# environment; Tix looks them up per tenant in its own database, because a desk
# can serve several organisations against several providers. So "point Tix at
# this Authentik" is a write, and there is no API for it that does not first need
# a signed-in admin. It is done through psql inside the desk's own database
# container — the same client schema the app reads — and it is idempotent.
connect_tix_connection() {
  local host="$ONTRAK_LOCAL_HOST"
  local issuer="http://$host:$AUTHENTIK_HTTP_PORT/application/o/${FAMILY_APPLICATION_SLUG:-ontrak-family}/"
  local client_id="${ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID:-ontrak-family}"
  local tenant="${ONTRAK_LOCAL_FAMILY_TIX_TENANT:-acme}"
  local container="${ONTRAK_TIX_DB_CONTAINER:-ontrak-family-tix-db-1}"
  local db="${ONTRAK_TIX_DB_NAME:-ontrak_tix}"
  local user="${ONTRAK_TIX_DB_USER:-ontrak}"

  if ! docker inspect "$container" >/dev/null 2>&1; then
    warn "no $container to write Tix's identity connection into — is the family stack up?"
    return 1
  fi

  # `tenantId` is Tix's own id for the desk, not its slug, so the row is written
  # from a subselect and only when the tenant exists. 'OIDC' is the enum label;
  # the role mappings are the same shape the app's parser reads.
  #
  # `email` and `profile` are in the scopes deliberately: Tix requests `openid`
  # plus whatever this column names, and a connection asking only for `groups`
  # gets an ID token with no address in it, which the desk refuses with "the ID
  # token carried no usable email address" — a sign-in that reached the desk and
  # could not be completed.
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" <<SQL
INSERT INTO "IdentityConnection" (
  id, "tenantId", protocol, issuer, "clientId", scopes, "allowedDomains",
  "defaultRole", "roleMappings", "mfaRequired", "scimEnabled", "createdAt", "updatedAt"
)
SELECT
  'ontrak-local-authentik', t.id, 'OIDC'::"IdentityProtocol", '$issuer', '$client_id',
  ARRAY['email', 'profile', 'groups'], ARRAY[]::text[], 'REQUESTER'::"Role",
  '[{"claim":"groups","value":"range-instructors","role":"AGENT"}]'::jsonb,
  false, false, now(), now()
FROM "Tenant" t WHERE t.slug = '$tenant'
ON CONFLICT ("tenantId") DO UPDATE SET
  protocol = EXCLUDED.protocol,
  issuer = EXCLUDED.issuer,
  "clientId" = EXCLUDED."clientId",
  scopes = EXCLUDED.scopes,
  "allowedDomains" = EXCLUDED."allowedDomains",
  "roleMappings" = EXCLUDED."roleMappings",
  "updatedAt" = now();
SQL
  ok "Tix: tenant $tenant signs in through this Authentik"
}


write_local_env() {
  local issuer="http://${ONTRAK_LOCAL_HOST}:${AUTHENTIK_HTTP_PORT}/application/o/ontrak/"
  # Demo mode is a *default*, never an override. This file is rewritten on every
  # run, so a hard-coded `true` here silently turned a range that had been put on
  # real machines back into a simulation — the portal comes up on an in-memory
  # Incus, sessions get fabricated addresses, and every console link is handed a
  # machine that does not exist, which reads as "the console is broken" rather
  # than "this range is not running the lab".
  #
  # The value comes from, in order: an explicit ONTRAK_LOCAL_DEMO, whatever this
  # file already says, the checkout's own .env, and finally true — a laptop range
  # with no image built yet, which is what the default is for.
  local demo="${ONTRAK_LOCAL_DEMO:-}"
  if [ -z "$demo" ] && [ -f "$LOCAL_ENV_FILE" ]; then
    demo="$(sed -n 's/^ONTRAK_DEMO__ENABLED=//p' "$LOCAL_ENV_FILE" | tail -1)"
  fi
  if [ -z "$demo" ] && [ -f "$REPO_ROOT/.env" ]; then
    demo="$(sed -n 's/^ONTRAK_DEMO__ENABLED=//p' "$REPO_ROOT/.env" | tail -1)"
  fi
  [ -n "$demo" ] || demo=true
  umask 077
  cat >"$LOCAL_ENV_FILE" <<EOF
# Generated by deploy/authentik/setup.sh — how a local range is pointed at the
# standalone Authentik in this directory. Gitignored: it holds a client secret.
#
# Use it by passing the checkout's .env first and this file second, so this one
# wins where the two disagree:
#
#   docker compose --env-file .env --env-file deploy/authentik/ontrak-local.env \\
#     up -d portal
#
# Or let setup.sh do exactly that: deploy/authentik/setup.sh --connect
#
# A bare 'docker compose up -d' resolves these from .env instead and puts the
# range back on the estate's Authentik — run --connect again to return to this
# one.
ONTRAK_PORTAL__OIDC_ISSUER=$issuer
ONTRAK_PORTAL__OIDC_CLIENT_ID=${ONTRAK_LOCAL_OIDC_CLIENT_ID}
ONTRAK_PORTAL__OIDC_CLIENT_SECRET=${ONTRAK_LOCAL_OIDC_CLIENT_SECRET}
ONTRAK_PORTAL__OIDC_REDIRECT_URI=${ONTRAK_LOCAL_OIDC_REDIRECT_URI}
ONTRAK_PORTAL__OIDC_INSTRUCTOR_GROUP=range-instructors

# The address a student's browser uses for this range and its console. The host
# address rather than localhost, for the reason at the top of this file: it is
# the one name the browser and the containers agree on.
ONTRAK_BIND_ADDR=${ONTRAK_LOCAL_BIND:-0.0.0.0}
ONTRAK_GUAC__BASE_URL=http://${ONTRAK_LOCAL_HOST}:${ONTRAK_PORTAL__PORT:-8080}/guacamole/

# A local range has no hypervisor-backed machines until the golden Windows image
# has been built ('make golden', 30-60 minutes) — so it serves its scenarios from
# demo mode, which is an in-memory Incus and a driver that reports plausible
# grades. That is what makes a class work end to end here. Set it to false once
# the image and the templates exist and the range should hand out real VMs.
#
# Carried forward from the last run (or from the checkout's .env), so turning it
# off sticks: pass ONTRAK_LOCAL_DEMO=false to change it from here.
ONTRAK_DEMO__ENABLED=$demo
EOF
  ok "wrote $LOCAL_ENV_FILE"
}


# -------------------------------------------------------------------- connect --
# Two env files on one command line: the checkout's own first, so a range keeps
# every other setting it has, and the local one second, so it wins on the values
# they disagree about. The operator's .env is never written to — wiring a range
# to a local IdP is a thing you do to a running stack, and undoing it is running
# compose without the second file.
connect() {
  log "pointing the local OnTrak portal at this Authentik"
  local env_args=(--env-file "$LOCAL_ENV_FILE")
  if [ -f "$REPO_ROOT/.env" ]; then
    env_args=(--env-file .env "${env_args[@]}")
  fi
  # portal *and* gateway: the portal reads the issuer from its environment, but
  # the address students reach it on is the gateway's published port, and
  # ONTRAK_BIND_ADDR is read there. Recreating only the portal leaves a range
  # that signs in and cannot be reached.
  ( cd "$REPO_ROOT" && docker compose "${env_args[@]}" -f docker-compose.yml up -d portal gateway )
  ok "portal and gateway recreated against http://${ONTRAK_LOCAL_HOST}:${AUTHENTIK_HTTP_PORT}"
}

# The family's side. No second env file here, unlike the range: the values went
# into the family checkout's own .env, so the only thing left is to make the
# running containers read them again. Named services rather than the whole stack —
# the databases, Sentinel and the preview host are not sign-in clients and
# restarting them buys nothing.
connect_family() {
  log "recreating the family services against this Authentik"
  ( cd "$FAMILY_DIR" && docker compose -f docker-compose.all.yml up -d \
      training-app tix-app portal-app sync-api genie-app )
  ok "training, tix, portal, sync and genie recreated"
}


# ------------------------------------------------------------------------ run --
case "${1:-}" in
  --down | down)
    load_env
    log "stopping the local Authentik (its database is kept)"
    compose down
    exit 0
    ;;
  --help | -h)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  generate_env
else
  ok "using the existing $ENV_FILE (delete it for fresh secrets)"
fi

# Before load_env, because the values it adds are the ones provisioning reads.
ensure_family_secrets
load_env

# The one value here that cannot be defaulted into working. The compose file
# publishes this port twice — once on loopback, which is where this script's own
# readiness wait and `provision.py` call it, and once on `AUTHENTIK_BIND_ADDR` — and
# dockerd accepts two mappings of one host port only when the addresses are specific
# and *different*. The wildcard beside loopback, or loopback twice, is refused with
# an "address already in use" that names neither the file nor the rule, and every
# path below would present that as a failure to start; so it is asked about here,
# where the answer is still a sentence. A host with nothing but loopback has no
# address the portal container and a browser can both use, which is what this says.
case "${AUTHENTIK_BIND_ADDR:-}" in
  "" | 0.0.0.0 | :: | 127.0.0.1 | localhost)
    die "AUTHENTIK_BIND_ADDR=${AUTHENTIK_BIND_ADDR:-} cannot be published beside the loopback mapping of the same port. Set it in $ENV_FILE to an address both this host and a browser can use — '$(detect_host)' is this host's — or delete $ENV_FILE and run this script again."
    ;;
esac

log "starting Authentik (${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${AUTHENTIK_TAG}) on port ${AUTHENTIK_HTTP_PORT}"
compose up -d

if ! wait_for_ready "$AUTHENTIK_HTTP_PORT"; then
  warn "Authentik did not report ready in time; recent logs:"
  compose logs --tail 40 server || true
  die "giving up — check 'docker compose -f $HERE/compose.yaml logs'"
fi

log "provisioning OnTrak's application, groups and accounts"
provision

write_local_env

cat <<EOF

$(log "local Authentik ready")

  admin UI     http://${ONTRAK_LOCAL_HOST}:${AUTHENTIK_HTTP_PORT}/
               sign in as akadmin / ${AUTHENTIK_BOOTSTRAP_PASSWORD}

  issuer       http://${ONTRAK_LOCAL_HOST}:${AUTHENTIK_HTTP_PORT}/application/o/ontrak/
  accounts     ${ONTRAK_LOCAL_INSTRUCTOR}  (instructor)
               student1..${ONTRAK_LOCAL_STUDENTS}@${ONTRAK_LOCAL_STUDENT_DOMAIN}   (students)
               password for all of them: ${ONTRAK_LOCAL_SEED_PASSWORD}

Next:
  1. point the range at it:   deploy/authentik/setup.sh --connect
  2. open the portal and use "Sign in with Authentik"
EOF

if [ "${1:-}" = "--connect" ]; then
  connect
fi

# --family does for the family stack what --connect does for the range, plus the
# two writes that have no environment variable to carry them: the family .env and
# Tix's identity connection row.
if [ "${1:-}" = "--family" ]; then
  write_family_env
  connect_tix_connection || true
  connect_family

  cat <<EOF

  family issuer     http://${ONTRAK_LOCAL_HOST}:${AUTHENTIK_HTTP_PORT}/application/o/${FAMILY_APPLICATION_SLUG:-ontrak-family}/
  family client id  ${ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID:-ontrak-family}
  family secret     ${ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET}

  Every family product signs in as the accounts above — the family has no
  accounts of its own, which is the point of wiring it to one provider.
  Products:  Training :${ONTRAK_LOCAL_FAMILY_TRAINING_PORT:-3000}
             Tix      :${ONTRAK_LOCAL_FAMILY_TIX_PORT:-3001}   (tenant ${ONTRAK_LOCAL_FAMILY_TIX_TENANT:-acme})
             Portal   :${ONTRAK_LOCAL_FAMILY_PORTAL_PORT:-3300}
             Genie    :${ONTRAK_LOCAL_FAMILY_GENIE_PORT:-3400}
             Sync     :${ONTRAK_LOCAL_FAMILY_SYNC_PORT:-8420}
EOF
fi
