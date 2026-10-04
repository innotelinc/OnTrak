#!/usr/bin/env python3
"""Unit tests for ontrak/reconcile.py — the report that closes two loops.

A scan says what is out of date. This says two things a scan creates but cannot
finish by itself:

  * **what vanished** — a removed container's target is pruned, but the *names*
    only exist for that instant, so the report is the only place an operator can
    read them back; and
  * **what is stuck** — a `failed` finding older than the threshold is a decision
    nobody has made, not a transient retry.

The tests hold the report to the same restraint the scan keeps: it must be
read-and-record only. Nothing here may change a finding's status, apply anything,
or delete anything — a noisy threshold is a nuisance, a destructive one is a bug.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db, reconcile  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402


def age(seconds: int) -> str:
    """An ISO timestamp `seconds` in the past, in the format `record_finding` uses."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds))


class ReconcileCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),),
                                 stale_failure_seconds=48 * 3600)

    def fail_finding(self, *, host="i4", name="proxy", package="binwiederhier/ntfy:latest",
                     first_seen_seconds_ago=0):
        target = db.ensure_target(self.conn, host=host, kind="container", name=name)
        db.record_finding(self.conn, target_id=target, manager="docker", package=package,
                          current="sha256:a", candidate="sha256:b")
        row = self.conn.execute(
            "SELECT id FROM findings WHERE package=?", (package,)).fetchone()
        db.set_status(self.conn, [row["id"]], "failed", "recreate it by hand")
        if first_seen_seconds_ago:
            self.conn.execute("UPDATE findings SET first_seen=? WHERE id=?",
                              (age(first_seen_seconds_ago), row["id"]))
        self.conn.commit()
        return row["id"]

    def runs(self, kind=None):
        clause = "WHERE kind=?" if kind else ""
        params = (kind,) if kind else ()
        return self.conn.execute(f"SELECT * FROM runs {clause}", params).fetchall()

    def events(self):
        return [row["message"] for row in
                self.conn.execute("SELECT * FROM events").fetchall()]


class QuietNetwork(ReconcileCase):
    def test_a_quiet_scan_records_nothing(self):
        report = reconcile.reconcile(self.conn, self.settings)
        self.conn.commit()
        self.assertEqual(0, report["vanished_count"])
        self.assertEqual(0, report["stale_count"])
        # No run row and no log line: the report is a signal, not a heartbeat.
        self.assertEqual([], self.runs("reconcile"))
        self.assertEqual([], self.events())

    def test_the_report_is_still_stored_when_it_is_empty(self):
        # So `GET /api/reconcile` can distinguish "nothing is wrong" from "never
        # scanned", which read the same on a dashboard otherwise.
        reconcile.reconcile(self.conn, self.settings)
        self.conn.commit()
        self.assertIsNotNone(reconcile.stored(self.conn))


class Vanished(ReconcileCase):
    def test_a_vanished_target_is_named_and_raises_a_run(self):
        report = reconcile.reconcile(self.conn, self.settings,
                                     vanished={"i3": ["onyx", "signara"]},
                                     trigger="schedule")
        self.conn.commit()
        self.assertEqual({"i3": ["onyx", "signara"]}, report["vanished"])
        self.assertEqual(2, report["vanished_count"])
        row = self.runs("reconcile")[0]
        self.assertEqual("attention", row["status"])
        self.assertEqual("schedule", row["trigger"])
        self.assertIn("onyx", row["summary"])
        self.assertTrue(any(row["level"] == "warning" for row in
                            self.conn.execute("SELECT * FROM events").fetchall()))

    def test_an_empty_host_entry_is_dropped_rather_than_named(self):
        report = reconcile.reconcile(self.conn, self.settings, vanished={"i2": []})
        self.conn.commit()
        self.assertEqual({}, report["vanished"])
        self.assertEqual([], self.runs("reconcile"))


class StaleFailures(ReconcileCase):
    def test_a_fresh_failure_is_not_yet_stale(self):
        self.fail_finding(first_seen_seconds_ago=0)
        report = reconcile.reconcile(self.conn, self.settings)
        self.conn.commit()
        self.assertEqual(0, report["stale_count"])
        self.assertEqual([], self.runs("reconcile"))

    def test_a_failure_past_the_threshold_is_named(self):
        self.fail_finding(first_seen_seconds_ago=72 * 3600)
        report = reconcile.reconcile(self.conn, self.settings)
        self.conn.commit()
        self.assertEqual(1, report["stale_count"])
        named = report["stale_failures"][0]
        self.assertEqual("i4", named["host"])
        self.assertEqual("proxy", named["target"])
        self.assertIn("ntfy", named["package"])
        self.assertEqual("attention", self.runs("reconcile")[0]["status"])

    def test_the_threshold_is_the_configured_one(self):
        self.fail_finding(first_seen_seconds_ago=3 * 3600)
        strict = Settings(hosts=self.settings.hosts, stale_failure_seconds=3600)
        report = reconcile.reconcile(self.conn, strict)
        self.conn.commit()
        self.assertEqual(1, report["stale_count"])

    def test_a_pending_finding_is_never_stale(self):
        # Only `failed` gets the attention: a pending update is simply waiting for
        # somebody to approve it, which is not a failure at all.
        target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target, manager="apt", package="nginx")
        self.conn.execute("UPDATE findings SET first_seen=?", (age(99 * 3600),))
        self.conn.commit()
        report = reconcile.reconcile(self.conn, self.settings)
        self.conn.commit()
        self.assertEqual(0, report["stale_count"])


class ReadOnly(ReconcileCase):
    def test_the_report_changes_no_finding_status(self):
        finding_id = self.fail_finding(first_seen_seconds_ago=72 * 3600)
        before = self.conn.execute("SELECT status, applied_at, detail FROM findings WHERE id=?",
                                   (finding_id,)).fetchone()
        reconcile.reconcile(self.conn, self.settings, vanished={"i3": ["onyx"]})
        self.conn.commit()
        after = self.conn.execute("SELECT status, applied_at, detail FROM findings WHERE id=?",
                                  (finding_id,)).fetchone()
        self.assertEqual(dict(before), dict(after))


class Current(ReconcileCase):
    def test_current_reuses_the_vanished_names_and_rechecks_the_clock(self):
        # A failure recorded *now* is not stale; make it old, then ask `current`.
        self.fail_finding(first_seen_seconds_ago=72 * 3600)
        reconcile.reconcile(self.conn, self.settings, vanished={"i2": ["capstone"]})
        self.conn.commit()
        report = reconcile.current(self.conn, self.settings)
        self.assertEqual({"i2": ["capstone"]}, report["vanished"])
        self.assertEqual(1, report["stale_count"])

    def test_current_before_any_scan_is_empty_rather_than_an_error(self):
        report = reconcile.current(self.conn, self.settings)
        self.assertEqual({}, report["vanished"])
        self.assertEqual(0, report["vanished_count"])
        self.assertEqual(0, report["stale_count"])


class SummaryLine(ReconcileCase):
    def test_the_summary_names_both_kinds_of_finding(self):
        self.fail_finding(first_seen_seconds_ago=72 * 3600)
        report = reconcile.build(self.conn, self.settings, vanished={"i3": ["onyx"]})
        line = reconcile.summarize(report)
        self.assertIn("onyx", line)
        self.assertIn("ntfy", line)

    def test_a_long_list_is_truncated_but_counted(self):
        for i in range(7):
            self.fail_finding(package=f"pkg-{i}:latest", first_seen_seconds_ago=72 * 3600)
        report = reconcile.build(self.conn, self.settings)
        line = reconcile.summarize(report)
        self.assertIn("7 stale failure(s)", line)
        self.assertIn("+2 more", line)


if __name__ == "__main__":
    unittest.main()
