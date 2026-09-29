#!/usr/bin/env python3
"""Unit tests for ontrak/scheduler.py — the timer.

The timer has exactly two jobs and both are easy to get wrong in ways that only
show up overnight:

  * **fire once per scheduled minute, not once per tick.** The default tick is 30
    seconds, so a minute contains two ticks. Without the guard, every scheduled run
    happens twice — two scans racing each other, and in `auto` mode two applies of
    the same package on the same host.
  * **never apply in detect mode.** This is the Network's default, and the scheduler
    is the one caller that could apply without a person. `scan_network` and
    `apply_findings` are both stubbed here so the assertions are about what the
    scheduler DECIDED, not about what a fake Network did.

The policy is read from the database on every tick rather than held in memory, so
these tests also pin that a settings change takes effect without a restart.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import db, scheduler  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from ontrak.policy import Policy  # noqa: E402


def dt(year, month, day, hour, minute):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


class SchedulerCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init(self.conn)
        self.settings = Settings(hosts=(Host("i1", "192.168.1.51", "both"),))
        self.scan_calls: list[dict] = []
        self.apply_calls: list[dict] = []

        def fake_scan(conn, settings, policy, **kwargs):
            self.scan_calls.append(kwargs)
            return {"run_id": 1, "targets": 2, "scanned": 2, "findings": 3,
                    "status": "ok", "summary": "2 target(s) scanned; 3 finding(s)", "hosts": []}

        def fake_apply(conn, settings, policy, *, finding_ids, trigger="manual"):
            self.apply_calls.append({"ids": list(finding_ids), "trigger": trigger})
            return {"run_id": 2, "applied": len(finding_ids), "failed": 0, "manual": [],
                    "messages": [], "summary": f"{len(finding_ids)} applied"}

        patcher = mock.patch.multiple(scheduler, scan_network=fake_scan, apply_findings=fake_apply)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.scheduler = scheduler.Scheduler(self.conn, self.settings)

    def set_policy(self, **kwargs):
        base = Policy().as_dict()
        base.update(kwargs)
        db.set_setting(self.conn, scheduler.POLICY_KEY, base)
        self.conn.commit()


class Firing(SchedulerCase):
    def test_a_run_fires_at_the_scheduled_minute(self):
        # 2026-09-28 is a Monday; 0 3 * * 1 is Mondays at 03:00.
        self.set_policy(schedule="0 3 * * 1")
        self.assertTrue(self.scheduler.due(dt(2026, 9, 28, 3, 0)))
        self.assertFalse(self.scheduler.due(dt(2026, 9, 28, 3, 1)))

    def test_it_does_not_fire_twice_in_the_same_minute(self):
        # THE bug this guard exists for: the tick is 30s, so without it every
        # scheduled run happens twice.
        self.set_policy(schedule="* * * * *")
        self.assertTrue(self.scheduler.due(dt(2026, 9, 28, 3, 0)))
        self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.assertFalse(self.scheduler.due(dt(2026, 9, 28, 3, 0)))
        self.assertEqual(1, len(self.scan_calls))

    def test_the_next_minute_fires_again(self):
        self.set_policy(schedule="* * * * *")
        self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.scheduler.tick(dt(2026, 9, 28, 3, 1))
        self.assertEqual(2, len(self.scan_calls))

    def test_a_disabled_timer_does_nothing(self):
        self.set_policy(schedule="* * * * *", enabled=False)
        self.assertFalse(self.scheduler.due(dt(2026, 9, 28, 3, 0)))
        self.assertIsNone(self.scheduler.tick(dt(2026, 9, 28, 3, 0)))
        self.assertEqual([], self.scan_calls)

    def test_an_unusable_schedule_does_not_crash_the_timer(self):
        # A schedule the parser rejects must be a non-event, not an exception on a
        # background thread that silently kills the timer for good.
        self.set_policy(schedule="not a cron")
        self.assertFalse(self.scheduler.due(dt(2026, 9, 28, 3, 0)))

    def test_a_policy_change_takes_effect_without_a_restart(self):
        self.set_policy(schedule="0 3 * * 1")
        self.assertFalse(self.scheduler.due(dt(2026, 9, 28, 4, 0)))
        self.set_policy(schedule="0 4 * * 1")
        self.assertTrue(self.scheduler.due(dt(2026, 9, 28, 4, 0)))


class Mode(SchedulerCase):
    def approved_findings(self, security: int = 0, plain: int = 0):
        target = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        for index in range(security):
            db.record_finding(self.conn, target_id=target, manager="apt",
                              package=f"sec{index}", security=True)
        for index in range(plain):
            db.record_finding(self.conn, target_id=target, manager="apt", package=f"pkg{index}")
        self.conn.commit()

    def test_detect_mode_scans_and_never_applies(self):
        # The Network's default. A timer that installed packages here would be the
        # worst possible bug in this project.
        self.approved_findings(security=2, plain=3)
        self.set_policy(schedule="* * * * *", mode="detect")
        result = self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.assertEqual(1, len(self.scan_calls))
        self.assertEqual([], self.apply_calls)
        self.assertNotIn("apply", result or {})

    def test_auto_mode_applies_inside_the_window(self):
        self.approved_findings(security=1, plain=1)
        self.set_policy(schedule="* * * * *", mode="auto")
        result = self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.assertEqual(1, len(self.apply_calls))
        self.assertEqual(2, len(self.apply_calls[0]["ids"]))
        self.assertEqual("schedule", self.apply_calls[0]["trigger"])
        self.assertIn("apply", result or {})

    def test_auto_mode_does_not_apply_outside_the_window(self):
        # The scan still runs — the window governs installation, not discovery.
        self.approved_findings(security=1)
        self.set_policy(schedule="* * * * *", mode="auto",
                        window_start_hour=2, window_end_hour=4)
        self.scheduler.tick(dt(2026, 9, 28, 12, 0))
        self.assertEqual(1, len(self.scan_calls))
        self.assertEqual([], self.apply_calls)

    def test_security_only_limits_what_the_timer_installs(self):
        self.approved_findings(security=2, plain=5)
        self.set_policy(schedule="* * * * *", mode="auto", security_only=True)
        self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.assertEqual(2, len(self.apply_calls[0]["ids"]))

    def test_auto_mode_with_nothing_to_do_does_not_call_apply(self):
        self.set_policy(schedule="* * * * *", mode="auto")
        result = self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.assertEqual([], self.apply_calls)
        self.assertNotIn("apply", result or {})

    def test_the_scan_runs_at_most_once_when_a_tick_does_not_fire(self):
        self.set_policy(schedule="0 3 * * 1")
        self.assertIsNone(self.scheduler.tick(dt(2026, 9, 28, 9, 0)))
        self.assertEqual([], self.scan_calls)

    def test_a_scan_that_explodes_does_not_leave_the_timer_dead(self):
        # `run()` catches everything around `tick()`; calling tick directly must at
        # least not corrupt the last-fired guard, or the next attempt would silently
        # skip its minute.
        self.set_policy(schedule="* * * * *", mode="auto")
        with mock.patch.object(scheduler, "scan_network", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.scheduler.tick(dt(2026, 9, 28, 3, 0))
        self.scheduler.tick(dt(2026, 9, 28, 3, 1))
        self.assertEqual(1, len(self.scan_calls))


class PolicyPersistence(SchedulerCase):
    def test_saving_a_valid_policy_round_trips(self):
        policy = Policy(mode="auto", schedule="30 2 * * 1", security_only=True,
                        scopes=["apt"], max_concurrent=5)
        self.assertEqual([], scheduler.save_policy(self.conn, policy))
        self.conn.commit()
        loaded = scheduler.load_policy(self.conn)
        self.assertEqual(policy.as_dict(), loaded.as_dict())

    def test_an_invalid_policy_is_refused_not_stored(self):
        # Refused rather than stored-and-ignored: a schedule the scheduler cannot
        # parse is a timer that never fires, and there is no way to tell that from a
        # timer that fired and found nothing.
        self.assertEqual([], scheduler.save_policy(self.conn, Policy(schedule="0 3 * * 1")))
        problems = scheduler.save_policy(self.conn, Policy(schedule="nonsense", mode="detect"))
        self.assertTrue(problems)
        self.assertEqual("0 3 * * 1", scheduler.load_policy(self.conn).schedule)

    def test_an_empty_database_yields_the_defaults(self):
        policy = scheduler.load_policy(self.conn)
        self.assertEqual("detect", policy.mode)
        self.assertTrue(policy.enabled)


if __name__ == "__main__":
    unittest.main()
