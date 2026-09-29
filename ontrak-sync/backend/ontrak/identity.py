"""Ontrak Sync — who the operator is, and what they are allowed to do.

This module is the one place that decides three things:

  * **Is this person who they say they are?** A password is verified against a
    PBKDF2-HMAC-SHA256 digest with its own salt, and a session is an opaque random
    token whose *digest* is what the database holds. Nothing here can be
    brute-forced from a copy of the SQLite file, which matters because that file is
    the whole history of a service that installs packages on every machine in the
    estate.

  * **What may they do once they are in?** Roles come from one vocabulary shared
    with the rest of the OnTrak family — the training range's students and
    instructors, the desk's technicians, Sentinel's analysts, this service's
    sysadmins — so one account works across all of them and the portal can decide
    which product to send somebody to from the same claim.

  * **What did they do?** Every sign-in, refusal, role change and apply decision is
    written to the same append-only event log the estate already reads. An audit
    trail that started after the incident is not an audit trail, so this is wired
    into the login path rather than bolted on.

WHY THE SESSION TOKEN IS NOT A JWT
----------------------------------
A signed token cannot be revoked. The token in the dashboard's `localStorage` is
handed out by `/api/auth/login` and is *looked up* on every request, so a
deactivated account or a signed-out operator stops working immediately rather
than whenever the signature happens to expire. The cost is one indexed SQLite
read per request, which against a local file is free.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
-----------------------------------------
It does not send email, store an SMTP password, or implement password reset by
link. There is no mail server in this estate's trust path, and a reset flow that
cannot deliver a message is a login page that lies. An administrator resets a
password through the API or the dashboard; that is honest about who can do it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# ── roles ────────────────────────────────────────────────────────────────────
# One vocabulary for the whole family. The names are the ones the sibling products
# already use (the training range's ADMIN/INSTRUCTOR/STUDENT, the desk's
# TECHNICIAN) plus the two this service and Sentinel need, so a claim arriving
# from Cerulean means the same thing to every product and nothing has to be
# translated at a boundary — translation tables are where "instructor became a
# student after the SSO migration" bugs live.
ROLES: tuple[str, ...] = (
    "ADMIN",
    "SYSADMIN",
    "ANALYST",
    "TECHNICIAN",
    "INSTRUCTOR",
    "STUDENT",
)

ROLE_LABELS: dict[str, str] = {
    "ADMIN": "Administrator — every product",
    "SYSADMIN": "Sysadmin — OnTrak Sync",
    "ANALYST": "Analyst — OnTrak Sentinel",
    "TECHNICIAN": "Technician — OnTrak Tix",
    "INSTRUCTOR": "Instructor — training range",
    "STUDENT": "Student — training range",
}

# ── capabilities ─────────────────────────────────────────────────────────────
# Capability names are namespaced so a role's grant reads as a sentence, and so a
# second product's grants can live in the same table later without a rename.
CAPABILITIES: tuple[str, ...] = (
    "portal:view",       # the central dashboard and its product tiles
    "sync:view",         # read the estate's update state
    "sync:scan",         # walk the estate and record findings
    "sync:approve",      # mark a finding approved
    "sync:apply",        # install what has been approved
    "sync:configure",    # the timer, the mode, the schedule
    "users:manage",      # create people and change what they may do
)

# THE ONE TABLE THAT MATTERS. Read it as: what does each role get?
#
# `sync:apply` is the interesting one. It is not granted to `TECHNICIAN` or
# `ANALYST` even though both can see the estate, because applying installs
# packages on twenty-seven containers at once — the capability belongs to the
# people who own the maintenance window, not to everyone who can read a report.
_ROLE_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "ADMIN": CAPABILITIES,
    "SYSADMIN": ("portal:view", "sync:view", "sync:scan", "sync:approve", "sync:apply",
                 "sync:configure", "users:manage"),
    "ANALYST": ("portal:view", "sync:view", "sync:scan"),
    "TECHNICIAN": ("portal:view", "sync:view", "sync:scan"),
    "INSTRUCTOR": ("portal:view", "sync:view"),
    "STUDENT": ("portal:view",),
}

# ── products ─────────────────────────────────────────────────────────────────
# Where each role is sent by the portal. The addresses are configuration in the
# portal itself; this is only the *mapping*, which is a decision and therefore
# lives next to the roles rather than in a page component.
PRODUCT_ROLES: dict[str, tuple[str, ...]] = {
    "its": ("STUDENT", "INSTRUCTOR", "ADMIN"),
    "tix": ("TECHNICIAN", "ADMIN", "SYSADMIN"),
    "sentinel": ("ANALYST", "ADMIN", "SYSADMIN"),
    "sync": ("SYSADMIN", "ADMIN"),
}

PRODUCT_NAMES: dict[str, str] = {
    "its": "OnTrak IT Support Training",
    "tix": "OnTrak Tix",
    "sentinel": "OnTrak Sentinel",
    "sync": "OnTrak Sync",
}


def role_capabilities(role: str) -> tuple[str, ...]:
    """The capabilities a role holds. An unknown role holds none — fail closed."""
    return _ROLE_CAPABILITIES.get(role.upper(), ())


def has_capability(role: str, capability: str) -> bool:
    return capability in role_capabilities(role)


def products_for(role: str) -> tuple[str, ...]:
    """Which products this role belongs in, in the portal's display order."""
    wanted = role.upper()
    return tuple(key for key in ("its", "tix", "sentinel", "sync")
                 if wanted in PRODUCT_ROLES.get(key, ()))


def normalize_role(value: str | None, *, default: str = "STUDENT") -> str:
    """Coerce a provider's group name or a form value to a role we know.

    Case-insensitive because Authentik group names are typed by people
    (`range-instructors`, `Range-Instructors`), and an unrecognised value falls
    back to the *least* privileged role rather than the greatest.
    """
    if not value:
        return default
    candidate = value.strip().upper()
    return candidate if candidate in ROLES else default


# ── passwords ────────────────────────────────────────────────────────────────
# 600k iterations of PBKDF2-HMAC-SHA256 is the current OWASP figure and costs
# roughly a quarter of a second on the hardware this runs on. That is invisible on
# a login and ruinous for an offline attacker, which is the trade being made:
# this digest is the only thing standing between a stolen SQLite file and every
# machine in the estate.
PBKDF2_ITERATIONS = 600_000
PBKDF2_ALGORITHM = "pbkdf2_sha256"
MIN_PASSWORD_LENGTH = 12


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS,
                  salt: bytes | None = None) -> str:
    """`pbkdf2_sha256$<iterations>$<salt-b64>$<digest-b64>`.

    The parameters travel with the digest so a future iteration count can be
    raised without invalidating every existing password: verification reads the
    work factor from the stored value instead of assuming today's constant.
    """
    if not isinstance(password, str) or password == "":
        raise ValueError("a password is required")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "$".join((
        PBKDF2_ALGORITHM,
        str(iterations),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    ))


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of a password against a stored digest.

    A malformed or absent digest returns False rather than raising: a row an
    administrator hand-edited into nonsense must fail closed, and a sign-in form
    that 500s on one account is a way to discover which accounts are special.
    """
    if not stored or not isinstance(password, str):
        return False
    parts = stored.split("$")
    if len(parts) != 4 or parts[0] != PBKDF2_ALGORITHM:
        return False
    try:
        iterations = int(parts[1])
        salt = base64.b64decode(parts[2], validate=True)
        expected = base64.b64decode(parts[3], validate=True)
    except (ValueError, TypeError):
        return False
    if iterations <= 0 or not salt or not expected:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


def password_problems(password: str, *, username: str | None = None,
                      email: str | None = None) -> list[str]:
    """Every reason this password is refused, so the form can show them at once.

    Length only — no character-class theatre. A composition rule mostly produces
    `Password1!`; a length floor is the rule that actually moves the search space.
    """
    problems: list[str] = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(f"must be at least {MIN_PASSWORD_LENGTH} characters")
    if password.strip() == "":
        problems.append("cannot be blank")
    lowered = password.lower()
    for field, label in ((username, "username"), (email, "email")):
        if field and field.strip() and field.strip().lower() in lowered:
            problems.append(f"cannot contain the {label}")
    return problems


# ── sessions ─────────────────────────────────────────────────────────────────
SESSION_TTL_SECONDS = 12 * 3600
SESSION_COOKIE = "ontrak_session"
# The window after which an *idle* session is dropped. A token on a wall-mounted
# dashboard that nobody has touched for a day should not still be a way in.
SESSION_IDLE_SECONDS = 8 * 3600


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def session_digest(token: str) -> str:
    """SHA-256 of the token, hex. What the database stores.

    Fast by design: this is an integrity reference for a 256-bit random value, not
    a password, so the work factor belongs on the password (above) and not here,
    where it would be paid on every single request.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _fmt(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def session_expiry(now: datetime | None = None, ttl: int = SESSION_TTL_SECONDS) -> str:
    return _fmt((now or datetime.now(timezone.utc)) + timedelta(seconds=ttl))


# ── login throttling ─────────────────────────────────────────────────────────
# Deliberately small numbers, because the account being attacked is also the
# account that has to be able to fix the estate at 3am: five failures, then a
# wait that doubles. The lockout is keyed on `username` AND on the address, and
# the longer of the two applies — keyed on the username alone, anybody who can
# guess a name can lock a sysadmin out of their own service, which turns a
# protection into the outage.
LOGIN_MAX_FAILURES = 5
LOGIN_BASE_LOCKOUT_SECONDS = 30
LOGIN_MAX_LOCKOUT_SECONDS = 900
# Failures older than this stop counting, so a slow guess cannot accumulate.
LOGIN_FAILURE_WINDOW_SECONDS = 900


def lockout_seconds(failure_count: int) -> int:
    """How long to refuse after `failure_count` consecutive failures."""
    if failure_count < LOGIN_MAX_FAILURES:
        return 0
    over = failure_count - LOGIN_MAX_FAILURES
    return min(LOGIN_MAX_LOCKOUT_SECONDS, LOGIN_BASE_LOCKOUT_SECONDS * (2 ** min(over, 5)))


def lockout_remaining(last_failure_iso: str | None, failure_count: int,
                      now: datetime | None = None) -> int:
    """Seconds still to wait, from the last failure and the running count."""
    window = lockout_seconds(failure_count)
    if window <= 0:
        return 0
    last = _parse_ts(last_failure_iso)
    if last is None:
        return 0
    moment = now or datetime.now(timezone.utc)
    elapsed = (moment - last).total_seconds()
    if elapsed > LOGIN_FAILURE_WINDOW_SECONDS:
        return 0
    return max(0, int(window - elapsed))


# ── rows ─────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class User:
    """A person. `password_hash` is present on the row and never in a response."""

    id: int
    username: str
    email: str
    display_name: str
    role: str
    active: bool
    external_id: str | None
    created_at: str
    updated_at: str
    last_login_at: str | None
    password_hash: str | None = None

    def public(self) -> dict:
        """The shape every HTTP response uses. No digest, ever."""
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "display_name": self.display_name,
            "role": self.role,
            "role_label": ROLE_LABELS.get(self.role, self.role),
            "active": self.active,
            "external": bool(self.external_id),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_login_at": self.last_login_at,
            "capabilities": list(role_capabilities(self.role)),
            "products": list(products_for(self.role)),
        }


def _user_from_row(row) -> User | None:
    if row is None:
        return None
    keys = set(row.keys()) if hasattr(row, "keys") else set()
    get = (lambda k, d=None: row[k]) if keys else (lambda k, d=None: d)
    return User(
        id=int(get("id", 0)),
        username=get("username") or "",
        email=get("email") or "",
        display_name=get("display_name") or get("username") or "",
        role=get("role") or "STUDENT",
        active=bool(get("active", 0)),
        external_id=get("external_id"),
        created_at=get("created_at") or "",
        updated_at=get("updated_at") or "",
        last_login_at=get("last_login_at"),
        password_hash=get("password_hash"),
    )


# ── users ────────────────────────────────────────────────────────────────────
def create_user(conn, *, username: str, password: str | None, role: str = "STUDENT",
                email: str = "", display_name: str = "", external_id: str | None = None,
                active: bool = True) -> User:
    """Create one account. The caller is responsible for having authorised this."""
    username = (username or "").strip()
    if not username:
        raise ValueError("a username is required")
    role = normalize_role(role)
    now = _now()
    conn.execute(
        """
        INSERT INTO users (username, email, display_name, role, active, external_id,
                           password_hash, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        """,
        (username, (email or "").strip(), (display_name or username).strip(), role,
         int(bool(active)), external_id, hash_password(password) if password else None, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return _user_from_row(row)


def get_user(conn, *, user_id: int | None = None, username: str | None = None) -> User | None:
    if user_id is not None:
        row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
    elif username:
        # Case-insensitive on the way in: a person typing `Sysadmin` at 3am is the
        # same person, and the unique index that keeps names unambiguous is
        # `COLLATE NOCASE` for the same reason.
        row = conn.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE",
                           (username.strip(),)).fetchone()
    else:
        return None
    return _user_from_row(row)


def get_user_by_email(conn, email: str) -> User | None:
    row = conn.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE",
                       ((email or "").strip(),)).fetchone()
    return _user_from_row(row)


def get_user_by_external_id(conn, external_id: str) -> User | None:
    row = conn.execute("SELECT * FROM users WHERE external_id=?", (external_id,)).fetchone()
    return _user_from_row(row)


def list_users(conn) -> list[User]:
    rows = conn.execute("SELECT * FROM users ORDER BY role, username").fetchall()
    return [u for u in (_user_from_row(r) for r in rows) if u is not None]


def count_users(conn) -> int:
    return int(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"])


def count_active_admins(conn) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM users WHERE active=1 AND role='ADMIN'"
    ).fetchone()
    return int(row["n"])


def update_user(conn, user_id: int, *, email: str | None = None,
                display_name: str | None = None, role: str | None = None,
                active: bool | None = None, external_id: str | None = None) -> User | None:
    """Change a person's fields. None means "leave alone"."""
    fields: dict[str, object] = {}
    if email is not None:
        fields["email"] = email.strip()
    if display_name is not None:
        fields["display_name"] = display_name.strip()
    if role is not None:
        fields["role"] = normalize_role(role)
    if active is not None:
        fields["active"] = int(bool(active))
    if external_id is not None:
        fields["external_id"] = external_id or None
    if not fields:
        return get_user(conn, user_id=user_id)
    fields["updated_at"] = _now()
    assignments = ", ".join(f"{name}=?" for name in fields)
    conn.execute(f"UPDATE users SET {assignments} WHERE id=?", (*fields.values(), int(user_id)))
    conn.commit()
    return get_user(conn, user_id=user_id)


def set_password(conn, user_id: int, password: str) -> None:
    """Replace a password and revoke every session that password opened.

    The revocation is not optional. A password change that leaves the old
    holder's sessions alive does not actually evict anybody.
    """
    conn.execute(
        "UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
        (hash_password(password), _now(), int(user_id)),
    )
    conn.commit()
    revoke_all_sessions(conn, user_id)


def delete_user(conn, user_id: int) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id=?", (int(user_id),))
    conn.execute("DELETE FROM users WHERE id=?", (int(user_id),))
    conn.commit()


def clear_password(conn, user_id: int) -> None:
    """Make an account SSO-only.

    A person who signs in through Cerulean needs no local password at all, and
    clearing it is stronger than setting a random one: the local form cannot
    succeed for this account even if the digest leaks, because there is nothing
    to match against.
    """
    conn.execute("UPDATE users SET password_hash=NULL, updated_at=? WHERE id=?",
                 (_now(), int(user_id)))
    conn.commit()
    revoke_all_sessions(conn, user_id)


# ── sessions, stored ─────────────────────────────────────────────────────────
def create_session(conn, user_id: int, *, ttl: int = SESSION_TTL_SECONDS,
                   user_agent: str = "", address: str = "") -> tuple[str, str]:
    """Open a session and return `(token, expires_at)`. The token is shown once."""
    token = new_session_token()
    now = datetime.now(timezone.utc)
    expires = session_expiry(now, ttl)
    conn.execute(
        """
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at,
                              user_agent, address)
        VALUES (?,?,?,?,?,?,?)
        """,
        (session_digest(token), int(user_id), _fmt(now), expires, _fmt(now),
         (user_agent or "")[:250], (address or "")[:64]),
    )
    conn.commit()
    return token, expires


def resolve_session(conn, token: str) -> dict | None:
    """The session and its user for a token, or None if it is unusable.

    Expiry and the idle window are checked here, on every request, rather than by
    a sweep: a sweep that has not run yet is a revoked session that still works.
    """
    if not token:
        return None
    row = conn.execute(
        """
        SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.user_id, u.*
          FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash=?
        """,
        (session_digest(token),),
    ).fetchone()
    if row is None:
        return None
    user = _user_from_row(row)
    if user is None or not user.active:
        return None
    now = datetime.now(timezone.utc)
    expires = _parse_ts(row["expires_at"])
    if expires is None or expires <= now:
        revoke_session(conn, token)
        return None
    seen = _parse_ts(row["last_seen_at"])
    if seen is not None and (now - seen).total_seconds() > SESSION_IDLE_SECONDS:
        revoke_session(conn, token)
        return None
    conn.execute("UPDATE sessions SET last_seen_at=? WHERE id=?",
                 (_fmt(now), int(row["session_id"])))
    conn.commit()
    return {"user": user, "session_id": int(row["session_id"]),
            "expires_at": row["expires_at"]}


def revoke_session(conn, token: str) -> bool:
    cur = conn.execute("DELETE FROM sessions WHERE token_hash=?",
                       (session_digest(token),))
    conn.commit()
    return cur.rowcount > 0


def revoke_session_by_id(conn, session_id: int) -> None:
    conn.execute("DELETE FROM sessions WHERE id=?", (int(session_id),))
    conn.commit()


def revoke_all_sessions(conn, user_id: int) -> int:
    cur = conn.execute("DELETE FROM sessions WHERE user_id=?", (int(user_id),))
    conn.commit()
    return cur.rowcount


def purge_expired_sessions(conn) -> int:
    """Drop rows nobody can use. Called on startup; not a security control."""
    cur = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (_now(),))
    conn.commit()
    return cur.rowcount


def list_sessions(conn, user_id: int | None = None) -> list[dict]:
    clause, params = ("WHERE s.user_id=?", (int(user_id),)) if user_id else ("", ())
    rows = conn.execute(
        f"""
        SELECT s.id, s.user_id, u.username, s.created_at, s.expires_at, s.last_seen_at,
               s.user_agent, s.address
          FROM sessions s JOIN users u ON u.id = s.user_id {clause}
         ORDER BY s.last_seen_at DESC
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


# ── login attempts, stored ───────────────────────────────────────────────────
def record_login_failure(conn, *, username: str, address: str = "") -> int:
    """Record a failed attempt and return the running count for that key.

    Two rows are maintained — one for the username, one for the address — because
    they protect against different things: the first stops a password being
    guessed, the second stops one source from walking a list of usernames.
    """
    now = _fmt(datetime.now(timezone.utc))
    for key in _failure_keys(username, address):
        conn.execute(
            """
            INSERT INTO login_failures (key, count, last_failure_at) VALUES (?,1,?)
            ON CONFLICT(key) DO UPDATE SET
                count = CASE
                    WHEN login_failures.last_failure_at < ?
                    THEN 1 ELSE login_failures.count + 1 END,
                last_failure_at = excluded.last_failure_at
            """,
            (key, now, _window_start()),
        )
    conn.commit()
    return _current_failure_count(conn, username, address)


def clear_login_failures(conn, *, username: str, address: str = "") -> None:
    keys = _failure_keys(username, address)
    if not keys:
        return
    marks = ",".join("?" for _ in keys)
    conn.execute(f"DELETE FROM login_failures WHERE key IN ({marks})", keys)
    conn.commit()


def login_locked_for(conn, *, username: str, address: str = "",
                     now: datetime | None = None) -> int:
    """Seconds the caller must wait. Zero means "try the password"."""
    waits: list[int] = []
    for key in _failure_keys(username, address):
        row = conn.execute(
            "SELECT count, last_failure_at FROM login_failures WHERE key=?", (key,)
        ).fetchone()
        if row is None:
            continue
        waits.append(lockout_remaining(row["last_failure_at"], int(row["count"]), now))
    return max(waits, default=0)


def _failure_keys(username: str, address: str) -> list[str]:
    keys = []
    if (username or "").strip():
        keys.append("user:" + username.strip().lower())
    if (address or "").strip():
        keys.append("addr:" + address.strip())
    return keys


def _window_start() -> str:
    return _fmt(datetime.now(timezone.utc) - timedelta(seconds=LOGIN_FAILURE_WINDOW_SECONDS))


def _current_failure_count(conn, username: str, address: str) -> int:
    row = conn.execute(
        """
        SELECT MAX(count) AS n FROM login_failures
         WHERE key IN (?, ?) AND last_failure_at >= ?
        """,
        ("user:" + (username or "").strip().lower(), "addr:" + (address or "").strip(),
         _window_start()),
    ).fetchone()
    return int(row["n"] or 0)


# ── sign-in ──────────────────────────────────────────────────────────────────
@dataclass
class LoginOutcome:
    ok: bool
    user: User | None = None
    token: str | None = None
    expires_at: str | None = None
    reason: str = ""
    retry_after: int = 0


def authenticate(conn, *, username: str, password: str, address: str = "",
                 user_agent: str = "", ttl: int = SESSION_TTL_SECONDS) -> LoginOutcome:
    """The whole local sign-in decision, in one auditable function.

    Every branch returns the SAME reason string for a wrong password and an
    unknown account. Two different messages turn the login form into a directory
    of who works here, and "invalid credentials" costs a legitimate user nothing.
    """
    wait = login_locked_for(conn, username=username, address=address)
    if wait > 0:
        _audit(conn, "auth.login.throttled",
               f"sign-in refused for {_safe(username)} — locked for {wait}s", level="warning")
        return LoginOutcome(False, reason=f"Too many attempts. Try again in {wait} seconds.",
                            retry_after=wait)

    user = get_user(conn, username=username)

    # A user with no password hash is SSO-only, and must fail here for the same
    # reason a wrong password does. The `verify_password` call is still made
    # against a dummy digest so this branch costs the same time as a real one.
    if user is None:
        verify_password(password, hash_password("placeholder-not-a-real-account"))
    usable = verify_password(password, user.password_hash) if user else False

    if not user or not usable or not user.active:
        count = record_login_failure(conn, username=username, address=address)
        _audit(conn, "auth.login.denied",
               f"sign-in refused for {_safe(username)} (attempt {count})", level="warning")
        return LoginOutcome(False, reason="Invalid username or password.")

    clear_login_failures(conn, username=username, address=address)
    token, expires = create_session(conn, user.id, ttl=ttl, user_agent=user_agent,
                                    address=address)
    conn.execute("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?",
                 (_now(), _now(), user.id))
    conn.commit()
    _audit(conn, "auth.login", f"{user.username} signed in as {user.role}",
           actor=user.username)
    return LoginOutcome(True, user=user, token=token, expires_at=expires)


# ── OIDC / Cerulean SSO ──────────────────────────────────────────────────────
@dataclass(frozen=True)
class OidcClaims:
    """The claims this service reads, after the token has been verified."""

    subject: str
    email: str
    name: str = ""
    username: str = ""
    groups: tuple[str, ...] = ()
    email_verified: bool = True

    @staticmethod
    def from_payload(payload: dict) -> "OidcClaims":
        raw_groups = payload.get("groups") or payload.get("roles") or []
        if isinstance(raw_groups, str):
            raw_groups = [raw_groups]
        verified = payload.get("email_verified")
        return OidcClaims(
            subject=str(payload.get("sub") or "").strip(),
            email=str(payload.get("email") or "").strip().lower(),
            name=str(payload.get("name") or "").strip(),
            username=str(payload.get("preferred_username") or "").strip(),
            groups=tuple(str(g).strip() for g in raw_groups if str(g).strip()),
            # Absent means "the provider did not say otherwise". Authentik sets it,
            # and an explicit false is a refusal rather than a missing field.
            email_verified=verified is not False,
        )


def role_from_groups(groups: tuple[str, ...], mappings: dict[str, str],
                     default: str = "STUDENT") -> tuple[str, str | None]:
    """Map a provider's groups to a family role.

    Returns `(role, matched_group)`. The highest-privilege match wins rather than
    the first, because Authentik group lists arrive in no guaranteed order and
    "first match" would make a person's role depend on a provider's sort.
    """
    order = {role: index for index, role in enumerate(
        ("STUDENT", "INSTRUCTOR", "TECHNICIAN", "ANALYST", "SYSADMIN", "ADMIN"))}
    best: tuple[str, str] | None = None
    for group in groups:
        key = group.strip().lower()
        mapped = mappings.get(key)
        if not mapped:
            continue
        role = normalize_role(mapped, default=default)
        if best is None or order.get(role, -1) > order.get(best[0], -1):
            best = (role, group)
    return best if best else (normalize_role(default), None)


def resolve_oidc_user(conn, claims: OidcClaims, mappings: dict[str, str],
                      default_role: str = "STUDENT") -> tuple[User | None, str, bool]:
    """Find or provision the local account behind a verified assertion.

    Returns `(user, "", provisioned)` or `(None, reason, False)`. Resolution is by
    the provider's stable subject first and email second, so an account created
    before SSO existed is *adopted* rather than duplicated — and a rename in the
    directory moves it instead of leaving its audit history behind.
    """
    if not claims.subject:
        return None, "the provider's assertion carried no subject", False
    if not claims.email:
        return None, "the provider's assertion carried no email address", False
    if not claims.email_verified:
        return None, "the provider did not verify that email address", False

    role, matched = role_from_groups(claims.groups, mappings, default_role)

    existing = get_user_by_external_id(conn, claims.subject) or get_user_by_email(conn, claims.email)
    if existing is None:
        username = _unique_username(conn, claims.username or claims.email.split("@")[0])
        user = create_user(
            conn, username=username, password=None, role=role, email=claims.email,
            display_name=claims.name or claims.email, external_id=claims.subject,
        )
        _audit(conn, "auth.sso.provision",
               f"provisioned {user.username} as {role} from Cerulean SSO",
               actor=user.username)
        return user, "", True

    # An assertion never REACTIVATES an account an administrator switched off, and
    # never strips the role from the last active administrator. Both would leave a
    # deployment that has to be repaired by hand.
    if not existing.active:
        _audit(conn, "auth.sso.denied",
               f"{existing.username} is deactivated and cannot sign in through SSO",
               level="warning", actor=existing.username)
        return None, "this account has been deactivated in OnTrak Sync", False

    wanted_role = role
    if existing.role == "ADMIN" and role != "ADMIN" and count_active_admins(conn) <= 1:
        wanted_role = "ADMIN"
        _audit(conn, "auth.sso.role.held",
               f"{existing.username} stays ADMIN — the last active administrator",
               level="warning", actor=existing.username)

    updated = update_user(
        conn, existing.id, email=claims.email,
        display_name=claims.name or existing.display_name,
        role=wanted_role, external_id=claims.subject,
    )
    if existing.role != wanted_role:
        _audit(conn, "auth.sso.role.change",
               f"{existing.username}: {existing.role} → {wanted_role}",
               actor=existing.username)
    elif matched is None:
        _audit(conn, "auth.sso.role.default",
               f"{existing.username} matched no group; role left as {existing.role}",
               level="warning", actor=existing.username)
    return (updated or existing), "", False


def _unique_username(conn, wanted: str) -> str:
    """A username that is free, derived from the provider's suggestion."""
    base = "".join(ch for ch in (wanted or "user").lower()
                   if ch.isalnum() or ch in "._-") or "user"
    base = base.strip("._-") or "user"
    candidate = base
    suffix = 1
    while get_user(conn, username=candidate) is not None:
        suffix += 1
        candidate = f"{base}{suffix}"
        if suffix > 500:
            return f"{base}-{secrets.token_hex(3)}"
    return candidate


# ── audit ────────────────────────────────────────────────────────────────────
# Audit lives HERE and not in the API layer on purpose: a rule that says "every
# privileged action is audited" only holds if the privileged functions are the
# ones that write the record. The API cannot forget a call it never makes.
def _audit(conn, action: str, message: str, *, level: str = "info",
           actor: str | None = None) -> None:
    try:
        conn.execute(
            "INSERT INTO events (ts, level, actor, message) VALUES (?,?,?,?)",
            (_now(), level, actor, f"{action} — {message}"),
        )
        conn.commit()
    except Exception:  # never let the audit sink break a sign-in
        pass


def audit(conn, action: str, message: str, *, level: str = "info",
          actor: str | None = None) -> None:
    """Public alias, for the API paths that change something."""
    _audit(conn, action, message, level=level, actor=actor)


def _safe(value: str) -> str:
    """A username as it may appear in a log line."""
    return (value or "").strip()[:64] or "(blank)"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── bootstrap ────────────────────────────────────────────────────────────────
def ensure_bootstrap_admin(conn, *, username: str = "admin", password: str = "",
                           email: str = "") -> tuple[User | None, str | None]:
    """Guarantee there is a way in on a fresh database.

    Returns `(user, generated_password_or_None)`. A generated password is returned
    so the caller can log it once: refusing to start would be worse than a
    documented first-run secret, because a service that is down cannot be the
    thing that hands you the credentials to bring it up.
    """
    if count_users(conn) > 0:
        return None, None
    generated: str | None = None
    if not password:
        generated = secrets.token_urlsafe(18)
        password = generated
    user = create_user(conn, username=username, password=password, role="ADMIN",
                       email=email or f"{username}@ontrak.local",
                       display_name=username)
    _audit(conn, "auth.bootstrap", f"created the first administrator account ({username})",
           actor=username)
    return user, generated
