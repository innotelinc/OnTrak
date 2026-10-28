#!/usr/bin/env python3
"""Rolling back one apply run (2.2).

The forward path's tests are about the rails: `--only-upgrade`, the re-read that
makes `applied` a fact about the machine, a held-back package reported as failed.
The undo has its own rails, and they are the same kind:

  * the version put back is the one the run *recorded* replacing, never one read
    from `findings.current` (which the next scan overwrites);
  * a run that cannot be undone in full is refused in full, before a command;
  * a run is rolled back once, and the second request names the first rollback;
  * a downgrade that did not take leaves the finding `applied`, because the new
    version is still on the machine.

Every case drives the real `rollback_run` over a throwaway SQLite database with
only the transport faked, so what is asserted is the command that would run and
the state that would be left behind.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from ontrak import applier, db  # noqa: E402
from test_applier import ApplierCase  # noqa: E402


class RollbackCase(ApplierCase):
    def applied_run(self, package: str = "nginx", manager: str = "apt") -> int:
        """Apply one finding the way a real run does, and return the run id."""
        self.finding(manager=manager, package=package)
        result = self.apply()
        self.assertEqual(1, result["applied"])
        return result["run_id"]

    def applied_rows(self):
        return self.conn.execute(
            "SELECT * FROM applied_packages ORDER BY id"
        ).fetchall()

    def rollback(self, run_id: int):
        return applier.rollback_run(self.conn, self.settings, self.policy,
                                    run_id=run_id, actor="test-operator")

    def rollback_runs(self):
        return self.conn.execute(
            "SELECT id, kind, trigger, status, rollback_of, summary FROM runs"
            " WHERE kind='rollback' ORDER BY id"
        ).fetchall()


class TheRecord(RollbackCase):
    def test_an_apply_records_the_version_it_replaced(self):
        run_id = self.applied_run()
        rows = self.applied_rows()
        self.assertEqual(1, len(rows))
        row = rows[0]
        self.assertEqual(run_id, row["run_id"])
        self.assertEqual("apt", row["manager"])
        self.assertEqual("1.0", row["from_version"])
        self.assertEqual("1.1", row["to_version"])
        self.assertIsNone(row["rollback_run_id"])

    def test_a_second_apply_keeps_both_history_rows(self):
        # The same package can be moved twice (a later version appears). `findings`
        # has one row and cannot answer "what did run 1 replace?", which is exactly
        # why the pair is written per run.
        first = self.applied_run()
        db.set_status(self.conn, [self.status_id()], "approved")
        second = self.apply()["run_id"]
        self.assertNotEqual(first, second)
        self.assertEqual(2, len(self.applied_rows()))
        self.assertEqual({first, second}, {row["run_id"] for row in self.applied_rows()})

    def status_id(self) -> int:
        return self.conn.execute(
            "SELECT id FROM findings WHERE package='nginx'"
        ).fetchone()["id"]


class TheDowngrade(RollbackCase):
    def test_it_pins_the_recorded_version_and_never_re_upgrades(self):
        run_id = self.applied_run()
        self.fake.installed_versions["nginx"] = "1.1"

        result = self.rollback(run_id)

        self.assertTrue(result["ok"], result)
        self.assertEqual(1, result["rolled_back"])
        installs = [call for call in self.fake.calls if call[0] == "apt-rollback"]
        self.assertEqual(1, len(installs))
        command = installs[0][2]
        self.assertIn("nginx=1.0", command)
        self.assertIn("--allow-downgrades", command)
        self.assertNotIn("--only-upgrade", command)
        self.assertNotIn("dist-upgrade", command)
        # The finding is back to pending: the machine has the old version and the
        # decision that was acted on has been spent, so a human decides again.
        self.assertEqual("pending", self.status_of()["status"])
        self.assertIn("1.0", self.status_of()["detail"])

    def test_the_rollback_is_its_own_run_linked_to_the_one_it_undoes(self):
        run_id = self.applied_run()
        self.fake.installed_versions["nginx"] = "1.1"
        result = self.rollback(run_id)

        self.assertIsNotNone(result["run_id"])
        runs = self.rollback_runs()
        self.assertEqual(1, len(runs))
        self.assertEqual(run_id, runs[0]["rollback_of"])
        self.assertEqual("ok", runs[0]["status"])
        self.assertIn("1 package(s) rolled back", runs[0]["summary"])
        self.assertIsNotNone(self.applied_rows()[0]["rolled_back_at"])

    def test_a_downgrade_that_did_not_take_leaves_the_finding_applied(self):
        run_id = self.applied_run()
        self.fake.installed_versions["nginx"] = "1.1"
        self.fake.rollback_installs = False   # apt exited 0 and changed nothing

        result = self.rollback(run_id)

        self.assertFalse(result["ok"])
        self.assertEqual(1, result["failed"])
        row = self.status_of()
        self.assertEqual("applied", row["status"])
        self.assertIn("failed", row["detail"])
        # Not stamped as rolled back: the row was not put back, so a later retry of
        # the run is still the truth about the machine.
        self.assertIsNone(self.applied_rows()[0]["rolled_back_at"])

    def test_a_failed_command_is_reported_with_the_reason(self):
        run_id = self.applied_run()
        self.fake.installed_versions["nginx"] = "1.1"
        self.fake.rollback_rc = 100

        result = self.rollback(run_id)

        self.assertEqual(1, result["failed"])
        self.assertTrue(any("failed" in message for message in result["messages"]))
        self.assertEqual("applied", self.status_of()["status"])


class TheRefusals(RollbackCase):
    def test_a_missing_previous_version_refuses_the_run_before_any_command(self):
        run_id = self.applied_run()
        self.conn.execute("UPDATE applied_packages SET from_version=NULL")
        self.conn.commit()
        self.fake.calls.clear()

        result = self.rollback(run_id)

        self.assertFalse(result["ok"])
        self.assertIn("was not recorded", " ".join(result["refusals"]))
        self.assertEqual([], self.fake.calls)
        self.assertEqual([], self.rollback_runs())
        self.assertEqual("applied", self.status_of()["status"])

    def test_a_manager_with_no_package_revert_is_refused_by_name(self):
        finding = self.finding(manager="docker", package="ghcr.io/innotel/api:1.2")
        target_id = self.conn.execute(
            "SELECT target_id FROM findings WHERE id=?", (finding,)
        ).fetchone()["target_id"]
        run_id = db.start_run(self.conn, "apply", "manual:test")
        db.finish_run(self.conn, run_id, status="ok", applied=1)
        db.record_applied(self.conn, run_id=run_id, finding_id=finding,
                          target_id=target_id, manager="docker",
                          package="ghcr.io/innotel/api:1.2",
                          from_version="sha256:old", to_version="sha256:new")
        self.conn.commit()

        result = self.rollback(run_id)

        self.assertFalse(result["ok"])
        self.assertIn("undo_roll", " ".join(result["refusals"]))
        self.assertEqual([], self.fake.calls)
        self.assertFalse(any(call[0] == "apt-rollback" for call in self.fake.calls))

    def test_a_second_rollback_names_the_first_one(self):
        run_id = self.applied_run()
        self.fake.installed_versions["nginx"] = "1.1"
        first = self.rollback(run_id)
        self.assertTrue(first["ok"])

        second = self.rollback(run_id)

        self.assertFalse(second["ok"])
        self.assertIn("already rolled back", " ".join(second["refusals"]))
        self.assertIn(f"#{first['run_id']}", " ".join(second["refusals"]))
        # The refused attempt did not open a second rollback run.
        self.assertEqual(1, len(self.rollback_runs()))

    def test_a_run_that_moved_nothing_is_refused(self):
        run_id = db.start_run(self.conn, "apply", "manual:test")
        db.finish_run(self.conn, run_id, status="ok")
        self.conn.commit()

        result = self.rollback(run_id)

        self.assertFalse(result["ok"])
        self.assertIn("nothing to roll back", " ".join(result["refusals"]))

    def test_an_unknown_or_unfinished_run_is_refused(self):
        unknown = self.rollback(999)
        self.assertFalse(unknown["ok"])
        self.assertIn("does not exist", " ".join(unknown["refusals"]))

        run_id = db.start_run(self.conn, "apply", "manual:test")
        unfinished = self.rollback(run_id)
        self.assertIn("has not finished", " ".join(unfinished["refusals"]))


class TheSnapPath(RollbackCase):
    def test_a_snap_is_reverted_and_verified_by_its_revision(self):
        run_id = self.applied_run(package="code", manager="snap")
        self.fake.snap_revisions["code"] = "51"
        self.fake.snap_revert_to["code"] = "50"

        result = self.rollback(run_id)

        self.assertTrue(result["ok"], result)
        self.assertEqual(1, result["rolled_back"])
        reverts = [call for call in self.fake.calls if call[0] == "snap-revert"]
        self.assertEqual(1, len(reverts))
        self.assertEqual("code", reverts[0][2])
        self.assertEqual("pending", self.status_of(manager="snap", package="code")["status"])

    def test_a_revert_that_left_the_revision_alone_is_a_failure(self):
        run_id = self.applied_run(package="code", manager="snap")
        self.fake.snap_revisions["code"] = "51"
        self.fake.revert_rc = 1

        result = self.rollback(run_id)

        self.assertEqual(1, result["failed"])
        self.assertEqual("applied", self.status_of(manager="snap", package="code")["status"])


if __name__ == "__main__":
    unittest.main()
