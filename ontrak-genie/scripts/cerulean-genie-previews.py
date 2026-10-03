#!/usr/bin/env python3
"""cerulean-genie-previews.py — put Genie's preview wildcard on the trust plane.

Genie serves temporary preview addresses by reading the left-most label of the
Host and proxying to the loopback port it names. `p4001.genie.innotel.us` is
whatever listens on 4001. One wildcard is therefore all the trust plane has to
carry — **once** — and every preview after that costs nothing on the edge:

    *.genie.innotel.us   →   <genie host>:<port>   (the console, on :3400)

This script ensures exactly that, idempotently:

  * a **Technitium A record** `*.genie.innotel.us` at the address the zone apex
    already publishes — read from the zone rather than passed in, because this
    Network sits behind one public address and a script that guesses it is a
    script that publishes a name nobody can reach;
  * an **NPM proxy host** `*.genie.innotel.us` forwarding to the console, with
    websocket upgrade on (a dev server's live reload is a WebSocket);
  * the **best matching certificate**, attached — and, with `--request-cert`, a
    wildcard certificate requested through NPM for the name nothing covers yet.

It is idempotent and it never deletes: this NPM is shared by every stack in the
Network, so a prune scoped to `genie.` would be a script that deletes somebody
else's host.

Run it **on the Cerulean host** (it reads the Cerulean `.env` for NPM/Technitium
credentials), the same place `scripts/cerulean-ontrak.py` runs:

    python3 scripts/cerulean-genie-previews.py --dry-run    # what would change
    python3 scripts/cerulean-genie-previews.py              # do it
    python3 scripts/cerulean-genie-previews.py --request-cert

It does not touch the preview *runtime*: that is Genie's own Host routing
(`src/preview.ts`), turned on with `PREVIEW_ENABLED=true`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def say(message: str) -> None:
    print(f"==> {message}")


def warn(message: str) -> None:
    print(f" warn {message}", file=sys.stderr)


# ── .env + environment ──────────────────────────────────────────────────────
def load_env_file(path: str) -> None:
    """Fill unset variables from a `.env`. An exported value always wins."""
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
def technitium_token(base_url: str, token: str, user: str, password: str) -> str:
    """A usable Technitium session token.

    The `.env` usually carries a long-lived token, but tokens expire and an
    expired one fails every call the same way a real one succeeds (HTTP 200 with
    `status: invalid-token`). When user/password are present they are the more
    durable credential, so they are preferred: a fresh login per run costs one
    request and removes a whole class of "the record was not created because the
    token had aged out" afternoons.
    """
    if user and password:
        query = urllib.parse.urlencode({"user": user, "pass": password, "includeInfo": "true"})
        _, payload = http_json(f"{base_url.rstrip('/')}/api/user/login?{query}")
        fresh = str((payload or {}).get("token") or "")
        if fresh:
            return fresh
    return token


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
            "publish the preview wildcard at. Pass --address explicitly if this "
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

    A wildcard's SAN list is not reliable evidence in NPM: importing a custom
    certificate replaces `domain_names` with just its CN, so Cerulean's
    `*.genie.innotel.us` is stored as `['genie.innotel.us']` — indistinguishable,
    by SAN list alone, from a certificate covering nothing but the apex. The
    stable `nice_name` Cerulean sets when it pushes a certificate is the other
    half, exactly as `scripts/cerulean-ontrak.py` matches it.

    The wildcard case is deliberately strict: a wildcard matches exactly one
    label, so `*.innotel.us` covers `genie.innotel.us` but **not**
    `*.genie.innotel.us` (its left-most label would have to be `*`, which is not
    a label). Only the wildcard itself — or Cerulean's imported form of it, the
    apex in the SAN list with `wildcard` in the name — covers it.
    """
    host = domain.lower()
    names_of = lambda cert: [str(name).lower() for name in (cert.get("domain_names") or [])]

    if host.startswith("*."):
        apex = host[2:]
        for certificate in certificates:
            names = names_of(certificate)
            if host in names:
                return int(certificate["id"])
            nice = str(certificate.get("nice_name") or "").lower()
            if apex in names and "wildcard" in nice and apex in nice:
                return int(certificate["id"])
        return 0

    labels = host.count(".") + 1
    best_id, best_score = 0, 0
    for certificate in certificates:
        names = names_of(certificate)
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
                # `ontrak.innotel.us`, so the suffix has to leave a label of its own.
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


def payload_for(domain: str, forward_host: str, port: int, certificate_id: int,
                request_cert: bool, email: str, existing: dict | None) -> dict:
    # An existing attachment always wins over a fresh request: re-requesting a
    # certificate on every run would burn the ACME rate limit for a name that is
    # already covered.
    taken = int(existing.get("certificate_id") or 0) if existing else 0
    attach = taken or certificate_id
    fresh = attach == 0 and request_cert
    meta = {"letsencrypt_agree": False, "dns_challenge": False}
    if fresh:
        # A wildcard can only be proven with DNS-01, which needs the DNS provider
        # configured in NPM. NPM performs the challenge itself.
        meta = {
            "letsencrypt_agree": True,
            "dns_challenge": True,
            "letsencrypt_email": email,
            "letsencrypt_force": True,
            "hsts": False,
            "hsts_subdomains": False,
        }
    return {
        "domain_names": [domain],
        "forward_scheme": "http",
        "forward_host": forward_host,
        "forward_port": int(port),
        "certificate_id": "new" if fresh else attach,
        "ssl_forced": bool(fresh or attach),
        "http2_support": True,
        "block_exploits": True,
        "caching_enabled": False,
        # A dev server's live reload is a WebSocket; without this the page loads
        # once and never updates.
        "allow_websocket_upgrade": True,
        "access_list_id": 0,
        "advanced_config": "",
        "meta": meta,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision Genie's preview wildcard on Cerulean.")
    parser.add_argument("--env-file",
                        default="/usr/src/projects/complete/1-primary/cerulean/.env",
                        help="the Cerulean .env to read NPM_*/TECHNITIUM_* from")
    parser.add_argument("--zone", default="", help="the DNS zone (default: innotel.us)")
    parser.add_argument("--domain", default="",
                        help="the wildcard name (default: *.genie.innotel.us)")
    parser.add_argument("--address", default="",
                        help="the A-record address (default: the zone apex's own A record)")
    parser.add_argument("--forward-host", default="",
                        help="the host Genie runs on (default: ONTRAK_HOST_ADDRESS)")
    parser.add_argument("--forward-port", default="",
                        help="the port Genie listens on (default: ONTRAK_GENIE_PORT, 3400)")
    parser.add_argument("--request-cert", action="store_true",
                        help="let NPM request a wildcard certificate (DNS-01) when nothing covers it")
    parser.add_argument("--dry-run", action="store_true", help="print what would change")
    args = parser.parse_args()

    load_env_file(args.env_file)

    zone = args.zone or env("GENIE_PREVIEW_ZONE", env("CERULEAN_ONTRAK_ZONE", "innotel.us"))
    domain = args.domain or env("GENIE_PREVIEW_DOMAIN", f"*.genie.{zone}")
    forward_host = args.forward_host or env("ONTRAK_HOST_ADDRESS", "192.168.1.21")
    forward_port = int(args.forward_port or env("ONTRAK_GENIE_PORT", "3400"))
    dns_url = env("TECHNITIUM_URL", "http://172.17.0.1:5380")
    dns_token = technitium_token(
        dns_url,
        env("TECHNITIUM_TOKEN"),
        env("TECHNITIUM_USER"),
        env("TECHNITIUM_PASSWORD"),
    )
    npm_url = env("NPM_API_URL", "http://192.168.1.71:81")
    npm_email = env("NPM_EMAIL", env("NPM_ADMIN_EMAIL"))
    npm_password = env("NPM_PASSWORD", env("NPM_ADMIN_PASSWORD"))
    acme_email = env("ACME_EMAIL", npm_email)

    if not (npm_email and npm_password):
        warn("NPM_EMAIL/NPM_PASSWORD are not set — add them to the Cerulean .env")
        return 2

    dns = Dns(dns_url, dns_token) if dns_token else None
    if dns is None:
        warn("TECHNITIUM_TOKEN is not set — the DNS record will be skipped")

    address = args.address
    if not address and dns is not None:
        address = dns.apex_address(zone)

    say(f"wildcard {domain} · zone {zone} · forwarding to {forward_host}:{forward_port} · "
        f"certificates {'requested when missing' if args.request_cert else 'attached when present'}")

    if dns is not None and address:
        if args.dry_run:
            print(f"    would ensure  {domain} → {address}")
        else:
            outcome = dns.add_a(domain, zone, address)
            mark = {"created": "+", "updated": "~", "unchanged": "="}[outcome]
            print(f"  {mark} {outcome:9} {domain} → {address}")
    elif dns is not None:
        warn("no address to publish — set --address, or a TECHNITIUM_TOKEN to read the apex")

    npm = Npm(npm_url, npm_email, npm_password)
    existing_hosts = npm.hosts()
    certificates = npm.certificates()
    found = next((host for host in existing_hosts
                  if domain.lower() in [str(name).lower() for name in (host.get("domain_names") or [])]),
                 None)
    certificate_id = certificate_for(certificates, domain)
    payload = payload_for(domain, forward_host, forward_port, certificate_id,
                          args.request_cert, acme_email, found)
    tls = ("a new certificate" if payload["certificate_id"] == "new"
           else f"certificate {payload['certificate_id']}" if payload["certificate_id"]
           else "no TLS yet")

    say(f"NPM proxy hosts at {npm_url} ({len(existing_hosts)} exist, {len(certificates)} certificates)")
    if args.dry_run:
        print(f"    would ensure  {domain} → http://{forward_host}:{forward_port}  ({tls})")
        return 0
    if found is None:
        try:
            npm.create(payload)
        except RuntimeError as error:
            if "already in use" not in str(error):
                raise
            # NPM refuses a name another object holds, and a soft-deleted or
            # "dead" host does not appear in the list endpoint — the state a
            # previous deployment leaves behind. Say how to find it rather than
            # pretending the name is free.
            raise RuntimeError(
                f"{domain} is already held in NPM, and not by a proxy host this "
                "script can see or update. Find the holder:\n"
                "    docker exec cerulean-npm-db mariadb -uroot -p\"$NPM_DB_ROOT_PASSWORD\" -e \""
                "SELECT 'proxy', id, is_deleted, domain_names FROM npm.proxy_host "
                f"WHERE domain_names LIKE '%{domain}%' UNION ALL SELECT 'dead', id, is_deleted, "
                "domain_names FROM npm.dead_host "
                f"WHERE domain_names LIKE '%{domain}%';\""
            ) from error
        print(f"  + created   {domain} → http://{forward_host}:{forward_port}  ({tls})")
    else:
        npm.update(found["id"], payload)
        print(f"  ~ updated   {domain} → http://{forward_host}:{forward_port}  ({tls})")
    if payload["certificate_id"] == 0:
        warn(f"nothing covers {domain} yet — re-run with --request-cert, or attach "
             "Cerulean's certificate once it is issued")

    print()
    say("the preview runtime still has to be turned on in Genie:")
    print("    PREVIEW_ENABLED=true")
    print(f"    PREVIEW_DOMAIN={domain[2:] if domain.startswith('*.') else domain}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
