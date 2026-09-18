"""Password hashing and portal session cookies.

Deliberately stdlib-only: scrypt for passwords, HMAC-SHA256 for the cookie. The
formats are versioned so they can be migrated later without a flag day.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

# OWASP-recommended scrypt parameters (16 MB, interactive latency).
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
DKLEN = 32

COOKIE_NAME = "ontrak_session"


def hash_password(password: str, *, salt: str | None = None) -> str:
    """Return ``scrypt$<salt_hex>$<hash_hex>``."""
    salt_bytes = bytes.fromhex(salt) if salt else secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_bytes,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=DKLEN,
    )
    return f"scrypt${salt_bytes.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    try:
        scheme, salt_hex, hash_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    candidate = hash_password(password, salt=salt_hex)
    return hmac.compare_digest(candidate, f"{scheme}${salt_hex}${hash_hex}")


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def sign_cookie(payload: dict[str, Any], secret: str, ttl_seconds: int = 12 * 3600) -> str:
    """Serialise + sign a cookie value.

    Value layout: ``<b64(body)>.<b64(hmac)>`` where body carries an ``exp``
    claim. Tamper-evident and expiry-checked on read.
    """
    if not secret:
        raise ValueError("portal.secret must be set to sign cookies")
    body = dict(payload)
    body["exp"] = int(time.time()) + int(ttl_seconds)
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    mac = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).digest()
    return f"{_b64(raw)}.{_b64(mac)}"


def read_cookie(value: str | None, secret: str) -> dict[str, Any] | None:
    """Return the payload, or ``None`` if absent/forged/expired."""
    if not value or not secret or "." not in value:
        return None
    b64_body, _, b64_mac = value.partition(".")
    try:
        raw = _unb64(b64_body)
        mac = _unb64(b64_mac)
    except Exception:
        return None
    expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected):
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload
