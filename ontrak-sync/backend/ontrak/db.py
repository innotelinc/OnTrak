"""Ontrak Sync — storage.

One SQLite file, because the entire Network's update state is a few thousand rows
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
  approved  — a person said apply this (the Network's default policy is
              detect-only, so nothing reaches `applied` without this step)
  applied   — it was installed, and `applied_at` says when
  failed    — the applier tried and something went wrong (`detail` says what)
  skipped   — a person said leave it alone; it is re-reported by a later scan,
              which is the point: skipping is per-run, not forever

A finding that is no longer detected is deleted by the next scan, except
`applied` rows, which are kept as history until pruning.
"""

from __future__ import annotations

import calendar
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
    error       TEXT,
    -- Whether the machine is waiting for a reboot, which packages asked for it,
    -- and when it was last asked. Kept beside `kernel` rather than inside `error`
    -- because "up to date but still booting the old kernel" is a real state and not
    -- a fault — see `scanners.parse_reboot_state`. `reboot_known` is what keeps
    -- "asked and clear" apart from "could not ask"; `reboot_packages` is the
    -- package list, one name per line, exactly as the host printed it.
    reboot_known    INTEGER NOT NULL DEFAULT 0,
    reboot_required INTEGER NOT NULL DEFAULT 0,
    reboot_packages TEXT,
    reboot_checked_at TEXT
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
    -- 1 when at least one manager actually produced a verdict about this target on
    -- the last scan, 0 when every manager failed to look. It is the durable form of
    -- `TargetReport.scanned`, and the dashboard's `unknown` count reads it: a target
    -- that was touched by a scan which could not read it must not age into reading
    -- as merely unscanned, which is how a stopped instance passes for a patched one.
    last_scanned_ok INTEGER,
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

-- A `docker login` already made on a host's Docker daemon. The login is itself a
-- request against the registry, and the daemon keeps the credential in its own
-- config until a logout or a reset — so re-authenticating on every scan spends a
-- request to re-establish something that is still in place. This remembers when it
-- was last done, so a scan can skip it until the record is old (see
-- `registry_login_is_fresh`). Keyed per container because each incus container runs
-- its own daemon, and like `digests` the timestamp is epoch seconds because the only
-- question asked of it is an age comparison.
CREATE TABLE IF NOT EXISTS registry_logins (
    host         TEXT NOT NULL,
    container    TEXT NOT NULL,
    registry     TEXT NOT NULL,
    logged_in_at INTEGER NOT NULL,
    PRIMARY KEY (host, container, registry)
);

-- What the registry would not judge, per host, per scan, and why. In a run report
-- these failures are one sentence; here a *rate limit* (the registry is throttling
-- this address) is kept apart from a refused read (a private or absent repository),
-- because only one of them clears on its own — and which one an operator is looking
-- at is a pattern, not a single scan's line. Pruned to the newest
-- `REGISTRY_REFUSAL_KEEP_RUNS` runs as it is written, so it is a window on the recent
-- past rather than a log that grows forever.
CREATE TABLE IF NOT EXISTS registry_refusals (
    run_id      INTEGER NOT NULL,
    host        TEXT NOT NULL,
    cause       TEXT NOT NULL,
    count       INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, host, cause)
);

-- THE REMIT: the containers this deployment has been *given*. Everything else in this
-- database is a record of what was seen; this table is the only list that says what the
-- unattended roll in `rollout.py` may restart. It is keyed on (host, container, ref)
-- rather than on the container name because one host runs several incus containers with
-- their own Docker daemons, and one image can legitimately run twice inside one of them;
-- a remit that could not tell those apart would roll both. An empty table is the shipped
-- posture and means "roll nothing", which is why "whole-network protection" here is a
-- list somebody wrote rather than a default.
CREATE TABLE IF NOT EXISTS rollout_targets (
    host              TEXT NOT NULL,
    container         TEXT NOT NULL DEFAULT '',
    ref               TEXT NOT NULL,
    project           TEXT NOT NULL DEFAULT '',
    service           TEXT NOT NULL DEFAULT '',
    auto              INTEGER NOT NULL DEFAULT 1,
    window_start_hour INTEGER,
    window_end_hour   INTEGER,
    cooldown_hours    INTEGER,
    note              TEXT NOT NULL DEFAULT '',
    created_by        TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    PRIMARY KEY (host, container, ref)
);

-- One row per attempted roll: what it was before, what it was asked to become, and how
-- it ended. Three things depend on this table existing rather than on a log line:
--   * the cooldown, which is "how long since this container was last rolled" and has to
--     survive a restart of this service;
--   * the block after a failed roll, which is the difference between a roll that failed
--     once and a container restarted every night forever;
--   * the rollback, which needs the image id that was in place *before*, recorded at the
--     moment it was captured rather than reconstructed from a `docker image ls` later.
CREATE TABLE IF NOT EXISTS container_rolls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER,
    host          TEXT NOT NULL,
    container     TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL DEFAULT '',
    ref           TEXT NOT NULL,
    project       TEXT NOT NULL DEFAULT '',
    service       TEXT NOT NULL DEFAULT '',
    from_image_id TEXT NOT NULL DEFAULT '',
    to_image_id   TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    trigger       TEXT NOT NULL DEFAULT '',
    actor         TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    duration_ms   INTEGER,
    cleared_at    TEXT
);

CREATE INDEX IF NOT EXISTS rolls_by_target
    ON container_rolls (host, container, ref, started_at DESC);
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
# will not add them, and the deployed SQLite file IS the Network's history, so a
# migration here has to be additive and idempotent rather than a schema reset.
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    # (table, column, definition)
    ("events", "actor", "TEXT"),
    # 1 when a manager produced a verdict about a target on the last scan, 0 when
    # every manager failed to look. The dashboard's `unknown` count reads it, and it
    # exists because a target that was touched by a scan which could not read it must
    # not age into reading as merely unscanned. See `touch_target`.
    ("targets", "last_scanned_ok", "INTEGER"),
    # A pending reboot is a fact about a host that no manager reports, because every
    # manager reports the machine current. These four are additive and idempotent
    # like the rest of this list; `reboot_known` defaults to 0, so a database
    # written before them reads as "not asked yet" rather than as "nothing pending".
    ("hosts", "reboot_known", "INTEGER NOT NULL DEFAULT 0"),
    ("hosts", "reboot_required", "INTEGER NOT NULL DEFAULT 0"),
    ("hosts", "reboot_packages", "TEXT"),
    ("hosts", "reboot_checked_at", "TEXT"),
    # How long the reboot has stood. A verdict that has been the same answer for a
    # week is a maintenance window somebody missed; one that appeared with this
    # scan is the machine working as intended. `reboot_since` opens at the first
    # scan that reports it and closes only on an explicit clear — never on a probe
    # that could not read the host, because "I could not ask" is not evidence the
    # machine restarted. `reboot_scans` counts the scans that have seen it, which is
    # what tells a daily probe apart from a weekly one at the same age.
    ("hosts", "reboot_since", "TEXT"),
    ("hosts", "reboot_scans", "INTEGER NOT NULL DEFAULT 0"),
)


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, definition in _ADDED_COLUMNS:
        existing = {row["name"] for row in
                    conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            if (table, column) == ("targets", "last_scanned_ok"):
                # Backfill the rows that already exist. Before this column the only
                # durable trace of a look that failed was `error`, so a target that
                # was scanned and carries one is recorded as not-looked. That is a
                # reconstruction, and the one case it gets wrong is a target read
                # *partially* — some managers answered, some could not — which lands
                # on the unknown side: the safe side, and where the run report
                # already puts it.
                conn.execute(
                    """
                    UPDATE targets SET last_scanned_ok =
                        CASE WHEN error IS NULL THEN 1 ELSE 0 END
                     WHERE last_scanned_at IS NOT NULL
                    """
                )
            elif (table, column) == ("hosts", "reboot_scans"):
                # A reboot already on record has no opening instant to recover: the
                # only evidence is the last time it was asked about, so the window
                # starts there. Claiming an earlier moment would be inventing history,
                # and the row is counted as seen at least once, because it is.
                conn.execute(
                    """
                    UPDATE hosts
                       SET reboot_since = COALESCE(reboot_since, reboot_checked_at),
                           reboot_scans = CASE WHEN reboot_required = 1 THEN 1 ELSE 0 END
                     WHERE reboot_required = 1
                    """
                )


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


def reboot_window(*, since: str | None, scans: int, state, now: str) -> tuple[str | None, int]:
    """The reboot window after one answer: `(when it began, how many scans have seen it)`.

    Pure, so the three transitions are testable without a clock or a database, and
    there are exactly three of them:

    * **Required** opens the window, or leaves it where it is. The instant does not
      move on a second report — the question a person is asking is *how long has this
      been true*, and an answer that resets to "just now" every scan is no answer at
      all. The scan count does advance, so two probes a minute apart are not mistaken
      for the same evidence as one probe on Monday and one on Friday.
    * **Clear** closes it. That is the only thing that may, because it is the only
      answer that says the machine went down and came back.
    * **Not known** changes neither. A probe that answered in a form this code does not
      understand has said nothing about the machine, and reading it as a clear would
      reset the age of a reboot nobody restarted — the same rule
      `expire_findings(..., protect=...)` applies to a finding.
    """
    if not state.known:
        return since, scans
    if not state.required:
        return None, 0
    return (since or now), scans + 1


def record_reboot_state(conn, *, name: str, state) -> None:
    """Record whether a host is waiting for a reboot, and for how long it has been.

    Called only when the host actually answered. A probe that timed out or failed
    leaves the previous row alone, and that is deliberate: "I could not ask" is not
    evidence that a machine stopped needing the reboot it reported yesterday, which
    is the same rule `expire_findings(..., protect=...)` applies to a finding. A
    state that could not be read *is* recorded as not-known, so the dashboard can
    tell a host that was asked from one that never has been.

    The window itself is decided by `reboot_window`; this only reads the row it is
    about to replace, so the transition has exactly one home.

    An UPDATE rather than an upsert: the host row is written by `upsert_host` in the
    same scan, moments earlier, and a function that could conjure a host row from a
    reboot answer would be a second, weaker writer of the hosts table.
    """
    row = conn.execute(
        "SELECT reboot_since, reboot_scans FROM hosts WHERE name=?", (name,)
    ).fetchone()
    if row is None:
        return

    now = utcnow()
    since, scans = reboot_window(
        since=row["reboot_since"],
        scans=int(row["reboot_scans"] or 0),
        state=state,
        now=now,
    )
    conn.execute(
        """
        UPDATE hosts
           SET reboot_known=?, reboot_required=?, reboot_packages=?, reboot_checked_at=?,
               reboot_since=?, reboot_scans=?
         WHERE name=?
        """,
        (int(bool(state.known)), int(bool(state.required)),
         "\n".join(state.packages) or None, now, since, scans, name),
    )


def reboot_age_seconds(since: str | None, *, now: str) -> int | None:
    """Whole seconds a pending reboot has been waiting, or `None` when unreadable.

    A window with no readable opening instant — a row written before the column
    existed, or a hand-edited file — has no age to state, and is reported as unknown
    rather than as zero: "waiting 0s" reads as "this was just found", which is the
    opposite of what a row without an instant actually tells you.
    """
    if not since:
        return None
    try:
        opened = calendar.timegm(time.strptime(since, "%Y-%m-%dT%H:%M:%SZ"))
        current = calendar.timegm(time.strptime(now, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return None
    return max(0, current - opened)


def reboot_run_note(hosts, *, now: str | None = None) -> str:
    """The reboot half of a run's summary line, or "" when nobody is waiting.

    The age is what turns a pending reboot into a decision somebody has to make: a
    host that reported it this morning is working as intended, one that has been
    waiting since the last patch window is a window nobody took. The run report is
    where that decision is looked for, so the count and the oldest age are written
    beside the finding counts rather than living only as a pill on the hosts page.

    The age is stated only from a whole day up, matching what the hosts page shows:
    "oldest waiting 0d" on the scan that just found it is noise. A window with no
    readable instant is counted but does not drag the oldest age in either direction
    — the count of hosts is a fact, and the oldest age is a separate one.
    """
    waiting = [h for h in hosts if int(h.get("reboot_required") or 0)]
    if not waiting:
        return ""
    ages = [reboot_age_seconds(h.get("reboot_since"), now=now or utcnow()) for h in waiting]
    known = [age for age in ages if age is not None]
    note = f"{len(waiting)} host(s) waiting to restart"
    days = max(known, default=0) // 86_400
    if days >= 1:
        note += f", oldest waiting {days}d"
    return note


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


def prune_targets(conn, *, host: str, kind: str, present: set[str]) -> list[str]:
    """Delete `kind` targets on `host` whose name is not in `present`.

    A container that has been removed leaves a target row — and its findings —
    behind forever, because a scan only ever visits what `incus list` still reports.
    Those findings can never be re-detected, applied or expired, so they sit red for
    a machine that is not there: the dashboard counts a host that no longer exists
    as one that is out of date. This drops them and returns the names removed, for
    the run log.

    Findings are deleted explicitly rather than left to `ON DELETE CASCADE`, so the
    cleanup does not depend on the connection having foreign keys enabled.
    """
    rows = conn.execute(
        "SELECT id, name FROM targets WHERE host=? AND kind=?", (host, kind)
    ).fetchall()
    removed: list[str] = []
    for row in rows:
        if row["name"] in present:
            continue
        conn.execute("DELETE FROM findings WHERE target_id=?", (row["id"],))
        conn.execute("DELETE FROM targets WHERE id=?", (row["id"],))
        removed.append(row["name"])
    return removed


def touch_target(conn, target_id: int, *, error: str | None = None,
                 looked: bool = False) -> None:
    """Record that a scan finished with one target, and what it managed to say.

    `looked` is `TargetReport.scanned` — true only when a manager produced a real
    verdict — and it is stored rather than derived, because by the next scan the
    error text has been overwritten and there is nothing left to derive it from:
    "I read it and it is clean" and "I could not read it" are both no findings and
    no error, and the dashboard has to tell them apart for weeks, not for one run.

    It defaults to false on purpose. A caller that forgets it reports a target as
    unknown, which costs an operator a second look; the other default would report
    a machine nobody could read as up to date.
    """
    conn.execute(
        "UPDATE targets SET last_scanned_at=?, error=?, last_scanned_ok=? WHERE id=?",
        (utcnow(), error, int(bool(looked)), target_id),
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

    `detail` IS TREATED THE SAME WAY ON A FAILED ROW, for the same reason. On every
    other row this write is the scan's detection note — the archive a package came
    from, "newer image in registry" — and it is meant to be refreshed each run. On a
    failed row it is the *reason the apply failed*, written by `set_status`, and a
    scan replacing it with "newer image in registry" is the dashboard forgetting
    why anything is red between one apply and the next. Eighteen findings read that
    way at the start of the last investigation, with the real messages sitting in
    one apply run's events and nowhere else.
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
            detail=CASE
                WHEN findings.status='failed' THEN findings.detail
                ELSE COALESCE(excluded.detail, findings.detail)
            END,
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


def stale_failures(conn, *, older_than_seconds: int, now: float | None = None) -> list[dict]:
    """Failed findings that have been red for longer than the threshold.

    The clock runs from `first_seen`, which is the honest answer to "how long has
    this been broken": `last_seen` is refreshed by every scan, so a failure that is
    happily re-detected each run would never look old, and `failed_at` does not
    exist (the failure may have been recorded several times). A failure that is
    still here after the threshold is not a transient retry, and this is the query
    that lets the reconcile report say so without a person trawling the Findings
    page — see `reconcile.py`.

    The join to `targets` is not decoration: the report names *where* the failure
    is, and a manual container on a far host is exactly the case this exists to
    surface.
    """
    moment = time.time() if now is None else now
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(moment - older_than_seconds))
    rows = conn.execute(
        """
        SELECT f.id, f.manager, f.package, f.current, f.candidate, f.detail,
               f.first_seen, f.last_seen,
               t.id AS target_id, t.host, t.kind, t.name AS target
          FROM findings f JOIN targets t ON t.id = f.target_id
         WHERE f.status='failed' AND f.first_seen <= ?
         ORDER BY f.first_seen, t.host, t.name
        """,
        (cutoff,),
    ).fetchall()
    return [dict(r) for r in rows]


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
# per image — fifty to a hundred in this Network — so two scans in an afternoon spend
# the whole budget on the same answers, and the Network's image *pulls* are the things
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


# ── the registry-login record ────────────────────────────────────────────────
# WHY THIS EXISTS. Authenticating a registry is the other half of not sharing
# Docker Hub's anonymous budget (see `digests` above for the cache half). But a
# login is *itself* a request against the registry, and the daemon keeps the
# credential in its own config — so a scan that logs in on every pass spends a
# request to establish what is already established. This records when each
# (host, container, registry) was last logged into, and the scan skips the login
# while that record is fresh. The apply path authenticates unconditionally, so a
# rotated token is still caught the moment a pull needs it, and its success is
# recorded here for the scans that follow.
def registry_login_is_fresh(conn, *, host: str, container: str, registry: str,
                            ttl_seconds: int, now: float | None = None) -> bool:
    """True when this (host, container, registry) was logged into within the TTL.

    A TTL of 0 (or less) means "never fresh", which restores the old behaviour of
    logging in on every scan — the same off switch `get_digest` has.
    """
    if ttl_seconds <= 0:
        return False
    row = conn.execute(
        "SELECT logged_in_at FROM registry_logins"
        " WHERE host=? AND container=? AND registry=?",
        (host, container, registry),
    ).fetchone()
    if row is None:
        return False
    moment = time.time() if now is None else now
    return moment - row["logged_in_at"] <= ttl_seconds


def record_registry_login(conn, *, host: str, container: str, registry: str,
                          now: float | None = None) -> None:
    """Note that this (host, container, registry) is authenticated as of now."""
    conn.execute(
        """
        INSERT INTO registry_logins (host, container, registry, logged_in_at)
        VALUES (?,?,?,?)
        ON CONFLICT(host, container, registry)
        DO UPDATE SET logged_in_at=excluded.logged_in_at
        """,
        (host, container, registry, time.time() if now is None else now),
    )


# ── queries the dashboard runs ───────────────────────────────────────────────
def list_hosts(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT h.*,
               (SELECT COUNT(*) FROM targets t WHERE t.host=h.name)                  AS targets,
               (SELECT COUNT(*) FROM targets t WHERE t.host=h.name
                  AND (t.last_scanned_at IS NULL
                       OR COALESCE(t.last_scanned_ok,0)=0))                          AS unscanned,
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


# How many runs of registry-refusal history to keep — enough to see a rate limit come
# and go, which is the only question the table answers that the run report cannot.
REGISTRY_REFUSAL_KEEP_RUNS = 20


def record_registry_refusals(conn, *, run_id: int, host: str, counts: dict[str, int],
                             keep_runs: int = REGISTRY_REFUSAL_KEEP_RUNS) -> None:
    """Record what the registry would not judge for one host on one scan.

    One row per cause with a non-zero count, and nothing at all for a host the registry
    answered about completely: an empty table then means "nothing was refused", which a
    run that would have written here — and did not — distinguishes from "nobody looked".
    A cause is a word from `scan._registry_failure` (`rate-limited`, `unauthorized`,
    `not-found`), stored verbatim, so the dashboard names failures in the same words
    the run report does.
    """
    positive = {cause: int(count) for cause, count in counts.items() if int(count) > 0}
    if not positive:
        return
    now = utcnow()
    for cause, count in positive.items():
        conn.execute(
            """
            INSERT INTO registry_refusals (run_id, host, cause, count, recorded_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(run_id, host, cause) DO UPDATE SET
                count=excluded.count, recorded_at=excluded.recorded_at
            """,
            (run_id, host, cause, count, now),
        )
    cutoff = run_id - max(1, keep_runs)
    if cutoff > 0:
        conn.execute("DELETE FROM registry_refusals WHERE run_id <= ?", (cutoff,))


def registry_refusal_summary(conn, *, runs: int = REGISTRY_REFUSAL_KEEP_RUNS) -> dict[str, dict]:
    """Per host: what its newest scan could not judge, and how that has moved.

    `latest` is the most recent scan that recorded anything for that host, keyed by
    cause. `rate_limited_runs` is how many scans inside the stored window saw at least
    one rate-limited image, which is the half a single scan cannot show: one refusal
    could be anything, but a host the registry throttles on every scan is a capacity
    problem, and only a window tells the two apart.

    `series` is that window as a *shape* rather than a count — one point per stored run,
    oldest first, each carrying the run's total refusals and how many of them were
    throttles. It is aligned to the window of runs this table remembers as a whole, not
    to the runs the host happens to appear in, so a scan that refused nothing for a host
    reads as a zero rather than as a missing bar and the bars keep their spacing. A host
    that was not scanned at all also reads as zero — the same word the dashboard already
    uses for "nothing refused" — and the target rows are what say a host was skipped.
    """
    rows = conn.execute(
        "SELECT run_id, host, cause, count FROM registry_refusals ORDER BY run_id ASC"
    ).fetchall()
    if not rows:
        return {}
    window = sorted({int(row["run_id"]) for row in rows})[-max(1, runs):]
    in_window = set(window)
    # (host, run) -> {total, rate_limited}, so `series` can be built run by run at the end.
    per_run: dict[tuple[str, int], dict[str, int]] = {}
    summary: dict[str, dict] = {}
    for row in rows:
        host = str(row["host"])
        run = int(row["run_id"])
        cause = str(row["cause"])
        count = int(row["count"])
        entry = summary.setdefault(host, {
            "latest": {}, "latest_run": 0, "rate_limited_runs": 0, "window": len(window),
        })
        if run > entry["latest_run"]:
            entry["latest_run"] = run
            entry["latest"] = {}
        entry["latest"][cause] = count
        if cause == "rate-limited":
            entry["rate_limited_runs"] += 1
        if run in in_window:
            bucket = per_run.setdefault((host, run), {"total": 0, "rate_limited": 0})
            bucket["total"] += count
            if cause == "rate-limited":
                bucket["rate_limited"] += count
    for host, entry in summary.items():
        entry["series"] = [
            {
                "run_id": run,
                "total": per_run.get((host, run), {}).get("total", 0),
                "rate_limited": per_run.get((host, run), {}).get("rate_limited", 0),
            }
            for run in window
        ]
    return summary


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


# ── the remit, and the rolls against it ──────────────────────────────────────
# The store side of `rollout.py`. Nothing here decides anything: the rails are pure
# and live there, and these four functions only move rows. Kept apart on purpose, so a
# test of a rail needs no database and a test of the store needs no policy.
def claim_rollout_target(conn, remit) -> None:
    """Record that this deployment has been given a container.

    Upsert on the (host, container, ref) key, so claiming a container twice — a form
    submitted twice, or the same container claimed after a host rebuild — updates the
    terms rather than refusing or duplicating. `created_by`/`created_at` are kept from
    the first claim, because who gave it up and when is the thing an incident review
    asks and a re-claim is not a new decision.
    """
    conn.execute(
        """
        INSERT INTO rollout_targets (host, container, ref, project, service, auto,
                                     window_start_hour, window_end_hour, cooldown_hours,
                                     note, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(host, container, ref) DO UPDATE SET
            project=excluded.project, service=excluded.service, auto=excluded.auto,
            window_start_hour=excluded.window_start_hour,
            window_end_hour=excluded.window_end_hour,
            cooldown_hours=excluded.cooldown_hours, note=excluded.note
        """,
        (remit.host, remit.container or "", remit.ref, remit.project or "",
         remit.service or "", int(bool(remit.auto)), remit.window_start_hour,
         remit.window_end_hour, remit.cooldown_hours, remit.note or "",
         remit.created_by or "", remit.created_at or utcnow()),
    )


def release_rollout_target(conn, *, host: str, container: str, ref: str) -> bool:
    """Give a container back. Returns whether anything was actually given back.

    A release that matched nothing is reported rather than silently succeeding: an
    operator who released the wrong row needs to know the row they meant is still
    being rolled.
    """
    cur = conn.execute(
        "DELETE FROM rollout_targets WHERE host=? AND container=? AND ref=?",
        (host, container or "", ref),
    )
    return cur.rowcount > 0


def list_rollout_targets(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM rollout_targets ORDER BY host, container, ref"
    ).fetchall()
    return [dict(row) for row in rows]


def get_rollout_target(conn, *, host: str, container: str, ref: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM rollout_targets WHERE host=? AND container=? AND ref=?",
        (host, container or "", ref),
    ).fetchone()
    return dict(row) if row is not None else None


def start_container_roll(conn, *, host: str, container: str, name: str, ref: str,
                         project: str = "", service: str = "", from_image_id: str = "",
                         trigger: str = "", actor: str | None = None,
                         run_id: int | None = None) -> int:
    """Open a roll row *before* anything is stopped.

    Written first on purpose: if this service dies mid-roll, a row saying `rolling` is
    the only evidence that a container may have been left half-replaced, and a row
    written afterwards would be missing exactly in the case that needs it.
    """
    cur = conn.execute(
        """
        INSERT INTO container_rolls (run_id, host, container, name, ref, project, service,
                                     from_image_id, state, trigger, actor, started_at)
        VALUES (?,?,?,?,?,?,?,?,'rolling',?,?,?)
        """,
        (run_id, host, container or "", name, ref, project or "", service or "",
         from_image_id or "", trigger, actor, utcnow()),
    )
    return int(cur.lastrowid)


def finish_container_roll(conn, roll_id: int, *, state: str, to_image_id: str = "",
                          reason: str = "", duration_ms: int | None = None) -> None:
    """Close a roll row with what actually happened.

    `state` is one of the constants in `rollout.py` — `rolled`, `rolled-back` or
    `failed` — and never "probably fine": a roll that could not be verified lands on
    one of the two bad states, because the cooldown and the block both read this
    column and a hopeful value would defeat both.
    """
    conn.execute(
        "UPDATE container_rolls SET state=?, to_image_id=?, reason=?, finished_at=?, "
        "duration_ms=? WHERE id=?",
        (state, to_image_id or "", (reason or "")[:400], utcnow(), duration_ms, roll_id),
    )


def last_container_roll(conn, *, host: str, container: str, ref: str) -> dict | None:
    """The most recent roll for one container, whatever state it ended in."""
    row = conn.execute(
        """
        SELECT * FROM container_rolls WHERE host=? AND container=? AND ref=?
         ORDER BY started_at DESC, id DESC LIMIT 1
        """,
        (host, container or "", ref),
    ).fetchone()
    return dict(row) if row is not None else None


def container_roll_blocker(conn, *, host: str, container: str, ref: str) -> str:
    """Why this container must not be rolled again, or "" when it may be.

    A roll that ended `rolled-back` or `failed` and has not been cleared blocks the
    next attempt. This is the rail that turns a nightly crash-loop into one incident:
    without it, every timer would try the same image again, restart the container, fail
    the health gate, roll back, and repeat — which is a container that flaps nightly and
    a Network nobody can keep stable long enough to fix.

    A `rolling` row that never finished counts as a failure too — see
    `start_container_roll` for why it is written first.
    """
    last = last_container_roll(conn, host=host, container=container, ref=ref)
    if last is None or last["cleared_at"]:
        return ""
    if last["state"] in ("rolled-back", "failed", "rolling"):
        return f"{last['state']}: {last['reason'] or 'no reason recorded'}"
    return ""


def clear_container_roll_blocker(conn, *, host: str, container: str, ref: str,
                                actor: str | None = None) -> int:
    """Let a blocked container be rolled again, after somebody looked at it.

    Clears every uncleared bad row rather than only the newest: an operator who fixed
    the image means "try this again", and leaving an older refusal in place would keep
    the container blocked for a reason that no longer applies.
    """
    cur = conn.execute(
        """
        UPDATE container_rolls SET cleared_at=?
         WHERE host=? AND container=? AND ref=? AND cleared_at IS NULL
           AND state IN ('rolled-back','failed','rolling')
        """,
        (utcnow(), host, container or "", ref),
    )
    if cur.rowcount:
        log(conn, f"roll block cleared for {container or host}:{ref}" +
                  (f" by {actor}" if actor else ""), actor=actor)
    return cur.rowcount


def list_container_rolls(conn, *, limit: int = 50, host: str | None = None) -> list[dict]:
    """Recent rolls, newest first — the history page, and the cooldown's evidence."""
    if host:
        rows = conn.execute(
            "SELECT * FROM container_rolls WHERE host=? ORDER BY started_at DESC, id DESC LIMIT ?",
            (host, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM container_rolls ORDER BY started_at DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def rollout_history(conn, targets: list[tuple[str, str, str]]) -> dict[tuple, dict]:
    """Per owned container, the two facts a rollout run needs: when it last rolled, and
    whether a bad roll is still holding it back.

    One pass over the roll history for the whole remit rather than a query per
    container, because a rollout run asks this for every container it owns before
    deciding anything and a hundred round trips to SQLite on a timer buys nothing.

    The two facts come from different rows on purpose:

      * **The cooldown runs from the last roll that actually changed the container**
        (`rolled`). An attempt that did not get that far — a throttled registry — must
        not start a day-long wait, or a rate limit would become a day of no updates.
      * **The block comes from the newest row whatever it is**, because a `rolling` row
        that never finished is the only evidence that a container may have been left
        half-replaced, and it outranks an older success.
    """
    wanted = set(targets)
    # Every owned container starts with an answer, so a caller never has to tell "never
    # rolled" apart from "not in the result".
    out: dict[tuple, dict] = {key: {"last_rolled_at": None, "blocker": ""} for key in wanted}
    for row in conn.execute(
        "SELECT * FROM container_rolls ORDER BY started_at ASC, id ASC"
    ).fetchall():
        key = (row["host"], row["container"], row["ref"])
        if key not in wanted:
            continue
        state = out[key]
        if row["state"] == "rolled":
            state["last_rolled_at"] = row["finished_at"] or row["started_at"]
        # The NEWEST bad row is the one that counts, and `cleared_at` un-blocks it: an
        # operator who looked at a failure and fixed the image means "try again", and
        # leaving an older refusal standing would hold the container back for a reason
        # that no longer applies. Walked oldest-first, so a later bad row simply overwrites
        # an earlier cleared one. See `clear_container_roll_blocker`.
        if row["state"] in ("rolled-back", "failed", "rolling"):
            state["blocker"] = "" if row["cleared_at"] else \
                f"{row['state']}: {row['reason'] or 'no reason recorded'}"
    return out
