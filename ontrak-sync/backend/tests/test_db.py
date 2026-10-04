#!/usr/bin/env python3
"""Unit tests for ontrak/db.py — the lifecycle of a finding.

A finding is not a log line. It has a status that is the workflow, and the two
rules that make the workflow work are exactly the two that are easy to get wrong:

  * **A re-scan must not reset a status.** Scans run every few hours and re-detect
    the same fifty packages. If the upsert overwrote `status`, an approval would be
    undone by the next scan and nothing could ever be applied.
  * **A moved candidate must reset `applied` to `pending`.** After a package is
    installed its row is `applied`; when the next release appears the same package
    is detected again with a different candidate. A status-preserving upsert would
    leave it `applied` forever and the package would be invisible to every future
    apply — a permanent, silent hole in the Network's patching.

The tests below are those two rules, plus expiry, which is what makes a fix
applied by hand elsewhere stop being reported without anyone clicking anything.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db, scanners  # noqa: E402


class FindingLifecycle(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")

    def row(self, package="nginx"):
        return self.conn.execute(
            "SELECT * FROM findings WHERE package=?", (package,)
        ).fetchone()

    def test_a_new_finding_starts_pending(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        found = self.row()
        self.assertEqual("pending", found["status"])
        self.assertIsNone(found["applied_at"])

    def test_a_rescan_does_not_reset_an_approval(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        db.set_status(self.conn, [self.row()["id"]], "approved")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        self.assertEqual("approved", self.row()["status"])

    def test_a_rescan_does_not_reset_a_skip(self):
        # Skipping is per-run, not forever — but the *next scan* is not the thing
        # that undoes it, or a skip would last minutes.
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        db.set_status(self.conn, [self.row()["id"]], "skipped")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        self.assertEqual("skipped", self.row()["status"])

    def test_a_newer_candidate_reopens_an_applied_finding(self):
        # THE important one. Without this, a package is patched once and then never
        # again, and every future scan reports the Network as clean.
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        db.set_status(self.conn, [self.row()["id"]], "applied")
        self.assertEqual("applied", self.row()["status"])
        self.assertIsNotNone(self.row()["applied_at"])

        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.1", candidate="1.2")
        found = self.row()
        self.assertEqual("pending", found["status"])
        self.assertEqual("1.2", found["candidate"])
        self.assertIsNone(found["applied_at"])

    def test_the_same_candidate_after_an_apply_leaves_it_applied(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        db.set_status(self.conn, [self.row()["id"]], "applied")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          current="1.0", candidate="1.1")
        self.assertEqual("applied", self.row()["status"])

    def test_a_scan_does_not_overwrite_why_a_failed_finding_failed(self):
        # The failure reason is not a detection note. A scan a few hours later must
        # not replace "unmet dependencies" with the archive the package came from,
        # or the dashboard is red with no way to find out why.
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          detail="Ubuntu:24.04/noble-updates")
        db.set_status(self.conn, [self.row()["id"]], "failed", "E: unmet dependencies")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          detail="Ubuntu:24.04/noble-security")
        self.assertEqual("E: unmet dependencies", self.row()["detail"])

    def test_a_row_that_is_no_longer_failed_gets_its_detection_note_back(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          detail="Ubuntu:24.04/noble-updates")
        db.set_status(self.conn, [self.row()["id"]], "failed", "E: unmet dependencies")
        db.set_status(self.conn, [self.row()["id"]], "pending")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          detail="Ubuntu:24.04/noble-security")
        self.assertEqual("Ubuntu:24.04/noble-security", self.row()["detail"])

    def test_the_same_package_under_two_managers_is_two_findings(self):
        # `docker` and `apt` both have a `n8n`; they are not the same thing and
        # must not collapse into one row.
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="n8n")
        db.record_finding(self.conn, target_id=self.target, manager="docker", package="n8n")
        count = self.conn.execute("SELECT COUNT(*) c FROM findings").fetchone()["c"]
        self.assertEqual(2, count)

    def test_a_finding_records_whether_it_is_a_security_update(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="curl",
                          security=True)
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx",
                          security=False)
        self.assertEqual(1, self.row("curl")["security"])
        self.assertEqual(0, self.row("nginx")["security"])

    def test_first_seen_survives_a_refresh_and_last_seen_moves(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        first = self.row()
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        self.assertEqual(first["first_seen"], self.row()["first_seen"])


class Expiry(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")

    def test_a_finding_that_is_no_longer_detected_is_deleted(self):
        # This is how "someone updated it by hand" becomes visible without a person
        # marking anything done.
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="curl")
        removed = db.expire_findings(self.conn, [self.target], {(self.target, "apt", "curl")})
        self.assertEqual(1, removed)
        remaining = [r["package"] for r in self.conn.execute("SELECT package FROM findings")]
        self.assertEqual(["curl"], remaining)

    def test_applied_history_is_never_expired(self):
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        db.set_status(self.conn, [self.conn.execute("SELECT id FROM findings").fetchone()["id"]],
                      "applied")
        removed = db.expire_findings(self.conn, [self.target], set())
        self.assertEqual(0, removed)
        self.assertEqual(1, self.conn.execute("SELECT COUNT(*) c FROM findings").fetchone()["c"])

    def test_expiry_is_scoped_to_the_targets_being_scanned(self):
        # A scan of i1 must not clear i2's findings: that is the failure mode where
        # a partial scan silently empties the dashboard.
        other = db.ensure_target(self.conn, host="i2", kind="container", name="capstone")
        db.record_finding(self.conn, target_id=self.target, manager="apt", package="nginx")
        db.record_finding(self.conn, target_id=other, manager="apt", package="nginx")
        db.expire_findings(self.conn, [self.target], set())
        self.assertEqual(1, self.conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE target_id=?", (other,)).fetchone()["c"])


class StatusUpdates(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        target = db.ensure_target(self.conn, host="i1", kind="host", name="i1")
        db.record_finding(self.conn, target_id=target, manager="apt", package="nginx")
        db.record_finding(self.conn, target_id=target, manager="apt", package="curl")
        db.record_finding(self.conn, target_id=target, manager="apt", package="vim")
        self.ids = [r["id"] for r in self.conn.execute("SELECT id FROM findings ORDER BY id")]

    def test_a_batch_status_update_touches_all_of_them(self):
        changed = db.set_status(self.conn, self.ids, "approved")
        self.assertEqual(3, changed)
        count = self.conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE status='approved'").fetchone()["c"]
        self.assertEqual(3, count)

    def test_an_empty_batch_is_a_no_op_rather_than_a_blanket_update(self):
        # Guards the SQL: `IN ()` is a syntax error in SQLite, and the naive fix —
        # dropping the WHERE clause — would set every finding in the Network.
        self.assertEqual(0, db.set_status(self.conn, [], "approved"))
        count = self.conn.execute(
            "SELECT COUNT(*) c FROM findings WHERE status='approved'").fetchone()["c"]
        self.assertEqual(0, count)

    def test_marking_applied_stamps_the_time(self):
        db.set_status(self.conn, self.ids[:1], "applied")
        row = self.conn.execute("SELECT status, applied_at FROM findings WHERE id=?",
                                (self.ids[0],)).fetchone()
        self.assertEqual("applied", row["status"])
        self.assertTrue(row["applied_at"])

    def test_a_failure_records_the_reason(self):
        db.set_status(self.conn, self.ids, "failed", "apt exited 100: unmet dependencies")
        row = self.conn.execute("SELECT detail FROM findings WHERE id=?", (self.ids[0],)).fetchone()
        self.assertIn("unmet dependencies", row["detail"])


class TargetsAndRuns(unittest.TestCase):
    def test_ensuring_the_same_target_twice_is_idempotent(self):
        conn = db.connect(":memory:")
        db.init(conn)
        first = db.ensure_target(conn, host="i1", kind="container", name="monarch")
        second = db.ensure_target(conn, host="i1", kind="container", name="monarch", ref="monarch")
        self.assertEqual(first, second)

    def test_a_target_is_identified_by_host_kind_and_name(self):
        conn = db.connect(":memory:")
        db.init(conn)
        a = db.ensure_target(conn, host="i1", kind="container", name="monarch")
        b = db.ensure_target(conn, host="i1", kind="host", name="monarch")
        c = db.ensure_target(conn, host="i2", kind="container", name="monarch")
        self.assertEqual(3, len({a, b, c}))

    def test_deleting_a_target_takes_its_findings_with_it(self):
        conn = db.connect(":memory:")
        db.init(conn)
        target = db.ensure_target(conn, host="i1", kind="container", name="gone")
        db.record_finding(conn, target_id=target, manager="apt", package="nginx")
        conn.execute("DELETE FROM targets WHERE id=?", (target,))
        self.assertEqual(0, conn.execute("SELECT COUNT(*) c FROM findings").fetchone()["c"])

    def test_a_run_records_how_it_ended(self):
        conn = db.connect(":memory:")
        db.init(conn)
        run_id = db.start_run(conn, "scan", "schedule")
        db.finish_run(conn, run_id, status="ok", findings=7, summary="7 finding(s)")
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        self.assertEqual("ok", row["status"])
        self.assertEqual(7, row["findings"])
        self.assertTrue(row["finished_at"])

    def test_events_are_recorded_against_a_run(self):
        conn = db.connect(":memory:")
        db.init(conn)
        run_id = db.start_run(conn, "scan", "manual")
        db.log(conn, "i1 unreachable: connection timed out", level="error", run_id=run_id)
        row = conn.execute("SELECT * FROM events").fetchone()
        self.assertEqual("error", row["level"])
        self.assertEqual(run_id, row["run_id"])


class ScanVerdict(unittest.TestCase):
    """`targets.last_scanned_ok` — the durable half of "we could not look".

    By the next scan the error text has been overwritten, so "I read it and it is
    clean" and "I could not read it" have to be distinguishable afterwards rather
    than during the run that produced them.
    """

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.target = db.ensure_target(self.conn, host="i1", kind="container",
                                       name="monarch")

    def row(self):
        return self.conn.execute(
            "SELECT * FROM targets WHERE id=?", (self.target,)).fetchone()

    def test_touch_records_whether_a_verdict_was_reached(self):
        db.touch_target(self.conn, self.target, error=None, looked=True)
        self.assertEqual(1, self.row()["last_scanned_ok"])
        self.assertTrue(self.row()["last_scanned_at"])

    def test_a_later_scan_that_could_not_look_clears_the_verdict(self):
        # This is the stopped instance: the first scan read it, the second could
        # not, and the second is the one that has to survive to the dashboard.
        db.touch_target(self.conn, self.target, error=None, looked=True)
        db.touch_target(self.conn, self.target, looked=False,
                        error="instance is not running (state: STOPPED)")
        self.assertEqual(0, self.row()["last_scanned_ok"])

    def test_a_call_that_does_not_say_it_looked_is_not_a_verdict(self):
        db.touch_target(self.conn, self.target, error="apt: probe timed out")
        self.assertEqual(0, self.row()["last_scanned_ok"])

    def test_a_database_from_before_the_column_gains_it_keeping_its_history(self):
        # The schema is applied with CREATE TABLE IF NOT EXISTS, so a Network that
        # was already running gets this column from the ALTER in `init` and from
        # nowhere else, and its existing rows are backfilled from `error` — the
        # only durable trace of a failed look that predates the column.
        old = db.connect(":memory:")
        old.execute(
            "CREATE TABLE targets (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT,"
            " kind TEXT, name TEXT, ref TEXT, meta TEXT, discovered_at TEXT,"
            " last_scanned_at TEXT, error TEXT)"
        )
        old.execute("INSERT INTO targets (host, kind, name, last_scanned_at, error)"
                    " VALUES ('i1','container','clean','2026-01-01T00:00:00Z',NULL)")
        old.execute("INSERT INTO targets (host, kind, name, last_scanned_at, error)"
                    " VALUES ('i1','container','stopped','2026-01-01T00:00:00Z',"
                    "'instance is not running')")
        old.execute("INSERT INTO targets (host, kind, name) VALUES ('i1','container','new')")

        db.init(old)

        rows = {r["name"]: r for r in old.execute("SELECT * FROM targets").fetchall()}
        self.assertEqual(1, rows["clean"]["last_scanned_ok"])
        self.assertEqual(0, rows["stopped"]["last_scanned_ok"])
        # Never scanned at all: counted unknown by the other half of the predicate.
        self.assertIsNone(rows["new"]["last_scanned_ok"])


class RebootState(unittest.TestCase):
    """`hosts.reboot_*` — the one report no manager makes.

    A host that has installed a new kernel and not restarted since is described as
    current by apt, snap and docker alike, so if this is not recorded somewhere of
    its own it is not recorded at all. The column defaults carry half the meaning:
    a Network that has never been scanned must read as *not asked*, never as
    "nothing pending".
    """

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        db.upsert_host(self.conn, name="i1", address="192.168.1.51", kind="both",
                       ssh_user="root", reachable=True)

    def row(self):
        return self.conn.execute("SELECT * FROM hosts WHERE name='i1'").fetchone()

    def test_a_host_waiting_to_restart_records_its_packages_one_per_line(self):
        db.record_reboot_state(self.conn, name="i1", state=scanners.RebootState(
            known=True, required=True, packages=("libc6", "linux-image-generic")))
        row = self.row()
        self.assertEqual(1, row["reboot_required"])
        self.assertEqual(1, row["reboot_known"])
        self.assertEqual("libc6\nlinux-image-generic", row["reboot_packages"])
        self.assertTrue(row["reboot_checked_at"])

    def test_a_host_with_nothing_pending_is_recorded_as_asked_and_clear(self):
        db.record_reboot_state(self.conn, name="i1",
                               state=scanners.RebootState(known=True, required=False))
        row = self.row()
        self.assertEqual(1, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        # No packages is no list, not an empty string: an empty one would render as
        # a pending reboot with nothing behind it.
        self.assertIsNone(row["reboot_packages"])

    def test_a_host_that_was_never_asked_does_not_read_as_clear(self):
        row = self.row()
        self.assertEqual(0, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        self.assertIsNone(row["reboot_checked_at"])

    def test_a_host_this_code_cannot_ask_is_recorded_as_asked_and_unknown(self):
        # "Checked, and it could not tell" is a third state, and it is the one that
        # has to be distinguishable from both others. `reboot_checked_at` is the
        # only column that separates it from never having been asked.
        db.record_reboot_state(self.conn, name="i1", state=scanners.UNKNOWN_REBOOT)
        row = self.row()
        self.assertEqual(0, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        self.assertTrue(row["reboot_checked_at"])

    def test_a_second_answer_replaces_the_first(self):
        db.record_reboot_state(self.conn, name="i1", state=scanners.RebootState(
            known=True, required=True, packages=("libc6",)))
        db.record_reboot_state(self.conn, name="i1", state=scanners.RebootState(
            known=True, required=False))
        row = self.row()
        self.assertEqual(0, row["reboot_required"])
        self.assertIsNone(row["reboot_packages"])

    def test_a_hosts_table_from_before_the_columns_gains_them(self):
        # The deployed SQLite file IS the Network's history, so these arrive by ALTER
        # and from nowhere else.
        old = db.connect(":memory:")
        old.execute(
            "CREATE TABLE hosts (name TEXT PRIMARY KEY, address TEXT NOT NULL,"
            " kind TEXT NOT NULL DEFAULT 'incus', ssh_user TEXT NOT NULL DEFAULT 'root',"
            " reachable INTEGER NOT NULL DEFAULT 0, os TEXT, kernel TEXT,"
            " container_count INTEGER NOT NULL DEFAULT 0, last_seen TEXT, error TEXT)"
        )
        old.execute("INSERT INTO hosts (name, address, reachable)"
                    " VALUES ('i1','192.168.1.51',1)")

        db.init(old)

        row = old.execute("SELECT * FROM hosts WHERE name='i1'").fetchone()
        self.assertEqual(0, row["reboot_known"])
        self.assertEqual(0, row["reboot_required"])
        self.assertIsNone(row["reboot_packages"])
        # The row it already had is untouched.
        self.assertEqual("192.168.1.51", row["address"])
        self.assertEqual(1, row["reachable"])


class DigestCache(unittest.TestCase):
    """The remembered remote digests.

    This exists to spend fewer of Docker Hub's anonymous requests. That makes its
    failure mode a correctness question rather than a performance one: a digest that
    is served for too long reports a Network as current, and one that is served after
    a failed lookup turns "could not ask" into "up to date".
    """

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)

    def test_a_fresh_digest_is_returned(self):
        db.set_digest(self.conn, "nginx:latest", "sha256:abc", now=1000.0)
        self.assertEqual("sha256:abc", db.get_digest(self.conn, "nginx:latest", now=1000.0 + 60))

    def test_an_unknown_reference_is_none(self):
        self.assertIsNone(db.get_digest(self.conn, "nginx:latest", now=1000.0))

    def test_a_digest_older_than_the_ttl_is_not_served(self):
        db.set_digest(self.conn, "nginx:latest", "sha256:abc", now=1000.0)
        self.assertIsNone(db.get_digest(self.conn, "nginx:latest", ttl_seconds=3600, now=1000.0 + 3601))

    def test_the_boundary_is_still_fresh(self):
        db.set_digest(self.conn, "nginx:latest", "sha256:abc", now=1000.0)
        self.assertEqual("sha256:abc",
                         db.get_digest(self.conn, "nginx:latest", ttl_seconds=3600, now=1000.0 + 3600))

    def test_a_ttl_of_zero_asks_again(self):
        # The escape hatch for anyone who would rather spend the requests.
        db.set_digest(self.conn, "nginx:latest", "sha256:abc", now=1000.0)
        self.assertIsNone(db.get_digest(self.conn, "nginx:latest", ttl_seconds=0, now=1000.0))

    def test_a_refetched_digest_replaces_the_old_one(self):
        # The tag moved: the new answer is the answer.
        db.set_digest(self.conn, "nginx:latest", "sha256:old", now=1000.0)
        db.set_digest(self.conn, "nginx:latest", "sha256:new", now=2000.0)
        self.assertEqual("sha256:new", db.get_digest(self.conn, "nginx:latest", now=2000.0))

    def test_references_do_not_collide(self):
        db.set_digest(self.conn, "nginx:latest", "sha256:a", now=1000.0)
        db.set_digest(self.conn, "nginx:1.27.0", "sha256:b", now=1000.0)
        self.assertEqual("sha256:a", db.get_digest(self.conn, "nginx:latest", now=1000.0))
        self.assertEqual("sha256:b", db.get_digest(self.conn, "nginx:1.27.0", now=1000.0))

    def test_init_twice_keeps_the_cache(self):
        # `init` runs on every start against the existing file; the schema has to be
        # additive so an upgrade does not wipe what is already known.
        db.set_digest(self.conn, "nginx:latest", "sha256:abc", now=1000.0)
        db.init(self.conn)
        self.assertEqual("sha256:abc", db.get_digest(self.conn, "nginx:latest", now=1000.0))


class RegistryLoginRecord(unittest.TestCase):
    """The remembered registry logins.

    A login is itself a request against the registry, and the daemon keeps the
    credential in its own config — so a scan re-authenticating on every pass spends
    a request to establish what is already established. What makes this correct
    rather than merely cheaper is the off switch: a TTL of zero must fall back to
    logging in every time, so an operator whose token rotates oftener than the TTL
    has a way back.
    """

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)

    def fresh(self, *args, **kwargs):
        return db.registry_login_is_fresh(self.conn, host="i1", container="monarch",
                                          registry="docker.io", *args, **kwargs)

    def test_an_unrecorded_login_is_not_fresh(self):
        self.assertFalse(self.fresh(ttl_seconds=3600, now=1000.0))

    def test_a_recent_login_is_fresh(self):
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        self.assertTrue(self.fresh(ttl_seconds=3600, now=1000.0 + 60))

    def test_the_boundary_is_still_fresh(self):
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        self.assertTrue(self.fresh(ttl_seconds=3600, now=1000.0 + 3600))

    def test_a_login_older_than_the_ttl_is_not_fresh(self):
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        self.assertFalse(self.fresh(ttl_seconds=3600, now=1000.0 + 3601))

    def test_a_ttl_of_zero_never_reuses_the_login(self):
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        self.assertFalse(self.fresh(ttl_seconds=0, now=1000.0))

    def test_the_key_is_per_container_and_registry(self):
        # Each incus container runs its own daemon, so a login on one says nothing
        # about another — and a Hub login says nothing about ghcr.
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        self.assertFalse(db.registry_login_is_fresh(
            self.conn, host="i1", container="atheniq", registry="docker.io",
            ttl_seconds=3600, now=1000.0))
        self.assertFalse(db.registry_login_is_fresh(
            self.conn, host="i1", container="monarch", registry="ghcr.io",
            ttl_seconds=3600, now=1000.0))

    def test_recording_again_moves_the_timestamp(self):
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=1000.0)
        db.record_registry_login(self.conn, host="i1", container="monarch",
                                 registry="docker.io", now=5000.0)
        self.assertTrue(self.fresh(ttl_seconds=3600, now=5000.0 + 10))


class PruneTargets(unittest.TestCase):
    """Dropping the targets of containers that are gone.

    A removed container leaves a target and its findings behind, because a scan only
    visits what `incus list` still reports — so the findings can never be applied or
    expired, and the host keeps counting a machine that is not there.
    """

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)

    def target_names(self, host="i1", kind="container"):
        return {row["name"] for row in self.conn.execute(
            "SELECT name FROM targets WHERE host=? AND kind=?", (host, kind)).fetchall()}

    def test_a_target_not_in_the_listing_is_removed(self):
        db.ensure_target(self.conn, host="i1", kind="container", name="gone")
        db.ensure_target(self.conn, host="i1", kind="container", name="stays")
        removed = db.prune_targets(self.conn, host="i1", kind="container", present={"stays"})
        self.assertEqual(["gone"], removed)
        self.assertEqual({"stays"}, self.target_names())

    def test_the_findings_of_a_removed_target_go_with_it(self):
        target = db.ensure_target(self.conn, host="i1", kind="container", name="gone")
        db.record_finding(self.conn, target_id=target, manager="docker", package="redis:7.4",
                          current="a", candidate="b")
        db.prune_targets(self.conn, host="i1", kind="container", present=set())
        count = self.conn.execute("SELECT COUNT(*) AS n FROM findings").fetchone()["n"]
        self.assertEqual(0, count)

    def test_nothing_is_removed_when_everything_is_present(self):
        db.ensure_target(self.conn, host="i1", kind="container", name="a")
        db.ensure_target(self.conn, host="i1", kind="container", name="b")
        self.assertEqual([], db.prune_targets(self.conn, host="i1", kind="container",
                                              present={"a", "b"}))

    def test_another_host_and_kind_are_left_alone(self):
        db.ensure_target(self.conn, host="i1", kind="container", name="gone")
        db.ensure_target(self.conn, host="i2", kind="container", name="gone")
        db.ensure_target(self.conn, host="i1", kind="host", name="i1")
        db.prune_targets(self.conn, host="i1", kind="container", present=set())
        self.assertEqual({"gone"}, self.target_names(host="i2"))
        self.assertEqual({"i1"}, self.target_names(host="i1", kind="host"))


if __name__ == "__main__":
    unittest.main()
