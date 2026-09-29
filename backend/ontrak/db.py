"""Ontrak Sync — storage.

One SQLite file, because the entire estate's update state is a few thousand rows
and a database server would be a second thing to back up, monitor and fail.
SQLite also makes the whole system movable: the file *is* the history.

THE ONE DESIGN DECISION WORTH READING: `findings` IS THE UNIT OF TRUTH
---------------------------------------------------------------------
A scan does not store "what is installed on i2". It stores *differences*: one row
per (target, package) that is behind. That is smaller than the alternative, but
the reason is behavioural rather than size — a finding has a lifetime that a
package list does not. It has a first time it was seen, a time it was approved and
a time it was applied, and those are the questions the dashboard is actually
asked ("what is new since yesterday?", "did the Tuesday run do anything?", "how
long has this been pending?"). Re-deriving them from snapshots is possible and
was the first design; it made every query a diff and made "approved but not yet
applied" unrepresentable.

`status` is therefore the workflow, and it is deliberately small:

  pending   — detected, nothing done
  approved  — a person said apply this (the estate's default policy is
              detect-only, so nothing reaches `applied` without this step)
  applied   — it was installed, and `applied_at` says when
  failed    — the applier tried and something went wrong (`detail` says what)
  skipped   — a person said leave it alone; it is re-reported by a later scan,
              which is the point: skipping is per-run, not forever

A finding that is no longer detected is deleted by the next scan, except
`applied` rows, which are kept as history until pruning.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
    name        TEXT PRIMARY KEY,
    address     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'incus',
    ssh_user    TEXT NOT NULL DEFAULT 'root',
    reachable   INTEGER NOT NULL DEFAULT 0,
    os          TEXT,
    kernel      TEXT,
    container_count INTEGER NOT NULL DEFAULT 0,
    last_seen   TEXT,
    error       TEXT
);

-- A target is anything that can be out of date: an incus host itself, an incus
-- container, or a Docker container inside one. `kind` says which, and `ref` is how
-- to reach it (the incus name, the container name, or the image reference).
CREATE TABLE IF NOT EXISTS targets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    ref         TEXT,
    meta        TEXT,
    discovered_at TEXT,
    last_scanned_at TEXT,
    error       TEXT,
    UNIQUE (host, kind, name)
);

CREATE TABLE IF NOT EXISTS findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    manager     TEXT NOT NULL,
    package     TEXT NOT NULL,
    current     TEXT,
    candidate   TEXT,
    security    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    first_seen  TEXT,
    last_seen   TEXT,
    applied_at  TEXT,
    detail      TEXT,
    UNIQUE (target_id, manager, package)
);

-- Deliberately NO extra unique index here. The table's own UNIQUE
-- (target_id, manager, package) is what makes a finding one row rather than a
-- log, and indexing `status` as well would forbid the two things this schema
-- needs: a history of applied rows, and the same package going back to `pending`
-- when a newer version appears.
CREATE INDEX IF NOT EXISTS findings_by_target ON findings (target_id);
CREATE INDEX IF NOT EXISTS findings_by_status ON findings (status);

CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    cron        TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'detect',
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    findings    INTEGER NOT NULL DEFAULT 0,
    applied     INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    summary     TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info',
    target_id   INTEGER,
    run_id      INTEGER,
    actor       TEXT,
    message     TEXT NOT NULL
);

-- One key per operator-editable setting, JSON-encoded. A table rather than a file
-- because the settings form and the scheduler both read this and the scheduler
-- runs on its own thread: SQLite's locking makes a write from the API visible to
-- the next tick without a reload path, which a config file would need.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
);

-- ── identity ─────────────────────────────────────────────────────────────────
-- WHO IS ALLOWED IN.
--
-- The username is `COLLATE NOCASE` unique: a person typing `Sysadmin` at 3am is
-- the same person, and two rows that differ only in case would be two accounts
-- with two different roles, which is how somebody ends up with access nobody
-- remembers granting.
--
-- `password_hash` is nullable on purpose. An account with no digest is an
-- SSO-only account: the local form cannot succeed for it even if the database
-- leaked, because there is nothing to compare against.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email         TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'STUDENT',
    active        INTEGER NOT NULL DEFAULT 1,
    external_id   TEXT,
    password_hash TEXT,
    created_at    TEXT,
    updated_at    TEXT,
    last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS users_by_external_id
    ON users (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_by_email ON users (email COLLATE NOCASE);

-- Sessions are rows, not signatures. `token_hash` is the SHA-256 of a 256-bit
-- random token, so the table is useless to whoever reads it and a sign-out or a
-- deactivation takes effect on the next request rather than at expiry.
CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT,
    user_agent   TEXT,
    address      TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);

-- Failed sign-ins, keyed on the username AND on the source address. Two rows per
-- failure because they stop different attacks: the first stops a password being
-- guessed, the second stops one source walking a list of names.
CREATE TABLE IF NOT EXISTS login_failures (
    key             TEXT PRIMARY KEY,
    count           INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT
);

-- The remote digest of an image reference, as last successfully fetched. Only
-- SUCCESSFUL lookups are stored — a rate limit, a refused token or a timeout is not
-- a statement about the image, and caching one would turn "could not ask" into "up
-- to date" for as long as the row lived.
--
-- `checked_at` is epoch seconds rather than the ISO text the other tables use,
-- because the only question ever asked of it is an age comparison.
CREATE TABLE IF NOT EXISTS digests (
    key        TEXT PRIMARY KEY,
    digest     TEXT NOT NULL,
    checked_at INTEGER NOT NULL
);
"""


def utcnow() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def connect(path: str | Path) -> sqlite3.Connection:
    """Open the database, creating its directory if needed.

    `check_same_thread=False` because FastAPI serves requests from a threadpool and
    the scheduler ticks from its own thread. SQLite's own locking is what actually
    serialises them, and every write here is short; the alternative — a connection
    per request and a pool to manage — buys nothing at this scale.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


# Columns added after a database was first created. `CREATE TABLE IF NOT EXISTS`
# will not add them, and the deployed SQLite file IS the estate's history, so a
# migration here has to be additive and idempotent rather than a schema reset.
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    # (table, column, definition)
    ("events", "actor", "TEXT"),
)


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, definition in _ADDED_COLUMNS:
        existing = {row["name"] for row in
                    conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


# ── hosts ────────────────────────────────────────────────────────────────────
def upsert_host(conn, *, name, address, kind, ssh_user, reachable, os_name=None,
                kernel=None, container_count=0, error=None) -> None:
    conn.execute(
        """
        INSERT INTO hosts (name, address, kind, ssh_user, reachable, os, kernel,
                           container_count, last_seen, error)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET
            address=excluded.address, kind=excluded.kind, ssh_user=excluded.ssh_user,
            reachable=excluded.reachable, os=excluded.os, kernel=excluded.kernel,
            container_count=excluded.container_count, last_seen=excluded.last_seen,
            error=excluded.error
        """,
        (name, address, kind, ssh_user, int(bool(reachable)), os_name, kernel,
         container_count, utcnow(), error),
    )


# ── targets ──────────────────────────────────────────────────────────────────
def ensure_target(conn, *, host, kind, name, ref=None, meta=None) -> int:
    """Return the target's id, creating it if this is the first time it is seen."""
    conn.execute(
        """
        INSERT INTO targets (host, kind, name, ref, meta, discovered_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(host, kind, name) DO UPDATE SET
            ref=excluded.ref,
            meta=COALESCE(excluded.meta, targets.meta),
            error=NULL
        """,
        (host, kind, name, ref, json.dumps(meta) if meta is not None else None, utcnow()),
    )
    row = conn.execute(
        "SELECT id FROM targets WHERE host=? AND kind=? AND name=?", (host, kind, name)
    ).fetchone()
    return int(row["id"])


def touch_target(conn, target_id: int, *, error: str | None = None) -> None:
    conn.execute(
        "UPDATE targets SET last_scanned_at=?, error=? WHERE id=?",
        (utcnow(), error, target_id),
    )


# ── findings ─────────────────────────────────────────────────────────────────
def record_finding(conn, *, target_id, manager, package, current=None, candidate=None,
                   security=False, detail=None) -> None:
    """Insert or refresh a finding — nearly always WITHOUT touching its status.

    The status is preserved because a scan runs every few hours and re-detects the
    same fifty packages; if it reset `status`, an approval would be undone by the
    next scan and nothing could ever be applied.

    THE ONE EXCEPTION IS A MOVED CANDIDATE, and it is a correctness fix rather
    than a nicety. After a package is applied the row is `applied`; when the next
    release appears the scan re-detects the *same* package with a *different*
    candidate, and a status-preserving upsert would leave it `applied` forever —
    the package would be invisible to every future apply. So a candidate that
    moved clears `applied` back to `pending`: the thing that was applied is not
    the thing that is now on offer.
    """
    conn.execute(
        """
        INSERT INTO findings (target_id, manager, package, current, candidate,
                              security, status, first_seen, last_seen, detail)
        VALUES (?,?,?,?,?,?,'pending',?,?,?)
        ON CONFLICT(target_id, manager, package) DO UPDATE SET
            current=excluded.current,
            candidate=excluded.candidate,
            security=excluded.security,
            last_seen=excluded.last_seen,
            detail=COALESCE(excluded.detail, findings.detail),
            status=CASE
                WHEN findings.status='applied'
                     AND IFNULL(excluded.candidate,'') != IFNULL(findings.candidate,'')
                THEN 'pending'
                ELSE findings.status
            END,
            applied_at=CASE
                WHEN findings.status='applied'
                     AND IFNULL(excluded.candidate,'') != IFNULL(findings.candidate,'')
                THEN NULL
                ELSE findings.applied_at
            END
        """,
        (target_id, manager, package, current, candidate, int(bool(security)),
         utcnow(), utcnow(), detail),
    )


def expire_findings(conn, target_ids: list[int], seen: set[tuple[int, str, str]],
                    protect: set[tuple[int, str, str]] | None = None) -> int:
    """Delete findings this scan did not re-detect, except applied history.

    This is what makes the dashboard honest: a package that got updated by hand (or
    by another tool) stops being reported without anyone marking it done. A finding
    whose candidate moved (same package, newer version) is *kept*, because the key
    is the package, not the version.

    `seen` is "this scan reached a verdict about it", and only two states belong in
    it: it needs an update (so a finding exists), or it is current (so anything on
    record should go). `protect` is the third state — the probe could not judge,
    because a registry refused a token or an image has no remote — and those rows
    are left exactly as they are. Deleting them would report an unverifiable
    package as fixed, which is the one direction of error this whole design exists
    to avoid.
    """
    protect = protect or set()
    removed = 0
    for target_id in target_ids:
        rows = conn.execute(
            "SELECT id, manager, package FROM findings WHERE target_id=? AND status != 'applied'",
            (target_id,),
        ).fetchall()
        for row in rows:
            key = (target_id, row["manager"], row["package"])
            if key in seen or key in protect:
                continue
            conn.execute("DELETE FROM findings WHERE id=?", (row["id"],))
            removed += 1
    return removed


def set_status(conn, finding_ids: list[int], status: str, detail: str | None = None) -> int:
    if not finding_ids:
        return 0
    marks = ",".join("?" for _ in finding_ids)
    applied = utcnow() if status == "applied" else None
    cur = conn.execute(
        f"UPDATE findings SET status=?, applied_at=COALESCE(?, applied_at), detail=COALESCE(?, detail)"
        f" WHERE id IN ({marks})",
        [status, applied, detail, *finding_ids],
    )
    return cur.rowcount


# ── runs, events, schedules ──────────────────────────────────────────────────
def start_run(conn, kind: str, trigger: str) -> int:
    cur = conn.execute(
        "INSERT INTO runs (kind, trigger, started_at) VALUES (?,?,?)",
        (kind, trigger, utcnow()),
    )
    return int(cur.lastrowid)


def finish_run(conn, run_id: int, *, status: str, findings: int = 0, applied: int = 0,
               failed: int = 0, summary: str = "") -> None:
    conn.execute(
        "UPDATE runs SET finished_at=?, status=?, findings=?, applied=?, failed=?, summary=?"
        " WHERE id=?",
        (utcnow(), status, findings, applied, failed, summary, run_id),
    )


def log(conn, message: str, *, level: str = "info", target_id: int | None = None,
        run_id: int | None = None, actor: str | None = None) -> None:
    """Append one line to the event log.

    `actor` is who caused it, when there is a person to name. It is a column and
    not a prefix in the message because "show me everything alice did" has to be a
    query, not a LIKE that also matches a host called alice.
    """
    conn.execute(
        "INSERT INTO events (ts, level, target_id, run_id, actor, message)"
        " VALUES (?,?,?,?,?,?)",
        (utcnow(), level, target_id, run_id, actor, message),
    )


# ── settings ─────────────────────────────────────────────────────────────────
def get_setting(conn, key: str, default=None):
    """Read one JSON setting, falling back to `default`.

    An unreadable value returns the default rather than raising: a hand-edited
    database should not stop the service from starting, and the settings form
    rewrites the whole object on save anyway.
    """
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return default


def set_setting(conn, key: str, value) -> None:
    conn.execute(
        """
        INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        """,
        (key, json.dumps(value), utcnow()),
    )


# ── the remote-digest cache ─────────────────────────────────────────────────
# WHY THIS EXISTS. Deciding whether an image is behind means asking its registry what
# the tag points at, and for Docker Hub that question is answered anonymously out of
# a budget of about a hundred requests per six hours per address. A scan asks it once
# per image — fifty to a hundred in this estate — so two scans in an afternoon spend
# the whole budget on the same answers, and the estate's image *pulls* are the things
# that then fail. A tag's digest does not change between two scans an hour apart, so
# the second ask buys nothing; this remembers the first.
#
# It is a cache and not a lock: the TTL is short enough that a republished tag is
# picked up by the next scheduled run, and setting the TTL to 0 turns it off and
# restores the old behaviour for anyone who would rather spend the requests.
DIGEST_TTL_SECONDS = 6 * 3600


def get_digest(conn, key: str, *, ttl_seconds: int = DIGEST_TTL_SECONDS,
               now: float | None = None) -> str | None:
    """The cached remote digest for `key`, or None if it is absent or stale."""
    if ttl_seconds <= 0:
        return None
    row = conn.execute("SELECT digest, checked_at FROM digests WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    moment = time.time() if now is None else now
    if moment - row["checked_at"] > ttl_seconds:
        return None
    return row["digest"]


def set_digest(conn, key: str, digest: str, *, now: float | None = None) -> None:
    conn.execute(
        """
        INSERT INTO digests (key, digest, checked_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET digest=excluded.digest, checked_at=excluded.checked_at
        """,
        (key, digest, time.time() if now is None else now),
    )


# ── queries the dashboard runs ───────────────────────────────────────────────
def list_hosts(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT h.*,
               (SELECT COUNT(*) FROM targets t WHERE t.host=h.name)                  AS targets,
               (SELECT COUNT(*) FROM targets t WHERE t.host=h.name
                  AND t.last_scanned_at IS NULL)                                     AS unscanned,
               (SELECT COUNT(*) FROM findings f JOIN targets t ON t.id=f.target_id
                 WHERE t.host=h.name AND f.status='pending')                          AS pending,
               (SELECT COUNT(*) FROM findings f JOIN targets t ON t.id=f.target_id
                 WHERE t.host=h.name AND f.status='pending' AND f.security=1)          AS security,
               (SELECT COUNT(*) FROM findings f JOIN targets t ON t.id=f.target_id
                 WHERE t.host=h.name AND f.status='failed')                            AS failed
          FROM hosts h ORDER BY h.name
        """
    ).fetchall()
    return [dict(r) for r in rows]


def list_targets(conn, host: str | None = None) -> list[dict]:
    """Targets with their finding counts.

    The counts are computed here rather than by the caller because "this target has
    no findings" and "this target was never scanned" both render as zero, and the
    coverage column on the Hosts page is only meaningful if it can tell them apart —
    which it does via `last_scanned_at`, read from the same row.
    """
    clause = "WHERE t.host=?" if host else ""
    rows = conn.execute(
        f"""
        SELECT t.*,
               (SELECT COUNT(*) FROM findings f WHERE f.target_id=t.id
                  AND f.status='pending')                                  AS pending,
               (SELECT COUNT(*) FROM findings f WHERE f.target_id=t.id
                  AND f.status='pending' AND f.security=1)                 AS security,
               (SELECT COUNT(*) FROM findings f WHERE f.target_id=t.id
                  AND f.status='approved')                                 AS approved,
               (SELECT COUNT(*) FROM findings f WHERE f.target_id=t.id
                  AND f.status='applied')                                  AS applied,
               (SELECT COUNT(*) FROM findings f WHERE f.target_id=t.id
                  AND f.status='failed')                                   AS failed
          FROM targets t {clause}
         ORDER BY t.host, t.kind DESC, t.name
        """,
        ((host,) if host else ()),
    ).fetchall()
    return [dict(r) for r in rows]


def list_findings(conn, *, status: str | None = None, manager: str | None = None,
                  host: str | None = None, security_only: bool = False,
                  target_id: int | None = None, limit: int = 2000) -> list[dict]:
    """Findings joined to their target, newest security first.

    The ordering is a product decision, not an arbitrary one: security updates
    first, then by host, so the top of the list is what an operator should look at
    if they read nothing else.
    """
    where, params = [], []
    if status:
        where.append("f.status=?")
        params.append(status)
    if manager:
        where.append("f.manager=?")
        params.append(manager)
    if host:
        where.append("t.host=?")
        params.append(host)
    if target_id is not None:
        where.append("f.target_id=?")
        params.append(target_id)
    if security_only:
        where.append("f.security=1")
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = conn.execute(
        f"""
        SELECT f.id, f.manager, f.package, f.current, f.candidate, f.security,
               f.status, f.first_seen, f.last_seen, f.applied_at, f.detail,
               t.id AS target_id, t.host, t.kind, t.name AS target, t.error AS target_error
          FROM findings f JOIN targets t ON t.id = f.target_id
          {clause}
         ORDER BY f.security DESC, t.host, t.name, f.manager, f.package
         LIMIT {int(limit)}
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def list_runs(conn, limit: int = 40) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def list_events(conn, limit: int = 200) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def upsert_schedule(conn, *, name: str, cron: str, mode: str, enabled: bool,
                    next_run_at: str | None = None) -> None:
    conn.execute(
        """
        INSERT INTO schedules (name, cron, mode, enabled, next_run_at, created_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET
            cron=excluded.cron, mode=excluded.mode, enabled=excluded.enabled,
            next_run_at=COALESCE(excluded.next_run_at, schedules.next_run_at)
        """,
        (name, cron, mode, int(bool(enabled)), next_run_at, utcnow()),
    )
