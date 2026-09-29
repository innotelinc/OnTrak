#!/usr/bin/env python3
"""cerulean-ontrak.py — put the OnTrak family on the Network's trust plane.

Creates what the five public names need and nothing else:

    ontrak.innotel.us              → the portal          (:3300)
    its.ontrak.innotel.us          → training range      (:3000)
    tix.ontrak.innotel.us          → the service desk    (:3001)
    sentinel.ontrak.innotel.us     → the identity/IDS   (:8787)
    sync.ontrak.innotel.us         → Network updates     (:8421)

For each name it ensures:

  * a **Technitium A record** in the Network zone, pointing at the same address the
    zone apex already uses — read from the zone rather than passed in, because this
    Network sits behind one public address and a script that guesses it is a script
    that publishes a name nobody can reach;
  * an **NPM proxy host** forwarding to the product's port on the OnTrak host;
  * the **best matching certificate** already on the edge, attached — and, with
    `--request-certs`, a Let's Encrypt certificate requested through NPM for the
    names nothing covers yet.

It is idempotent: create when missing, update when drifted, and never delete. This
NPM is shared by every stack in the Network, so a prune scoped to `ontrak.` would be
a script that deletes somebody else's host.

WHAT IT DOES NOT DO
-------------------
It does not touch Authentik. The OIDC client is registered by the Network's own
`cerulean/scripts/authentik-setup.py ontrak`, which reads
`AUTHENTIK_ONTRAK_*` from the Cerulean `.env`. That script is the one place the
provider is configured, and a second writer would be a second source of truth.
`--print-redirect-uris` prints the list that `.env` has to hold, so the two cannot
drift apart silently.

Usage:
    python3 scripts/cerulean-ontrak.py --env-file /path/to/cerulean/.env
    python3 scripts/cerulean-ontrak.py --dry-run
    python3 scripts/cerulean-ontrak.py --request-certs
    python3 scripts/cerulean-ontrak.py --print-redirect-uris
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# ── the complete host map ───────────────────────────────────────────────────
# `port` is the published port on the OnTrak host. Nothing here carries an
# nginx authorization gate: identity is Cerulean OIDC, and a product that needs
# SSO gets it from its own application, not from an `auth_request` the product
# cannot see. An edge gate would prove *somebody* signed in and could never tell
# the product *who*.
HOSTS = [
    {
        "name": "ontrak",
        "port": 3300,
        "purpose": "OnTrak Portal — one sign-in, then the products a role belongs in",
        "websocket": True,
    },
    {
        "name": "its.ontrak",
        "port": 3000,
        "purpose": "OnTrak IT Support Training — the training range",
        "websocket": True,
    },
    {
        "name": "tix.ontrak",
        "port": 3001,
        "purpose": "OnTrak Tix — the service desk",
        "websocket": True,
    },
    {
        "name": "sentinel.ontrak",
        "port": 8787,
        "purpose": "OnTrak Sentinel — identity provider and IDS/IPS console",
        "websocket": True,
    },
    {
        "name": "sync.ontrak",
        "port": 8421,
        "purpose": "OnTrak Sync — Network package and container updates",
        "websocket": True,
    },
]

# The redirect URIs the `ontrak` OIDC client has to be registered with. Kept
# beside the host map so a new product cannot be added to one and forgotten in
# the other, and printed by `--print-redirect-uris` for the Cerulean `.env`.
REDIRECT_URIS = [
    "https://ontrak.innotel.us/api/sso/callback",          # the portal
    "https://ontrak.innotel.us/api/auth/sso/callback",     # OnTrak Sync, same origin
    "https://its.ontrak.innotel.us/api/sso/callback",      # the training range
    "https://tix.ontrak.innotel.us/api/sso/callback",      # the desk
    "https://sync.ontrak.innotel.us/api/auth/sso/callback",  # OnTrak Sync behind the edge
]


def say(message: str) -> None:
    print(f"==> {message}")


def warn(message: str) -> None:
    print(f" warn {message}", file=sys.stderr)


# ── .env + environment ──────────────────────────────────────────────────────
def load_env_file(path: str) -> None:
    """Fill unset variables from a `.env`.

    Only unset ones, so an explicitly exported value wins — the same rule the
    Network's other scripts use, and the reason a stale ambient `NPM_BASE_DOMAIN`
    cannot silently redirect a run at another zone.
    """
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("[") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def http_json(url: str, *, method: str = "GET", body: dict | None = None,
              headers: dict | None = None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace") if error.fp else ""
        raise RuntimeError(f"{method} {url} failed (HTTP {error.code}): {detail[:400]}") from error


# ── Technitium DNS ──────────────────────────────────────────────────────────
class Dns:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _get(self, path: str):
        _, payload = http_json(f"{self.base_url}/api/{path}",
                               headers={"Authorization": f"Bearer {self.token}"})
        return payload or {}

    def records(self, domain: str, zone: str) -> list[dict]:
        payload = self._get("zones/records/get?" + urllib.parse.urlencode(
            {"domain": domain, "zone": zone}))
        return ((payload.get("response") or {}).get("records")) or []

    def add_a(self, domain: str, zone: str, address: str, ttl: int = 300) -> str:
        """Create or update an A record. Returns "created", "updated" or "unchanged"."""
        existing = [row for row in self.records(domain, zone) if row.get("type") == "A"]
        for row in existing:
            if str((row.get("rData") or {}).get("ipAddress")) == address:
                return "unchanged"
        if existing:
            # A name that resolves to the wrong place is worse than one that does
            # not resolve: it is a successful connection to the wrong host.
            self._get("zones/records/update?" + urllib.parse.urlencode(
                {"domain": domain, "zone": zone, "type": "A", "ttl": str(ttl),
                 "ipAddress": address, "oldIpAddress": str(
                     (existing[0].get("rData") or {}).get("ipAddress"))}))
            return "updated"
        self._get("zones/records/add?" + urllib.parse.urlencode(
            {"domain": domain, "zone": zone, "type": "A", "ttl": str(ttl),
             "ipAddress": address}))
        return "created"

    def apex_address(self, zone: str) -> str:
        """The address the zone apex already publishes."""
        for row in self.records(zone, zone):
            if row.get("type") == "A":
                address = (row.get("rData") or {}).get("ipAddress")
                if address:
                    return str(address)
        raise RuntimeError(
            f"the zone {zone} has no apex A record, so there is no address to "
            "publish the OnTrak names at. Pass --address explicitly if this "
            "deployment is meant to point somewhere else."
        )


# ── Nginx Proxy Manager ─────────────────────────────────────────────────────
class Npm:
    def __init__(self, api_url: str, email: str, password: str):
        self.api_url = api_url.rstrip("/")
        self.email = email
        self.password = password
        self.token = ""

    def _request(self, method: str, path: str, body: dict | None = None):
        if not self.token:
            self._login()
        status, payload = http_json(f"{self.api_url}/api{path}", method=method, body=body,
                                    headers={"Authorization": f"Bearer {self.token}"})
        if status not in (200, 201, 204):
            raise RuntimeError(f"NPM {method} {path} failed (HTTP {status})")
        return payload

    def _login(self) -> None:
        _, payload = http_json(f"{self.api_url}/api/tokens", method="POST",
                               body={"identity": self.email, "secret": self.password})
        token = (payload or {}).get("token")
        if not token:
            raise RuntimeError("NPM returned no token — check NPM_EMAIL/NPM_PASSWORD")
        self.token = token

    def hosts(self) -> list[dict]:
        return self._request("GET", "/nginx/proxy-hosts") or []

    def certificates(self) -> list[dict]:
        return self._request("GET", "/nginx/certificates") or []

    def create(self, payload: dict) -> dict:
        return self._request("POST", "/nginx/proxy-hosts", payload)

    def update(self, host_id: int, payload: dict) -> dict:
        return self._request("PUT", f"/nginx/proxy-hosts/{host_id}", payload)


def certificate_for(certificates: list[dict], domain: str) -> int:
    """The id of a certificate that covers `domain`, or 0.

    THREE SPELLINGS HAVE TO BE RECOGNISED, and the third is the one that matters:

      1. an exact name — a single-name certificate lists the host itself;
      2. an explicit wildcard — `*.ontrak.innotel.us` in the SAN list;
      3. a wildcard whose SAN list NPM has rewritten. NPM's certificate import
         replaces a custom certificate's `domain_names` with just its CN, so the
         Network's `*.ontrak.innotel.us` certificate is stored as
         `['ontrak.innotel.us']` — indistinguishable, by SAN list alone, from a
         certificate that covers nothing but the apex. Cerulean's own
         `cert-rebuild.py` compensates for exactly this and matches on the stable
         `nice_name`; so does this, and the `wildcard` in that name is the only
         evidence in NPM that the SANs underneath are broader than they look.

    Getting this wrong in the permissive direction serves the wrong certificate;
    getting it wrong in the strict direction is four hosts with no TLS. It is
    checked against `nice_name`, which Cerulean sets when it pushes a certificate.
    """
    host = domain.lower()
    labels = host.count(".") + 1
    best_id, best_score = 0, 0
    for certificate in certificates:
        names = [str(name).lower() for name in (certificate.get("domain_names") or [])]
        score = 0
        if host in names:
            # An exact name always wins. Serving the Network-wide wildcard where a
            # certificate for the host itself exists makes a future revocation of
            # one host into an outage for all of them.
            score = 100 + labels
        else:
            for name in names:
                if not name.startswith("*."):
                    continue
                parent = name[2:]
                # `*.ontrak.innotel.us` covers `its.ontrak.innotel.us` and not
                # `ontrak.innotel.us`, so the suffix has to leave at least one
                # label of its own. Scoring by the wildcard's specificity is what
                # makes the host's own wildcard beat the Network's.
                if host.endswith("." + parent):
                    score = max(score, labels)
            if score == 0:
                parent = host.split(".", 1)[1] if "." in host else host
                nice = str(certificate.get("nice_name") or "").lower()
                if parent in names and "wildcard" in nice:
                    score = parent.count(".") + 1
        if score > best_score:
            best_id, best_score = int(certificate["id"]), score
    return best_id


def payload_for(entry: dict, zone: str, forward_host: str, certificate_id: int,
                request_certs: bool, email: str, existing: dict | None) -> dict:
    domain = f"{entry['name']}.{zone}"
    # An existing attachment always wins over a fresh request: re-requesting a
    # certificate on every run would burn the ACME rate limit for a name that is
    # already covered, and the Network's Cerulean imports its own certificates onto
    # these hosts as it issues them.
    taken = int(existing.get("certificate_id") or 0) if existing else 0
    attach = taken or certificate_id
    fresh = attach == 0 and request_certs
    meta = {"letsencrypt_agree": False, "dns_challenge": False}
    if fresh:
        meta = {
            "letsencrypt_agree": True,
            "dns_challenge": False,
            "letsencrypt_email": email,
            "letsencrypt_force": True,
            "hsts": False,
            "hsts_subdomains": False,
        }
    return {
        "domain_names": [domain],
        "forward_scheme": "http",
        "forward_host": forward_host,
        "forward_port": int(entry["port"]),
        # `"new"` asks NPM to issue one; `0` means "no TLS yet" and is honest about
        # it rather than serving the wrong certificate.
        "certificate_id": "new" if fresh else attach,
        "ssl_forced": bool(fresh or attach),
        "http2_support": True,
        "block_exploits": True,
        "caching_enabled": False,
        "allow_websocket_upgrade": bool(entry.get("websocket", True)),
        "access_list_id": 0,
        "advanced_config": "",
        "meta": meta,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision the OnTrak family on Cerulean.")
    parser.add_argument("--env-file", default="/usr/src/projects/complete/1-primary/cerulean/.env",
                        help="the Cerulean .env to read NPM_*/TECHNITIUM_* from")
    parser.add_argument("--zone", default="", help="the DNS zone (default: CERULEAN_ZONE)")
    parser.add_argument("--address", default="",
                        help="the A-record address (default: the zone apex's own A record)")
    parser.add_argument("--forward-host", default="",
                        help="the OnTrak host the products run on (default: ONTRAK_HOST_ADDRESS)")
    parser.add_argument("--request-certs", action="store_true",
                        help="let NPM request a Let's Encrypt certificate for names nothing covers")
    parser.add_argument("--dry-run", action="store_true", help="print what would change")
    parser.add_argument("--print-redirect-uris", action="store_true",
                        help="print the redirect URIs the OIDC client needs, and exit")
    args = parser.parse_args()

    if args.print_redirect_uris:
        for uri in REDIRECT_URIS:
            print(uri)
        return 0

    load_env_file(args.env_file)

    zone = args.zone or env("CERULEAN_ONTRAK_ZONE", "innotel.us")
    forward_host = args.forward_host or env("ONTRAK_HOST_ADDRESS", "192.168.1.21")
    dns_url = env("TECHNITIUM_URL", "http://172.17.0.1:5380")
    dns_token = env("TECHNITIUM_TOKEN")
    npm_url = env("NPM_API_URL", "http://192.168.1.71:81")
    npm_email = env("NPM_EMAIL", env("NPM_ADMIN_EMAIL"))
    npm_password = env("NPM_PASSWORD", env("NPM_ADMIN_PASSWORD"))
    acme_email = env("ACME_EMAIL", npm_email)

    if not (npm_email and npm_password):
        warn("NPM_EMAIL/NPM_PASSWORD are not set — add them to the Cerulean .env")
        return 2

    dns = Dns(dns_url, dns_token) if dns_token else None
    if dns is None:
        warn("TECHNITIUM_TOKEN is not set — the DNS records will be skipped")

    address = args.address
    if not address and dns is not None:
        address = dns.apex_address(zone)

    say(f"zone {zone} · forwarding to {forward_host} · certificates "
        f"{'requested when missing' if args.request_certs else 'attached when present'}")

    if dns is not None and address:
        say(f"DNS A records in {zone} → {address}")
        for entry in HOSTS:
            domain = f"{entry['name']}.{zone}"
            if args.dry_run:
                print(f"    would ensure  {domain} → {address}")
                continue
            outcome = dns.add_a(domain, zone, address)
            mark = {"created": "+", "updated": "~", "unchanged": "="}[outcome]
            print(f"  {mark} {outcome:9} {domain}")
    elif address is None:
        warn("no address to publish — set --address, or a TECHNITIUM_TOKEN to read the apex")

    npm = Npm(npm_url, npm_email, npm_password)
    existing_hosts = npm.hosts()
    certificates = npm.certificates()
    say(f"NPM proxy hosts at {npm_url} ({len(existing_hosts)} exist, "
        f"{len(certificates)} certificates)")

    for entry in HOSTS:
        domain = f"{entry['name']}.{zone}"
        found = next((host for host in existing_hosts
                      if domain in [str(name).lower() for name in (host.get("domain_names") or [])]),
                     None)
        certificate_id = certificate_for(certificates, domain)
        payload = payload_for(entry, zone, forward_host, certificate_id,
                              args.request_certs, acme_email, found)
        tls = ("a new certificate" if payload["certificate_id"] == "new"
               else f"certificate {payload['certificate_id']}" if payload["certificate_id"]
               else "no TLS yet")
        if args.dry_run:
            print(f"    would ensure  {domain} → http://{forward_host}:{entry['port']}  ({tls})")
            continue
        if found is None:
            try:
                npm.create(payload)
            except RuntimeError as error:
                if "already in use" not in str(error):
                    raise
                # The message is truthful and the cause is invisible: NPM refuses
                # the name because a SOFT-DELETED host already holds it, and its
                # own API omits deleted rows from every listing — so there is
                # nothing to update and nothing to see. That is the state a
                # previous deployment of this product leaves behind, and the only
                # way out is to purge the tombstones.
                raise RuntimeError(
                    f"{domain} is already held in NPM, and not by a proxy host that "
                    "this script can see or update. Four other things claim a name: "
                    "a soft-deleted proxy host, a 404 ('dead') host, a redirection "
                    "host, and a stream — and none of the first three appears in the "
                    "list endpoint for proxy hosts. An earlier deployment of this "
                    "product leaves the first two behind. Find the holder and then "
                    "decide whether to remove it:\n"
                    "    docker exec cerulean-npm-db mariadb -uroot -p\"$NPM_DB_ROOT_PASSWORD\" -e \""
                    "SELECT 'proxy', id, is_deleted, domain_names FROM npm.proxy_host "
                    f"WHERE domain_names LIKE '%{domain}%' UNION ALL SELECT 'dead', id, is_deleted, "
                    "domain_names FROM npm.dead_host "
                    f"WHERE domain_names LIKE '%{domain}%' UNION ALL SELECT 'redirect', id, is_deleted, "
                    "domain_names FROM npm.redirection_host "
                    f"WHERE domain_names LIKE '%{domain}%';\"\n"
                    "    -- then, for the row that is not wanted any more:\n"
                    "    --   DELETE FROM npm.proxy_host|npm.dead_host|npm.redirection_host WHERE id=<id>;"
                ) from error
            print(f"  + created   {domain} → http://{forward_host}:{entry['port']}  ({tls})")
        else:
            npm.update(found["id"], payload)
            print(f"  ~ updated   {domain} → http://{forward_host}:{entry['port']}  ({tls})")
        if payload["certificate_id"] == 0:
            warn(f"nothing covers {domain} yet — Cerulean attaches its certificate "
                 "once issued, or re-run with --request-certs")

    print()
    say("the OIDC client still has to be registered in Authentik; "
        "the redirect URIs it needs are:")
    for uri in REDIRECT_URIS:
        print(f"    {uri}")
    print("    python3 scripts/authentik-setup.py ontrak   # on the Cerulean host")
    return 0


if __name__ == "__main__":
    sys.exit(main())
