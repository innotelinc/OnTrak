#!/usr/bin/env bash
#
# Create the "intranet" the scenarios test against.
#
#   infra/lab-services.sh
#
# Two tiny containers on the lab bridge give the network scenarios something real
# to resolve and reach:
#
#   fileserver.ontrak.lab  (HTTP 80)    — the file server in the ticket text
#   portal.ontrak.lab      (HTTP 8080)  — the staff portal the malware scenario redirects
#
# Names are resolved by the bridge's own DNS (Incus runs dnsmasq and answers
# <name>.<dns.domain>), which is what makes the DNS scenario honest: fixing the
# resolver is what makes the name work, not a hosts file entry.

set -euo pipefail

PROJECT="${ONTRAK_INCUS_PROJECT:-ontrak}"
NETWORK="${ONTRAK_NETWORK:-ontrak0}"
DOMAIN="${ONTRAK_DOMAIN:-ontrak.lab}"
IMAGE="${ONTRAK_SERVICE_IMAGE:-images:alpine/3.20/cloud}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }

command -v incus >/dev/null || { echo "incus not found; run infra/bootstrap-host.sh first" >&2; exit 1; }

create_service() {
  local name="$1" port="$2" body="$3"
  if incus --project "$PROJECT" info "$name" >/dev/null 2>&1; then
    log "container '$name' already exists"
  else
    log "creating container '$name'"
    incus --project "$PROJECT" launch "$IMAGE" "$name" -p default
  fi

  # Wait for the container's network and default user, then install busybox httpd.
  for _ in $(seq 1 60); do
    if incus --project "$PROJECT" exec "$name" -- sh -c 'true' >/dev/null 2>&1; then break; fi
    sleep 2
  done

  incus --project "$PROJECT" exec "$name" -- sh -c "
    mkdir -p /srv/www
    cat > /srv/www/index.html <<'HTML'
$body
HTML
    rc-update add local default >/dev/null 2>&1 || true
    cat > /etc/local.d/ontrak-http.start <<'SCRIPT'
#!/bin/sh
exec busybox httpd -f -p $port -h /srv/www
SCRIPT
    chmod +x /etc/local.d/ontrak-http.start
    pkill busybox 2>/dev/null || true
    /etc/local.d/ontrak-http.start &
  " || warn "could not start the web service inside $name"

  local ip
  ip="$(incus --project "$PROJECT" list "$name" --format=csv -c 4 | cut -d' ' -f1)"
  log "  $name -> ${ip:-?} (http://${name}.${DOMAIN}:$port)"
}

create_service fileserver 80 \
  "<html><body><h1>OnTrak file server</h1><p>Shared drives: Finance, Reception, Sites.</p></body></html>"

create_service portal 8080 \
  "<html><body><h1>OnTrak staff portal</h1><p>Internal portal. If you are reading this from a redirect, your machine has been tampered with.</p></body></html>"

cat <<EOF

$(log "lab services ready")

Verify name resolution from a guest (or from a test VM):
  Get-DnsClientServerAddress
  Resolve-DnsName fileserver.$DOMAIN
  Test-NetConnection fileserver.$DOMAIN -Port 80

If names do not resolve, confirm the bridge has the DNS domain set:
  incus network get $NETWORK dns.domain
EOF
