#!/usr/bin/env python3
"""Unit tests for the unattended roll itself — `applier._roll_one` and `apply_rollouts`.

`test_rollout.py` pins the rails, and a rail is worth nothing if the code under it
stops the container anyway. This file pins the parts that touch a machine:

  * **Nothing is stopped until the tag has actually moved.** The pull is the verdict;
    an owned container whose tag resolves to what is already running is left alone
    (the finding was stale, or the scan could not judge it and protected the row), and
    a registry that refuses the pull restarts nothing.
  * **The health gate decides, and the rollback follows it.** A container that comes up
    healthy is recorded `rolled`; one that does not is put back on the previous image,
    recorded `rolled-back`, and *held* so the next timer does not try again.
  * **A rollback that cannot happen is reported as `failed`, not as success.** If the
    previous image is gone from the host, saying "rolled" would be the one lie an
    operator cannot recover from.
  * **The caps count attempts that changed something**, so a run cannot be stopped by
    containers that needed nothing.
  * **A composed invocation is the container's own.** The project name, working
    directory and `-f` set come from the container's labels, and the plan check that
    refuses an incomplete stack refuses the roll too — before the stop, not during.

The remote is faked exactly as `test_applier.py` fakes it, because the point is the
*decision to write* and not the SSH client: every command the roll would run is recorded,
so the assertions can be about which commands were issued rather than about what the
function returned.
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import applier, db, registry, rollout  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from ontrak.policy import Policy  # noqa: E402
from ontrak.remote import Result  # noqa: E402

REF = "ghcr.io/innotelinc/monarch/api:1.4"
AT = datetime(2026, 11, 3, 3, 30, tzinfo=timezone.utc)


class FakeDocker:
    """A host with one compose project on it, answering the roll's commands.

    Only what a roll issues is modelled: the ancestor listing, the compose labels, the
    plan, the pull, the image ids and the container's state. Everything else answers
    emptily, which is what makes an *unexpected* command visible in `self.calls`.
    """

    def __init__(self):
        self.calls: list[tuple] = []
        # The container running the image, as (id, name); empty means nothing runs it.
        self.containers: list[tuple[str, str]] = [("cid-1", "monarch-api-1")]
        self.image_id = "sha256:oldimage"
        self.pulled_id = "sha256:newimage"
        self.running_now = self.image_id
        self._tagged_back = False
        self._last_up_was_rollback = False
        # What the container is running once the recreate has happened. The default is
        # the new image; setting it back to `image_id` is how a recreate that arrived on
        # the old layer is expressed, which is the case the roll has to notice and
        # report rather than call a success.
        self.after_up_id = "sha256:newimage"
        self.pull_rc = 0
        self.pull_stderr = ""
        self.compose_up_rc = 0
        self.status = "running"
        self.health = "healthy"
        self.has_healthcheck = True
        self.labels = {
            "com.docker.compose.project": "monarch",
            "com.docker.compose.service": "api",
            "com.docker.compose.project.working_dir": "/srv/monarch",
            "com.docker.compose.project.config_files": "/srv/monarch/compose.yml",
        }
        self.planned_services = ["api"]
        self.running_services = ["api"]
        self.profiles: list[str] = []
        self.config_fail = ""
        # Whether the image the roll wants to put back is still on the host.
        self.old_image_present = True
        self.tag_rc = 0
        # Set when the rollback's own `compose up` should be the one that fails.
        self.rollback_up_rc = 0
        self.rollback_status = "running"

    # ── the remote ───────────────────────────────────────────────────────────
    def docker_in_container(self, host, container, args, timeout, stdin_text=None):
        self.calls.append(("docker", tuple(args)))
        head = args[0]
        if head == "ps":
            if any(a.startswith("ancestor=") for a in args):
                return Result("docker ps", 0,
                              "".join(f"{cid}|{name}\n" for cid, name in self.containers), "")
            return Result("docker ps", 0,
                          "".join(f"{s}\n" for s in self.running_services), "")
        if head == "inspect":
            fmt = args[2] if len(args) > 2 else ""
            if "Labels" in fmt:
                return Result("docker inspect", 0, json.dumps(self.labels), "")
            if "State.Status" in fmt:
                # The health gate's one command. The status it reports is the one the
                # fake was told to have, so a rollback case is a state and not a race.
                status = self.rollback_status if self._rolled_back else self.status
                has = "yes" if self.has_healthcheck else ""
                return Result("docker inspect", 0, f"{status}|{self.health}|{has}\n", "")
            # `{{.Image}}` — the id the target container is running, which changes when
            # the recreate happens and changes back when the rollback does.
            return Result("docker inspect", 0, self._running_id + "\n", "")
        if head == "image":
            target = args[-1]
            if target == REF:
                return Result("docker image inspect", 0, self.pulled_id + "\n", "")
            if self.old_image_present:
                return Result("docker image inspect", 0, self.image_id + "\n", "")
            return Result("docker image inspect", 1, "", "No such image")
        if head == "tag":
            self.calls.append(("tag", args[1], args[2]))
            if self.tag_rc == 0:
                # The tag now points at the old image, so the next `up` will bring the
                # container back onto it — which is what a rollback *is*.
                self._tagged_back = True
            return Result("docker tag", self.tag_rc, "", "" if self.tag_rc == 0 else "denied")
        if head == "pull":
            return Result("docker pull", self.pull_rc, "",
                          self.pull_stderr if self.pull_rc else "")
        if head == "compose":
            if "config" in args:
                if "config_fail" in self.config_fail or self.config_fail:
                    return Result("docker compose config", 1, "", self.config_fail)
                if "--profiles" in args:
                    # `config --profiles` names what the files declare; compose does not
                    # record which of them a running stack was started with.
                    return Result("docker compose config", 0,
                                  "".join(f"{p}\n" for p in self.profiles), "")
                # With a profile enabled, what the stack manages is the wider set — which
                # is the whole reason the applier widens at all.
                table = (self.planned_with_profiles if "--profile" in args
                         else self.planned_services)
                return Result("docker compose config", 0,
                              "".join(f"{s}\n" for s in table), "")
            self.calls.append(("compose-up", tuple(args)))
            # WHERE THE CONTAINER LANDS IS DECIDED BY THE TAG, exactly as it is on a
            # real host: `up` recreates from whatever the ref resolves to, so a recreate
            # after a `docker tag` of the previous image comes back on the previous
            # image. Modelling it that way is what makes a second roll in the same test
            # (after a rollback and a clear) behave like the first one.
            putting_back = self._tagged_back
            self._tagged_back = False
            self._last_up_was_rollback = putting_back
            self.running_now = self.image_id if putting_back else self.after_up_id
            rc = self.rollback_up_rc if putting_back else self.compose_up_rc
            return Result("docker compose up", rc, "", "")
        return Result("docker", 0, "", "")

    @property
    def _rolled_back(self) -> bool:
        """Whether the most recent recreate put the previous image back."""
        return self._last_up_was_rollback

    @property
    def _running_id(self) -> str:
        """What the container is running right now."""
        return self.running_now

    running_now = "sha256:oldimage"
    _tagged_back = False
    _last_up_was_rollback = False

    def ssh(self, host, remote_argv, timeout, stdin_text=None):
        return Result("ssh", 0, "", "")

    def incus_exec(self, host, container, command, timeout, stdin_text=None):
        return Result("incus exec", 0, "", "")

    def up_calls(self) -> list[tuple]:
        return [call for call in self.calls if call[0] == "compose-up"]


class RollCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.fake = FakeDocker()
        self.host = Host("i1", "192.168.1.51", "both")
        self.settings = Settings(hosts=(self.host,), rollout_enabled=True)
        self.policy = Policy()
        patcher = mock.patch.multiple(applier,
                                      ssh=self.fake.ssh,
                                      incus_exec=self.fake.incus_exec,
                                      docker_in_container=self.fake.docker_in_container)
        patcher.start()
        self.addCleanup(patcher.stop)
        reg = mock.patch.multiple(registry, docker_in_container=self.fake.docker_in_container)
        reg.start()
        self.addCleanup(reg.stop)
        self.claim()

    def claim(self, **overrides):
        fields = dict(host="i1", ref=REF, container="monarch", project="monarch",
                      service="api", created_by="alice")
        fields.update(overrides)
        db.claim_rollout_target(self.conn, rollout.Remit(**fields))
        self.conn.commit()

    def finding(self, status="pending"):
        """The scan's finding, which is the precondition for a roll even being attempted."""
        target_id = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target_id, manager="docker", package=REF,
                          current="sha256:old", candidate="sha256:new")
        row = self.conn.execute("SELECT id FROM findings WHERE manager='docker'").fetchone()
        db.set_status(self.conn, [row["id"]], status)
        return row["id"]

    def run_rollouts(self, **kwargs):
        return applier.apply_rollouts(self.conn, self.settings, self.policy,
                                      now=kwargs.pop("now", AT), **kwargs)

    def last_roll(self):
        return self.conn.execute(
            "SELECT * FROM container_rolls ORDER BY id DESC LIMIT 1").fetchone()


class ThePullIsTheVerdict(RollCase):
    def test_a_tag_that_moved_is_rolled(self):
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled"])
        self.assertEqual(1, len(self.fake.up_calls()))
        self.assertEqual(rollout.ROLLED, self.last_roll()["state"])
        self.assertIn("rolled to", self.last_roll()["reason"])

    def test_a_tag_that_did_not_move_is_left_running(self):
        # The finding said behind and the registry disagrees: the image was republished
        # back, or the row was protected rather than judged. Either way the container is
        # not restarted to arrive where it already is.
        self.finding()
        self.fake.pulled_id = self.fake.image_id
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual(rollout.ROLL_UNTOUCHED, self.last_roll()["state"])
        self.assertIn("already running the current image", self.last_roll()["reason"])

    def test_a_registry_that_refuses_the_pull_restarts_nothing(self):
        self.finding()
        self.fake.pull_rc = 1
        self.fake.pull_stderr = "429 Too Many Requests"
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        row = self.last_roll()
        self.assertEqual(rollout.ROLL_UNTOUCHED, row["state"])
        self.assertIn("429", row["reason"])

    def test_a_refused_pull_does_not_hold_the_container_back(self):
        # A throttled registry clears on its own; blocking a container for a day because
        # Docker Hub was busy is a rail that does harm.
        self.finding()
        self.fake.pull_rc = 1
        self.run_rollouts()
        self.assertEqual("", db.container_roll_blocker(
            self.conn, host="i1", container="monarch", ref=REF))

    def test_an_owned_ref_with_no_finding_is_not_even_asked_about(self):
        # The scan is the precondition: a ref it judged current has no row, and a run
        # over a hundred owned containers should not spend a hundred registry requests
        # re-asking an hour-old question.
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "docker" and c[1][0] == "pull"])

    def test_a_skipped_finding_is_honoured(self):
        # `skipped` is an operator asking for something to be left alone. It is not the
        # same answer as a scan that could not judge, and the roll respects it.
        self.finding(status="skipped")
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())


class TheHealthGate(RollCase):
    def test_a_crash_looping_container_is_rolled_back_and_held(self):
        self.finding()
        self.fake.status = "restarting"
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled_back"])
        self.assertEqual(0, result["rolled"])
        row = self.last_roll()
        self.assertEqual(rollout.ROLLED_BACK, row["state"])
        self.assertIn("did not come up", row["reason"])
        # Held: the next scheduled pass must not try the same image again tonight.
        self.assertTrue(db.container_roll_blocker(self.conn, host="i1",
                                                 container="monarch", ref=REF))

    def test_the_previous_image_is_tagged_back_and_recreated(self):
        self.finding()
        self.fake.status = "exited"
        self.run_rollouts()
        self.assertEqual(2, len(self.fake.up_calls()), "rolled forward, then back")
        tags = [call for call in self.fake.calls if call[0] == "tag"]
        self.assertEqual([("tag", "sha256:oldimage", REF)], tags)

    def test_an_unhealthy_container_is_rolled_back(self):
        self.finding()
        self.fake.health = "unhealthy"
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled_back"])

    def test_a_container_with_no_healthcheck_that_keeps_running_is_left_alone(self):
        # The honest limit of the gate: `running` alone cannot tell a serving process
        # from one that has not restarted yet, and this is the documented behaviour.
        self.finding()
        self.fake.has_healthcheck = False
        self.fake.health = ""
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled"])

    def test_a_rollback_that_cannot_happen_is_a_failure_not_a_success(self):
        # The old image was pruned off the host. Saying "rolled" here would be the one
        # lie an operator cannot recover from.
        self.finding()
        self.fake.status = "exited"
        self.fake.old_image_present = False
        result = self.run_rollouts()
        self.assertEqual(1, result["failed"])
        self.assertEqual(0, result["rolled"])
        row = self.last_roll()
        self.assertEqual(rollout.ROLL_FAILED, row["state"])
        self.assertIn("no longer on the host", row["reason"])

    def test_a_failed_compose_up_is_rolled_back_too(self):
        self.finding()
        self.fake.compose_up_rc = 1
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled_back"])
        self.assertIn("compose up failed", self.last_roll()["reason"])


class TheRecreateIsVerified(RollCase):
    def test_a_recreate_that_arrived_on_the_old_layer_is_not_called_a_roll(self):
        # Compose can decide the image it was asked for is the one already there. The
        # container then keeps running the old layer, and reporting that as a successful
        # roll would put a green row on a container that is still behind — the same
        # distinction `_docker_recreate` makes on the clicked path.
        self.finding()
        self.fake.after_up_id = self.fake.image_id
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        row = self.last_roll()
        self.assertEqual(rollout.ROLL_UNTOUCHED, row["state"])
        self.assertIn("did not replace", row["reason"])


class ThePlanIsTheContainersOwn(RollCase):
    def test_an_incomplete_compose_plan_refuses_the_roll_before_anything_is_stopped(self):
        # The applier's refusal, honoured here ahead of the stop rather than by it.
        self.finding()
        self.fake.running_services = ["api", "worker"]
        self.fake.planned_services = ["api"]
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "docker" and c[1][0] == "pull"])
        decisions = {d["code"] for d in result["decisions"]}
        self.assertIn(rollout.PLAN_REFUSED, decisions)

    def test_a_stack_started_with_profiles_is_widened_rather_than_refused(self):
        self.finding()
        self.fake.running_services = ["api", "worker"]
        self.fake.planned_services = ["api"]
        self.fake.profiles = ["extra"]
        self.fake.planned_with_profiles = ["api", "worker"]
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled"])
        self.assertIn("--profile", self.fake.up_calls()[0][1])

    def test_a_container_compose_cannot_read_is_refused(self):
        self.finding()
        self.fake.config_fail = "yaml: line 3: could not find expected ':'"
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertIn("compose could not read", json.dumps(result["decisions"]))

    def test_the_invocation_is_rebuilt_from_the_containers_own_labels(self):
        self.finding()
        self.run_rollouts()
        argv = list(self.fake.up_calls()[0][1])
        self.assertEqual("compose", argv[0])
        self.assertIn("--project-name", argv)
        self.assertEqual("monarch", argv[argv.index("--project-name") + 1])
        self.assertEqual("api", argv[-1], "the service the container belongs to")


class OwnershipGatesTheRun(RollCase):
    def test_a_container_nobody_claimed_is_not_pulled_or_restarted(self):
        self.conn.execute("DELETE FROM rollout_targets")
        self.conn.commit()
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "docker" and c[1][0] == "pull"])
        self.assertEqual([], [c for c in self.fake.calls if c[0] == "compose-up"])
        self.assertIn("no containers in the remit", result["summary"])

    def test_the_kill_switch_stops_a_claimed_container(self):
        self.settings = Settings(hosts=(self.host,), rollout_enabled=False)
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())

    def test_a_watched_only_remit_is_never_rolled(self):
        self.conn.execute("UPDATE rollout_targets SET auto=0")
        self.conn.commit()
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())

    def test_a_protected_ref_is_never_rolled(self):
        self.settings = Settings(hosts=(self.host,), rollout_enabled=True,
                                 rollout_protected_refs=(REF,))
        self.finding()
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual([], self.fake.up_calls())
        self.assertEqual(rollout.PROTECTED, result["decisions"][0]["code"])

    def test_an_image_nothing_runs_is_reported_rather_than_rolled(self):
        self.finding()
        self.fake.containers = []
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual(rollout.NOT_RUNNING, result["decisions"][0]["code"])


class CapsAndCooldown(RollCase):
    def test_a_container_rolled_recently_is_left_for_its_cooldown(self):
        self.finding()
        db.claim_rollout_target(self.conn, rollout.Remit(
            host="i1", ref="ghcr.io/innotelinc/monarch/web:2", container="monarch", service="web"))
        db.start_container_roll(self.conn, host="i1", container="monarch", name="monarch-web-1",
                                ref=REF, from_image_id="sha256:x")
        last = self.conn.execute("SELECT max(id) AS id FROM container_rolls").fetchone()["id"]
        db.finish_container_roll(self.conn, last, state=rollout.ROLLED,
                                 reason="rolled earlier", to_image_id="sha256:newimage")
        # The stamps are written back relative to the clock the run is *given*, rather
        # than left at the wall clock: the cooldown is an age comparison, and a test that
        # compares a real timestamp against a fixed one passes or fails depending on what
        # day it is run.
        stamp = (AT - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.conn.execute("UPDATE container_rolls SET started_at=?, finished_at=? WHERE id=?",
                          (stamp, stamp, last))
        self.conn.commit()
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        codes = {d["code"] for d in result["decisions"] if d["ref"] == REF}
        self.assertEqual({rollout.COOLDOWN}, codes)

    def test_the_run_limit_counts_containers_it_actually_changed(self):
        # Three owned container refs behind at once, with a limit of two: the third is
        # left with a reason rather than the run stopping silently.
        self.settings = Settings(hosts=(self.host,), rollout_enabled=True, rollout_max_per_run=1)
        self.claim(ref="ghcr.io/innotelinc/monarch/web:2", service="web")
        self.claim(ref="ghcr.io/innotelinc/monarch/worker:2", service="worker")
        for ref in (REF, "ghcr.io/innotelinc/monarch/web:2",
                    "ghcr.io/innotelinc/monarch/worker:2"):
            target_id = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
            db.record_finding(self.conn, target_id=target_id, manager="docker", package=ref,
                              current="sha256:old", candidate="sha256:new")
        self.conn.commit()
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled"])
        self.assertIn(rollout.BATCH_LIMIT, {d["code"] for d in result["decisions"]})

    def test_a_blocking_roll_row_holds_the_container_back(self):
        self.finding()
        self.fake.status = "exited"
        self.run_rollouts()
        # The second pass must not try again: one bad image, one incident.
        self.fake.status = "running"
        before = len(self.fake.up_calls())
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual(before, len(self.fake.up_calls()))
        self.assertEqual(rollout.BLOCKED, result["decisions"][0]["code"])

    def test_clearing_the_block_arms_it_again(self):
        self.finding()
        self.fake.status = "exited"
        self.run_rollouts()
        db.clear_container_roll_blocker(self.conn, host="i1", container="monarch", ref=REF,
                                        actor="alice")
        self.conn.commit()
        self.fake.status = "running"
        result = self.run_rollouts()
        self.assertEqual(1, result["rolled"])


class Undo(RollCase):
    def test_undoing_a_landed_roll_puts_the_previous_image_back(self):
        self.finding()
        self.run_rollouts()
        landed = self.last_roll()["id"]
        outcome = applier.undo_roll(self.conn, self.settings, roll_id=landed, actor="alice")
        self.assertTrue(outcome["ok"], outcome.get("error"))
        self.assertEqual(rollout.ROLLED_BACK, outcome["state"])
        tags = [call for call in self.fake.calls if call[0] == "tag"]
        self.assertIn(("tag", "sha256:oldimage", REF), tags)

    def test_an_undo_leaves_the_container_held(self):
        # Otherwise the next timer rolls it forward again while somebody is still working
        # out why they reached for the undo.
        self.finding()
        self.run_rollouts()
        landed = self.last_roll()["id"]
        applier.undo_roll(self.conn, self.settings, roll_id=landed, actor="alice")
        self.assertTrue(db.container_roll_blocker(self.conn, host="i1",
                                                 container="monarch", ref=REF))

    def test_only_a_roll_that_landed_can_be_undone(self):
        self.finding()
        self.fake.pulled_id = self.fake.image_id  # nothing changed, so nothing landed
        self.run_rollouts()
        outcome = applier.undo_roll(self.conn, self.settings,
                                    roll_id=self.last_roll()["id"], actor="alice")
        self.assertFalse(outcome["ok"])
        self.assertIn("only a roll that landed", outcome["error"])

    def test_undoing_a_roll_whose_previous_image_is_gone_says_so(self):
        self.finding()
        self.run_rollouts()
        landed = self.last_roll()["id"]
        self.fake.old_image_present = False
        outcome = applier.undo_roll(self.conn, self.settings, roll_id=landed, actor="alice")
        self.assertTrue(outcome["ok"])
        self.assertEqual(rollout.ROLL_FAILED, outcome["state"])
        self.assertFalse(outcome["held"])


class TheRecord(RollCase):
    def test_the_row_is_opened_before_anything_is_stopped(self):
        # A service that dies mid-roll leaves a `rolling` row, which is the only evidence
        # that a container may have been left half-replaced.
        self.finding()
        self.fake.compose_up_rc = 1
        self.fake.pull_rc = 0
        self.run_rollouts()
        rows = db.list_container_rolls(self.conn)
        self.assertTrue(rows)
        self.assertEqual("sha256:oldimage", rows[0]["from_image_id"])
        self.assertIsNotNone(rows[0]["finished_at"])

    def test_the_run_is_recorded_against_the_remit(self):
        self.finding()
        result = self.run_rollouts(trigger="manual:alice", actor="alice")
        run = self.conn.execute("SELECT * FROM runs WHERE id=?",
                                (result["run_id"],)).fetchone()
        self.assertEqual("rollout", run["kind"])
        self.assertEqual("manual:alice", run["trigger"])
        self.assertEqual("ok", run["status"])
        events = db.list_events(self.conn)
        self.assertTrue(any("rollout finished" in e["message"] for e in events))

    def test_a_rollback_makes_the_run_partial_rather_than_ok(self):
        self.finding()
        self.fake.status = "exited"
        result = self.run_rollouts()
        run = self.conn.execute("SELECT * FROM runs WHERE id=?",
                                (result["run_id"],)).fetchone()
        self.assertEqual("partial", run["status"])
        self.assertEqual(1, run["failed"])

    def test_the_states_that_hold_a_container_back(self):
        # Which outcomes hold a container back is the *store's* rule
        # (`db.container_roll_blocker`), and this pins it rather than leaving it to a
        # constant that lives somewhere else: a roll that changed the container and ended
        # badly holds it, and one that never got that far does not.
        holding = {
            rollout.ROLLED_BACK: True,
            rollout.ROLL_FAILED: True,
            rollout.ROLLING_ROW: True,
            rollout.ROLLED: False,
            rollout.ROLL_UNTOUCHED: False,
        }
        for state, expected in holding.items():
            self.conn.execute("DELETE FROM container_rolls")
            db.start_container_roll(self.conn, host="i1", container="monarch",
                                    name="monarch-api-1", ref=REF)
            last = self.conn.execute(
                "SELECT max(id) AS id FROM container_rolls").fetchone()["id"]
            db.finish_container_roll(self.conn, last, state=state, reason="for the test")
            self.conn.commit()
            blocked = bool(db.container_roll_blocker(self.conn, host="i1",
                                                     container="monarch", ref=REF))
            self.assertEqual(expected, blocked, f"{state} should block={expected}")

    def test_clearing_a_hold_un_blocks_the_newest_bad_row(self):
        self.conn.execute("DELETE FROM container_rolls")
        for state in (rollout.ROLLED_BACK, rollout.ROLL_FAILED):
            db.start_container_roll(self.conn, host="i1", container="monarch",
                                    name="monarch-api-1", ref=REF)
            last = self.conn.execute(
                "SELECT max(id) AS id FROM container_rolls").fetchone()["id"]
            db.finish_container_roll(self.conn, last, state=state, reason="for the test")
            self.conn.commit()
            self.assertTrue(db.container_roll_blocker(self.conn, host="i1",
                                                      container="monarch", ref=REF))
        cleared = db.clear_container_roll_blocker(self.conn, host="i1", container="monarch",
                                                 ref=REF, actor="alice")
        self.assertEqual(2, cleared, "every uncleared bad row, not only the newest")
        self.assertEqual("", db.container_roll_blocker(self.conn, host="i1",
                                                       container="monarch", ref=REF))

    def test_every_decision_is_reported_with_its_reason(self):
        # A run that does nothing is the normal case, so what it decided has to be
        # legible per container and not only as a count.
        self.finding()
        self.fake.pulled_id = self.fake.image_id
        result = self.run_rollouts()
        self.assertEqual(0, result["rolled"])
        self.assertEqual(1, len(result["decisions"]))
        decision = result["decisions"][0]
        self.assertEqual("i1", decision["host"])
        self.assertEqual(REF, decision["ref"])
        self.assertEqual(rollout.ROLL, decision["code"])
        self.assertIn("rolling", decision["detail"])
