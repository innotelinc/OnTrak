#!/usr/bin/env python3
"""Unit tests for ontrak/approvals.py — is an approval still a decision?

The whole point of 2.1's approval work is that `approved` stops being a word and
becomes a record: who decided, when the decision lapses, and why it was made. What
is tested here is the *rule* that reads that record, because the apply path and the
scheduler must not each grow their own version of it.

The cases that matter are the refusals, and each one is a different way a stale or
anonymous decision could otherwise install a package:

  * an `approved` row from before this existed, with nobody's name on it;
  * an approval whose deadline has passed;
  * an approval whose deadline cannot even be read;
  * a reason-required deployment with no reason recorded;
  * a row that is not approved at all, named as such rather than silently skipped.

The calendar lives in the same answer (`apply_refusal`) because an apply needs both
questions answered at once, and a route that asked only one of them would be a way
around the other.
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak import approvals, policy  # noqa: E402


def dt(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def live(**overrides):
    """A finding row whose approval is live: named, unexpiring, with a reason."""
    row = {
        "id": 12,
        "package": "nginx",
        "status": "approved",
        "approved_by": "alice",
        "approved_at": "2026-09-28T09:00:00Z",
        "approval_expires_at": "",
        "approval_reason": "CVE-2026-1234",
    }
    row.update(overrides)
    return row


class ApprovalExpiry(unittest.TestCase):
    def test_zero_hours_means_never(self):
        self.assertIsNone(approvals.approval_expiry(ttl_hours=0, moment=dt(2026, 9, 28, 9, 0)))

    def test_a_positive_ttl_is_stamped_from_the_instant_it_was_given(self):
        # Fixed from *now*, not from the policy when somebody later reads it: a
        # deadline that moves when the form changes is not a deadline.
        self.assertEqual(
            "2026-09-29T09:00:00Z",
            approvals.approval_expiry(ttl_hours=24, moment=dt(2026, 9, 28, 9, 0)),
        )

    def test_a_negative_ttl_is_treated_as_no_deadline_rather_than_a_past_one(self):
        # `Policy.validate` refuses a negative TTL; this is the read path, where the
        # honest degradation is "no deadline" rather than an approval that expired
        # before it was recorded.
        self.assertIsNone(approvals.approval_expiry(ttl_hours=-3, moment=dt(2026, 9, 28, 9, 0)))


class ApprovalLiveness(unittest.TestCase):
    def test_a_named_undated_approval_is_live(self):
        self.assertIsNone(approvals.approval_refusal(live(), now=dt(2026, 9, 28, 12, 0)))

    def test_an_approval_with_no_approver_is_refused_by_name(self):
        reason = approvals.approval_refusal(live(approved_by=""), now=dt(2026, 9, 28, 12, 0))
        self.assertIn("finding #12 (nginx)", reason)
        self.assertIn("no named approver", reason)

    def test_an_expired_approval_names_the_deadline_and_the_approver(self):
        reason = approvals.approval_refusal(
            live(approval_expires_at="2026-09-28T10:00:00Z"),
            now=dt(2026, 9, 28, 12, 0),
        )
        self.assertIn("expired at 2026-09-28T10:00:00Z", reason)
        self.assertIn("alice", reason)

    def test_the_deadline_is_inclusive_until_the_instant_it_names(self):
        # At the deadline the approval is spent; one second before it is not.
        row = live(approval_expires_at="2026-09-28T10:00:00Z")
        self.assertIsNone(approvals.approval_refusal(row, now=dt(2026, 9, 28, 9, 59)))
        self.assertIsNotNone(approvals.approval_refusal(row, now=dt(2026, 9, 28, 10, 0)))

    def test_an_unreadable_expiry_is_a_refusal_not_an_eternity(self):
        reason = approvals.approval_refusal(
            live(approval_expires_at="next Tuesday-ish"), now=dt(2026, 9, 28, 12, 0)
        )
        self.assertIn("cannot be read", reason)

    def test_a_reason_is_only_required_when_the_policy_says_so(self):
        row = live(approval_reason="")
        self.assertIsNone(approvals.approval_refusal(row, now=dt(2026, 9, 28, 12, 0)))
        required = policy.Policy(require_approval_reason=True)
        reason = approvals.approval_refusal(row, policy=required, now=dt(2026, 9, 28, 12, 0))
        self.assertIn("no reason", reason)

    def test_a_row_that_is_not_approved_says_which_state_it_is_in(self):
        reason = approvals.approval_refusal(live(status="pending"), now=dt(2026, 9, 28, 12, 0))
        self.assertIn("is pending", reason)
        self.assertIn("no approval to act on", reason)

    def test_a_row_that_does_not_carry_the_columns_is_treated_as_unapproved(self):
        # A select that forgot the columns must fail closed, not open.
        reason = approvals.approval_refusal({"id": 4}, now=dt(2026, 9, 28, 12, 0))
        self.assertIn("finding #4", reason)
        self.assertIn("no named approver", reason)


class ApplyRefusal(unittest.TestCase):
    def test_no_calendar_and_live_rows_is_no_refusal(self):
        self.assertIsNone(approvals.apply_refusal(
            policy=policy.Policy(), rows=[live()], now=dt(2026, 9, 28, 12, 0)
        ))

    def test_the_calendar_is_answered_before_the_approvals(self):
        # A click outside the window is refused for *that* reason even when the
        # findings are fine; an operator reading "14:00 is outside the calendar"
        # knows what to change, where "7 findings are not ready" would send them to
        # the wrong place.
        outside = policy.Policy(maintenance_windows=[{
            "name": "Weekend", "weekdays": [5, 6], "start_hour": 22, "end_hour": 4,
        }])
        reason = approvals.apply_refusal(
            policy=outside, rows=[live()], now=dt(2026, 9, 28, 12, 0),  # a Monday
        )
        self.assertIn("outside the maintenance calendar", reason)
        self.assertIn("Weekend", reason)

    def test_an_empty_row_list_still_answers_the_calendar(self):
        # This is the one-click approve-and-apply path: its click is the approval, so
        # only the window can refuse it.
        outside = policy.Policy(maintenance_windows=[{
            "name": "Weekend", "weekdays": [5, 6], "start_hour": 0, "end_hour": 1,
        }])
        self.assertIn("outside the maintenance calendar", approvals.apply_refusal(
            policy=outside, rows=[], now=dt(2026, 9, 28, 12, 0)
        ))

    def test_several_stale_approvals_are_counted_then_named(self):
        rows = [
            live(id=1, package="nginx"),
            live(id=2, package="openssl", approved_by=""),
            live(id=3, package="curl", approval_expires_at="2026-01-01T00:00:00Z"),
        ]
        reason = approvals.apply_refusal(policy=policy.Policy(), rows=rows,
                                         now=dt(2026, 9, 28, 12, 0))
        self.assertIn("2 findings are not ready to apply", reason)
        self.assertIn("openssl", reason)
        self.assertIn("curl", reason)
        # The live one is not named as a problem.
        self.assertNotIn("finding #1 (nginx)", reason)

    def test_a_long_list_is_capped_rather_than_read_out_in_full(self):
        rows = [live(id=index, package=f"pkg{index}", approved_by="")
                for index in range(1, 10)]
        reason = approvals.apply_refusal(policy=policy.Policy(), rows=rows,
                                         now=dt(2026, 9, 28, 12, 0))
        self.assertIn("9 findings are not ready to apply", reason)
        self.assertIn("and 6 more", reason)

    def test_the_refusal_does_not_depend_on_the_wall_clock(self):
        # Determinism for the test and for a replay: the instant is an argument.
        row = live(approval_expires_at="2026-09-28T13:00:00Z")
        self.assertIsNone(approvals.apply_refusal(
            policy=policy.Policy(), rows=[row], now=dt(2026, 9, 28, 12, 0)
        ))
        self.assertIn("expired", approvals.apply_refusal(
            policy=policy.Policy(), rows=[row], now=dt(2026, 9, 28, 15, 0)
        ))


if __name__ == "__main__":
    unittest.main()
