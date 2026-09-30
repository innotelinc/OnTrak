#!/usr/bin/env python3
"""verify-sso.py — prove Genie's sign-in posture still holds on a live deployment.

Genie's console can read, edit and run code in a workspace, so the gate in front of
it is the thing that keeps that from being open to whoever can reach the port. This
asserts the gate is real, end to end, against the *deployed* name rather than a
description of it:

  1. The console is up, and signing in is **configured** — `/api/auth/status` says
     `oidc: true`. Without that the console falls back to `WEB_TOKEN` or to loopback
     trust, which is a different posture and not this one.
  2. The API is **closed** to an unauthenticated caller: `/api/workspace` must be
     refused. This is the half `WEB_TOKEN` used to cover and sign-in now covers
     instead, so it is asserted rather than assumed.
  3. `/api/auth/login` hands out an authorize URL for the configured issuer, for the
     configured `client_id`, for **this** name's callback. A deployment whose
     redirect URI does not match what the provider registered fails here rather than
     in a browser.
  4. A real authorization-code flow completes: the temporary identity signs in at
     Authentik, the console's callback exchanges the code, and the browser is left
     holding a session.
  5. With that session the console knows **who** signed in — `/api/auth/status`
     reports the subject and the address — which is what tenancy keys on. A gate that
     proves *someone* signed in and never *who* is the thing being ruled out.
  6. Signing out ends it: the status goes back to unauthenticated.

The temporary identity is created in Authentik and deleted on the way out, including
when a check fails. Nothing else is created, started or edited.

Config (environment, falling back to this repo's `.env`):

    ONTRAK_PUBLIC_URL           the name a browser reaches (default the family's)
    ONTRAK_OIDC_ISSUER          the app-scoped issuer (default the family's)
    ONTRAK_OIDC_CLIENT_ID       the shared `ontrak` client (default `ontrak`)
    AUTHENTIK_BOOTSTRAP_TOKEN   Authentik admin token — required. Read from the
                                environment, then `.env`, then the estate's Cerulean
                                `.env` (../../cerulean/.env), because a deployment
                                of this console does not hold it and should not.
    AUTHENTIK_API_URL           default: the issuer's own origin
    VERIFY_USER / VERIFY_GROUP  the throwaway identity (default e2e-genie-sso / none)

Usage:
    python3 scripts/verify-sso.py [--url https://genie.example] [--verbose]

Exit codes: 0 = every check passed, 1 = a check failed, 2 = cannot run from here.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import pathlib
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

AUTH_FLOW = "default-authentication-flow"
DEFAULT_PUBLIC_URL = "https://genie.ontrak.innotel.us"
DEFAULT_ISSUER = "https://auth.cerulean.innotel.us/application/o/ontrak"
DEFAULT_CLIENT_ID = "ontrak"

OK = "\033[32mPASS\033[0m"
BAD = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"

failures: list[str] = []


class CannotRun(Exception):
    """Not a failure: this host cannot answer the question."""


class CheckFailed(Exception):
    pass


def check(condition: bool, message: str) -> bool:
    if condition:
        print(f"  {OK}  {message}")
        return True
    print(f"  {BAD}  {message}")
    failures.append(message)
    return False


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


class Config:
    def __init__(self, args: argparse.Namespace, repo: pathlib.Path) -> None:
        env = dict(read_env_file(repo / ".env"))
        # The platform's Authentik admin token lives with the estate's trust layer,
        # not with a product that only consumes it.
        for fallback in (repo.parent.parent / "cerulean" / ".env",):
            for key, value in read_env_file(fallback).items():
                env.setdefault(key, value)
        for key, value in os.environ.items():
            env[key] = value

        def pick(*names: str, default: str = "") -> str:
            for name in names:
                value = env.get(name, "").strip()
                if value:
                    return value
            return default

        self.public = (args.url or pick("ONTRAK_PUBLIC_URL", "PUBLIC_URL", default=DEFAULT_PUBLIC_URL)).rstrip("/")
        self.issuer = pick("ONTRAK_OIDC_ISSUER", "OIDC_ISSUER", default=DEFAULT_ISSUER).rstrip("/")
        self.client_id = pick("ONTRAK_OIDC_CLIENT_ID", "OIDC_CLIENT_ID", default=DEFAULT_CLIENT_ID)
        self.token = pick("AUTHENTIK_BOOTSTRAP_TOKEN", "AUTHENTIK_TOKEN")
        self.api = pick("AUTHENTIK_API_URL") or urllib.parse.urlparse(self.issuer).netloc.join(["https://", ""])
        self.verbose = args.verbose
        self.user = pick("VERIFY_USER", default="e2e-genie-sso")
        self.group = pick("VERIFY_GROUP", default="ontrak-admins")
        self.password = pick("VERIFY_PASSWORD") or "Genie!" + secrets.token_urlsafe(12)

    def expect_redirect(self) -> str:
        return f"{self.public}/api/auth/callback"


def lower_headers(headers) -> dict[str, str]:
    """Header lookup is case-sensitive on a plain dict; the wire case is not ours."""
    return {str(key).lower(): value for key, value in (headers or {}).items()}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Hand back 3xx as a response rather than following it — the hops are the check."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            NoRedirect,
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        self.base = None

    def _trace(self, method: str, url: str, status: int) -> None:
        if self.cfg.verbose:
            print(f"       {method} {status} {url}")

    def get(self, url: str, headers=None):
        if url.startswith("/") and self.base:
            url = self.base + url
        request = urllib.request.Request(url)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        return self._open(request, "GET")

    def post(self, url: str, payload, headers=None):
        if url.startswith("/") and self.base:
            url = self.base + url
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("X-authentik-CSRF", self.cookie("authentik_csrf") or "")
        request.add_header("Referer", self.base + "/")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        return self._open(request, "POST")

    def _open(self, request: urllib.request.Request, method: str):
        try:
            with self.opener.open(request, timeout=60) as response:
                self._trace(method, request.full_url, response.status)
                return response.status, lower_headers(response.headers), response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            self._trace(method, request.full_url, error.code)
            return error.code, lower_headers(error.headers), (error.read() or b"").decode("utf-8", "replace")
        except urllib.error.URLError as error:
            raise CannotRun(f"cannot reach {urllib.parse.urlparse(request.full_url).netloc} ({error.reason})") from error

    def cookie(self, name: str):
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return None


class AuthApi:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.cfg.api + "/api/v3" + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + self.cfg.token)
        request.add_header("Accept", "application/json")
        if data:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            detail = (error.read() or b"").decode()[:200]
            raise CannotRun(f"Authentik's API answered HTTP {error.code} for {method} {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise CannotRun(f"cannot reach Authentik's API at {self.cfg.api} ({error.reason})") from error

    def ensure_user(self) -> str:
        found = self.call("GET", "/core/users/?username=" + urllib.parse.quote(self.cfg.user))
        for stale in found.get("results", []):
            self.call("DELETE", f"/core/users/{stale['pk']}/")
        user = self.call("POST", "/core/users/", {
            "username": self.cfg.user,
            "name": "Genie sign-in verification",
            "email": f"{self.cfg.user}@innotel.us",
            "is_active": True,
            "path": "users",
            "type": "internal",
        })
        pk = user["pk"]
        self.call("POST", f"/core/users/{pk}/set_password/", {"password": self.cfg.password})
        if self.cfg.group:
            groups = self.call("GET", "/core/groups/?name=" + urllib.parse.quote(self.cfg.group))
            results = groups.get("results") or []
            # A missing group is not fatal: the console does not gate on one, and the
            # provider may not either. It is worth saying, because a refusal at the
            # authorize step is usually this.
            if results:
                self.call("POST", f"/core/groups/{results[0]['pk']}/add_user/", {"pk": pk})
            else:
                print(f"       note: group {self.cfg.group} not found; continuing without it")
        return pk

    def delete_user(self, pk: str) -> None:
        try:
            self.call("DELETE", f"/core/users/{pk}/")
        except CannotRun:
            print(f"       note: could not delete the temporary identity {self.cfg.user}")


def follow_json(client: Client, url: str, hops: int = 8):
    for _ in range(hops):
        status, headers, body = client.get(url)
        if status == 200:
            return json.loads(body)
        if status == 302 and headers.get("location"):
            url = urllib.parse.urljoin(url, headers["location"])
            continue
        raise CheckFailed(f"expected a JSON flow stage, got HTTP {status} for {url}")
    raise CheckFailed("too many redirects inside Authentik's authentication flow")


def finish_flow(client: Client, flow_url: str, base: str) -> str:
    """Drive the IdP's flow and return the console's callback URL, code and all."""
    flow_url = urllib.parse.urljoin(base, flow_url)
    parsed = urllib.parse.urlparse(flow_url)
    idp = f"{parsed.scheme}://{parsed.netloc}"
    client.base = idp
    executor = idp + "/api/v3/flows/executor/" + AUTH_FLOW + "/?" + urllib.parse.urlencode({"query": parsed.query})

    stage = follow_json(client, executor)
    for _ in range(8):
        component = stage.get("component")
        if component == "xak-flow-redirect":
            break
        if component == "ak-stage-identification":
            payload = {"uid_field": client.cfg.user}
        elif component == "ak-stage-password":
            payload = {"password": client.cfg.password}
        else:
            raise CheckFailed(f"unexpected Authentik stage {component}")
        status, headers, body = client.post(executor, payload)
        if status not in (200, 302):
            raise CheckFailed(f"the flow stage answered HTTP {status}: {body[:200]}")
        stage = follow_json(client, urllib.parse.urljoin(idp + "/", headers.get("location") or executor))
    require(stage.get("component") == "xak-flow-redirect", "Authentik's flow never handed back the authorize URL")

    url = urllib.parse.urljoin(idp + "/", stage["to"])
    for _ in range(8):
        status, headers, body = client.get(url)
        if status == 302 and headers.get("location"):
            url = urllib.parse.urljoin(url, headers["location"])
            if "/api/auth/callback" in url:
                return url
            continue
        raise CheckFailed(f"authorize returned HTTP {status} instead of a code: {body[:200]}")
    raise CheckFailed("no callback URL after too many redirects")


def status_of(client: Client) -> dict:
    status, _, body = client.get(client.cfg.public + "/api/auth/status")
    require(status == 200, f"/api/auth/status -> HTTP {status}")
    try:
        return json.loads(body)
    except ValueError as error:
        raise CheckFailed(f"/api/auth/status did not answer JSON: {body[:160]}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="the origin the console is served on")
    parser.add_argument("--verbose", action="store_true", help="trace every HTTP hop")
    args = parser.parse_args()

    repo = pathlib.Path(__file__).resolve().parent.parent
    cfg = Config(args, repo)

    if not cfg.token:
        print(f"  {SKIP}  no Authentik admin token, so a real sign-in cannot be driven")
        print("        set AUTHENTIK_BOOTSTRAP_TOKEN (the estate keeps it in cerulean/.env)")
        return 2

    api = AuthApi(cfg)
    client = Client(cfg)

    print(f"Genie sign-in posture — {cfg.public}")
    user_pk = None
    try:
        # 1. Liveness, before anything that needs a gateway.
        status, _, body = client.get(cfg.public + "/health")
        check(status == 200 and '"status":"ok"' in body, f"the console answers /health 200 ({body.strip()[:48]})")

        # 2. Sign-in is configured, and the API is closed without it.
        anon = status_of(client)
        check(anon.get("oidc") is True, "sign-in is configured (oidc: true)")
        check(anon.get("authenticated") is False, "an unauthenticated caller is not authenticated")
        status, _, _ = client.get(cfg.public + "/api/workspace")
        check(status == 401, f"an unauthenticated /api/workspace is refused (HTTP {status})")

        # 3. The authorize URL names the configured client and THIS name's callback.
        status, headers, _ = client.get(cfg.public + "/api/auth/login")
        require(status == 302 and headers.get("location"), f"/api/auth/login -> HTTP {status}, not a redirect")
        authorize = headers["location"]
        check("client_id=" + cfg.client_id in authorize, f"the authorize URL names client_id={cfg.client_id}")
        query = urllib.parse.parse_qs(urllib.parse.urlparse(authorize).query)
        redirect_uri = (query.get("redirect_uri") or [""])[0]
        check(
            redirect_uri == cfg.expect_redirect(),
            f"the redirect URI is this name's callback ({redirect_uri or 'missing'})",
        )
        check(
            (query.get("code_challenge_method") or [""])[0] == "S256",
            "the flow is PKCE (code_challenge_method=S256)",
        )

        # 4. A real authorization-code flow, with a throwaway identity.
        user_pk = api.ensure_user()
        status, headers, body = client.get(authorize)
        if status == 200:
            raise CheckFailed(
                "the IdP refused this identity at the authorize step, which is usually a group "
                f"binding on the provider ({cfg.group})"
            )
        require(status == 302 and headers.get("location"), f"authorize -> HTTP {status}: {body[:160]}")
        callback = finish_flow(client, headers["location"], authorize)
        status, _, _ = client.get(callback)
        check(client.cookie("ontrak_genie_session") is not None, f"the callback set a session (HTTP {status})")

        # 5. The session names who signed in — the subject tenancy keys on.
        signed_in = status_of(client)
        identity = signed_in.get("identity") or {}
        check(
            signed_in.get("authenticated") is True and bool(identity.get("sub")),
            f"the session resolves to a subject ({str(identity.get('sub'))[:12]}…)",
        )
        check(
            identity.get("email") == f"{cfg.user}@innotel.us",
            f"the session carries the address ({identity.get('email')})",
        )

        # 6. Signing out ends it.
        status, _, _ = client.post(cfg.public + "/api/auth/logout", {})
        check(status in (200, 204), f"/api/auth/logout -> HTTP {status}")
        check(status_of(client).get("authenticated") is False, "the session is gone after signing out")
    except CannotRun as error:
        print(f"  {SKIP}  {error}")
        return 2
    except CheckFailed as error:
        print(f"  {BAD}  {error}")
        failures.append(str(error))
    finally:
        if user_pk:
            api.delete_user(user_pk)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("sign-in posture holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
