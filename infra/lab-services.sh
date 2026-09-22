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
# Names are served by the bridge's own dnsmasq, which is what makes the DNS
# scenario honest: fixing the resolver is what makes the name work, not a hosts
# file entry on the guest.
#
# The records are written *explicitly* (raw.dnsmasq) rather than left to Incus's
# automatic name registration (dns.mode=managed), for two reasons:
#
#   * the lab bridge runs with dns.mode=none, because Incus refuses a second NIC
#     on a managed network while that network is also registering its names
#     ("Instance DNS name X conflict between eth1 and eth0 because both are
#     connected to same network") and `hw-driver-device` needs exactly that;
#   * an explicit record with a pinned address is deterministic, where an
#     auto-registered one follows whatever lease the container happened to get.
#
# Neither change touches the exercise: the resolver a student has to repair is
# still this bridge's dnsmasq, and nothing else resolves the intranet names.

set -euo pipefail

PROJECT="${ONTRAK_INCUS_PROJECT:-ontrak}"
NETWORK="${ONTRAK_NETWORK:-ontrak0}"
DOMAIN="${ONTRAK_DOMAIN:-ontrak.lab}"
# An Alpine *branch* alias, which the image server carries only for the newest
# couple of releases: 3.20 rolled off and this script then could not run on any
# fresh host ("Failed getting image: The requested image couldn't be found"). The
# preflight below turns the next roll-off into one actionable line.
IMAGE="${ONTRAK_SERVICE_IMAGE:-images:alpine/3.21/cloud}"
# Pinned, and outside the DHCP pool (ipv4.dhcp.ranges), so a lease can never be
# handed to something else and shadow these.
FILESERVER_IP="${ONTRAK_FILESERVER_IP:-10.20.0.53}"
PORTAL_IP="${ONTRAK_PORTAL_IP:-10.20.0.54}"

log()  { printf '\033[36m==>%s\033[0m %s\n' "" "$*"; }
warn() { printf '\033[33m[!]%s\033[0m %s\n' "" "$*"; }

command -v incus >/dev/null || { echo "incus not found; run infra/bootstrap-host.sh first" >&2; exit 1; }

if ! incus image info "$IMAGE" >/dev/null 2>&1; then
  {
    echo "service image '$IMAGE' is not available from the image server." >&2
    echo "Alpine branch aliases disappear once a branch goes end of life; pick a" >&2
    echo "current one and set ONTRAK_SERVICE_IMAGE, for example:" >&2
    echo "  incus image list images: --format=csv -c l | grep alpine" >&2
  } >&2
  exit 1
fi

address_of() {
  incus --project "$PROJECT" list "$1" --format=csv -c 4 2>/dev/null | cut -d' ' -f1
}

serves() {
  curl -fsS --max-time 5 "http://$1:$2/" >/dev/null 2>&1
}

create_service() {
  local name="$1" port="$2" address="$3" body="$4"

  if incus --project "$PROJECT" info "$name" >/dev/null 2>&1; then
    log "container '$name' already exists"
  else
    log "creating container '$name'"
    incus --project "$PROJECT" launch "$IMAGE" "$name" -p default
  fi

  # Pin the address. On a container this is a DHCP reservation, so the name the
  # records below publish always points at this container. eth0 comes from the
  # `default` profile, and a profile device cannot be edited per instance
  # ("Device from profile(s) cannot be modified for individual instance") -- the
  # instance needs its own *override* of that one key.
  local current
  current="$(incus --project "$PROJECT" config device get "$name" eth0 ipv4.address 2>/dev/null || true)"
  if [[ "$current" != "$address" ]]; then
    incus --project "$PROJECT" config device override "$name" eth0 "ipv4.address=$address"
    log "  reserved ${name} at $address"
  fi

  # A container that was already running keeps the lease it took before the
  # reservation existed (dnsmasq grants it again on renewal), which would leave
  # the published name pointing at some other address. One restart settles it.
  local live
  live="$(address_of "$name")"
  if [[ "$live" != "$address" ]]; then
    log "  restarting $name to take the reserved address (held ${live:-none})"
    incus --project "$PROJECT" restart "$name" >/dev/null
    live=""
    for _ in $(seq 1 30); do
      live="$(address_of "$name")"
      [[ "$live" == "$address" ]] && break
      sleep 2
    done
    if [[ "$live" != "$address" ]]; then
      warn "$name is at ${live:-no address}, not the reserved $address; the published name will not answer"
    fi
  fi

  # Wait for the container's default user to be usable.
  for _ in $(seq 1 60); do
    if incus --project "$PROJECT" exec "$name" -- sh -c 'true' >/dev/null 2>&1; then break; fi
    sleep 2
  done

  # busybox-extras: Alpine's own busybox no longer carries the httpd applet, so
  # `busybox httpd` answers "httpd: applet not found" and the container silently
  # serves nothing. The package installs /usr/sbin/httpd.
  incus --project "$PROJECT" exec "$name" -- sh -c "
    apk add --no-cache busybox-extras >/dev/null 2>&1 || true
    mkdir -p /srv/www
    cat > /srv/www/index.html <<'HTML'
$body
HTML
    rc-update add local default >/dev/null 2>&1 || true
    cat > /etc/local.d/ontrak-http.start <<'SCRIPT'
#!/bin/sh
exec /usr/sbin/httpd -f -p $port -h /srv/www
SCRIPT
    chmod +x /etc/local.d/ontrak-http.start
    pkill httpd 2>/dev/null || true
    /etc/local.d/ontrak-http.start &
  " || warn "could not configure the web service inside $name"

  # Prove it, rather than reporting that it was started.
  local ok=""
  for _ in $(seq 1 15); do
    if serves "$address" "$port"; then ok=yes; break; fi
    sleep 2
  done
  if [[ -n "$ok" ]]; then
    log "  $name -> $address (http://${name}.${DOMAIN}:$port) — answering"
  else
    warn "$name is not answering on $address:$port; check 'incus exec $name -- ps aux'"
  fi
}

create_service fileserver 80 "$FILESERVER_IP" \
  "<html><body><h1>OnTrak file server</h1><p>Shared drives: Finance, Reception, Sites.</p></body></html>"

create_service portal 8080 "$PORTAL_IP" \
  "<html><body><h1>OnTrak staff portal</h1><p>Internal portal. If you are reading this from a redirect, your machine has been tampered with.</p></body></html>"

# --------------------------------------------------------------- dns records ---
# One value for the whole setting: `raw.dnsmasq` is not additive, so both records
# are written together or the second service would silently lose its name.
records="# OnTrak lab services (infra/lab-services.sh)
address=/fileserver.$DOMAIN/$FILESERVER_IP
address=/portal.$DOMAIN/$PORTAL_IP"
incus network set "$NETWORK" "raw.dnsmasq=$records"
incus network set "$NETWORK" "dns.domain=$DOMAIN"
log "published DNS records on '$NETWORK' for fileserver and portal in $DOMAIN"

cat <<EOF

$(log "lab services ready")

Verify name resolution from a guest (or from a test VM):
  Get-DnsClientServerAddress
  Resolve-DnsName fileserver.$DOMAIN
  Test-NetConnection fileserver.$DOMAIN -Port 80

If names do not resolve, confirm the bridge still carries the records:
  incus network get $NETWORK raw.dnsmasq
  incus network get $NETWORK dns.domain

The bridge answers these because they are declared here, not because Incus
registered the containers automatically: it runs with dns.mode=none so that one
instance may hold two NICs on it (see infra/bootstrap-host.sh).
EOF
