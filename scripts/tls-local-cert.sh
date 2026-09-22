#!/usr/bin/env bash
# OnTrak — a local TLS certificate for the gateway, so a LAN range is encrypted.
#
#   bash scripts/tls-local-cert.sh            # write deploy/tls/ if it is missing
#   bash scripts/tls-local-cert.sh --force    # re-issue (the host's address moved)
#
# Why self-signed: a range reached directly on a LAN has no public name, so there
# is nothing for Let's Encrypt to validate and no CA to ask — `docker-compose.tls.yml`
# is the LAN case, and the alternative is no encryption at all. The browser warns
# once per device until this certificate is trusted there; the traffic is encrypted
# regardless. A deployment behind Cerulean's edge has a real certificate and does
# not use this at all.
#
# What it covers: every address this host answers on — `localhost`, its hostname,
# 127.0.0.1 and each private IPv4 it holds — as *subject alternative names*, which
# is the part browsers actually check. Re-run it with --force when the host's
# address changes (a new Wi-Fi network is the usual reason): a certificate that
# names yesterday's IP is the one warning that looks like the range being broken.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ONTRAK_TLS_DIR:-$ROOT/deploy/tls}"
CRT="$OUT/ontrak.crt"
KEY="$OUT/ontrak.key"

if [ -f "$CRT" ] && [ -f "$KEY" ] && [ "$FORCE" -ne 1 ]; then
  echo "==> ${CRT} already exists; leaving it alone (--force to re-issue)"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "!! openssl not found: install it, or place a certificate pair in ${OUT} yourself" >&2
  exit 1
fi

# The addresses to name. `hostname -I` is a space-separated list on Linux; only the
# private ones are kept, because a public address on this list would be a name this
# certificate should not claim.
SAN="DNS:localhost"
HOSTNAME_SHORT="$(hostname 2>/dev/null || true)"
if [ -n "$HOSTNAME_SHORT" ]; then
  SAN="${SAN},DNS:${HOSTNAME_SHORT}"
fi
SAN="${SAN},IP:127.0.0.1"
FOUND_LAN=0
for addr in $(hostname -I 2>/dev/null || true); do
  case "$addr" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) SAN="${SAN},IP:${addr}"; FOUND_LAN=1 ;;
  esac
done
if [ "$FOUND_LAN" -eq 0 ]; then
  echo "!! no private IPv4 address found; the certificate will not cover a LAN address." >&2
  echo "   Add one by hand: ONTRAK_TLS_SAN=\"IP:192.168.1.50\" bash scripts/tls-local-cert.sh" >&2
fi
# An operator can extend the list without editing this script.
[ -n "${ONTRAK_TLS_SAN:-}" ] && SAN="${SAN},${ONTRAK_TLS_SAN}"

mkdir -p "$OUT"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/openssl.cnf" <<EOF
[req]
distinguished_name = dn
prompt             = no
x509_extensions    = v3
[dn]
CN = OnTrak
O  = OnTrak (local)
[v3]
subjectAltName   = ${SAN}
basicConstraints = critical,CA:FALSE
keyUsage         = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
# A decade: this is a lab appliance, and a certificate that expires mid-course is
# an outage nobody scheduled.
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/ontrak.key" -out "$tmp/ontrak.crt" \
  -config "$tmp/openssl.cnf" >/dev/null 2>&1

install -m 0644 "$tmp/ontrak.crt" "$CRT"
# The key is a secret, and the repository's secret scanner is right to treat a
# committed one as an incident: gitignored (deploy/tls/) and 0600 here.
install -m 0600 "$tmp/ontrak.key" "$KEY"

echo "==> wrote ${CRT}"
echo "    and  ${KEY}  (0600 — never commit this)"
echo "    covers: ${SAN}"
echo
echo "    next: make up       -> https://<this host>:${ONTRAK_TLS_PORT:-8443}/   (TLS is the default)"
