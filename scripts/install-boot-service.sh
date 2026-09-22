#!/usr/bin/env bash
#
# OnTrak — make the range start on boot.
#
#   sudo bash scripts/install-boot-service.sh
#   # or: make boot
#
# Writes /etc/systemd/system/ontrak-range.service from
# infra/systemd/ontrak-range.service with this checkout's absolute path
# substituted, then enables it. The unit starts the same TLS stack `make up`
# starts, so a host that reboots — a power cut, an unattended update — comes back
# serving the range with no operator at the keyboard:
#
#   https://<this host>:8443/
#
# The checkout path is baked in. If you move the checkout, re-run this.
#
# Undo:
#   sudo systemctl disable --now ontrak-range
#   sudo rm /etc/systemd/system/ontrak-range.service && sudo systemctl daemon-reload
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/infra/systemd/ontrak-range.service"
UNIT="/etc/systemd/system/ontrak-range.service"
SERVICE="ontrak-range.service"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# --- the three things this needs, checked before anything is written ----------
[[ "$(id -u)" -eq 0 ]] || die "must run as root: sudo bash scripts/install-boot-service.sh"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found: this host does not use systemd"
command -v docker >/dev/null 2>&1 || die "docker not found: run 'make docker' first, or 'make bootstrap'"
[[ -f "$TEMPLATE" ]] || die "missing unit template: $TEMPLATE"
[[ -f "$ROOT/docker-compose.yml" && -f "$ROOT/docker-compose.tls.yml" ]] \
  || die "this does not look like an OnTrak checkout (no compose files in $ROOT)"

DOCKER_BIN="$(command -v docker)"

# The unit hard-codes /usr/bin/docker, which is the one realistic difference
# between hosts (a Homebrew or snap install lands elsewhere). Patch the template
# rather than shipping a unit that silently cannot start.
log "installing $SERVICE (checkout: $ROOT)"
{
  sed -e "s|@ONTRAK_DIR@|$ROOT|g" -e "s|/usr/bin/docker|$DOCKER_BIN|g" "$TEMPLATE"
} > "$UNIT"
chmod 0644 "$UNIT"

# Docker itself has to come up at boot, or the unit's Requires= has nothing to
# start. Idempotent; --now also starts it if it is stopped.
log "enabling docker.service (the stack cannot start before it)"
systemctl enable --now docker.service >/dev/null 2>&1 || warn "could not enable docker.service — check: systemctl status docker"

# The certificate the unit requires. Idempotent: it only writes when missing.
log "ensuring the TLS certificate exists"
bash "$ROOT/scripts/tls-local-cert.sh" >/dev/null

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

# Start it now too, so the running stack is the same stack boot will bring back.
# `up -d` is idempotent, so a range already serving is left exactly as it is.
log "starting $SERVICE"
systemctl start "$SERVICE" || die "the unit failed to start — see: journalctl -u $SERVICE -n 50"

address="$(bash -c "cd '$ROOT' && make -s lan 2>/dev/null || true")"

cat <<EOF

$(log "the range starts on boot")

  unit      $(systemctl is-enabled "$SERVICE") / $(systemctl is-active "$SERVICE")
  starts    docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
  portal    ${address:-https://<this host>:8443/}

  now       journalctl -u $SERVICE -n 50        what the last boot did
  check     make lan                            the address to open
  stop      sudo systemctl disable --now $SERVICE
  remove    sudo rm $UNIT && sudo systemctl daemon-reload

  note      the checkout path is baked in: re-run this after moving $ROOT
EOF
