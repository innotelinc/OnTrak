#!/usr/bin/env python3
"""Unit tests for ontrak/policy.py — the timer and the apply policy.

Two things are being pinned here, and they fail in opposite directions.

The cron parser fails *silently*: a wrong next-run means the estate is simply not
updated, and nothing reports an error because nothing is wrong from the
scheduler's point of view. It is also the one field an operator types by hand in a
web form. So the cases below are as much about the expressions that must be
REFUSED as about the ones that must work — a parser that guesses at `5/0` or a
six-field expression is worse than one that says no.

The policy function fails *loudly and expensively*: `action_for` is the single
gate between "proposed a patch" and "installed it on twenty-seven containers". The
estate runs detect-only, so the load-bearing assertion is that no input to a
detect-mode policy returns `"apply"`.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import policy  # noqa: E402


def dt(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


class CronParsing(unittest.TestCase):
    def test_the_five_field_expression_is_understood(self):
        cron = policy.Cron.parse("30 4 * * 1")
        self.assertEqual({30}, cron.minutes)
        self.assertEqual({4}, cron.hours)
        self.assertEqual({1}, cron.weekdays)

    def test_star_and_lists_and_ranges_and_steps(self):
        cron = policy.Cron.parse("*/15 2,4-6 1,15 * *")
        self.assertEqual({0, 15, 30, 45}, cron.minutes)
        self.assertEqual({2, 4, 5, 6}, cron.hours)
        self.assertEqual({1, 15}, cron.days)

    def test_sunday_is_both_zero_and_seven(self):
        # cron accepts 7 for Sunday and this estate's docs use 0; both must land on
        # Sunday rather than 7 being read as "no match" and silently never firing.
        self.assertEqual({0}, policy.Cron.parse("0 3 * * 7").weekdays)
        self.assertEqual({0}, policy.Cron.parse("0 3 * * 0").weekdays)

    def test_the_named_aliases_expand(self):
        daily = policy.Cron.parse("@daily")
        self.assertEqual({0}, daily.minutes)
        self.assertEqual({0}, daily.hours)
        hourly = policy.Cron.parse("@hourly")
        self.assertEqual({0}, hourly.minutes)
        self.assertEqual(set(range(0, 24)), hourly.hours)
        weekly = policy.Cron.parse("@weekly")
        self.assertEqual({0}, weekly.weekdays)

    def test_an_expression_with_seconds_is_refused_rather_than_misread(self):
        # Six fields is the most common thing an operator pastes from a crontab
        # generator. Silently dropping one field would schedule the job an hour or a
        # day out.
        with self.assertRaises(policy.CronError) as ctx:
            policy.Cron.parse("0 0 3 * * *")
        self.assertIn("seconds are not supported", str(ctx.exception))

    def test_a_zero_step_is_refused(self):
        with self.assertRaises(policy.CronError):
            policy.Cron.parse("*/0 * * * *")

    def test_out_of_range_values_are_refused(self):
        for expression in ("60 * * * *", "* 24 * * *", "* * 32 * *", "* * * 13 *", "* * * * 9"):
            with self.subTest(expression=expression):
                with self.assertRaises(policy.CronError):
                    policy.Cron.parse(expression)

    def test_a_backwards_range_is_refused(self):
        with self.assertRaises(policy.CronError):
            policy.Cron.parse("30-10 * * * *")

    def test_junk_and_empty_input_are_refused(self):
        for expression in ("", "   ", "* * * *", "* * * * * *", "every day", "* * * * mon"):
            with self.subTest(expression=expression):
                with self.assertRaises(policy.CronError):
                    policy.Cron.parse(expression)

    def test_a_bare_value_with_a_step_runs_to_the_top_of_the_range(self):
        # `5/10` in the minute field is 5,15,25,35,45,55 — the meaning cron gives
        # it, and not "just 5".
        self.assertEqual({5, 15, 25, 35, 45, 55}, policy.Cron.parse("5/10 * * * *").minutes)


class CronMatching(unittest.TestCase):
    def test_daily_at_three_matches_only_then(self):
        cron = policy.Cron.parse("0 3 * * *")
        self.assertTrue(cron.matches(dt(2026, 9, 28, 3, 0)))
        self.assertFalse(cron.matches(dt(2026, 9, 28, 3, 1)))
        self.assertFalse(cron.matches(dt(2026, 9, 28, 4, 0)))

    def test_the_weekday_field_is_honoured(self):
        # 0 3 * * 0 is Sundays. 2026-09-27 is a Sunday; 2026-09-28 is a Monday.
        cron = policy.Cron.parse("0 3 * * 0")
        self.assertTrue(cron.matches(dt(2026, 9, 27, 3, 0)))
        self.assertFalse(cron.matches(dt(2026, 9, 28, 3, 0)))

    def test_every_weekday_number_lands_on_its_own_day(self):
        # cron numbers weekdays Sunday=0 … Saturday=6 while Python's datetime
        # numbers them Monday=0 … Sunday=6, so this mapping is one line of
        # arithmetic that is wrong by exactly one day if it is assumed away.
        # 2026-09-28 is a Monday; the week from it runs Mon 28th … Sun 4th.
        cases = {1: (9, 28), 2: (9, 29), 3: (9, 30), 4: (10, 1), 5: (10, 2), 6: (10, 3), 0: (10, 4)}
        for cron_day, (month, day) in cases.items():
            with self.subTest(cron_day=cron_day):
                self.assertTrue(policy.Cron.parse(f"0 0 * * {cron_day}").matches(dt(2026, month, day, 0, 0)))
                # …and the day before it in the same week must not match.
                other = {1: (9, 27), 2: (9, 28), 3: (9, 29), 4: (9, 30), 5: (10, 1), 6: (10, 2), 0: (10, 3)}
                month2, day2 = other[cron_day]
                self.assertFalse(policy.Cron.parse(f"0 0 * * {cron_day}").matches(dt(2026, month2, day2, 0, 0)))

    def test_the_star_weekday_field_covers_the_whole_week(self):
        self.assertEqual({0, 1, 2, 3, 4, 5, 6}, policy.Cron.parse("0 0 * * *").weekdays)

    def test_day_of_month_and_weekday_together_are_an_or_not_an_and(self):
        # Cron's rule, and the one that surprises people. Implemented as AND this
        # would fire roughly twelve times a year instead of about sixty, and the
        # only symptom would be a fleet that quietly updates less often than asked.
        cron = policy.Cron.parse("0 0 1 * 1")
        self.assertTrue(cron.matches(dt(2026, 9, 1, 0, 0)))   # the 1st, a Tuesday
        self.assertTrue(cron.matches(dt(2026, 9, 28, 0, 0)))  # a Monday, not the 1st

    def test_with_only_one_of_the_two_restricted_it_is_an_and(self):
        # `0 0 1 * *` — "any weekday" is not restricted, so only the day matters.
        cron = policy.Cron.parse("0 0 1 * *")
        self.assertTrue(cron.matches(dt(2026, 9, 1, 0, 0)))
        self.assertFalse(cron.matches(dt(2026, 9, 28, 0, 0)))


class CronNextRun(unittest.TestCase):
    def test_daily_schedule_advances_to_tomorrow(self):
        cron = policy.Cron.parse("0 3 * * *")
        self.assertEqual(dt(2026, 9, 29, 3, 0), cron.next_after(dt(2026, 9, 28, 9, 0)))

    def test_a_run_today_still_ahead_is_chosen(self):
        cron = policy.Cron.parse("0 3 * * *")
        self.assertEqual(dt(2026, 9, 28, 3, 0), cron.next_after(dt(2026, 9, 27, 9, 0)))

    def test_weekly_schedule_lands_on_the_right_weekday(self):
        cron = policy.Cron.parse("0 4 * * 0")
        self.assertEqual(dt(2026, 10, 4, 4, 0), cron.next_after(dt(2026, 9, 28, 9, 0)))

    def test_a_leap_day_expression_finds_the_leap_day(self):
        # The case that justifies minute-stepping instead of field arithmetic: the
        # next 29 February is a knowable thing only if you know the calendar.
        cron = policy.Cron.parse("0 0 29 2 *")
        self.assertEqual(dt(2028, 2, 29, 0, 0), cron.next_after(dt(2026, 9, 28, 0, 0)))

    def test_an_impossible_expression_returns_none_rather_than_looping(self):
        # 30 February never exists. Returning None lets the caller say "this
        # schedule will never fire" instead of hanging the scheduler thread.
        cron = policy.Cron.parse("0 0 30 2 *")
        self.assertIsNone(cron.next_after(dt(2026, 9, 28, 0, 0), horizon_days=400))

    def test_the_next_run_is_strictly_after_the_given_instant(self):
        # Feeding back the previous firing must advance, or the scheduler would
        # re-run the same minute forever.
        cron = policy.Cron.parse("0 3 * * *")
        first = cron.next_after(dt(2026, 9, 28, 0, 0))
        second = cron.next_after(first)
        self.assertGreater(second, first)

    def test_the_next_five_runs_are_evenly_spaced_for_a_daily_schedule(self):
        runs = policy.next_runs(policy.Cron.parse("0 3 * * *"), count=5, now=dt(2026, 9, 28, 0, 0))
        self.assertEqual(5, len(runs))
        self.assertTrue(all(run.startswith(("2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"))
                            for run in runs))


class HumanDescription(unittest.TestCase):
    def test_common_schedules_get_a_sentence(self):
        self.assertIn("every day", policy.describe("30 2 * * *"))

    def test_the_weekday_named_is_the_weekday_the_timer_will_fire_on(self):
        # Regression: cron numbers weekdays from Sunday and the name list this
        # sentence is built from runs from Monday, so every named day was reported
        # one day early — "0 4 * * 0" described itself as Monday while the list of
        # next runs directly beneath it showed Sundays. The description and the
        # schedule must be checked against each other here rather than separately.
        for expression, day in (("0 4 * * 0", "Sun"), ("0 4 * * 1", "Mon"),
                                ("0 4 * * 6", "Sat"), ("0 4 * * 7", "Sun")):
            with self.subTest(expression=expression):
                self.assertIn(day, policy.describe(expression))

    def test_a_sunday_schedule_is_not_described_as_monday(self):
        self.assertNotIn("Mon", policy.describe("0 4 * * 0"))

    def test_several_days_are_listed_in_week_order(self):
        # Monday-first, so the sentence reads the way the week does rather than the
        # way cron happens to number it.
        self.assertEqual("Mon, Wed, Sun at 04:00", policy.describe("0 4 * * 1,3,0"))

    def test_an_invalid_expression_says_so_rather_than_describing_nothing(self):
        self.assertIn("invalid", policy.describe("99 * * * *"))

    def test_an_alias_is_described_by_its_expansion(self):
        self.assertIn("@weekly", policy.describe("@weekly"))


class PolicyValidation(unittest.TestCase):
    def test_every_problem_is_reported_at_once(self):
        # One pass, not one round trip per complaint: the settings form is a single
        # submit and re-submitting four times to find four typos is how a form gets
        # abandoned.
        problems = policy.Policy(schedule="nonsense", mode="yolo", scopes=[], max_concurrent=0).validate()
        self.assertGreaterEqual(len(problems), 4)

    def test_a_sane_policy_validates(self):
        self.assertEqual([], policy.Policy().validate())

    def test_an_unknown_scope_is_refused(self):
        self.assertTrue(any("scope" in p for p in policy.Policy(scopes=["apt", "dnf"]).validate()))

    def test_out_of_range_window_hours_are_refused(self):
        self.assertTrue(any("window_start_hour" in p
                            for p in policy.Policy(window_start_hour=25).validate()))

    def test_the_round_trip_through_json_keeps_every_setting(self):
        original = policy.Policy(mode="auto", schedule="15 5 * * 2", security_only=True,
                                 window_start_hour=22, window_end_hour=5, max_concurrent=7,
                                 scopes=["apt"], enabled=False, host_ids=[1, 2])
        restored = policy.Policy.from_dict(original.as_dict())
        self.assertEqual(original.as_dict(), restored.as_dict())


class MaintenanceWindow(unittest.TestCase):
    def test_no_window_configured_means_any_time(self):
        self.assertTrue(policy.Policy().in_window(dt(2026, 9, 28, 13, 0)))

    def test_a_simple_window_covers_its_hours(self):
        p = policy.Policy(window_start_hour=2, window_end_hour=5)
        self.assertTrue(p.in_window(dt(2026, 9, 28, 2, 0)))
        self.assertTrue(p.in_window(dt(2026, 9, 28, 4, 59)))
        self.assertFalse(p.in_window(dt(2026, 9, 28, 5, 0)))

    def test_a_window_that_wraps_midnight_is_the_normal_case(self):
        # 22 -> 05 is how maintenance windows are actually written.
        p = policy.Policy(window_start_hour=22, window_end_hour=5)
        self.assertTrue(p.in_window(dt(2026, 9, 28, 23, 0)))
        self.assertTrue(p.in_window(dt(2026, 9, 29, 1, 0)))
        self.assertFalse(p.in_window(dt(2026, 9, 28, 5, 0)))
        self.assertFalse(p.in_window(dt(2026, 9, 28, 21, 59)))

    def test_an_equal_start_and_end_is_no_window_rather_than_a_lockout(self):
        p = policy.Policy(window_start_hour=3, window_end_hour=3)
        self.assertTrue(p.in_window(dt(2026, 9, 28, 13, 0)))


class ApplyDecision(unittest.TestCase):
    def test_detect_mode_can_never_apply(self):
        # THE load-bearing assertion. The estate runs detect-only, and this is the
        # one function that decides whether a package gets installed.
        p = policy.Policy(mode="detect")
        for security, total in ((0, 0), (1, 1), (5, 50), (0, 10)):
            with self.subTest(security=security, total=total):
                self.assertNotEqual("apply", p.action_for(security_count=security, total_count=total,
                                                           now=dt(2026, 9, 28, 12, 0)))

    def test_detect_mode_asks_for_approval_when_there_is_something_to_do(self):
        self.assertEqual("approve", policy.Policy(mode="detect").action_for(
            security_count=1, total_count=3, now=dt(2026, 9, 28, 12, 0)))

    def test_auto_mode_applies_inside_the_window(self):
        p = policy.Policy(mode="auto")
        self.assertEqual("apply", p.action_for(security_count=1, total_count=3,
                                               now=dt(2026, 9, 28, 12, 0)))

    def test_auto_mode_still_respects_the_window(self):
        p = policy.Policy(mode="auto", window_start_hour=2, window_end_hour=4)
        self.assertEqual("skip", p.action_for(security_count=1, total_count=3,
                                              now=dt(2026, 9, 28, 12, 0)))

    def test_nothing_to_do_is_a_skip_not_an_approval(self):
        self.assertEqual("skip", policy.Policy(mode="detect").action_for(
            security_count=0, total_count=0, now=dt(2026, 9, 28, 12, 0)))

    def test_a_disabled_schedule_does_nothing_even_in_auto(self):
        self.assertEqual("skip", policy.Policy(mode="auto", enabled=False).action_for(
            security_count=1, total_count=1, now=dt(2026, 9, 28, 12, 0)))

    def test_security_only_skips_a_run_with_no_security_updates(self):
        # The setting that makes `auto` acceptable to a nervous operator: feature
        # updates wait for a person, CVE fixes do not.
        p = policy.Policy(mode="auto", security_only=True)
        self.assertEqual("skip", p.action_for(security_count=0, total_count=9,
                                              now=dt(2026, 9, 28, 12, 0)))
        self.assertEqual("apply", p.action_for(security_count=1, total_count=9,
                                               now=dt(2026, 9, 28, 12, 0)))


if __name__ == "__main__":
    unittest.main()
