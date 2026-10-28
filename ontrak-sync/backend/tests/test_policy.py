#!/usr/bin/env python3
"""Unit tests for ontrak/policy.py — the timer and the apply policy.

Two things are being pinned here, and they fail in opposite directions.

The cron parser fails *silently*: a wrong next-run means the Network is simply not
updated, and nothing reports an error because nothing is wrong from the
scheduler's point of view. It is also the one field an operator types by hand in a
web form. So the cases below are as much about the expressions that must be
REFUSED as about the ones that must work — a parser that guesses at `5/0` or a
six-field expression is worse than one that says no.

The policy function fails *loudly and expensively*: `action_for` is the single
gate between "proposed a patch" and "installed it on twenty-seven containers". The
Network runs detect-only, so the load-bearing assertion is that no input to a
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
        # cron accepts 7 for Sunday and this Network's docs use 0; both must land on
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

    def test_a_zero_wave_size_is_refused(self):
        # A wave of nothing is not "no limit" — it would plan no waves at all and
        # report a clean run that touched nothing.
        self.assertTrue(any("apply_wave_size" in p
                            for p in policy.Policy(apply_wave_size=0).validate()))

    def test_a_canary_larger_than_its_wave_is_refused(self):
        problems = policy.Policy(apply_canary_targets=3, apply_wave_size=2).validate()
        self.assertTrue(any("apply_canary_targets" in p for p in problems))

    def test_a_negative_blast_radius_is_refused(self):
        problems = policy.Policy(apply_max_targets=-1, apply_canary_targets=-1).validate()
        self.assertTrue(any("apply_max_targets" in p for p in problems))
        self.assertTrue(any("apply_canary_targets" in p for p in problems))

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
        # THE load-bearing assertion. The Network runs detect-only, and this is the
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


class ChangeFreeze(unittest.TestCase):
    """The date-range freeze, which is a different question from the hourly window.

    The window says *which hours* the desk patches; the freeze says *which weeks*
    it does not (an audit, a shutdown, a change moratorium). The load-bearing
    assertion is that a freeze outranks `auto` — a freeze that `auto` could drive
    through would be a label rather than a rail.
    """

    def test_an_auto_policy_applies_outside_the_freeze(self):
        p = policy.Policy(mode="auto", freeze_from="2026-12-20", freeze_to="2027-01-03")
        self.assertEqual("apply", p.action_for(security_count=1, total_count=3,
                                               now=dt(2026, 12, 1, 12, 0)))

    def test_a_freeze_outranks_auto(self):
        p = policy.Policy(mode="auto", freeze_from="2026-12-20", freeze_to="2027-01-03")
        self.assertEqual("skip", p.action_for(security_count=9, total_count=9,
                                              now=dt(2026, 12, 25, 12, 0)))

    def test_the_freeze_is_inclusive_on_both_ends(self):
        p = policy.Policy(mode="auto", freeze_from="2026-12-20", freeze_to="2027-01-03")
        self.assertTrue(p.in_freeze(dt(2026, 12, 20, 0, 0)))
        self.assertTrue(p.in_freeze(dt(2027, 1, 3, 23, 0)))
        self.assertFalse(p.in_freeze(dt(2027, 1, 4, 0, 0)))
        self.assertFalse(p.in_freeze(dt(2026, 12, 19, 23, 59)))

    def test_no_freeze_is_the_default(self):
        self.assertFalse(policy.Policy(mode="auto").in_freeze(dt(2026, 12, 25, 12, 0)))

    def test_a_half_written_freeze_is_refused(self):
        self.assertTrue(any("both" in m for m in policy.Policy(freeze_from="2026-12-20").validate()))
        self.assertTrue(any("both" in m for m in policy.Policy(freeze_to="2027-01-03").validate()))

    def test_a_malformed_date_is_refused(self):
        msgs = policy.Policy(freeze_from="20/12/2026", freeze_to="2027-01-03").validate()
        self.assertTrue(any("ISO date" in m for m in msgs))

    def test_an_ended_freeze_is_refused(self):
        msgs = policy.Policy(freeze_from="2027-01-03", freeze_to="2026-12-20").validate()
        self.assertTrue(any("before it starts" in m for m in msgs))

    def test_the_freeze_round_trips_through_a_dict(self):
        p = policy.Policy(freeze_from="2026-12-20", freeze_to="2027-01-03")
        self.assertEqual(p.as_dict()["freeze_from"], "2026-12-20")
        again = policy.Policy.from_dict(p.as_dict())
        self.assertEqual(again.freeze_from, "2026-12-20")
        self.assertEqual(again.freeze_to, "2027-01-03")

    def test_detect_mode_still_never_applies(self):
        p = policy.Policy(mode="detect", freeze_from="2026-12-20", freeze_to="2027-01-03")
        for now in (dt(2026, 12, 25, 12, 0), dt(2026, 12, 1, 12, 0)):
            self.assertNotEqual("apply", p.action_for(security_count=1, total_count=1, now=now))


class MaintenanceCalendar(unittest.TestCase):
    """The named windows an apply is *allowed* in, on top of the freeze.

    The freeze is a moratorium; a calendar is the other direction — the windows the
    desk has said it patches in (a weekend night, a month-end, a change board's
    slot). Two properties carry it: a configured calendar is an allow-list (outside
    every window is outside the calendar), and an entry this code cannot read covers
    *nothing* rather than everything, because a typo must not authorise a 3am apply.
    """

    def calendar(self, **overrides):
        window = {"name": "Patch night", "weekdays": [5, 6],
                  "start_hour": 22, "end_hour": 4}
        window.update(overrides)
        return policy.Policy(maintenance_windows=[window])

    def test_no_calendar_means_any_time(self):
        p = policy.Policy()
        self.assertTrue(p.in_change_window(dt(2026, 9, 28, 13, 0)))
        self.assertIsNone(p.window_refusal(dt(2026, 9, 28, 13, 0)))

    def test_a_weekly_window_covers_its_days_and_wraps_midnight(self):
        # 2026-09-26 is a Saturday, 2026-09-28 a Monday.
        p = self.calendar()
        self.assertTrue(p.in_change_window(dt(2026, 9, 26, 23, 0)))
        self.assertTrue(p.in_change_window(dt(2026, 9, 27, 3, 59)))
        self.assertFalse(p.in_change_window(dt(2026, 9, 26, 12, 0)))
        self.assertFalse(p.in_change_window(dt(2026, 9, 28, 23, 0)))

    def test_a_daytime_window_does_not_wrap(self):
        p = self.calendar(start_hour=10, end_hour=12)
        self.assertTrue(p.in_change_window(dt(2026, 9, 26, 10, 0)))
        self.assertTrue(p.in_change_window(dt(2026, 9, 26, 11, 59)))
        self.assertFalse(p.in_change_window(dt(2026, 9, 26, 12, 0)))

    def test_a_one_off_window_is_bounded_by_its_dates(self):
        p = self.calendar(weekdays=[0, 1, 2, 3, 4, 5, 6], start_hour=0, end_hour=23,
                          start="2026-12-20", end="2026-12-24")
        self.assertTrue(p.in_change_window(dt(2026, 12, 22, 10, 0)))
        self.assertFalse(p.in_change_window(dt(2026, 12, 25, 10, 0)))
        self.assertFalse(p.in_change_window(dt(2026, 12, 19, 10, 0)))

    def test_the_refusal_names_the_window_the_operator_has_to_change(self):
        reason = self.calendar().window_refusal(dt(2026, 9, 28, 12, 0))
        self.assertIn("outside the maintenance calendar", reason)
        self.assertIn("Patch night", reason)
        self.assertIn("Sat, Sun 22:00-04:00", reason)

    def test_several_windows_are_all_named(self):
        p = policy.Policy(maintenance_windows=[
            {"name": "Weekend", "weekdays": [5, 6], "start_hour": 22, "end_hour": 4},
            {"name": "Month end", "weekdays": [0], "start_hour": 1, "end_hour": 5},
        ])
        reason = p.window_refusal(dt(2026, 9, 29, 12, 0))  # a Tuesday
        self.assertIn("Weekend", reason)
        self.assertIn("Month end", reason)

    def test_any_one_matching_window_is_enough(self):
        p = policy.Policy(maintenance_windows=[
            {"name": "Weekend", "weekdays": [5, 6], "start_hour": 22, "end_hour": 4},
            {"name": "Monday noon", "weekdays": [0], "start_hour": 11, "end_hour": 13},
        ])
        self.assertTrue(p.in_change_window(dt(2026, 9, 28, 12, 0)))

    def test_an_unreadable_entry_covers_nothing_rather_than_everything(self):
        # The fail-closed direction: a window whose hours or weekdays cannot be read
        # is a typo, and a typo must not authorise an apply at any hour.
        for window in (
            {"name": "broken", "weekdays": [], "start_hour": 0, "end_hour": 1},
            {"name": "broken", "weekdays": [0], "start_hour": "soon", "end_hour": 1},
            {"name": "broken", "weekdays": [0], "start_hour": 0, "end_hour": 1,
             "start": "20/12/2026", "end": "2026-12-24"},
            "not a window",
        ):
            with self.subTest(window=window):
                self.assertFalse(policy.Policy(maintenance_windows=[window])
                                 .in_change_window(dt(2026, 9, 28, 0, 30)))

    def test_a_calendar_outranks_auto(self):
        p = self.calendar()
        self.assertEqual("skip", p.action_for(security_count=9, total_count=9,
                                              now=dt(2026, 9, 28, 12, 0)))
        p_auto = self.calendar()
        p_auto.mode = "auto"
        self.assertEqual("skip", p_auto.action_for(security_count=9, total_count=9,
                                                   now=dt(2026, 9, 28, 12, 0)))

    def test_auto_applies_inside_the_calendar(self):
        p = policy.Policy(mode="auto", maintenance_windows=[{
            "name": "Patch night", "weekdays": [5, 6], "start_hour": 22, "end_hour": 4,
        }])
        self.assertEqual("apply", p.action_for(security_count=1, total_count=1,
                                               now=dt(2026, 9, 26, 23, 0)))

    def test_a_freeze_still_outranks_a_window_that_covers_the_moment(self):
        p = policy.Policy(mode="auto", freeze_from="2026-12-20", freeze_to="2027-01-03",
                          maintenance_windows=[{
                              "name": "Always", "weekdays": [0, 1, 2, 3, 4, 5, 6],
                              "start_hour": 0, "end_hour": 23,
                          }])
        self.assertTrue(p.in_change_window(dt(2026, 12, 25, 12, 0)))
        self.assertEqual("skip", p.action_for(security_count=1, total_count=1,
                                              now=dt(2026, 12, 25, 12, 0)))

    def test_detect_mode_still_never_applies_inside_a_window(self):
        p = self.calendar()
        self.assertEqual("approve", p.action_for(security_count=1, total_count=1,
                                                 now=dt(2026, 9, 26, 23, 0)))

    def test_a_window_needs_a_name(self):
        msgs = policy.Policy(maintenance_windows=[{
            "weekdays": [1], "start_hour": 1, "end_hour": 2,
        }]).validate()
        self.assertTrue(any("needs a name" in m for m in msgs))

    def test_a_window_needs_at_least_one_weekday(self):
        msgs = policy.Policy(maintenance_windows=[{
            "name": "Empty", "weekdays": [], "start_hour": 1, "end_hour": 2,
        }]).validate()
        self.assertTrue(any("at least one weekday" in m for m in msgs))

    def test_a_weekday_outside_monday_to_sunday_is_refused(self):
        msgs = policy.Policy(maintenance_windows=[{
            "name": "Bad", "weekdays": [0, 7], "start_hour": 1, "end_hour": 2,
        }]).validate()
        self.assertTrue(any("outside 0-6" in m for m in msgs))

    def test_bad_hours_and_a_zero_length_window_are_refused(self):
        for hour in (-1, 24, "late"):
            with self.subTest(hour=hour):
                msgs = policy.Policy(maintenance_windows=[{
                    "name": "Bad", "weekdays": [1], "start_hour": hour, "end_hour": 2,
                }]).validate()
                self.assertTrue(any("must be 0-23" in m for m in msgs))
        equal = policy.Policy(maintenance_windows=[{
            "name": "Same", "weekdays": [1], "start_hour": 4, "end_hour": 4,
        }]).validate()
        self.assertTrue(any("same start and end hour" in m for m in equal))

    def test_a_half_written_or_backwards_date_range_is_refused(self):
        half = policy.Policy(maintenance_windows=[{
            "name": "One end", "weekdays": [1], "start_hour": 1, "end_hour": 2,
            "start": "2026-12-20", "end": "",
        }]).validate()
        self.assertTrue(any("both a start and an end" in m for m in half))
        backwards = policy.Policy(maintenance_windows=[{
            "name": "Backwards", "weekdays": [1], "start_hour": 1, "end_hour": 2,
            "start": "2026-12-24", "end": "2026-12-20",
        }]).validate()
        self.assertTrue(any("ends before it starts" in m for m in backwards))
        malformed = policy.Policy(maintenance_windows=[{
            "name": "Typo", "weekdays": [1], "start_hour": 1, "end_hour": 2,
            "start": "20/12/2026", "end": "2026-12-24",
        }]).validate()
        self.assertTrue(any("ISO date" in m for m in malformed))

    def test_a_sane_calendar_validates(self):
        self.assertEqual([], self.calendar().validate())

    def test_the_calendar_round_trips_through_a_dict(self):
        p = self.calendar()
        again = policy.Policy.from_dict(p.as_dict())
        self.assertEqual(p.as_dict(), again.as_dict())
        self.assertEqual("Patch night", again.maintenance_windows[0]["name"])

    def test_a_negative_approval_ttl_is_refused(self):
        msgs = policy.Policy(approval_ttl_hours=-1).validate()
        self.assertTrue(any("approval_ttl_hours" in m for m in msgs))

    def test_the_approval_settings_round_trip(self):
        p = policy.Policy(approval_ttl_hours=24, require_approval_reason=True)
        again = policy.Policy.from_dict(p.as_dict())
        self.assertEqual(24, again.approval_ttl_hours)
        self.assertTrue(again.require_approval_reason)


if __name__ == "__main__":
    unittest.main()
