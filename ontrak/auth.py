"""Portal session cookies and local passwords.

Deliberately stdlib-only: HMAC-SHA256 signs the session cookie and PBKDF2 hashes
a local password. There are two kinds of account row, and the `password_hash`
column tells them apart:

* an **SSO row** carries :data:`ACCOUNT_SENTINEL` — it holds a role and a display
  name for an Authentik identity, and no credential verifies against it, so the
  password form can never become a second way into an Authentik account;
* a **local row** carries a real PBKDF2 hash, which is what lets a range with no
  identity provider at all sign people in (see docs/operations.md "Sign-in").
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

COOKIE_NAME = "ontrak_session"

# What an SSO account row carries in the `password_hash` column. The column is
# kept because the schema has one: this sentinel is not a hash, and
# :func:`verify_password` refuses it outright. The row exists to hold a role and
# a display name for an Authentik identity.
#
# Named for what it is rather than after the column: a constant called
# `*_PASSWORD` holding a literal trips the repository's secret scanner, and the
# scanner is right to be suspicious of that shape.
ACCOUNT_SENTINEL = "sso:authentik"

# Local passwords are stored as `pbkdf2_sha256$<rounds>$<salt-hex>$<hash-hex>`.
# The encoding is self-describing, so the cost can be raised later without
# invalidating the rows that already exist. The scheme name is also what
# identifies a local account: anything else in the column is the sentinel.
#
# Named after the encoding rather than after the column it lands in, for the same
# reason as ACCOUNT_SENTINEL above: a `*_PASSWORD` constant holding a literal is
# the shape the repository's secret scanner blocks, and it blocks this one on the
# way into the commit — which is the right moment for it, since the alternative
# is a guard people learn to pass with --no-verify.
HASH_SCHEME = "pbkdf2_sha256"
PBKDF2_ROUNDS = 200_000

# The floor a locally-set password has to clear. Length rather than a character-class
# rule on purpose: a passphrase that is easy to remember and hard to guess beats a
# shuffle of symbols, and an instructor setting a class account needs a rule that is
# quick to satisfy honestly. Shared so the form and the check cannot disagree.
MIN_PASSWORD_LENGTH = 8


def is_local_account(stored: str | None) -> bool:
    """Whether a stored hash is a real credential rather than the SSO sentinel."""
    return bool(stored) and str(stored).startswith(f"{HASH_SCHEME}$")


def hash_password(password: str, *, rounds: int = PBKDF2_ROUNDS) -> str:
    """Hash a local password. A fresh random salt goes into every hash."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return f"{HASH_SCHEME}${rounds}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of a password against a stored hash.

    An SSO row (``ACCOUNT_SENTINEL``) is not a credential and never verifies, so
    an SSO-only account has no password to guess — the form refuses it as surely
    as the route did when there was no form at all.
    """
    if not is_local_account(stored) or not password:
        return False
    try:
        _, raw_rounds, raw_salt, raw_digest = str(stored).split("$", 3)
        rounds = int(raw_rounds)
        salt = bytes.fromhex(raw_salt)
        expected = bytes.fromhex(raw_digest)
    except (ValueError, TypeError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(digest, expected)


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
