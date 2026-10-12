#!/usr/bin/env python3
"""Unit tests for ontrak/rollout.py — the rails around unattended container rolls.

This module decides whether a container may be pulled and restarted *without anybody
clicking anything*, which is the one thing in this project that can take a Network
down while its dashboard stays green. So the tests here are almost entirely about
refusals, and each one names the accident it prevents:

  * an unowned container is never touched (the remit is the blast radius);
  * a registry that could not be asked is not "up to date" *and* is not a reason to
    restart anything (the three-valued digest, read both ways);
  * a compose plan the applier would refuse is refused **before** a container is
    stopped rather than during;
  * the window, the freeze, the cooldown and the caps all stop a roll, and the
    cooldown says how long is left;
  * a new container that has not become healthy inside its grace period is DOWN, not
    UP-because-it-has-not-failed-yet — the assertion this file exists for;
  * a container held back after a failed roll is not retried on the next timer.

Everything is a pure function of (state, remit, config, policy), so every case below
is a replay and not a simulation: same inputs, same answer, no clock and no network.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import rollout  # noqa: E402
from ontrak.policy import Policy  # noqa: E402

NOW = datetime(2026, 11, 3, 3, 30, tzinfo=timezone.utc)
REF = "ghcr.io/innotelinc/monarch/api:1.4"


def remit(**overrides) -> rollout.Remit:
    base = dict(host="i1", ref=REF, container="monarch", project="monarch", service="api")
    base.update(overrides)
    return rollout.Remit(**base)


def state(**overrides) -> rollout.ContainerState:
    base = dict(host="i1", name="monarch", ref=REF, container="monarch", behind=True,
                project="monarch", service="api")
    base.update(overrides)
    return rollout.ContainerState(**base)


# Kept under a second name so the `decide` helper's own `state` parameter can shadow
# the factory without losing the default it falls back to.
_default_state = state


# A sentinel, because `None` is a meaningful owner here: it is the container nobody
# claimed. A helper that read `None` as "use the default remit" could not test the
# most important refusal in the file.
_DEFAULT = object()


def decide(state=None, owner=_DEFAULT, config=None, policy=None, *, now=NOW, **kwargs):
    """One decision, with the shipped posture unless a test says otherwise."""
    return rollout.decide_roll(
        state if state is not None else _default_state(),
        remit() if owner is _DEFAULT else owner,
        config if config is not None else rollout.RolloutConfig(enabled=True),
        policy if policy is not None else Policy(),
        now=now,
        **kwargs,
    )


class Ownership(unittest.TestCase):
    """The remit is the whole blast radius: if it is not in the list, nothing happens."""

    def test_an_unowned_container_is_left_alone(self):
        decision = decide(owner=None)
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.NOT_OWNED, decision.code)
        self.assertIn("has not been given", decision.detail)
        self.assertFalse(decision.owned)

    def test_a_remit_owns_one_container_and_not_its_neighbour(self):
        # The same image legitimately runs twice on one host. A remit keyed on the image
        # rather than on (host, container, ref) would restart both — and the key below is
        # the tuple the database is really keyed on (`db.rollout_targets`), so a remit
        # cannot mean one thing to a test and another to the store.
        owner = remit(container="monarch")
        self.assertEqual(("i1", "monarch", REF), owner.key())
        self.assertNotEqual(owner.key(), ("i1", "onyx", REF))
        self.assertNotEqual(owner.key(), ("i1", "monarch", "ghcr.io/x/y:1"))
        # A container empty in the remit means Docker on the host itself, which is a
        # different key from any incus container's.
        self.assertEqual(("i1", "", REF), remit(container="").key())

    def test_a_host_taken_out_of_the_configuration_is_not_reached_for(self):
        decision = decide(configured_hosts={"i2"})
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.HOST_NOT_CONFIGURED, decision.code)

    def test_the_kill_switch_ships_off(self):
        # The default posture, not a misconfiguration: enabling this is a decision.
        self.assertFalse(rollout.RolloutConfig().enabled)
        decision = decide(config=rollout.RolloutConfig())
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.DISABLED, decision.code)
        self.assertIn("ONTRAK_ROLLOUT", decision.detail)

    def test_a_watched_remit_raises_findings_and_rolls_nothing(self):
        decision = decide(owner=remit(auto=False))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.MANUAL_ONLY, decision.code)


class RegistryUnknown(unittest.TestCase):
    """Three values, and only one of them rolls."""

    def test_an_unjudged_image_is_not_current(self):
        decision = decide(state(behind=None))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.UNJUDGED, decision.code)
        self.assertIn("unknown is not a reason", decision.detail)

    def test_an_unjudged_image_is_also_not_rolled(self):
        # The bug with the sign flipped: "cannot tell" must not become "restart it".
        self.assertNotEqual(rollout.ROLL, decide(state(behind=None)).code)

    def test_a_current_image_is_left_alone(self):
        decision = decide(state(behind=False))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.CURRENT, decision.code)

    def test_a_behind_image_passes_the_registry_gate(self):
        self.assertTrue(decide().roll)


class NothingRunning(unittest.TestCase):
    """An owned image nothing runs is a finding, not a rollout."""

    def test_an_image_no_container_runs_is_not_rolled(self):
        decision = decide(state=state(behind=True, running=False))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.NOT_RUNNING, decision.code)

    def test_it_is_reported_before_the_window_because_it_is_not_about_the_clock(self):
        decision = decide(state=state(running=False),
                          policy=Policy(window_start_hour=4, window_end_hour=5))
        self.assertEqual(rollout.NOT_RUNNING, decision.code)


class PlanRefusal(unittest.TestCase):
    """The compose refusal the applier already makes, honoured *before* a stop."""

    def test_a_container_compose_cannot_read_is_refused_before_anything_is_stopped(self):
        decision = decide(state(plan_problem="compose could not read project monarch"))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.PLAN_REFUSED, decision.code)
        self.assertIn("compose could not read", decision.detail)

    def test_the_plan_is_checked_before_the_window_is(self):
        # A refusal that is a fact about the container is more use than one about the
        # clock, and it does not depend on a window that a caller could widen.
        decision = decide(state(plan_problem="missing api, worker"),
                          policy=Policy(window_start_hour=4, window_end_hour=5))
        self.assertEqual(rollout.PLAN_REFUSED, decision.code)


class Hours(unittest.TestCase):
    """The window and the freeze, which are the deployment's own (policy.py's)."""

    def test_outside_the_window_nothing_is_rolled(self):
        decision = decide(policy=Policy(window_start_hour=4, window_end_hour=6))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.OUTSIDE_WINDOW, decision.code)
        self.assertIn("04:00", decision.detail)

    def test_inside_the_window_it_rolls(self):
        decision = decide(policy=Policy(window_start_hour=3, window_end_hour=6))
        self.assertTrue(decision.roll)

    def test_a_window_that_wraps_midnight_still_works(self):
        late = datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc)
        policy = Policy(window_start_hour=22, window_end_hour=4)
        self.assertTrue(decide(policy=policy, now=late).roll)
        self.assertEqual(rollout.OUTSIDE_WINDOW,
                         decide(policy=policy,
                                now=datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)).code)

    def test_a_remit_can_narrow_the_hours_for_one_container(self):
        # "Unattended, but not in the hours the trading desk is using it."
        policy = Policy(window_start_hour=0, window_end_hour=23)
        owner = remit(window_start_hour=3, window_end_hour=4)
        self.assertTrue(decide(owner=owner, policy=policy).roll)
        self.assertEqual(rollout.OUTSIDE_WINDOW,
                         decide(owner=owner, policy=policy,
                                now=datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)).code)

    def test_a_change_freeze_stops_every_roll(self):
        policy = Policy(freeze_from="2026-11-01", freeze_to="2026-11-07")
        decision = decide(policy=policy)
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.FREEZE, decision.code)
        self.assertIn("2026-11-07", decision.detail)

    def test_the_freeze_outranks_a_remit_that_widened_its_hours(self):
        policy = Policy(freeze_from="2026-11-01", freeze_to="2026-11-07")
        decision = decide(owner=remit(window_start_hour=0, window_end_hour=23), policy=policy)
        self.assertEqual(rollout.FREEZE, decision.code)


class Cooldown(unittest.TestCase):
    """A tag republished twice an hour must not become a container restarted twice an hour."""

    def test_a_recently_rolled_container_is_left_to_settle(self):
        decision = decide(state(last_roll_at=NOW - timedelta(hours=2)))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.COOLDOWN, decision.code)
        self.assertIn("left of its 24h cooldown", decision.detail)

    def test_after_the_cooldown_it_rolls_again(self):
        self.assertTrue(decide(state(last_roll_at=NOW - timedelta(hours=25))).roll)

    def test_a_remit_can_ask_for_its_own_cooldown(self):
        owner = remit(cooldown_hours=1)
        self.assertTrue(decide(owner=owner, state=state(last_roll_at=NOW - timedelta(hours=2))).roll)

    def test_a_cooldown_of_zero_means_roll_whenever_it_is_behind(self):
        config = rollout.RolloutConfig(enabled=True, cooldown_hours=0)
        self.assertTrue(decide(config=config, state=state(last_roll_at=NOW)).roll)


class Caps(unittest.TestCase):
    """One bad image must not become a Network outage."""

    def test_the_run_limit_stops_the_fourth_container(self):
        config = rollout.RolloutConfig(enabled=True, max_per_run=3)
        self.assertTrue(decide(config=config, rolls_this_run=2).roll)
        decision = decide(config=config, rolls_this_run=3)
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.BATCH_LIMIT, decision.code)

    def test_the_per_host_limit_stops_the_third_container_on_one_host(self):
        config = rollout.RolloutConfig(enabled=True, max_per_host=2)
        decision = decide(config=config, rolls_this_host=2)
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.HOST_LIMIT, decision.code)
        self.assertIn("i1", decision.detail)

    def test_another_host_is_not_paying_for_the_first_host_limit(self):
        config = rollout.RolloutConfig(enabled=True, max_per_host=2)
        self.assertTrue(decide(config=config, rolls_this_host=0).roll)

    def test_the_shipped_posture_is_deliberately_small(self):
        config = rollout.RolloutConfig()
        self.assertLessEqual(config.max_per_run, 3)
        self.assertLessEqual(config.max_per_host, 2)
        self.assertGreaterEqual(config.cooldown_hours, 1)


class Protected(unittest.TestCase):
    """Some images want a person every time, and that must be expressible."""

    def test_a_protected_ref_is_never_rolled(self):
        config = rollout.RolloutConfig(enabled=True, protected_refs=("postgres:16",))
        decision = decide(config=config, state=state(ref="postgres:16"), owner=remit(ref="postgres:16"))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.PROTECTED, decision.code)

    def test_a_registry_spelling_does_not_defeat_the_protection(self):
        config = rollout.RolloutConfig(enabled=True, protected_refs=("postgres:16",))
        decision = decide(config=config,
                          state=state(ref="docker.io/library/postgres:16"),
                          owner=remit(ref="docker.io/library/postgres:16"))
        self.assertEqual(rollout.PROTECTED, decision.code)

    def test_a_different_tag_of_a_protected_image_is_not_protected(self):
        config = rollout.RolloutConfig(enabled=True, protected_refs=("postgres:16",))
        self.assertTrue(decide(config=config, state=state(ref="postgres:17"),
                               owner=remit(ref="postgres:17")).roll)

    def test_an_empty_entry_protects_nothing(self):
        config = rollout.RolloutConfig(enabled=True, protected_refs=("", "   "))
        self.assertTrue(decide(config=config).roll)


class FailedRoll(unittest.TestCase):
    """A roll that had to be undone is a decision, not a retry."""

    def test_a_blocked_container_is_not_retried_on_the_next_timer(self):
        decision = decide(state(blocked_reason="api did not become healthy after 90s"))
        self.assertFalse(decision.roll)
        self.assertEqual(rollout.BLOCKED, decision.code)
        self.assertIn("did not become healthy", decision.detail)

    def test_being_blocked_outranks_being_protected_or_unjudged(self):
        # The first reason reported is the one an operator acts on, and "you cleared this
        # one and it still will not roll" is a better sentence than "it is protected".
        config = rollout.RolloutConfig(enabled=True, protected_refs=("monarch/api:1.4",))
        self.assertEqual(rollout.BLOCKED,
                         decide(config=config, state=state(blocked_reason="boom", behind=None)).code)

    def test_clearing_the_block_lets_it_roll_again(self):
        self.assertTrue(decide(state(blocked_reason="")).roll)


class HealthGate(unittest.TestCase):
    """Did the new container actually come up? The assertion this file exists for."""

    def gate(self, *, status, health="", has_healthcheck=True, elapsed=0.0, grace=90):
        return rollout.health_verdict(status=status, health=health,
                                      has_healthcheck=has_healthcheck,
                                      elapsed_seconds=elapsed, grace_seconds=grace)

    def test_a_running_healthy_container_is_up(self):
        self.assertEqual(rollout.UP, self.gate(status="running", health="healthy"))

    def test_an_unhealthy_container_is_down(self):
        self.assertEqual(rollout.DOWN, self.gate(status="running", health="unhealthy"))

    def test_an_exited_container_is_down(self):
        self.assertEqual(rollout.DOWN, self.gate(status="exited"))

    def test_a_crash_looping_container_is_down_at_once(self):
        # `restarting` means the process exited and the restart policy picked it up, so
        # the new image has already failed. Waiting out the grace period would spend
        # ninety seconds serving nothing from the new image, and the rollback is the
        # answer either way.
        self.assertEqual(rollout.DOWN, self.gate(status="restarting", elapsed=0))

    def test_a_container_that_is_still_starting_at_the_end_of_the_grace_period_is_down(self):
        # Not "up because it has not failed yet". A healthcheck that never reports is a
        # service that never served, and every minute past the grace is a minute the
        # Network is on the new image and not being served by it.
        self.assertEqual(rollout.DOWN,
                         self.gate(status="running", health="starting", elapsed=90))
        self.assertEqual(rollout.DOWN, self.gate(status="created", elapsed=91))

    def test_inside_the_grace_period_it_is_still_starting(self):
        self.assertEqual(rollout.STARTING,
                         self.gate(status="running", health="starting", elapsed=30))

    def test_an_image_without_a_healthcheck_is_judged_on_running_alone(self):
        # Stated rather than hidden: this gate cannot tell a serving process from one
        # that has not restarted yet, and the plan says so.
        self.assertEqual(rollout.UP,
                         self.gate(status="running", health="", has_healthcheck=False))
        self.assertEqual(rollout.DOWN,
                         self.gate(status="created", health="", has_healthcheck=False, elapsed=90))

    def test_a_status_the_daemon_spells_differently_is_not_treated_as_up(self):
        self.assertEqual(rollout.STARTING, self.gate(status="Running", health="Starting", elapsed=1))


class Reporting(unittest.TestCase):
    """A run that does nothing is the normal case, and it has to say which nothing."""

    def test_the_summary_counts_the_refusals_by_code(self):
        decisions = [
            decide(),
            decide(state=state(behind=False)),
            decide(state=state(behind=False, name="onyx")),
            decide(owner=None),
        ]
        summary = rollout.summarize(decisions)
        self.assertIn("1 rolled", summary)
        self.assertIn("already-current ×2", summary)
        self.assertIn("not-owned ×1", summary)

    def test_an_empty_remit_says_so(self):
        self.assertEqual("no containers in the remit", rollout.summarize([]))

    def test_every_decision_code_has_a_label(self):
        # The closed set is declared in `rollout.py` rather than discovered by scanning the
        # module, so a new rail that forgot its label fails here instead of rendering a raw
        # slug in a dashboard column.
        self.assertEqual(rollout.DECISION_CODES, rollout.REFUSAL_CODES | {rollout.ROLL})
        for code in sorted(rollout.DECISION_CODES):
            self.assertNotEqual(code, rollout.describe(code), f"{code} has no label")

    def test_the_roll_outcome_states_are_not_decision_codes(self):
        # Two vocabularies that look alike and mean different things: what a run *decided*
        # (`decision.code`) and how a roll that actually ran *ended*
        # (`container_rolls.state`). Mixing them would make a run report count a refusal as
        # a successful roll.
        for state in (rollout.ROLLED, rollout.ROLLED_BACK, rollout.ROLL_FAILED,
                      rollout.ROLL_UNTOUCHED, rollout.ROLLING_ROW):
            self.assertNotIn(state, rollout.DECISION_CODES)

    def test_the_next_attempt_is_the_cooldown_away(self):
        self.assertEqual(NOW + timedelta(hours=24), rollout.next_attempt(NOW, 24))


class Validation(unittest.TestCase):
    def test_a_half_written_window_is_refused(self):
        problems = rollout.Remit(host="i1", ref=REF, window_start_hour=3).validate()
        self.assertTrue(any("both an opening and a closing hour" in p for p in problems))

    def test_a_remit_must_name_a_host_and_a_ref(self):
        problems = rollout.Remit(host="  ", ref="").validate()
        self.assertEqual(2, len(problems))

    def test_hours_and_cooldowns_are_range_checked(self):
        problems = rollout.Remit(host="i1", ref=REF, window_start_hour=24,
                                 window_end_hour=25, cooldown_hours=-1).validate()
        self.assertTrue(any("0-23" in p for p in problems))
        self.assertTrue(any("negative" in p for p in problems))

    def test_a_remit_round_trips_through_the_database_form(self):
        owner = remit(auto=False, note="the imaging VLAN", created_by="alice")
        again = rollout.Remit.from_dict(owner.as_dict())
        self.assertEqual(owner.as_dict(), again.as_dict())


class Purity(unittest.TestCase):
    """No clock, no database, no ssh — so a case can be replayed exactly."""

    def test_the_same_inputs_give_the_same_answer(self):
        first = decide()
        second = decide()
        self.assertEqual((first.roll, first.code), (second.roll, second.code))

    def test_the_clock_arrives_as_an_argument(self):
        # A `datetime.now()` inside `decide_roll` would make the cooldown unmeasurable
        # and this test pass at 03:30 and fail in the afternoon. Here the only thing
        # that changes between the two calls is `now`, and only the age-dependent rail
        # changes its answer.
        cooled = state(last_roll_at=NOW - timedelta(hours=2))
        self.assertEqual(rollout.COOLDOWN, decide(state=cooled, now=NOW).code)
        self.assertEqual(rollout.ROLL, decide(state=cooled, now=NOW + timedelta(hours=25)).code)

    def test_every_rolling_decision_carries_the_remit_it_acted_on(self):
        decision = decide()
        self.assertTrue(decision.roll)
        self.assertEqual(rollout.ROLL, decision.code)
        self.assertIsNotNone(decision.remit)
        self.assertTrue(decision.owned)


if __name__ == "__main__":
    unittest.main(verbosity=2)
