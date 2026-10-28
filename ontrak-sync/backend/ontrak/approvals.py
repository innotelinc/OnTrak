"""Ontrak Sync — is an approval still a decision somebody made?

An `approved` finding used to be a status and nothing else: a row had been set to a
word, and `/api/apply` installed whatever carried that word. That is enough to stop
a script applying something nobody looked at, and it is not enough to answer the
questions asked afterwards — *who* decided, *when* does that decision lapse, and
*why* was this installed. So an approval is now a small record on the finding:
a named approver, the instant, an optional expiry and an optional reason.

This module is the pure half: given a row and the policy, is that record still
live? Nothing here writes, reads a clock it was not given, or knows what HTTP is,
which is what lets the rule be tested exhaustively and lets the route and the
scheduler share one answer.

THE RULES, AND WHY EACH ONE FAILS CLOSED
----------------------------------------
  * **No named approver is a refusal.** A row approved before this existed, or one
    set by a script that passed no actor, is not an approval somebody can be held
    to. The refusal says so and asks for a re-approval, which costs one click and
    records the name.
  * **An unreadable expiry is a refusal.** The safe reading of an expiry this code
    cannot parse is not "never expires"; a record it cannot read is a record it
    cannot promise is live.
  * **An expired approval is a refusal**, stated with the deadline and the approver
    so the operator knows which decision lapsed rather than that something is
    wrong.
  * **A missing reason is a refusal when the policy requires one.** Off by
    default, because a reason is worth having and a deployment that insists on one
    chose to.

The calendar is checked here too, in `apply_refusal`, because the two questions
("may anything be applied now?" and "is this particular decision live?") both have
to be answered before one apply runs, and a route that asked only one of them would
be a way around the other.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _field(row, name: str) -> str:
    """One column as text, tolerating a row that does not carry it.

    A `sqlite3.Row` raises `IndexError` for a column it was not selected with, a
    dict raises `KeyError`, and a test may pass either. An absent column reads as
    empty rather than as an error, because the rule's answer to "I cannot see the
    approver" is the same as its answer to "there is no approver": not live.
    """
    try:
        value = row[name]
    except (KeyError, IndexError, TypeError):
        return ""
    return "" if value is None else str(value)


def _parse(value: str | None) -> datetime | None:
    """An ISO instant, in the one format the database writes and the API accepts.

    `Z` is normalised rather than required: every stored timestamp is written as
    `...Z` (`db.utcnow`), and a hand-written `+00:00` is the same instant.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _subject(row) -> str:
    """How a refusal names the finding: `finding #12 (nginx)`."""
    finding = _field(row, "id").strip()
    package = _field(row, "package").strip()
    if finding and package:
        return f"finding #{finding} ({package})"
    if finding:
        return f"finding #{finding}"
    return "a finding"


def approval_expiry(*, ttl_hours: int, moment: datetime | None = None) -> str | None:
    """The expiry stamped onto a new approval, or None when approvals do not lapse.

    `ttl_hours` of 0 is the shipped default and means "no deadline". A positive
    value is turned into an instant *now*, so the deadline is fixed when the
    decision is made: changing the policy later must not move a promise that was
    already made to an approver.
    """
    try:
        hours = int(ttl_hours or 0)
    except (TypeError, ValueError):
        # A hand-edited policy with a word where the number goes has no TTL, not a
        # crash: `Policy.validate` refuses it on the way in, and this is the read
        # path, where "no deadline" is the only safe interpretation.
        return None
    if hours <= 0:
        return None
    start = moment or datetime.now(timezone.utc)
    return _stamp(start + timedelta(hours=hours))


def approval_refusal(row, *, policy=None, now: datetime | None = None) -> str | None:
    """Why this finding's approval cannot be acted on, or None when it can.

    The row is one `findings` row joined with nothing else — the fields read are
    `id`, `package`, `status`, `approved_by`, `approved_at`, `approval_expires_at`
    and `approval_reason`. A row that is not `approved` has no approval to check,
    and says so rather than falling through to the apply.
    """
    moment = now or datetime.now(timezone.utc)
    subject = _subject(row)

    status = _field(row, "status").strip()
    if status and status != "approved":
        return f"{subject} is {status}, so there is no approval to act on"

    approver = _field(row, "approved_by").strip()
    if not approver:
        return (f"{subject} has no named approver — approve it again so the record "
                "says who decided")

    expires = _field(row, "approval_expires_at").strip()
    if expires:
        deadline = _parse(expires)
        if deadline is None:
            return (f"{subject} carries an approval expiry that cannot be read "
                    f"({expires}) — re-approve it or fix the record")
        if deadline.tzinfo is None:
            # A hand-written timestamp with no zone is read as UTC rather than as
            # local time, which is what every other stored instant means here.
            deadline = deadline.replace(tzinfo=timezone.utc)
        if deadline <= moment:
            return (f"the approval {subject} carries expired at {expires} "
                    f"(approved by {approver})")

    if policy is not None and getattr(policy, "require_approval_reason", False):
        if not _field(row, "approval_reason").strip():
            return (f"{subject} was approved by {approver} with no reason, and this "
                    "deployment requires one")

    return None


def apply_refusal(*, policy, rows, now: datetime | None = None) -> str | None:
    """Why this apply may not run at all, or None when it may.

    Two questions in one answer, because an apply needs both: the calendar says
    whether *anything* may be applied at this instant, and each row says whether
    *that* decision is live. The calendar is checked first — "it is 14:00 on a
    Tuesday" is a fact about the deployment, and reporting it ahead of five
    expired approvals is more useful than the other order.

    The row list is whatever the caller is about to apply. An empty list still
    answers the calendar question, which is what the one-click approve-and-apply
    path uses: its click *is* the approval, so only the window can refuse it.
    """
    moment = now or datetime.now(timezone.utc)

    if policy is not None:
        outside = policy.window_refusal(moment)
        if outside:
            return outside

    problems = [reason for reason in
                (approval_refusal(row, policy=policy, now=moment) for row in rows)
                if reason]
    if not problems:
        return None
    if len(problems) == 1:
        return problems[0]
    shown = "; ".join(problems[:3])
    more = f"; and {len(problems) - 3} more" if len(problems) > 3 else ""
    return f"{len(problems)} findings are not ready to apply: {shown}{more}"
