#!/usr/bin/env python3
"""Unit tests for ontrak/waves.py — the order an apply touches machines in.

2.2's exit is an ordering property: a failed canary stops the run and every later
host is untouched. That is worth testing as a value rather than as a rollout, so the
plan is pure and these are its tests. The applier's own test file covers the other
half — that the loop actually obeys the plan.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import waves  # noqa: E402
from ontrak.policy import Policy  # noqa: E402


def targets(count: int) -> list[tuple[str, str]]:
    return [(f"i{index}", f"i{index}") for index in range(1, count + 1)]


class TheShapeOfAPlan(unittest.TestCase):
    def test_the_default_is_one_canary_then_waves_of_five(self):
        plan = waves.plan(targets(7), Policy())
        self.assertEqual(["canary", "wave", "wave"], [w.kind for w in plan.waves])
        self.assertEqual([1, 5, 1], [len(w.targets) for w in plan.waves])
        self.assertEqual(targets(7), list(plan.attempted))

    def test_no_canary_means_the_first_wave_is_the_canary_slot(self):
        # 0 is a real setting, not a synonym for 1: a deployment that would rather
        # never single one machine out has to be able to say so.
        plan = waves.plan(targets(3), Policy(apply_canary_targets=0, apply_wave_size=2))
        self.assertEqual(["wave", "wave"], [w.kind for w in plan.waves])
        self.assertFalse(any(w.kind == "canary" for w in plan.waves))

    def test_the_order_passed_in_is_the_order_run(self):
        # The applier's query decides which machine is the canary. If the planner
        # re-sorted, the operator's "canary" would be whichever name sorted first.
        order = [("i9", "z-cache"), ("i1", "a-proxy"), ("i4", "i4")]
        plan = waves.plan(order, Policy(apply_canary_targets=1, apply_wave_size=5))
        self.assertEqual(order[0], plan.waves[0].targets[0])
        self.assertEqual(tuple(order), plan.attempted)

    def test_a_target_appears_once_even_with_several_findings(self):
        duplicated = [("i1", "i1"), ("i1", "i1"), ("i2", "i2")]
        plan = waves.plan(duplicated, Policy(apply_canary_targets=0))
        self.assertEqual([("i1", "i1"), ("i2", "i2")], list(plan.attempted))

    def test_the_cap_leaves_targets_out_and_says_so(self):
        plan = waves.plan(targets(5), Policy(apply_canary_targets=0,
                                             apply_wave_size=2, apply_max_targets=3))
        self.assertEqual(targets(3), list(plan.attempted))
        self.assertEqual(targets(5)[3:], list(plan.capped))
        self.assertIn("apply_max_targets=3", plan.note)

    def test_an_oversized_canary_is_clamped_rather_than_swallowing_the_run(self):
        # `validate()` refuses this combination, but a stored row that skipped the
        # form must not turn into one enormous first wave.
        plan = waves.plan(targets(6), Policy(apply_canary_targets=4, apply_wave_size=2))
        self.assertEqual(2, len(plan.waves[0].targets))
        self.assertEqual(targets(6), list(plan.attempted))

    def test_a_wave_knows_which_targets_a_halt_would_protect(self):
        plan = waves.plan(targets(4), Policy(apply_canary_targets=1, apply_wave_size=2))
        self.assertEqual(("i1", "i1"), plan.waves[0].targets[0])
        self.assertEqual([("i2", "i2"), ("i3", "i3"), ("i4", "i4")],
                         list(plan.after(plan.waves[0])))

    def test_an_empty_apply_is_an_empty_plan(self):
        plan = waves.plan([], Policy())
        self.assertEqual((), plan.waves)
        self.assertEqual((), plan.attempted)


if __name__ == "__main__":
    unittest.main()
