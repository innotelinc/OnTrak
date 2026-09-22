#!/usr/bin/env python3
"""Unit tests for grade-sweep.py — the reading half, which is where it can lie.

The sweep drives real machines, so its slow half cannot run here; what *can* run is
everything that decides what the run means, and that is the half worth pinning down.
A sweep is looked at by a person once, under time pressure, to answer one question —
is the pool fit to teach on — and both ways of getting it wrong are silent:

* a **false "ok"** is a fault that is not in the snapshot, discovered by a classroom;
* a **false "BROKEN"** is a healthy range reported as broken, which teaches whoever
  reads it to ignore the table, and then the real failure goes past unnoticed too.

The rules here are the two claims the tool exists to check, and each test below is one
way a run can be misread. The module under test has a hyphen in its name, so it is
loaded by path.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "grade-sweep.py"

spec = importlib.util.spec_from_file_location("grade_sweep", SCRIPT)
assert spec and spec.loader
grade_sweep = importlib.util.module_from_spec(spec)
sys.modules["grade_sweep"] = grade_sweep
spec.loader.exec_module(grade_sweep)


def report(score: float, passed: int, total: int, resolved: bool, objectives: dict | None = None):
    return {
        "score": score,
        "resolved": resolved,
        "passed": passed,
        "total": total,
        "error": None,
        "objectives": objectives or {},
    }


def record(pair: str = "id-locked-account", **overrides):
    base = {
        "pair": pair,
        "scenario": pair.split("@")[0],
        "untouched": report(20.0, 1, 5, resolved=False),
        "repaired": report(100.0, 5, 5, resolved=True),
        "repair": {"ok": True, "exit_code": 0},
    }
    base.update(overrides)
    return base


class VerdictTests(unittest.TestCase):
    def test_a_broken_range_that_repairs_is_ok(self):
        self.assertEqual(grade_sweep.verdict(record(), repairs_expected=True), "ok")

    def test_a_fault_missing_from_the_snapshot_is_reported(self):
        """The failure this tool exists for: full marks for no work at all."""
        broken = record(untouched=report(100.0, 5, 5, resolved=True))
        self.assertTrue(
            grade_sweep.verdict(broken, repairs_expected=True).startswith("BROKEN")
        )

    def test_a_repair_that_cannot_pass_is_reported(self):
        """The other failure: grading the injection rather than the student's work."""
        stuck = record(repaired=report(80.0, 4, 5, resolved=False))
        self.assertTrue(grade_sweep.verdict(stuck, repairs_expected=True).startswith("BROKEN"))

    def test_a_repair_short_of_full_marks_is_reported(self):
        nearly = record(repaired=report(80.0, 4, 5, resolved=True))
        self.assertTrue(grade_sweep.verdict(nearly, repairs_expected=True).startswith("BROKEN"))

    def test_the_grade_outranks_the_repair_scripts_exit_code(self):
        """A repair may legitimately drop the transport it runs over.

        ``net-static-ip-conflict`` hands the machine's address back to DHCP in its last
        line, so the grade is what is read — treating a non-zero exit as failure would
        mark a correct repair broken and send someone chasing a working scenario.
        """
        dropped = record(repair={"ok": False, "exit_code": 1, "stderr": "connection reset"})
        self.assertTrue(grade_sweep.verdict(dropped, repairs_expected=True).startswith("ok"))
        self.assertIn("transport dropped", grade_sweep.verdict(dropped, repairs_expected=True))

    def test_an_untouched_only_run_says_so_rather_than_claiming_ok(self):
        """Without a repairs file the second claim was never tested, and the table says it."""
        half = record(repaired=None)
        call = grade_sweep.verdict(half, repairs_expected=False)
        self.assertTrue(call.startswith("ok"))
        self.assertIn("untouched only", call)

    def test_a_missing_repair_with_a_repairs_file_is_incomplete_not_ok(self):
        call = grade_sweep.verdict(record(repaired=None), repairs_expected=True)
        self.assertTrue(call.startswith("incomplete"))

    def test_a_pair_that_could_not_be_graded_is_not_ok(self):
        call = grade_sweep.verdict({"pair": "x", "error": "IncusError: no image"}, repairs_expected=True)
        self.assertTrue(call.startswith("BROKEN"))

    def test_an_empty_record_is_incomplete_rather_than_a_pass(self):
        self.assertTrue(
            grade_sweep.verdict({"pair": "x"}, repairs_expected=True).startswith("incomplete")
        )


class TableTests(unittest.TestCase):
    def test_a_clean_sweep_says_so_and_shows_both_grades(self):
        text = grade_sweep.table([record("a"), record("b")], repairs_expected=True)
        self.assertIn("20% 1/5", text)
        self.assertIn("100% 5/5", text)
        self.assertIn("every pair: broken untouched, resolved after repair", text)
        self.assertNotIn("need attention", text)

    def test_a_failed_pair_is_named_with_its_failing_objective(self):
        """Whoever reads this has to be able to act without opening the JSON lines."""
        rows = [
            record("a"),
            record(
                "b",
                repaired=report(50.0, 1, 2, resolved=False, objectives={"fix-route": (False, "no route to host")}),
            ),
        ]
        text = grade_sweep.table(rows, repairs_expected=True)
        self.assertIn("1 pair(s) need attention", text)
        self.assertIn("== b:", text)
        self.assertIn("FAIL fix-route: no route to host", text)

    def test_an_empty_sweep_does_not_print_a_clean_bill_of_health(self):
        self.assertEqual(grade_sweep.table([], repairs_expected=True), "nothing was graded")


class RepairsFileTests(unittest.TestCase):
    def _write(self, payload) -> Path:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            handle.write(payload if isinstance(payload, str) else json.dumps(payload))
        return Path(handle.name)

    def test_the_answer_key_loads(self):
        path = self._write({"id-locked-account": "unlock aisha.khan\n"})
        self.assertEqual(grade_sweep.load_repairs(path), {"id-locked-account": "unlock aisha.khan\n"})

    def test_a_missing_file_says_so(self):
        with self.assertRaises(SystemExit) as caught:
            grade_sweep.load_repairs(Path("/nonexistent/repairs.json"))
        self.assertIn("no repairs file", str(caught.exception))

    def test_a_file_of_the_wrong_shape_is_refused(self):
        """It would otherwise load as "no repair given" for the whole catalogue."""
        for payload in ([{"a": "b"}], "not json at all", {"a": ""}, {}):
            with self.subTest(payload=payload), self.assertRaises(SystemExit):
                grade_sweep.load_repairs(self._write(payload))


class WriteRepairsSkeletonTests(unittest.TestCase):
    """The key is written once and re-read by every later run, so its shape matters.

    The property that makes it worth persisting is that it round-trips: an operator
    fills it in once and `make sweep` grades both halves from then on.
    """

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "sweep-repairs.json"

    def test_it_keys_every_scenario_the_range_offers(self):
        grade_sweep.write_repairs_skeleton(self.path, ["b-scenario", "a-scenario"])
        self.assertEqual(
            json.loads(self.path.read_text(encoding="utf-8")),
            {"a-scenario": "", "b-scenario": ""},
        )

    def test_an_existing_key_is_never_overwritten(self):
        """It holds work that cannot be regenerated: the answers to the exercises."""
        self.path.write_text('{"id-locked-account": "unlock aisha.khan\\n"}\n', encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            grade_sweep.write_repairs_skeleton(self.path, ["id-locked-account"])
        self.assertIn("refusing to overwrite", str(caught.exception))
        self.assertIn("unlock aisha.khan", self.path.read_text(encoding="utf-8"))

    def test_a_filled_in_key_re_grades_both_halves(self):
        """The round trip the persistence exists for: written, filled, reloaded."""
        grade_sweep.write_repairs_skeleton(self.path, ["id-locked-account"])
        # An unfilled entry is refused, not silently graded untouched-only.
        with self.assertRaises(SystemExit):
            grade_sweep.load_repairs(self.path)
        filled = json.loads(self.path.read_text(encoding="utf-8"))
        filled["id-locked-account"] = "unlock aisha.khan\n"
        self.path.write_text(json.dumps(filled), encoding="utf-8")
        self.assertEqual(
            grade_sweep.load_repairs(self.path),
            {"id-locked-account": "unlock aisha.khan\n"},
        )

    def test_it_creates_the_directory_it_is_pointed_at(self):
        """dist/ is ignored and may have been cleaned; the write must still land."""
        nested = self.dir / "dist" / "sweep-repairs.json"
        grade_sweep.write_repairs_skeleton(nested, ["a"])
        self.assertTrue(nested.is_file())


if __name__ == "__main__":
    unittest.main()
