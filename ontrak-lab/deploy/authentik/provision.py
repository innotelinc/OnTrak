#!/usr/bin/env python3
"""Provision the local Authentik (deploy/authentik/compose.yaml) for OnTrak.

The portal is a relying party: it wants an issuer, a client id, a client secret
and a group whose members are instructors (ontrak/oidc.py, and docs/operations.md
"Sign-in"). In the estate Cerulean's `scripts/authentik-setup.py` creates all of
that. Here there is nobody to run that script for us, so this does the same four
things against the local instance, through its own REST API:

  1. a `range-instructors` group, and the seed accounts that belong in it
  2. a `groups` scope mapping, so the scope the portal asks for exists
  3. a confidential OAuth2/OIDC provider for the OnTrak application
  4. the application itself, pointing at that provider
  5. when ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET is set, the same pair again for
     the family stack (`docker-compose.all.yml`), whose products each read a
     client id and secret from their own environment

It is idempotent: everything is looked up by name first, so re-running it after a
`docker compose down` (or after adding a student) changes what is missing and
nothing else. The one thing it deliberately *rewrites* every run is each seed
account's password, because a local IdP whose demo passwords have drifted from
.env is a support call, not a security property.

Stdlib only, like ontrak/oidc.py and for the same reason: this is four HTTP calls
and a JSON body, and a dev helper that needs `requests` installed is a dev helper
that does not run.

    AUTHENTIK_URL=http://127.0.0.1:9000 \
    AUTHENTIK_BOOTSTRAP_TOKEN=... \
    ONTRAK_LOCAL_OIDC_CLIENT_SECRET=... \
    ONTRAK_LOCAL_OIDC_REDIRECT_URI=http://localhost:8080/oidc/callback \
        python3 deploy/authentik/provision.py

deploy/authentik/setup.sh writes those variables and calls this; running it by
hand is for the times setup.sh has already run and only the provider is missing.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_SECONDS = 30

# The application slug decides the issuer: Authentik serves every provider under
# /application/o/<slug>/, so this value is part of the URL in .env.
APPLICATION_NAME = "OnTrak"
APPLICATION_SLUG = "ontrak"
PROVIDER_NAME = "OnTrak"

# Where the portal runs here. Not the estate's three names (docs/operations.md) —
# a local range answers on one origin, and a callback that is not registered is a
# sign-in that cannot complete.
DEFAULT_REDIRECT_URI = "http://localhost:8080/oidc/callback"

INSTRUCTOR_GROUP = "range-instructors"
STUDENT_GROUP = "range-students"

# ── the family's own client ────────────────────────────────────────────────────
# The second relying party here, and a different one from the portal above: the
# family stack (`docker-compose.all.yml`) — Training, Tix, Sentinel, Sync, Genie
# and the family Portal — signs in through a *single* issuer and, in the estate,
# one client per product registered against it.
#
# Authentik cannot spell that: an issuer IS an application here
# (`/application/o/<slug>/`), and an application has exactly one front-channel
# provider, so two client ids in this instance means two issuers. The family
# compose carries one `ONTRAK_OIDC_ISSUER` for every product, deliberately, so
# one client for the whole family is the shape that fits — and it is the shape a
# laptop range wants anyway. The per-product `*_OIDC_CLIENT_ID` variables in the
# family .env are all pointed at this one client id rather than left to disagree.
#
# `ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET` is the credential; which products read
# it is setup.sh's business, not this file's.
FAMILY_APPLICATION_NAME = "OnTrak Family"
FAMILY_APPLICATION_SLUG = "ontrak-family"
FAMILY_PROVIDER_NAME = "OnTrak Family"
DEFAULT_FAMILY_CLIENT_ID = "ontrak-family"

# Every callback the family's products answer on, as (port, path). This is the
# list that has to be right: the provider compares the redirect URI byte for
# byte, and a missing one is a sign-in that dies at the provider's door with a
# page that names no product. Ports and paths are the published ones — Training
# 3000, Tix 3001, the family Portal 3300, Genie 3400, Sync's API 8420.
FAMILY_CALLBACKS = (
    (3000, "/api/sso/callback"),        # OnTrak Training
    (3001, "/api/sso/callback"),        # OnTrak Tix
    (3300, "/api/sso/callback"),        # the family Portal
    (3400, "/api/auth/callback"),       # OnTrak Genie
    (8420, "/api/auth/sso/callback"),   # OnTrak Sync
)
# The names a callback is registered under. The machine's own address first:
# that is the one the browser and every container agree on, and the one the
# family .env hands the products as their public base URL. Loopback and
# `localhost` are registered beside it so a product opened on the range itself
# works without the operator having to a second time remember which name the
# browser used.
REDIRECT_HOSTS = ("127.0.0.1", "localhost")

# The scope the portal asks for. Authentik's default `profile` mapping already
# returns a groups claim, but the *scope name* it requests has to exist on the
# provider or the authorize request is refused before anyone types a password —
# which is why Cerulean's setup "pins the platform's groups scope mapping on
# every app" (ontrak/oidc.py). Same mapping, made here.
# The scope the products read the address out of, and the one mapping in here
# that replaces an Authentik default rather than adding beside it.
#
# Authentik's own mapping for `email` is, in full:
#
#     return {'email': request.user.email, 'email_verified': False}
#
# — false, unconditionally. A defensible default for an IdP that has no way to
# know, and fatal for this one: every OnTrak product refuses a sign-in whose
# address is not verified, so with the default in place the whole family, and the
# range's portal with it, signs in successfully and is then turned away by every
# one of them — "the provider has not verified that email address".
#
# The accounts here are created by this script, exist nowhere else, and hold
# addresses nobody off this machine can claim. Asserting them verified is the
# honest answer; the alternative is a login page nobody can get past.
EMAIL_SCOPE = "email"
EMAIL_MAPPING_NAME = "OnTrak email"
EMAIL_EXPRESSION = (
    "# OnTrak: the address this deployment created the account with, asserted\n"
    "# verified. See deploy/authentik/provision.py for why the default cannot be\n"
    "# used — it reports every address unverified, and every product refuses one.\n"
    "return {\n"
    "    'email': request.user.email,\n"
    "    'email_verified': bool(request.user.email),\n"
    "}\n"
)

GROUPS_SCOPE = "groups"
GROUPS_EXPRESSION = (
    "# The portal reads this to decide who is an instructor (ontrak/oidc.py).\n"
    "groups = getattr(request.user, 'ak_groups', None)\n"
    "if groups is None:  # older releases called this `groups`\n"
    "    groups = request.user.groups\n"
    "return {'groups': [group.name for group in groups.all()]}\n"
)

# Flows a new OIDC provider must point at. Authentik ships both under these
# slugs; the difference is whether the account is shown a consent screen before
# being handed back to the application.
#
# This stack takes the no-consent one. A consent screen exists so a person can
# approve a *third party* reading their identity — and the only application on a
# local Authentik is the range that person just opened, on their own machine.
# Asking them to approve it on every sign-in is friction that protects nothing,
# and it is the difference between a demo that is one click and one that is two.
AUTHORIZATION_FLOW_SLUGS = (
    "default-provider-authorization-implicit-consent",
    "default-provider-authorization-explicit-consent",
)
INVALIDATION_FLOW_SLUG = "default-provider-invalidation-flow"


class ProvisionError(RuntimeError):
    """Something the operator has to know about — phrased for them, not for a log."""


class Api:
    """The smallest useful client for Authentik's REST API."""

    def __init__(self, base_url: str, token: str, version: str = "v3"):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.version = version

    def _call(self, method: str, url: str, body=None):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = ""
            with contextlib.suppress(Exception):
                detail = error.read().decode("utf-8", "replace").strip()[:400]
            raise ProvisionError(f"{method} {url} -> HTTP {error.code} {detail}") from error
        except (urllib.error.URLError, OSError) as error:
            raise ProvisionError(
                f"{method} {url} is unreachable: {getattr(error, 'reason', error)}"
            ) from error
        if not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise ProvisionError(f"{method} {url} did not return JSON") from error

    def _url(self, path: str, params=None) -> str:
        url = f"{self.base_url}/api/{self.version}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        return url

    def get(self, path, params=None):
        return self._call("GET", self._url(path, params))

    def post(self, path, body=None):
        return self._call("POST", self._url(path), body)

    def patch(self, path, body=None):
        return self._call("PATCH", self._url(path), body)

    def send(self, method, path, body=None):
        return self._call(method, self._url(path), body)

    def one(self, path, params):
        """The first match, or None. Every list endpoint here is paginated."""
        page = self.get(path, params)
        results = page.get("results") if isinstance(page, dict) else page
        return results[0] if results else None

    def all(self, path, params=None):
        """Every match across pages.

        The cursor is read out of the reply rather than assumed: releases in the
        wild paginate by absolute URL and by page number under the same key, and
        either one arrives here.
        """
        out: list = []
        cursor = ""
        page_params = dict(params or {})
        while True:
            page = self._call("GET", cursor) if cursor else self.get(path, page_params or None)
            if isinstance(page, list):
                out.extend(page)
                return out
            out.extend(page.get("results", []))
            nxt = (page.get("pagination") or {}).get("next")
            if not nxt:
                return out
            if isinstance(nxt, int):
                cursor = ""
                page_params = {**dict(params or {}), "page": nxt}
            else:
                cursor = str(nxt)


# Upstream moved the REST API from /api/v2 to /api/v3 — 2026.8 answers only on
# v3, the releases before the move answer only on v2 — and the routes below are
# the same either way. Probed, not pinned, so a checkout older or newer than the
# image deploy/authentik/.env names still provisions.
API_VERSIONS = ("v3", "v2")


def detect_version(base_url: str, token: str) -> str:
    for version in API_VERSIONS:
        try:
            Api(base_url, token, version).get("/core/users/me/")
        except ProvisionError:
            continue
        return version
    raise ProvisionError(
        f"neither /api/v3 nor /api/v2 answered at {base_url} — is this an Authentik?"
    )


def log(text: str) -> None:
    print(f"  {text}", flush=True)


# --------------------------------------------------------------------- lookups --
def one_where(api: Api, path: str, params: dict, field: str, value: str) -> dict | None:
    """The first match whose `field` is exactly `value` — or None.

    Deliberately not `api.one`, and this is the one thing in this file that has to
    be got right. Authentik 2026.8 answers a *filtered* list endpoint with a
    pagination count of 0 and the unfiltered page in `results`: asking
    `/core/applications/?slug=ontrak-family` for an application that does not
    exist returns the application beside it, with `"count": 0`. That breaks a
    lookup in both directions — `results[0]` concludes the thing is already there
    and skips creating it, while paging to the end of the *response* concludes it
    is not there and creates it a second time, which Authentik refuses with
    "Application with this slug already exists".

    So the filter is not sent at all: the list is fetched whole and the field is
    compared here. `params` is kept in the signature because it is what says
    *which* field identifies a row, and because a caller reading it should still
    be able to see what it is looking for; every table this is asked about is
    small, and an unfiltered page costs nothing next to a wrong answer.
    """
    for row in api.all(path):
        if str(row.get(field) or "") == value:
            return row
    return None


def required(api: Api, path: str, params: dict, what: str) -> dict:
    # The single parameter *is* the identity being asked for, so the same one is
    # the one compared.
    field, value = next(iter(params.items()))
    found = one_where(api, path, params, field, str(value))
    if not found:
        raise ProvisionError(f"{what} not found in Authentik ({path} {params})")
    return found


def authorization_flow(api: Api) -> dict:
    for slug in AUTHORIZATION_FLOW_SLUGS:
        found = one_where(api, "/flows/instances/", {"slug": slug}, "slug", slug)
        if found:
            return found
    raise ProvisionError("neither default provider authorization flow is present")


def signing_key(api: Api) -> dict:
    # The one lookup here that has to trust the endpoint's filter: `has_key` is
    # not in the list serializer at all, so there is nothing to compare it
    # against. It is worth knowing *why* that is safe here and not elsewhere —
    # this endpoint has a single row on a fresh instance, and a keypair without a
    # private key makes provider creation fail loudly rather than quietly sign
    # with nothing.
    keys = api.all("/crypto/certificatekeypairs/", {"has_key": "true"})
    if not keys:
        raise ProvisionError("Authentik has no certificate keypair to sign with")
    # Prefer the self-signed one the installer creates; it is the one the UI
    # picks in "Select a signing Key" when you make a provider by hand.
    for key in keys:
        if "self-signed" in str(key.get("name", "")).lower():
            return key
    return keys[0]


def scope_mappings(api: Api, scope: str) -> list:
    """Every scope mapping that claims `scope`.

    Filtered here rather than at the endpoint, for the reason `one_where` gives:
    Authentik will hand back the whole table whatever was asked for, and the
    mappings for `openid`, `email` and `profile` all look alike from the outside
    — taking the first one that came back is how a provider ends up signing
    tokens with the wrong claims in them.
    """
    return [m for m in api.all("/propertymappings/provider/scope/") if str(m.get("scope_name") or "") == scope]


def default_scope_mapping(api: Api, scope: str) -> dict:
    """Authentik's own scope mapping for `openid`, `email` or `profile`."""
    mappings = scope_mappings(api, scope)
    if not mappings:
        raise ProvisionError(f"Authentik has no default '{scope}' scope mapping")
    for mapping in mappings:
        if str(mapping.get("name", "")).startswith("authentik default OAuth Mapping"):
            return mapping
    return mappings[0]


def ensure_email_mapping(api: Api) -> dict:
    """This instance's own `email` scope, which asserts the address verified.

    Found by name rather than by scope: Authentik ships a mapping for this scope
    already, and that mapping is precisely the one that has to be left out of the
    provider.
    """
    found = next(
        (m for m in scope_mappings(api, EMAIL_SCOPE) if str(m.get("name")) == EMAIL_MAPPING_NAME),
        None,
    )
    if found:
        return found
    return api.post(
        "/propertymappings/provider/scope/",
        {
            "name": EMAIL_MAPPING_NAME,
            "scope_name": EMAIL_SCOPE,
            "description": "The account's email address, asserted verified",
            "expression": EMAIL_EXPRESSION,
        },
    )


def ensure_groups_mapping(api: Api) -> dict:
    found = next(iter(scope_mappings(api, GROUPS_SCOPE)), None)
    if found:
        return found
    return api.post(
        "/propertymappings/provider/scope/",
        {
            "name": "OnTrak groups",
            "scope_name": GROUPS_SCOPE,
            "description": "The account's groups, which the portal turns into a role",
            "expression": GROUPS_EXPRESSION,
        },
    )


def ensure_group(api: Api, name: str) -> dict:
    found = one_where(api, "/core/groups/", {"name": name}, "name", name)
    if found:
        return found
    return api.post("/core/groups/", {"name": name, "is_superuser": False})


# ----------------------------------------------------------------------- users --
def ensure_user(api: Api, email: str, name: str, password: str, group_pk: str) -> dict:
    user = one_where(api, "/core/users/", {"username": email}, "username", email)
    if not user:
        user = api.post(
            "/core/users/",
            {
                "username": email,
                "name": name,
                "email": email,
                "is_active": True,
                "groups": [group_pk],
            },
        )
        log(f"created {email}")
    else:
        api.patch(f"/core/users/{user['pk']}/", {"groups": [group_pk]})
    # Rewritten every run: the password in .env is the one that works, whether or
    # not it was the one this account had.
    api.post(f"/core/users/{user['pk']}/set_password/", {"password": password})
    return user


# -------------------------------------------------------------------- provider --
def _redirect_uri_shapes(uris):
    """How a provider's allowed redirect URIs are spelled has changed twice.

    The per-URL objects lived in `allowed_redirect_uris`; 2024.2 flattened them
    into a list of strings called `redirect_uris`; and by 2026.8 the field is
    `redirect_uris` again but holds the objects. All three are tried in release
    order, and only an answer *about this field* moves on to the next one — a
    validation error on anything else surfaces as itself instead of as three
    confusing retries.
    """
    entries = [{"matching_mode": "strict", "url": uri} for uri in uris]
    return (
        {"redirect_uris": entries},
        {"redirect_uris": list(uris)},
        {"allowed_redirect_uris": entries},
    )


def family_redirect_uris(host: str) -> list[str]:
    """Every callback the family's products answer on, under every name above."""
    names = list(REDIRECT_HOSTS)
    if host and host not in names:
        names.append(host)
    return [f"http://{name}:{port}{path}" for name in names for port, path in FAMILY_CALLBACKS]


def provider_body(*, name, flows, mappings, key, client_id, client_secret):
    return {
        "name": name,
        "authorization_flow": flows[0]["pk"],
        "invalidation_flow": flows[1]["pk"],
        # confidential: the portal has a client secret and exchanges the code
        # server-side (ontrak/oidc.py sends it as HTTP Basic).
        "client_type": "confidential",
        "client_id": client_id,
        "client_secret": client_secret,
        # Not optional in practice. A provider created without these answers the
        # authorize request with `Invalid grant_type for provider`, the browser
        # comes back with `error=invalid_request`, and the portal shows a login
        # page whose button goes nowhere — a provider that exists, reads as
        # configured, and can sign nobody in.
        "grant_types": ["authorization_code", "refresh_token"],
        "property_mappings": [m["pk"] for m in mappings],
        "signing_key": key["pk"],
    }


def redirect_urls(value) -> list:
    """The URLs out of whatever shape this release returned."""
    out = []
    for item in value or []:
        url = str(item.get("url") or "") if isinstance(item, dict) else str(item)
        if url:
            out.append(url)
    return out


def provider_drift(found: dict, *, flows, mappings, key, client_id, redirect_uris) -> list:
    """What this provisioner would change about the provider that is already there.

    Compared rather than skipped: an existing provider is the usual state on a
    re-run, and the interesting failures — no `grant_types`, so it authorizes
    nothing at all; the consent flow, so a local demo stops at a screen nobody
    asked for — look exactly like a correct provider from the outside.
    """
    problems = []
    if str(found.get("authorization_flow") or "") != str(flows[0]["pk"]):
        problems.append("authorization_flow")
    if not {"authorization_code", "refresh_token"} <= set(found.get("grant_types") or []):
        problems.append("grant_types")
    if str(found.get("client_id") or "") != client_id:
        problems.append("client_id")
    if str(found.get("signing_key") or "") != str(key["pk"]):
        problems.append("signing_key")
    if set(found.get("property_mappings") or []) != {m["pk"] for m in mappings}:
        problems.append("property_mappings")
    if set(redirect_urls(found.get("redirect_uris"))) != set(redirect_uris):
        problems.append("redirect_uris")
    return problems


def write_provider(api: Api, method: str, path: str, body: dict, redirect_uris) -> dict:
    """POST or PATCH a provider, trying each spelling of the redirect URIs."""
    last = None
    for shape in _redirect_uri_shapes(redirect_uris):
        try:
            return api.send(method, path, {**body, **shape})
        except ProvisionError as error:
            if "redirect_uris" not in str(error):
                raise
            last = error
    raise last or ProvisionError("the provider could not be written")


def ensure_provider(api: Api, *, name, flows, mappings, key, client_id, client_secret, redirect_uris):
    body = provider_body(
        name=name,
        flows=flows,
        mappings=mappings,
        key=key,
        client_id=client_id,
        client_secret=client_secret,
    )
    found = one_where(api, "/providers/oauth2/", {"name": name}, "name", name)
    if not found:
        return write_provider(api, "POST", "/providers/oauth2/", body, redirect_uris)
    drift = provider_drift(
        found,
        flows=flows,
        mappings=mappings,
        key=key,
        client_id=client_id,
        redirect_uris=redirect_uris,
    )
    if not drift:
        return found
    log(f"provider {name} is not what this range needs ({', '.join(drift)}) — correcting")
    return write_provider(api, "PATCH", f"/providers/oauth2/{found['pk']}/", body, redirect_uris)


def find_application(api: Api, slug: str) -> dict | None:
    """The application with this slug, or None.

    Asked for at its own route, not through the list, and that is not a
    preference. On 2026.8 `/core/applications/` answers `"count": 2` and returns
    one row — an application that plainly exists is simply absent from the page,
    while `/core/applications/<slug>/` serves it. A lookup that trusts the list
    concludes it has to create the application, and the create is refused with
    "Application with this slug already exists", which reads as a broken
    provisioner rather than a broken list.
    """
    try:
        found = api.get(f"/core/applications/{slug}/")
    except ProvisionError:
        return None
    return found if str(found.get("slug") or "") == slug else None


def ensure_application(api: Api, provider_pk: str, *, name=APPLICATION_NAME, slug=APPLICATION_SLUG) -> dict:
    found = find_application(api, slug)
    if not found:
        return api.post(
            "/core/applications/",
            {
                "name": name,
                "slug": slug,
                "provider": provider_pk,
            },
        )
    # An application pointed at the wrong provider is an application whose
    # sign-in runs against the wrong client — and it looks entirely correct from
    # the outside, so it is compared rather than assumed.
    if str(found.get("provider") or "") != str(provider_pk):
        log(f"application {slug} points at provider {found.get('provider')} — correcting")
        return api.patch(f"/core/applications/{slug}/", {"provider": provider_pk})
    return found


# ------------------------------------------------------------------------ main --
def split(value: str) -> list[str]:
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def main() -> int:
    base_url = os.environ.get("AUTHENTIK_URL", "http://127.0.0.1:9000")
    token = os.environ.get("AUTHENTIK_BOOTSTRAP_TOKEN", "").strip()
    if not token:
        raise ProvisionError(
            "AUTHENTIK_BOOTSTRAP_TOKEN is not set — it is in deploy/authentik/.env"
        )

    client_id = os.environ.get("ONTRAK_LOCAL_OIDC_CLIENT_ID", "ontrak").strip()
    client_secret = os.environ.get("ONTRAK_LOCAL_OIDC_CLIENT_SECRET", "").strip()
    if not client_secret:
        raise ProvisionError(
            "ONTRAK_LOCAL_OIDC_CLIENT_SECRET is not set — it is in deploy/authentik/.env"
        )
    redirect_uris = split(os.environ.get("ONTRAK_LOCAL_OIDC_REDIRECT_URI", DEFAULT_REDIRECT_URI))
    password = os.environ.get("ONTRAK_LOCAL_SEED_PASSWORD", "").strip()
    if not password:
        raise ProvisionError(
            "ONTRAK_LOCAL_SEED_PASSWORD is not set — it is in deploy/authentik/.env"
        )
    students = int(os.environ.get("ONTRAK_LOCAL_STUDENTS", "6"))
    instructor = os.environ.get("ONTRAK_LOCAL_INSTRUCTOR", "instructor@ontrak.lab").strip()
    student_domain = os.environ.get("ONTRAK_LOCAL_STUDENT_DOMAIN", "ontrak.lab").strip()
    host = os.environ.get("ONTRAK_LOCAL_HOST", "").strip()

    version = detect_version(base_url, token)
    api = Api(base_url, token, version)
    log(f"authentik at {api.base_url} (REST API {version})")
    auth_flow = authorization_flow(api)
    inval_flow = required(api, "/flows/instances/", {"slug": INVALIDATION_FLOW_SLUG}, "invalidation flow")
    key = signing_key(api)
    log(f"flows and signing key ready ({key.get('name')})")

    mappings = [
        default_scope_mapping(api, "openid"),
        # Ours, not Authentik's: see EMAIL_EXPRESSION.
        ensure_email_mapping(api),
        default_scope_mapping(api, "profile"),
    ]
    groups_mapping = ensure_groups_mapping(api)
    mappings.append(groups_mapping)
    log(f"scope mappings: openid, {EMAIL_MAPPING_NAME} (email), profile, {GROUPS_SCOPE}")

    instructors = ensure_group(api, INSTRUCTOR_GROUP)
    students_group = ensure_group(api, STUDENT_GROUP)
    log(f"groups: {INSTRUCTOR_GROUP}, {STUDENT_GROUP}")

    provider = ensure_provider(
        api,
        name=PROVIDER_NAME,
        flows=(auth_flow, inval_flow),
        mappings=mappings,
        key=key,
        client_id=client_id,
        client_secret=client_secret,
        redirect_uris=redirect_uris,
    )
    ensure_application(api, provider["pk"])
    log(f"application {APPLICATION_SLUG} -> provider {provider['name']} (client {client_id})")
    log(f"redirect URIs: {', '.join(redirect_uris) or '(none — Authentik keeps the first used)'}")

    # ── the family's client ────────────────────────────────────────────────
    # Optional on purpose: this script is also the portal-only provisioner, and a
    # checkout that never generated the family secret should still come up with
    # a working portal rather than die here for a client nothing was going to
    # use. When the secret *is* set — the state of any .env setup.sh has written
    # — the family's client is registered and drift-corrected on exactly the same
    # terms as the portal's.
    family_secret = os.environ.get("ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET", "").strip()
    if family_secret:
        family_client_id = os.environ.get(
            "ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_ID", DEFAULT_FAMILY_CLIENT_ID
        ).strip()
        family_uris = family_redirect_uris(host)
        family_provider = ensure_provider(
            api,
            name=FAMILY_PROVIDER_NAME,
            flows=(auth_flow, inval_flow),
            mappings=mappings,
            key=key,
            client_id=family_client_id,
            client_secret=family_secret,
            redirect_uris=family_uris,
        )
        ensure_application(
            api,
            family_provider["pk"],
            name=FAMILY_APPLICATION_NAME,
            slug=FAMILY_APPLICATION_SLUG,
        )
        log(
            f"application {FAMILY_APPLICATION_SLUG} -> provider {family_provider['name']} "
            f"(client {family_client_id})"
        )
        log(f"family redirect URIs: {len(family_uris)} registered, across {len(REDIRECT_HOSTS) + (1 if host and host not in REDIRECT_HOSTS else 0)} host name(s)")
    else:
        log("no ONTRAK_LOCAL_FAMILY_OIDC_CLIENT_SECRET — skipping the family's client")

    # The seed accounts. Same shape as demo mode's (ontrak/demo.py): one
    # instructor who runs the class, N students who take it.
    ensure_user(api, instructor, "Instructor", password, instructors["pk"])
    for index in range(1, max(students, 0) + 1):
        email = f"student{index}@{student_domain}"
        ensure_user(api, email, f"Student {index}", password, students_group["pk"])
    log(f"accounts: {instructor} (instructor), {students} student(s) in {STUDENT_GROUP}")
    log(f"password for all seed accounts: {password}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as error:
        print(f"\n[!] {error}", file=sys.stderr)
        raise SystemExit(1) from error
