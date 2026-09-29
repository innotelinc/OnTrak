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
    apply — a permanent, silent hole in the estate's patching.

The tests below are those two rules, plus expiry, which is what makes a fix
applied by hand elsewhere stop being reported without anyone clicking anything.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db  # noqa: E402


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
        # again, and every future scan reports the estate as clean.
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
        # dropping the WHERE clause — would set every finding in the estate.
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


class DigestCache(unittest.TestCase):
    """The remembered remote digests.

    This exists to spend fewer of Docker Hub's anonymous requests. That makes its
    failure mode a correctness question rather than a performance one: a digest that
    is served for too long reports an estate as current, and one that is served after
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


if __name__ == "__main__":
    unittest.main()
