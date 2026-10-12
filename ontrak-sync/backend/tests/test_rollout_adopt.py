#!/usr/bin/env python3
"""Who fills the remit — `applier.adopt_discovered`, and its effect on a pass.

`test_rollout.py` pins the rails and `test_rollout_apply.py` pins the roll. Both of them
start from a remit that somebody wrote, which is the shipped posture and no longer the
only one: with `ONTRAK_ROLLOUT_ADOPT` set, the scans fill the remit themselves, and the
set of things that can restart a container grows from "the list a person wrote" to "every
image a scan has ever seen on a host this deployment reaches".

That is a large change in blast radius, so what is pinned here is mostly *what stays out*:
a host that is no longer configured, a finding somebody skipped by hand, a container that
was released, and a claim whose terms a person chose. The other half is what the two
postures mean — `watched` fills the remit and rolls none of it, `unattended` fills it and
rolls it — and that the default is still nothing at all.

The remote is faked exactly as `test_rollout_apply.py` fakes it, and the fake is imported
rather than copied so the two modules cannot disagree about what a host answers.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from ontrak import applier, db, rollout  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from ontrak.policy import Policy  # noqa: E402
from test_rollout_apply import AT, REF, FakeDocker  # noqa: E402


class AdoptCase(unittest.TestCase):
    """A deployment with the fake Network, and a scan that has already run."""

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.fake = FakeDocker()
        self.host = Host("i1", "192.168.1.51", "both")
        # Two hosts, so "a host this deployment does not reach" is expressible as a
        # finding rather than as a missing one.
        self.settings = Settings(hosts=(self.host, Host("i2", "192.168.1.52", "both")),
                                 rollout_enabled=True, rollout_adopt="unattended")
        self.policy = Policy()
        patcher = mock.patch.multiple(applier, ssh=self.fake.ssh,
                                      incus_exec=self.fake.incus_exec,
                                      docker_in_container=self.fake.docker_in_container)
        patcher.start()
        self.addCleanup(patcher.stop)

    # ── helpers ──────────────────────────────────────────────────────────────
    def with_posture(self, adopt: str, **overrides) -> None:
        """Rebuild the settings a test runs under, as a deployment would configure them."""
        fields = dict(hosts=self.settings.hosts, rollout_enabled=True, rollout_adopt=adopt)
        fields.update(overrides)
        self.settings = Settings(**fields)

    def finding(self, *, host: str = "i1", container: str = "monarch", ref: str = REF,
                status: str = "pending", kind: str = "container") -> int:
        name = host if kind == "host" else container
        target = db.ensure_target(self.conn, host=host, kind=kind, name=name)
        db.record_finding(self.conn, target_id=target, manager="docker", package=ref,
                          current="sha256:old", candidate="sha256:new")
        row = self.conn.execute("SELECT id FROM findings ORDER BY id DESC LIMIT 1").fetchone()
        db.set_status(self.conn, [row["id"]], status)
        self.conn.commit()
        return row["id"]

    def adopt(self, actor: str = "sync") -> dict:
        outcome = applier.adopt_discovered(self.conn, self.settings, actor=actor)
        self.conn.commit()
        return outcome

    def remit(self) -> list[dict]:
        return db.list_rollout_targets(self.conn)

    def run_rollouts(self, **kwargs) -> dict:
        return applier.apply_rollouts(self.conn, self.settings, self.policy,
                                      now=kwargs.pop("now", AT), **kwargs)


class TheDefaultIsStillNothing(AdoptCase):
    def test_an_unconfigured_adoption_mode_claims_nothing(self):
        # The shipped posture, and the one thing that must not change by accident.
        self.with_posture("off")
        self.finding()
        outcome = self.adopt()
        self.assertFalse(outcome["adopting"])
        self.assertEqual(0, outcome["adopted"])
        self.assertEqual([], self.remit())

    def test_a_pass_takes_nothing_on_its_own_with_adoption_off(self):
        self.with_posture("off")
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(0, result["adopted"])
        self.assertEqual([], self.remit())
        self.assertEqual([], self.fake.up_calls())
        self.assertIn("no containers in the remit", result["summary"])


class WatchedFillsTheRemitAndArmsNothing(AdoptCase):
    def setUp(self):
        super().setUp()
        self.with_posture("watched")

    def test_the_scan_fills_the_remit_without_arming_it(self):
        self.finding()
        outcome = self.adopt(actor="the-timer")
        self.assertTrue(outcome["adopting"])
        self.assertEqual(1, outcome["adopted"])
        rows = self.remit()
        self.assertEqual(1, len(rows))
        self.assertEqual(0, rows[0]["auto"], "watched is not unattended")
        self.assertEqual("the-timer", rows[0]["created_by"])
        self.assertIn("adopted automatically", rows[0]["note"])

    def test_a_pass_leaves_watched_containers_running(self):
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(1, result["adopted"])
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual(rollout.MANUAL_ONLY, result["decisions"][0]["code"])
        self.assertIn("adopted 1 container(s) from the scans", result["summary"])


class UnattendedAdoptsAndRolls(AdoptCase):
    def test_the_scan_fills_the_remit_unattended(self):
        self.finding()
        outcome = self.adopt(actor="the-timer")
        self.assertEqual(1, outcome["adopted"])
        self.assertEqual(1, self.remit()[0]["auto"])

    def test_a_pass_adopts_and_then_rolls_in_one_run(self):
        # The point of the posture: nobody clicks, and the container is updated at the end
        # of the scan the operator already scheduled.
        self.finding()
        result = self.run_rollouts(trigger="schedule")
        self.assertEqual(1, result["adopted"])
        self.assertEqual(1, result["rolled"])
        self.assertEqual(1, len(self.fake.up_calls()))
        self.assertEqual(rollout.ROLLED, self.conn.execute(
            "SELECT state FROM container_rolls ORDER BY id DESC LIMIT 1").fetchone()["state"])

    def test_the_adoption_is_written_down_with_who_did_it(self):
        self.finding()
        self.run_rollouts(actor="the-timer")
        rows = db.list_events(self.conn, limit=200)
        adopted = [row for row in rows if "rollout remit: adopted" in row["message"]]
        self.assertTrue(adopted, "the remit changed with nothing in the log saying so")
        self.assertEqual("the-timer", adopted[0]["actor"])
        self.assertIn(REF, adopted[0]["message"])
        # And the run itself says what it took on, because "1 rolled" in a log does not
        # say whether that container was claimed by a person or by the pass.
        run = self.conn.execute("SELECT summary FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertIn("adopted 1 container(s)", run["summary"])

    def test_a_host_this_deployment_no_longer_reaches_is_not_adopted(self):
        # Adoption of a container nobody can roll is a row that only ever reads as
        # coverage.
        self.with_posture("unattended", hosts=(self.host,))
        self.finding(host="i2")
        outcome = self.adopt()
        self.assertEqual(0, outcome["adopted"])
        self.assertEqual([], self.remit())

    def test_the_finding_is_keyed_the_way_a_remit_is(self):
        # A finding's target is the incus container, or the host's own name when Docker
        # runs on the host — and the remit's `container` is "" for the second of those.
        # Getting this wrong adopts a container under a name the roll then cannot match.
        self.finding(kind="host", container="")
        self.assertEqual(1, self.adopt()["adopted"])
        self.assertEqual("", self.remit()[0]["container"])


class WhatStaysOut(AdoptCase):
    def test_a_skipped_finding_is_a_person_not_a_discovery(self):
        # `skipped` is an operator on the Findings page saying "leave this one", so it
        # outranks a scan that merely found it.
        self.finding(status="skipped")
        self.assertEqual(0, self.adopt()["adopted"])
        self.assertEqual([], self.remit())

    def test_a_released_container_is_not_adopted_straight_back(self):
        # Without this the next pass would undo the operator's release, and a control that
        # undoes itself lasts until the next scan.
        self.finding()
        db.claim_rollout_target(self.conn, rollout.Remit(
            host="i1", container="monarch", ref=REF, created_by="alice"))
        self.assertTrue(db.release_rollout_target(self.conn, host="i1",
                                                 container="monarch", ref=REF))
        db.opt_out_rollout_target(self.conn, host="i1", container="monarch", ref=REF,
                                  reason="the imaging window", actor="alice")
        self.conn.commit()
        outcome = self.adopt()
        self.assertEqual(0, outcome["adopted"])
        self.assertEqual(1, outcome["kept_out"])
        self.assertEqual([], self.remit())

    def test_a_pass_does_not_put_a_released_container_back(self):
        self.finding()
        db.opt_out_rollout_target(self.conn, host="i1", container="monarch", ref=REF,
                                  reason="hands off", actor="alice")
        self.conn.commit()
        result = self.run_rollouts()
        self.assertEqual(0, result["adopted"])
        self.assertEqual(1, result["kept_out"])
        self.assertEqual([], self.remit())
        # And the run says so, because "no containers in the remit" on a deployment where
        # every container was released reads as a Network with nothing to do.
        self.assertIn("kept out of the remit by hand", result["summary"])

    def test_a_released_container_alongside_an_owned_one_is_only_counted_once(self):
        self.finding(ref="ghcr.io/innotelinc/monarch/api:1.4")
        self.finding(ref="ghcr.io/innotelinc/monarch/web:2", container="monarch-web")
        db.opt_out_rollout_target(self.conn, host="i1", container="monarch-web",
                                  ref="ghcr.io/innotelinc/monarch/web:2", actor="alice")
        self.conn.commit()
        result = self.run_rollouts()
        self.assertEqual(1, result["adopted"])
        self.assertEqual(1, result["kept_out"])
        self.assertEqual(1, result["rolled"])
        # The run that *was* opened carries both facts, because this is the shape an
        # incident review reads a week later: what it took on, and what it left alone
        # because a person had said so.
        run = self.conn.execute("SELECT summary FROM runs ORDER BY id DESC LIMIT 1")
        recorded = run.fetchone()["summary"]
        self.assertIn("adopted 1 container(s)", recorded)
        self.assertIn("kept out of the remit by hand", recorded)

    def test_a_claim_keeps_the_terms_a_person_chose(self):
        # A claim can be watched-only, or windowed, or carry a note somebody will read
        # during an incident. Re-writing it from a discovery would throw away the only
        # part of the remit anybody actually decided.
        db.claim_rollout_target(self.conn, rollout.Remit(
            host="i1", container="monarch", ref=REF, auto=False, note="asked for by ops",
            window_start_hour=2, window_end_hour=4, created_by="alice"))
        self.conn.commit()
        self.finding()
        outcome = self.adopt()
        self.assertEqual(0, outcome["adopted"])
        row = self.remit()[0]
        self.assertEqual(0, row["auto"])
        self.assertEqual("asked for by ops", row["note"])
        self.assertEqual(2, row["window_start_hour"])
        self.assertEqual("alice", row["created_by"])

    def test_adopting_twice_does_not_duplicate_or_flap(self):
        self.finding()
        self.assertEqual(1, self.adopt()["adopted"])
        self.assertEqual(0, self.adopt()["adopted"])
        self.assertEqual(1, len(self.remit()))

    def test_a_skipped_finding_is_still_not_adopted_after_other_rows_are(self):
        # The two live side by side: one image a scan found, one an operator waved off.
        self.finding(ref="ghcr.io/innotelinc/monarch/api:1.4")
        self.finding(ref="ghcr.io/innotelinc/monarch/web:2", status="skipped")
        self.assertEqual(1, self.adopt()["adopted"])
        self.assertEqual([REF], [row["ref"] for row in self.remit()])


class TheOptOutIsADoorNotAWall(AdoptCase):
    def test_claiming_again_lifts_it(self):
        self.finding()
        db.opt_out_rollout_target(self.conn, host="i1", container="monarch", ref=REF,
                                  reason="released by hand", actor="alice")
        self.conn.commit()
        self.assertEqual(1, self.adopt()["kept_out"])
        self.assertEqual([], self.remit())

        # The way back in: a person claims it again, which lifts the deny list first.
        self.assertTrue(db.lift_rollout_optout(self.conn, host="i1", container="monarch",
                                              ref=REF))
        db.claim_rollout_target(self.conn, rollout.Remit(host="i1", container="monarch",
                                                        ref=REF, created_by="alice"))
        self.conn.commit()
        outcome = self.adopt()
        self.assertEqual(0, outcome["adopted"], "it is already claimed")
        self.assertEqual(0, outcome["kept_out"], "and no longer on the deny list")
        self.assertEqual(1, len(self.remit()))

    def test_lifting_one_that_was_never_there_reports_that(self):
        self.assertFalse(db.lift_rollout_optout(self.conn, host="i1", container="monarch",
                                               ref=REF))


if __name__ == "__main__":
    unittest.main()
