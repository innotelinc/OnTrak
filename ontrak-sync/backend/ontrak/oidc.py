"""Ontrak Sync — Cerulean SSO (OpenID Connect, authorization code + PKCE).

Cerulean runs **Authentik** at `auth.cerulean.innotel.us` as the Network's identity
provider. This module is the relying-party half of that: it discovers the
provider, starts an authorization-code flow with PKCE, exchanges the code, and
verifies the ID token against the provider's published JWKS before anything in it
is believed.

WHY THIS IS HAND-WRITTEN AND NOT A LIBRARY
------------------------------------------
The service's whole dependency list is a web framework and an ASGI server, and
that is a deliberate position for a tool whose job is patching — every library is
one more thing to patch. The parts of OIDC this needs are four HTTP calls, a
PKCE pair, and RS256 signature verification, and all four are small enough to
read in one sitting and to unit-test without a network.

WHAT IS VERIFIED, AND WHY EACH ONE MATTERS
------------------------------------------
  * **signature** — against the provider's JWKS, by `kid`. Without it, the ID
    token is a claim anybody can type.
  * **issuer** — the discovery document has to name the same issuer it was
    fetched from, or a compromised discovery URL could point the whole flow at
    another provider.
  * **audience** — the token has to have been minted for *this* client. Without
    it, an assertion issued to any other application in the Network would be a
    valid sign-in here.
  * **nonce** — the value this deployment put in the authorization request. It is
    what makes a replayed assertion useless.
  * **expiry and not-before** — with a small clock skew allowance, because the
    two machines do not share a clock and refusing a token three seconds early is
    an outage blamed on the network.
  * **PKCE (S256) verifier** — checked by the provider on the token endpoint; this
    module only has to generate and remember it.

The claims are then turned into a local account by `identity.resolve_oidc_user`,
which is where the group→role decision lives. This module never touches the
database: it answers "who does the provider say this is", and nothing else.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

log = logging.getLogger("ontrak.oidc")

# A provider's clock and this container's differ by seconds in practice. The skew
# allowance is applied to `exp` and `iat`/`nbf` and is small on purpose: it exists
# to absorb drift, not to extend a token's life.
CLOCK_SKEW_SECONDS = 90
DISCOVERY_TTL_SECONDS = 3600
JWKS_TTL_SECONDS = 3600
HTTP_TIMEOUT_SECONDS = 20

STATE_TTL_SECONDS = 600


class OidcError(RuntimeError):
    """A refusal. The message is safe to show a person and never contains a token."""


# ── PKCE + state ─────────────────────────────────────────────────────────────
def code_verifier() -> str:
    """RFC 7636 verifier: 43–128 chars of unreserved base64url."""
    return secrets.token_urlsafe(64)[:96]


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


@dataclass
class AuthorizationState:
    """What has to survive the round trip to the provider and back.

    Signed into one short-lived cookie rather than held in memory: a restart
    between the redirect and the callback would otherwise break every sign-in in
    flight, and a table would be a third thing to clean up.
    """

    state: str
    nonce: str
    verifier: str
    return_to: str = "/"
    issued_at: int = field(default_factory=lambda: int(time.time()))

    def to_dict(self) -> dict:
        return {"state": self.state, "nonce": self.nonce, "verifier": self.verifier,
                "return_to": self.return_to, "issued_at": self.issued_at}

    @staticmethod
    def new(return_to: str = "/") -> "AuthorizationState":
        return AuthorizationState(state=secrets.token_urlsafe(24), nonce=secrets.token_urlsafe(24),
                                  verifier=code_verifier(), return_to=return_to or "/")


def sign_state(state: AuthorizationState, secret: str) -> str:
    """`<payload-b64>.<hmac-b64>` — an HS256-shaped envelope without a JWT library."""
    payload = _b64(json.dumps(state.to_dict(), separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret.encode("utf-8"), payload.encode("ascii"),
                              hashlib.sha256).digest())
    return f"{payload}.{signature}"


def read_state(value: str, secret: str, *, now: int | None = None) -> AuthorizationState | None:
    """Verify and decode a signed state cookie. None when it is absent or invalid."""
    if not value or value.count(".") != 1:
        return None
    payload, signature = value.split(".", 1)
    expected = _b64(hmac.new(secret.encode("utf-8"), payload.encode("ascii"),
                             hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        data = json.loads(_unb64(payload))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    moment = int(now if now is not None else time.time())
    issued = int(data.get("issued_at") or 0)
    if issued <= 0 or moment - issued > STATE_TTL_SECONDS or issued - moment > CLOCK_SKEW_SECONDS:
        return None
    if not all(data.get(key) for key in ("state", "nonce", "verifier")):
        return None
    return AuthorizationState(state=str(data["state"]), nonce=str(data["nonce"]),
                              verifier=str(data["verifier"]),
                              return_to=str(data.get("return_to") or "/"), issued_at=issued)


def safe_return_to(value: str | None, *, fallback: str = "/") -> str:
    """Only ever redirect to a path inside this deployment.

    An open redirect on the callback is how a sign-in page becomes a phishing
    page, so anything that is not a single-slash path is discarded.
    """
    candidate = (value or "").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return fallback
    return candidate


# ── discovery + JWKS ─────────────────────────────────────────────────────────
class OidcClient:
    """Discovery, the two network calls, and ID-token verification.

    Each deployment gets one instance, which caches the discovery document and the
    JWKS for an hour: a sign-in is two HTTP calls to the provider, not four, and a
    provider that briefly stops answering cannot log out everybody who is already
    signed in.
    """

    def __init__(self, *, issuer: str, client_id: str, client_secret: str = "",
                 scopes: tuple[str, ...] = ("openid", "profile", "email", "groups"),
                 provider_name: str = "Cerulean", fetch=None):
        self.issuer = (issuer or "").rstrip("/")
        self.client_id = client_id or ""
        self.client_secret = client_secret or ""
        self.scopes = scopes
        self.provider_name = provider_name or "Cerulean"
        self._fetch = fetch or _http_json
        self._discovery: dict = {}
        self._discovery_at = 0.0
        self._jwks: dict = {}
        self._jwks_at = 0.0

    @property
    def configured(self) -> bool:
        """Whether this deployment can actually offer the button.

        A client id and an issuer, and nothing else: a public client proves itself
        with PKCE, so requiring a secret would refuse a correct configuration.
        """
        return bool(self.issuer and self.client_id)

    # ── the four calls ───────────────────────────────────────────────────────
    def discovery(self, *, now: float | None = None) -> dict:
        if not self.configured:
            raise OidcError("Cerulean SSO is not configured for this deployment.")
        moment = time.time() if now is None else now
        if self._discovery and moment - self._discovery_at < DISCOVERY_TTL_SECONDS:
            return self._discovery
        url = f"{self.issuer}/.well-known/openid-configuration"
        document = self._fetch(url, timeout=HTTP_TIMEOUT_SECONDS)
        if not isinstance(document, dict):
            raise OidcError(f"{self.provider_name} did not return a discovery document.")
        # The document must name the issuer it was asked about. A document that
        # renames it elsewhere is how a redirect quietly leaves the Network.
        advertised = str(document.get("issuer") or "").rstrip("/")
        if advertised and advertised != self.issuer:
            raise OidcError(
                f"{self.provider_name} advertises issuer {advertised!r}, not {self.issuer!r}."
            )
        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            if not document.get(key):
                raise OidcError(f"{self.provider_name}'s discovery document has no {key}.")
        self._discovery = document
        self._discovery_at = moment
        return document

    def jwks(self, *, now: float | None = None) -> dict:
        moment = time.time() if now is None else now
        if self._jwks and moment - self._jwks_at < JWKS_TTL_SECONDS:
            return self._jwks
        keys = self._fetch(self.discovery()["jwks_uri"], timeout=HTTP_TIMEOUT_SECONDS)
        if not isinstance(keys, dict) or not keys.get("keys"):
            raise OidcError(f"{self.provider_name} published no signing keys.")
        self._jwks = keys
        self._jwks_at = moment
        return keys

    def authorization_url(self, state: AuthorizationState, redirect_uri: str) -> str:
        document = self.discovery()
        query = urllib.parse.urlencode({
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(self.scopes),
            "state": state.state,
            "nonce": state.nonce,
            "code_challenge": code_challenge(state.verifier),
            "code_challenge_method": "S256",
        })
        return f"{document['authorization_endpoint']}?{query}"

    def exchange_code(self, code: str, redirect_uri: str, verifier: str) -> dict:
        document = self.discovery()
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self.client_id,
            "code_verifier": verifier,
        }
        if self.client_secret:
            form["client_secret"] = self.client_secret
        return self._fetch(document["token_endpoint"], method="POST",
                           form=form, timeout=HTTP_TIMEOUT_SECONDS)

    # ── verification ─────────────────────────────────────────────────────────
    def verify_id_token(self, id_token: str, *, nonce: str, redirect_uri: str,
                        now: float | None = None) -> dict:
        """Verify an ID token end to end and return its claims.

        Raises `OidcError` with a plain-language reason for every refusal — the
        operator seeing the message is the person who can fix the configuration,
        and "invalid token" would tell them nothing.
        """
        moment = time.time() if now is None else now
        header, payload, signing_input, signature = _split_jwt(id_token)

        algorithm = str(header.get("alg") or "")
        # `none` and the HS* family are refused outright. A provider that signs
        # with a symmetric key would have this service holding the signing key,
        # which makes it the provider.
        if algorithm != "RS256":
            raise OidcError(f"the ID token is signed with {algorithm or 'no algorithm'}; "
                            "only RS256 is accepted")
        key = _select_key(self.jwks(), str(header.get("kid") or ""))
        if key is None:
            # A rotated key is not a refusal — refetch once, then give up.
            self._jwks, self._jwks_at = {}, 0.0
            key = _select_key(self.jwks(), str(header.get("kid") or ""))
        if key is None:
            raise OidcError("the ID token names a signing key the provider does not publish")
        if not _verify_rs256(key, signing_input, signature):
            raise OidcError("the ID token's signature does not match the provider's key")

        claims = payload
        issuer = str(claims.get("iss") or "").rstrip("/")
        if issuer != self.issuer:
            raise OidcError(f"the ID token was issued by {issuer or 'nobody'}, not {self.issuer}")
        audience = claims.get("aud")
        audiences = [audience] if isinstance(audience, str) else list(audience or [])
        if self.client_id not in audiences:
            raise OidcError("the ID token was not issued to this application")
        if len(audiences) > 1:
            # With multiple audiences the provider must also name `azp`, otherwise
            # the token proves less than it looks like it does.
            if str(claims.get("azp") or "") != self.client_id:
                raise OidcError("the ID token has several audiences and no matching azp")
        if claims.get("nonce") != nonce:
            raise OidcError("the ID token's nonce does not match this sign-in")
        expiry = _as_number(claims.get("exp"))
        if expiry is None or expiry + CLOCK_SKEW_SECONDS < moment:
            raise OidcError("the ID token has expired")
        issued = _as_number(claims.get("iat"))
        if issued is not None and issued - CLOCK_SKEW_SECONDS > moment:
            raise OidcError("the ID token was issued in the future")
        not_before = _as_number(claims.get("nbf"))
        if not_before is not None and not_before - CLOCK_SKEW_SECONDS > moment:
            raise OidcError("the ID token is not valid yet")
        # `redirect_uri` is not a claim; it is threaded through so that a future
        # provider that echoes it can be checked here rather than in the caller.
        del redirect_uri
        return claims

    def userinfo(self, access_token: str) -> dict:
        """The userinfo endpoint, for deployments that return claims there.

        Not required by the flow — the ID token is authoritative — but Cerulean's
        Authentik includes `groups` here, and reading them is what lets a role be
        decided when the ID token alone does not carry them.
        """
        if not access_token:
            return {}
        endpoint = self.discovery().get("userinfo_endpoint")
        if not endpoint:
            return {}
        return self._fetch(endpoint, headers={"Authorization": f"Bearer {access_token}"},
                           timeout=HTTP_TIMEOUT_SECONDS)


# ── helpers ──────────────────────────────────────────────────────────────────
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _split_jwt(token: str) -> tuple[dict, dict, bytes, bytes]:
    parts = (token or "").split(".")
    if len(parts) != 3:
        raise OidcError("the provider returned something that is not an ID token")
    try:
        header = json.loads(_unb64(parts[0]))
        payload = json.loads(_unb64(parts[1]))
        signature = _unb64(parts[2])
    except (ValueError, TypeError) as exc:
        raise OidcError("the ID token could not be decoded") from exc
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise OidcError("the ID token's header or payload is not an object")
    return header, payload, f"{parts[0]}.{parts[1]}".encode("ascii"), signature


def _select_key(jwks: dict, kid: str) -> dict | None:
    keys = [key for key in (jwks.get("keys") or []) if isinstance(key, dict)]
    usable = [key for key in keys if str(key.get("kty") or "") == "RSA"]
    if kid:
        for key in usable:
            if str(key.get("kid") or "") == kid:
                return key
        return None
    # A single RSA key with no `kid` on either side is unambiguous; more than one
    # is not, and guessing which is the point of not guessing.
    return usable[0] if len(usable) == 1 else None


def _verify_rs256(key: dict, signing_input: bytes, signature: bytes) -> bool:
    """PKCS#1 v1.5 RSA-SHA256 over `header.payload`."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
    except ImportError as exc:  # pragma: no cover — dependency is declared
        raise OidcError(
            "this deployment cannot verify SSO assertions: the `cryptography` "
            "package is missing from the API image"
        ) from exc
    try:
        modulus = _as_int(key.get("n"))
        exponent = _as_int(key.get("e"))
        if modulus is None or exponent is None:
            return False
        public = rsa.RSAPublicNumbers(exponent, modulus).public_key()
        public.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
        return True
    except InvalidSignature:
        return False
    except (ValueError, TypeError):
        return False


def _as_int(value) -> int | None:
    if value is None:
        return None
    try:
        return int.from_bytes(_unb64(str(value)), "big")
    except (ValueError, TypeError):
        return None


def _as_number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _http_json(url: str, *, method: str = "GET", form: dict | None = None,
               headers: dict | None = None, timeout: int = HTTP_TIMEOUT_SECONDS) -> dict:
    """One JSON HTTP call. urllib, because the dependency list is a position."""
    data = urllib.parse.urlencode(form).encode("ascii") if form is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400] if exc.fp else ""
        raise OidcError(f"the provider refused the request ({exc.code}): {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OidcError(f"the provider could not be reached: {exc}") from exc
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise OidcError("the provider returned a response that is not JSON") from exc
