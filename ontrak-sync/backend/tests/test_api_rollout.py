#!/usr/bin/env python3
"""The remit and the roll, driven through the real HTTP application.

`test_rollout.py` proves the rails and `test_rollout_apply.py` proves the execution.
This proves the thing an operator actually touches: that the endpoints exist, that
claiming a container *records who gave it up*, that a remit which cannot be honoured is
refused with the sentence saying why, and that the capabilities are split the way the
docstrings claim — reading the remit is `sync:view`, changing it is `sync:configure`, and
running a pass or undoing a roll is `sync:apply`.

It is deliberately NOT a mock of the routes. `create_app()` builds the real application
and it is called as an ASGI application: FastAPI routes, Pydantic parses the bodies, the
bearer token is authenticated, the capability is checked, and the real `apply_rollouts`
and `undo_roll` run. Only the remote is faked, because a test cannot pull an image.

The fake and the ASGI client are imported from the two test modules that already have
them (`FakeDocker`, and `call` from `test_api_approve`) rather than copied, for the same
reason `test_api_approve` imports `FakeRemote`: three copies of an ASGI client is three
places for it to drift.

WHY THIS SKIPS WITHOUT FASTAPI — see the same note in `test_api_approve.py`. The module
skips where FastAPI is absent rather than failing, and the backend image runs it during
`docker build`, which is the deployment's own gate.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

try:
    import fastapi  # noqa: F401  (imported for its absence, which is a skip)
except ImportError as exc:  # pragma: no cover — the CI runner has no FastAPI
    raise unittest.SkipTest(
        "fastapi is not installed; this drives the HTTP layer, which only the "
        f"backend image has (see requirements.txt) — skipping ({exc})"
    )

from ontrak import api, applier, db, identity, registry, rollout  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from test_api_approve import call  # noqa: E402
from test_rollout_apply import AT, REF, FakeDocker  # noqa: E402


class RolloutApiCase(unittest.TestCase):
    """A real app over a throwaway database, with only the Network faked."""

    TOKEN = "an-integration-token"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),),
            db_path=Path(self.tmp.name) / "ontrak.sqlite3",
            api_token=self.TOKEN,
            scheduler_enabled=False,
            admin_password="a-long-enough-one",
            rollout_enabled=True,
        )
        self.app = api.create_app(self.settings)
        self.conn = self.app.state.conn

        self.fake = FakeDocker()
        patcher = mock.patch.multiple(
            applier,
            ssh=self.fake.ssh,
            incus_exec=self.fake.incus_exec,
            docker_in_container=self.fake.docker_in_container,
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        reg_patcher = mock.patch.multiple(
            registry, docker_in_container=self.fake.docker_in_container)
        reg_patcher.start()
        self.addCleanup(reg_patcher.stop)

    # ── helpers ──────────────────────────────────────────────────────────────
    def claim(self, **body):
        payload = {"host": "i1", "ref": REF, "container": "monarch", "service": "api"}
        payload.update(body)
        return call(self.app, "POST", "/api/rollouts/claim", body=payload, token=self.TOKEN)

    def finding(self, status="pending"):
        """The scan's finding — the precondition for a roll even being attempted."""
        target_id = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target_id, manager="docker", package=REF,
                          current="sha256:old", candidate="sha256:new")
        row = self.conn.execute("SELECT id FROM findings WHERE manager='docker'").fetchone()
        db.set_status(self.conn, [row["id"]], status)
        self.conn.commit()
        return row["id"]

    def analyst_token(self) -> str:
        """A session for a role that may read the Network and change nothing about it."""
        user = identity.create_user(self.conn, username="analyst",
                                    password="a-long-enough-one", role="ANALYST")
        token, _ = identity.create_session(self.conn, user.id)
        self.conn.commit()
        return token

    def rollouts(self):
        return call(self.app, "GET", "/api/rollouts", token=self.TOKEN)


class ReadingAndClaiming(RolloutApiCase):
    def test_reading_the_remit_needs_a_credential(self):
        # It names every container this deployment is allowed to restart, which is a map
        # of the Network's most sensitive machines.
        response = call(self.app, "GET", "/api/rollouts")
        self.assertEqual(401, response.status)

    def test_an_untouched_deployment_owns_nothing_and_says_so(self):
        payload = self.rollouts().json()
        self.assertEqual([], payload["targets"])
        self.assertEqual([], payload["rolls"])
        # The limits are reported even with nothing claimed, so the page can show what a
        # claimed container would be subject to before anybody claims one.
        self.assertGreaterEqual(payload["limits"]["max_per_run"], 1)
        self.assertEqual(24, payload["limits"]["cooldown_hours"])

    def test_a_claim_is_recorded_with_who_made_it(self):
        response = self.claim(note="the imaging VLAN")
        self.assertEqual(200, response.status, response.body)
        target = response.json()["target"]
        # The deployment token is a service principal, and that is what is recorded: a
        # remit created by a script names the script's credential and not a person.
        self.assertEqual(api.SERVICE_ACTOR, target["created_by"])
        self.assertEqual("the imaging VLAN", target["note"])
        self.assertEqual(1, target["auto"])
        payload = self.rollouts().json()
        self.assertEqual([REF], [row["ref"] for row in payload["targets"]])
        self.assertEqual("", payload["targets"][0]["blocked_reason"])
        self.assertIsNone(payload["targets"][0]["last_rolled_at"])
        events = db.list_events(self.conn)
        self.assertTrue(any("now owns" in e["message"] for e in events))

    def test_a_claim_is_on_the_audit_trail_with_the_actor(self):
        self.claim()
        rows = self.conn.execute(
            "SELECT * FROM events WHERE actor IS NOT NULL").fetchall()
        self.assertTrue(rows)

    def test_a_remit_that_cannot_be_honoured_is_refused(self):
        # A remit with no ref is a row that looks like coverage and protects nothing.
        response = call(self.app, "POST", "/api/rollouts/claim",
                        body={"host": "i1", "ref": ""}, token=self.TOKEN)
        self.assertEqual(400, response.status)
        self.assertIn("image ref", response.json()["detail"])
        self.assertEqual([], self.rollouts().json()["targets"])

    def test_a_half_written_window_is_refused(self):
        response = self.claim(window_start_hour=3)
        self.assertEqual(400, response.status)
        self.assertIn("both an opening and a closing hour", response.json()["detail"])

    def test_claiming_twice_updates_the_terms_rather_than_duplicating(self):
        self.claim()
        self.claim(auto=False, cooldown_hours=48, note="now watched")
        targets = self.rollouts().json()["targets"]
        self.assertEqual(1, len(targets))
        self.assertEqual(0, targets[0]["auto"])
        self.assertEqual(48, targets[0]["cooldown_hours"])

    def test_releasing_gives_it_back(self):
        self.claim()
        response = call(self.app, "POST", "/api/rollouts/release",
                        body={"host": "i1", "ref": REF, "container": "monarch"},
                        token=self.TOKEN)
        self.assertEqual(200, response.status)
        self.assertEqual([], self.rollouts().json()["targets"])

    def test_releasing_something_that_was_never_claimed_is_a_404(self):
        # An operator who released the wrong row has to be told, because the row they
        # meant is still being rolled on a timer.
        response = call(self.app, "POST", "/api/rollouts/release",
                        body={"host": "i1", "ref": REF, "container": "monarch"},
                        token=self.TOKEN)
        self.assertEqual(404, response.status)


class Capabilities(RolloutApiCase):
    def test_changing_the_remit_needs_sync_configure(self):
        # The same capability as the timer, because a remit *is* what the timer acts on.
        token = self.analyst_token()
        response = call(self.app, "POST", "/api/rollouts/claim",
                        body={"host": "i1", "ref": REF}, token=token)
        self.assertEqual(403, response.status)
        # The refusal names what they may not do and what they are, because "forbidden"
        # on its own sends somebody to read the source.
        detail = response.json()["detail"]
        self.assertIn("may not configure", detail)
        self.assertIn("ANALYST", detail)
        self.assertEqual([], db.list_rollout_targets(self.conn))

    def test_an_analyst_may_still_read_the_remit(self):
        self.claim()
        token = self.analyst_token()
        self.assertEqual(200, call(self.app, "GET", "/api/rollouts", token=token).status)

    def test_running_a_pass_needs_sync_apply(self):
        self.claim()
        token = self.analyst_token()
        response = call(self.app, "POST", "/api/rollouts/run", token=token)
        self.assertEqual(403, response.status)
        self.assertEqual([], self.fake.up_calls())

    def test_undoing_needs_sync_apply_too(self):
        self.claim()
        token = self.analyst_token()
        response = call(self.app, "POST", "/api/rollouts/undo", body={"roll_id": 1},
                        token=token)
        self.assertEqual(403, response.status)

    def test_a_refusal_is_audited(self):
        # "Who tried to change the remit and was told no" is the question asked after an
        # unauthorised change, and it is unanswerable if only successes are recorded.
        token = self.analyst_token()
        call(self.app, "POST", "/api/rollouts/claim", body={"host": "i1", "ref": REF},
             token=token)
        rows = db.list_events(self.conn, limit=200)
        self.assertTrue(any("lacks sync:configure" in row["message"] for row in rows))


class RunningAPass(RolloutApiCase):
    def test_a_pass_rolls_a_claimed_container_through_the_api(self):
        self.claim()
        self.finding()
        response = call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN)
        self.assertEqual(200, response.status, response.body)
        payload = response.json()
        self.assertEqual(1, payload["rolled"])
        self.assertEqual(1, len(self.fake.up_calls()))
        # The finding the scan raised is closed out by the roll, so the Findings page and
        # the rollout history cannot disagree about a container that was just updated.
        self.assertEqual("applied", self.conn.execute(
            "SELECT status FROM findings WHERE package=?", (REF,)).fetchone()["status"])

    def test_a_pass_with_the_feature_switched_off_reports_why(self):
        # The kill switch is a deployment's decision, and a run has to be able to say
        # that is the reason nothing happened rather than looking like an up-to-date
        # Network.
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),),
            db_path=self.settings.db_path, api_token=self.TOKEN, scheduler_enabled=False,
            admin_password="a-long-enough-one", rollout_enabled=False,
        )
        self.app = api.create_app(self.settings)
        self.conn = self.app.state.conn
        self.claim()
        self.finding()
        payload = call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN).json()
        self.assertEqual(0, payload["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual(rollout.DISABLED, payload["decisions"][0]["code"])

    def test_a_run_in_flight_refuses_a_second_pass(self):
        # The same lock as a scan and an apply: two passes could restart one container
        # twice, or roll a stack while a scan is describing it.
        self.claim()
        self.assertTrue(api.RUN_LOCK.acquire(blocking=False))
        self.addCleanup(api.RUN_LOCK.release)
        response = call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN)
        self.assertEqual(409, response.status)


class UndoingThroughTheApi(RolloutApiCase):
    def test_a_roll_can_be_undone_and_the_container_is_held(self):
        self.claim()
        self.finding()
        call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN)
        roll_id = db.list_container_rolls(self.conn)[0]["id"]
        response = call(self.app, "POST", "/api/rollouts/undo", body={"roll_id": roll_id},
                        token=self.TOKEN)
        self.assertEqual(200, response.status, response.body)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(rollout.ROLLED_BACK, payload["state"])
        self.assertTrue(payload["held"])
        # And it is held: the next pass does not roll it forward again while somebody is
        # still working out why they reached for the undo.
        self.assertTrue(db.container_roll_blocker(self.conn, host="i1",
                                                 container="monarch", ref=REF))

    def test_a_roll_that_never_landed_cannot_be_undone(self):
        self.claim()
        self.finding()
        self.fake.pulled_id = self.fake.image_id       # the tag did not move
        call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN)
        roll_id = db.list_container_rolls(self.conn)[0]["id"]
        response = call(self.app, "POST", "/api/rollouts/undo", body={"roll_id": roll_id},
                        token=self.TOKEN)
        self.assertEqual(400, response.status)
        self.assertIn("only a roll that landed", response.json()["detail"])

    def test_clearing_the_hold_arms_the_container_again(self):
        self.claim()
        self.finding()
        self.fake.status = "exited"                    # it will fail the health gate
        call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN)
        self.assertTrue(db.container_roll_blocker(self.conn, host="i1",
                                                 container="monarch", ref=REF))
        response = call(self.app, "POST", "/api/rollouts/clear",
                        body={"host": "i1", "ref": REF, "container": "monarch"},
                        token=self.TOKEN)
        self.assertEqual(200, response.status)
        self.assertEqual(1, response.json()["cleared"])
        self.assertEqual("", db.container_roll_blocker(self.conn, host="i1",
                                                       container="monarch", ref=REF))

    def test_clearing_needs_sync_approve_not_sync_apply(self):
        # Removing a hold restarts nothing by itself; the next run is what makes it real.
        self.claim()
        token = self.analyst_token()
        response = call(self.app, "POST", "/api/rollouts/clear",
                        body={"host": "i1", "ref": REF}, token=token)
        self.assertEqual(403, response.status)


class Adoption(RolloutApiCase):
    """The posture where the scans fill the remit, driven over the wire.

    `test_rollout_adopt.py` pins what is adopted and what stays out; these four pin the
    things only visible from outside the process: which posture the deployment *says* it
    is in, that a release is still standing after a pass, and that a claim is the way back
    in. The page draws all of that from this payload, so a field missing here is a screen
    an operator cannot trust.
    """

    def adopt_unattended(self):
        """Rebuild the app as a deployment that adopts and rolls what it finds."""
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),),
            db_path=self.settings.db_path, api_token=self.TOKEN, scheduler_enabled=False,
            admin_password="a-long-enough-one", rollout_enabled=True,
            rollout_adopt="unattended",
        )
        self.app = api.create_app(self.settings)
        self.conn = self.app.state.conn

    def test_the_posture_is_reported_and_the_default_is_manual(self):
        payload = self.rollouts().json()
        self.assertEqual("off", payload["adopt"])
        self.assertEqual([], payload["optouts"])

    def test_a_release_is_recorded_and_a_claim_is_the_way_back(self):
        self.claim()
        call(self.app, "POST", "/api/rollouts/release",
             body={"host": "i1", "ref": REF, "container": "monarch",
                   "note": "the imaging window"}, token=self.TOKEN)
        payload = self.rollouts().json()
        self.assertEqual([], payload["targets"])
        self.assertEqual(1, len(payload["optouts"]), "a release has to stay a release")
        self.assertEqual("the imaging window", payload["optouts"][0]["reason"])
        self.assertIsNotNone(payload["optouts"][0]["actor"])

        self.claim()
        payload = self.rollouts().json()
        self.assertEqual([], payload["optouts"], "a claim lifts the release")
        self.assertEqual(1, len(payload["targets"]))

    def test_a_pass_adopts_what_the_scan_found_and_says_so(self):
        self.adopt_unattended()
        self.finding()
        self.assertEqual("unattended", self.rollouts().json()["adopt"])
        payload = call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN).json()
        self.assertEqual(1, payload["adopted"])
        self.assertEqual(1, payload["rolled"])
        targets = self.rollouts().json()["targets"]
        self.assertEqual(1, len(targets))
        self.assertEqual(1, targets[0]["auto"])
        # The deployment token is the principal that did it, which is what "adopted by"
        # has to read as on a deployment where no person was involved.
        self.assertEqual(api.SERVICE_ACTOR, targets[0]["created_by"])

    def test_a_released_container_is_not_put_back_by_the_next_pass(self):
        self.adopt_unattended()
        self.claim()
        self.finding()
        call(self.app, "POST", "/api/rollouts/release",
             body={"host": "i1", "ref": REF, "container": "monarch"}, token=self.TOKEN)
        payload = call(self.app, "POST", "/api/rollouts/run", token=self.TOKEN).json()
        self.assertEqual(0, payload["adopted"])
        self.assertEqual(1, payload["kept_out"])
        self.assertEqual([], self.rollouts().json()["targets"])
        self.assertEqual([], self.fake.up_calls())


if __name__ == "__main__":
    unittest.main()
