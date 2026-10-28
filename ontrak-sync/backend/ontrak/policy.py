"""Ontrak Sync — when the timer fires, and what it is allowed to do.

Two responsibilities, kept apart on purpose.

`cron` is arithmetic. Given an expression and an instant, when is the next one?
It is hand-written rather than pulled from a library because this is the piece an
operator edits by hand in a web form, and a wrong answer here is silent: the
fleet simply stops being updated and nothing says so. So it is small enough to
test exhaustively and it refuses anything it does not fully understand instead of
falling back to a default.

`decide` is policy. Given what was found and what the operator configured, is
this a scan, an approval request, or an apply? Keeping it a pure function of
(findings, policy) is what makes "detect only" provable rather than a claim — the
same input can be replayed in a test and must not produce a write.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

# ── cron ─────────────────────────────────────────────────────────────────────
# The weekday field's upper bound is 7, not 6, because cron accepts both 0 and 7
# for Sunday. It is normalised to 0 after expansion; validating against 6 would
# reject `0 3 * * 7` outright, and a schedule that is refused looks like a typo
# rather than like the other spelling of the same day.
_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day", 1, 31), ("month", 1, 12), ("weekday", 0, 7))
_ALIASES = {
    "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}


class CronError(ValueError):
    """The expression is not something this scheduler will pretend to understand."""


def _expand(field: str, low: int, high: int, name: str) -> set[int]:
    """Expand one cron field into the set of values it names.

    Accepts `*`, `a`, `a-b`, `a-b/n`, `*/n` and comma lists of those. A step of 0,
    an out-of-range number, or a backwards range is an error — every one of them
    is more likely to be a typo than an intent, and guessing would hide it.
    """
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            raise CronError(f"{name}: empty list item in {field!r}")
        step = 1
        if "/" in part:
            part, _, step_text = part.partition("/")
            if not step_text.isdigit() or int(step_text) == 0:
                raise CronError(f"{name}: bad step in {field!r}")
            step = int(step_text)
        if part == "*":
            start, end = low, high
        elif "-" in part.lstrip("-"):
            start_text, _, end_text = part.partition("-")
            if not start_text.isdigit() or not end_text.isdigit():
                raise CronError(f"{name}: bad range in {field!r}")
            start, end = int(start_text), int(end_text)
        else:
            if not part.isdigit():
                raise CronError(f"{name}: bad value in {field!r}")
            start = end = int(part)
            if step != 1:
                # `5/10` means "from 5, every 10" — i.e. to the top of the range.
                end = high
        if start < low or end > high or start > end:
            raise CronError(f"{name}: {part!r} outside {low}-{high}")
        values.update(range(start, end + 1, step))
    return values


@dataclass(frozen=True)
class Cron:
    """A parsed 5-field cron expression."""

    minutes: set[int]
    hours: set[int]
    days: set[int]
    months: set[int]
    weekdays: set[int]
    source: str = ""
    # `dom_restricted`/`dow_restricted` matter because cron's rule for day-of-month
    # and day-of-week together is OR, not AND — but only when both are restricted.
    # `0 0 1 * 1` is "the 1st, or any Monday", which surprises people; implementing
    # it as AND would fire roughly 12 times a year instead of ~60, and the operator
    # would have no way to tell except by counting.
    dom_restricted: bool = True
    dow_restricted: bool = True

    @classmethod
    def parse(cls, expression: str) -> "Cron":
        text = (expression or "").strip()
        if not text:
            raise CronError("empty expression")
        lowered = text.lower()
        if lowered in _ALIASES:
            text = _ALIASES[lowered]
        fields = text.split()
        if len(fields) != 5:
            if len(fields) == 6:
                raise CronError("6 fields given; seconds are not supported — use 5 (minute hour day month weekday)")
            raise CronError(f"expected 5 fields, got {len(fields)}")
        expanded = [_expand(f, low, high, name) for f, (name, low, high) in zip(fields, _FIELDS)]
        minutes, hours, days, months, weekdays = expanded
        if not all(expanded):
            raise CronError("a field matched nothing")
        # cron accepts 7 for Sunday; normalise to 0 so the rest of the code has one
        # spelling to reason about.
        if 7 in weekdays:
            weekdays = (weekdays - {7}) | {0}
        return cls(
            minutes=minutes, hours=hours, days=days, months=months, weekdays=weekdays,
            source=text,
            dom_restricted=fields[2] != "*", dow_restricted=fields[4] != "*",
        )

    def matches(self, moment: datetime) -> bool:
        """Does this expression fire at `moment` (to the minute)?"""
        if moment.minute not in self.minutes or moment.hour not in self.hours:
            return False
        if moment.month not in self.months:
            return False
        day_ok = moment.day in self.days
        # THE WEEKDAY MAPPING IS NOT THE SAME IN BOTH PLACES, and this conversion is
        # the whole reason it is written out rather than assumed. cron numbers
        # Sunday=0 … Saturday=6; Python's `datetime.weekday()` numbers Monday=0 …
        # Sunday=6. Reading one as the other shifts every weekly schedule by a day:
        # `0 4 * * 0` would fire on Monday, which is a bug with no symptom except
        # that the fleet updates on the wrong night.
        week_ok = (moment.weekday() + 1) % 7 in self.weekdays
        if self.dom_restricted and self.dow_restricted:
            return day_ok or week_ok
        return day_ok and week_ok

    def next_after(self, after: datetime, horizon_days: int = 366 * 5) -> datetime | None:
        """The first firing strictly after `after`, or None within the horizon.

        Minute-stepping rather than a field-wise jump: it cannot be wrong about
        month lengths or leap years, and the horizon bound means a never-firing
        expression (`0 0 30 2 *`) returns None instead of looping forever.
        """
        moment = (after + timedelta(minutes=1)).replace(second=0, microsecond=0)
        limit = after + timedelta(days=horizon_days)
        while moment <= limit:
            if self.matches(moment):
                return moment
            moment += timedelta(minutes=1)
        return None


# ── the maintenance calendar ─────────────────────────────────────────────────
# Weekday names, Monday-first, because Python's `datetime.weekday()` numbers the
# week that way and this module already had one off-by-a-day bug from reading
# cron's Sunday-first numbers as Monday-first (see `describe`).
_WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _window_covers(window, moment: datetime) -> bool:
    """Is `moment` inside one named window?

    A window is recurring (a weekday set) or a one-off inside a date range; both
    are the same shape with the dates left empty. Every question this asks can be
    answered "no" from a malformed entry, which is deliberate: `validate()` is
    where a malformed calendar is reported, and a runtime check that failed open
    would turn a typo into an apply at any hour.
    """
    if not isinstance(window, dict):
        return False
    weekdays = window.get("weekdays")
    if not isinstance(weekdays, (list, tuple)) or not weekdays:
        return False
    if moment.weekday() not in [day for day in weekdays
                               if isinstance(day, int) and 0 <= day <= 6]:
        return False
    start_date, end_date = str(window.get("start") or ""), str(window.get("end") or "")
    if start_date or end_date:
        try:
            first, last = date.fromisoformat(start_date), date.fromisoformat(end_date)
        except (ValueError, TypeError):
            return False
        if not first <= moment.date() <= last:
            return False
    start_hour, end_hour = window.get("start_hour"), window.get("end_hour")
    if not isinstance(start_hour, int) or not isinstance(end_hour, int):
        return False
    if start_hour == end_hour:
        return False
    hour = moment.hour
    if start_hour < end_hour:
        return start_hour <= hour < end_hour
    return hour >= start_hour or hour < end_hour


def _describe_window(window) -> str:
    """One window as the sentence a refusal uses, e.g. `"Quarterly audit" (Sat, Sun 22:00-04:00)`."""
    if not isinstance(window, dict):
        return "an unreadable window"
    name = str(window.get("name") or "").strip() or "unnamed window"
    weekdays = [day for day in window.get("weekdays") or []
                if isinstance(day, int) and 0 <= day <= 6]
    days = ", ".join(_WEEKDAY_NAMES[day] for day in sorted(set(weekdays))) or "no days"
    start_hour, end_hour = window.get("start_hour"), window.get("end_hour")
    hours = (f"{int(start_hour):02d}:00-{int(end_hour):02d}:00"
             if isinstance(start_hour, int) and isinstance(end_hour, int) else "no hours")
    dates = ""
    start, end = str(window.get("start") or ""), str(window.get("end") or "")
    if start and end:
        dates = f", {start} to {end}"
    return f'"{name}" ({days} {hours}{dates})'


def _window_problems(index: int, window) -> list[str]:
    """Every complaint about one calendar entry, all at once.

    The settings form is a single submit, and a calendar is the field most likely
    to be pasted in by hand, so a half-typed entry has to come back as a list of
    what is wrong rather than as the first thing that happened to be parsed.
    """
    if not isinstance(window, dict):
        return [f"maintenance window {index + 1} must be an object"]
    name = str(window.get("name") or "").strip()
    label = f"maintenance window {name!r}" if name else f"maintenance window {index + 1}"
    problems: list[str] = []
    if not name:
        problems.append(f"maintenance window {index + 1} needs a name")
    weekdays = window.get("weekdays")
    if not isinstance(weekdays, (list, tuple)) or not weekdays:
        problems.append(f"{label} needs at least one weekday")
    else:
        bad = [day for day in weekdays
               if not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6]
        if bad:
            problems.append(f"{label} has weekday(s) outside 0-6: {bad!r} (Monday is 0)")
    start_date = str(window.get("start") or "")
    end_date = str(window.get("end") or "")
    if bool(start_date) != bool(end_date):
        problems.append(f"{label} needs both a start and an end date, or neither")
    parsed: dict[str, date] = {}
    for key, value in (("start", start_date), ("end", end_date)):
        if not value:
            continue
        try:
            parsed[key] = date.fromisoformat(value)
        except (ValueError, TypeError):
            problems.append(f"{label} {key} must be an ISO date (YYYY-MM-DD), not {value!r}")
    if len(parsed) == 2 and parsed["start"] > parsed["end"]:
        problems.append(f"{label} ends before it starts")
    start_hour, end_hour = window.get("start_hour"), window.get("end_hour")
    for key, hour in (("start_hour", start_hour), ("end_hour", end_hour)):
        if not isinstance(hour, int) or isinstance(hour, bool) or not 0 <= hour <= 23:
            problems.append(f"{label} {key} must be 0-23")
    if isinstance(start_hour, int) and isinstance(end_hour, int) and start_hour == end_hour:
        problems.append(f"{label} has the same start and end hour — write 0 and 23 for a whole day")
    return problems


@dataclass
class Policy:
    """How this deployment is allowed to behave. Persisted as one JSON row."""

    mode: str = "detect"                 # detect | auto
    schedule: str = "0 3 * * 0"          # Sundays 03:00
    enabled: bool = True
    timezone: str = "UTC"
    # Scopes are the safety rail that makes `auto` usable: `apt` unattended is a
    # different risk from `docker`, which recreates containers, and different
    # again from `dist-upgrade`, which this tool never does.
    scopes: list[str] = field(default_factory=lambda: ["apt", "snap", "docker"])
    security_only: bool = False
    window_start_hour: int | None = None
    window_end_hour: int | None = None
    max_concurrent: int = 3
    # Blast radius, the part that decides how much of the fleet one bad candidate can
    # reach. The canary is applied alone first; only when it comes back clean does the
    # run move on, and each later wave is at most `apply_wave_size` targets. The
    # defaults are the cautious ones — one canary, five per wave — because an update
    # tool that touches the whole fleet in the first run is one upgrade away from an
    # outage nobody can pause. `apply_max_targets` (0 = no bound) is the separate
    # ceiling on a whole run: a scan that found four hundred findings is not four
    # hundred authorisations.
    apply_canary_targets: int = 1
    apply_wave_size: int = 5
    apply_max_targets: int = 0
    # Whether a wave that produced any failure stops the run. On by default: the
    # reason to canary at all is that a failure should cost one machine, not one
    # fleet. Off is for a deployment that would rather see every outcome in one run
    # and sort it out afterwards — an explicit choice, not a default.
    apply_halt_on_failure: bool = True
    host_ids: list[int] = field(default_factory=list)   # empty = every host
    # A change freeze — an inclusive ISO date range during which nothing is applied,
    # whatever the mode. The hourly window says "these are the hours we patch"; the
    # freeze says "these are the weeks we do not" (an audit, a holiday shutdown, a
    # change moratorium), which is a different question and needs a date rather than
    # an hour. Empty on both ends means no freeze, which is the shipped default.
    freeze_from: str = ""                # ISO YYYY-MM-DD, inclusive
    freeze_to: str = ""                  # ISO YYYY-MM-DD, inclusive
    # A maintenance calendar — the windows an apply is *allowed* during, which is
    # the other direction from the freeze. The freeze says "these weeks we do not
    # patch"; a calendar says "these are the windows we do". Each entry is
    # `{name, start, end, weekdays, start_hour, end_hour}`: dates are optional
    # (empty on both means a weekly window), weekdays are Monday=0 to Sunday=6, and
    # a window that wraps midnight is the normal case rather than an error. An
    # empty list is the shipped default and means no calendar at all.
    maintenance_windows: list[dict] = field(default_factory=list)
    # How long an approval stays live, in hours. 0 is the shipped default and means
    # "never expires": an approval is a named decision, and a deployment that wants
    # one to lapse has to say so. A positive value is stamped onto each approval as
    # it is recorded, so a later change to this number does not move deadlines that
    # were already promised.
    approval_ttl_hours: int = 0
    # When on, an approval must carry a reason before it can be applied. Off by
    # default: a reason is worth having, and a deployment that requires one is a
    # policy somebody chose rather than a form field everybody is forced through.
    require_approval_reason: bool = False

    def as_dict(self) -> dict:
        return {
            "mode": self.mode, "schedule": self.schedule, "enabled": self.enabled,
            "timezone": self.timezone, "scopes": list(self.scopes),
            "security_only": self.security_only, "window_start_hour": self.window_start_hour,
            "window_end_hour": self.window_end_hour,            "max_concurrent": self.max_concurrent,
            "apply_canary_targets": self.apply_canary_targets,
            "apply_wave_size": self.apply_wave_size,
            "apply_max_targets": self.apply_max_targets,
            "apply_halt_on_failure": self.apply_halt_on_failure,
            "host_ids": list(self.host_ids),
            "freeze_from": self.freeze_from, "freeze_to": self.freeze_to,
            "maintenance_windows": [dict(window) for window in (self.maintenance_windows or [])
                                   if isinstance(window, dict)],
            "approval_ttl_hours": self.approval_ttl_hours,
            "require_approval_reason": self.require_approval_reason,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Policy":
        known = {f for f in cls().__dict__}
        return cls(**{k: v for k, v in (data or {}).items() if k in known})

    def validate(self) -> list[str]:
        """Return every complaint at once, so a bad form is fixed in one pass."""
        problems: list[str] = []
        if self.mode not in ("detect", "auto"):
            problems.append(f"mode must be 'detect' or 'auto', not {self.mode!r}")
        try:
            Cron.parse(self.schedule)
        except CronError as exc:
            problems.append(f"schedule: {exc}")
        bad = sorted(set(self.scopes) - {"apt", "snap", "docker"})
        if bad:
            problems.append(f"unknown scope(s): {', '.join(bad)}")
        if not self.scopes:
            problems.append("at least one scope is required")
        for label, hour in (("window_start_hour", self.window_start_hour), ("window_end_hour", self.window_end_hour)):
            if hour is not None and not 0 <= hour <= 23:
                problems.append(f"{label} must be 0-23, not {hour}")
        if self.max_concurrent < 1:
            problems.append("max_concurrent must be at least 1")

        # The blast radius is read straight into an apply order, so a nonsense value
        # here is not a cosmetic form error: a zero wave size or a canary larger than
        # its wave would make the run touch more than the operator asked for, and the
        # first symptom would be an outage rather than a validation message.
        for label, value in (("apply_canary_targets", self.apply_canary_targets),
                             ("apply_wave_size", self.apply_wave_size),
                             ("apply_max_targets", self.apply_max_targets)):
            if not isinstance(value, int) or isinstance(value, bool):
                problems.append(f"{label} must be a whole number")
        if isinstance(self.apply_wave_size, int) and not isinstance(self.apply_wave_size, bool) \
                and self.apply_wave_size < 1:
            problems.append("apply_wave_size must be at least 1")
        if isinstance(self.apply_canary_targets, int) and not isinstance(self.apply_canary_targets, bool) \
                and self.apply_canary_targets < 0:
            problems.append("apply_canary_targets must be 0 (no canary) or more")
        if isinstance(self.apply_max_targets, int) and not isinstance(self.apply_max_targets, bool) \
                and self.apply_max_targets < 0:
            problems.append("apply_max_targets must be 0 (unlimited) or more")
        if (isinstance(self.apply_canary_targets, int) and not isinstance(self.apply_canary_targets, bool)
                and isinstance(self.apply_wave_size, int) and not isinstance(self.apply_wave_size, bool)
                and self.apply_canary_targets > self.apply_wave_size):
            problems.append("apply_canary_targets must not exceed apply_wave_size")

        # A freeze is a promise the operator makes to somebody else (an auditor, a
        # change board), so a half-written one is refused rather than quietly read
        # as "no freeze": one date without the other is almost always a form that
        # was saved too early, and failing open on it is the wrong direction.
        if bool(self.freeze_from) != bool(self.freeze_to):
            problems.append("a change freeze needs both a start and an end date")
        parsed: dict[str, date] = {}
        for label, value in (("freeze_from", self.freeze_from), ("freeze_to", self.freeze_to)):
            if not value:
                continue
            try:
                parsed[label] = date.fromisoformat(value)
            except ValueError:
                problems.append(f"{label} must be an ISO date (YYYY-MM-DD), not {value!r}")
        if len(parsed) == 2 and parsed["freeze_from"] > parsed["freeze_to"]:
            problems.append("the change freeze ends before it starts")

        # A calendar is the same kind of promise as a freeze — somebody else plans
        # around it — so every entry is validated here rather than at the moment an
        # apply is refused with a window the form should never have accepted.
        if not isinstance(self.maintenance_windows, list):
            problems.append("maintenance_windows must be a list of windows")
        else:
            for index, window in enumerate(self.maintenance_windows):
                problems.extend(_window_problems(index, window))
        if not isinstance(self.approval_ttl_hours, int) or isinstance(self.approval_ttl_hours, bool) \
                or self.approval_ttl_hours < 0:
            problems.append("approval_ttl_hours must be 0 (never expires) or a positive number of hours")
        return problems

    def in_window(self, moment: datetime) -> bool:
        """Is `moment` inside the maintenance window, if one is set?

        A window that wraps midnight (`22`->`4`) is the normal case for this kind
        of work, so the wrap is supported rather than treated as a mistake.
        """
        if self.window_start_hour is None or self.window_end_hour is None:
            return True
        if self.window_start_hour == self.window_end_hour:
            return True  # a zero-length window is no window, not a 24-hour lockout
        hour = moment.hour
        if self.window_start_hour < self.window_end_hour:
            return self.window_start_hour <= hour < self.window_end_hour
        return hour >= self.window_start_hour or hour < self.window_end_hour

    def _freeze_dates(self) -> tuple[date, date] | None:
        """The freeze as inclusive dates, or None when there is no usable freeze.

        A freeze with one end missing or an unparseable date is a form error that
        `validate()` reports; here it degrades to *no freeze* rather than to an
        open-ended one, and the read paths that only need a yes/no answer (the
        API payload, the report) get that answer without having to re-parse.
        """
        if not self.freeze_from or not self.freeze_to:
            return None
        try:
            start = date.fromisoformat(self.freeze_from)
            end = date.fromisoformat(self.freeze_to)
        except ValueError:
            return None
        return (start, end) if start <= end else None

    def in_change_window(self, moment: datetime | None = None) -> bool:
        """Is `moment` inside the maintenance calendar?

        No calendar means any time, so a deployment that never configures one keeps
        exactly the behaviour it had. A configured calendar is an allow-list: a
        moment outside every window is outside the calendar, and that is what
        `window_refusal` turns into the sentence a refused operator reads. An
        unreadable entry covers nothing rather than everything — the fail-closed
        direction, because a typo in a window must not authorise a 3am apply.
        """
        if not self.maintenance_windows:
            return True
        current = moment or datetime.now(timezone.utc)
        return any(_window_covers(window, current) for window in self.maintenance_windows)

    def window_refusal(self, moment: datetime | None = None) -> str | None:
        """Why `moment` is outside the calendar, or None when it is inside.

        This is the sentence an operator reads when a click is refused, so it names
        every window the deployment has rather than only saying no: one of them is
        the thing to change, and which one is not for this function to guess.
        """
        if not self.maintenance_windows:
            return None
        current = moment or datetime.now(timezone.utc)
        if self.in_change_window(current):
            return None
        stamp = current.strftime("%Y-%m-%d %H:%M UTC")
        if len(self.maintenance_windows) == 1:
            return (f"outside the maintenance calendar: {stamp} is not inside "
                    f"{_describe_window(self.maintenance_windows[0])}")
        windows = "; ".join(_describe_window(window) for window in self.maintenance_windows)
        return f"outside the maintenance calendar: {stamp} is not inside any of {windows}"

    def in_freeze(self, moment: datetime) -> bool:
        """Is `moment`'s date inside the change freeze? Inclusive on both ends.

        A freeze is a *date* question and the window is an *hour* question, so this
        is checked separately rather than folded into `in_window` — a deployment
        can want "patch on Sunday nights, except through the December moratorium"
        and should be able to say exactly that.
        """
        window = self._freeze_dates()
        if window is None:
            return False
        start, end = window
        return start <= moment.date() <= end

    def action_for(self, *, security_count: int, total_count: int, now: datetime | None = None) -> str:
        """What should happen to a host's findings right now?

        Returns `"apply"`, `"approve"` or `"skip"`. In `detect` mode the best it
        can return is `"approve"` — there is no input that makes it apply, which is
        the property the tests pin.
        """
        if not self.enabled or total_count == 0:
            return "skip"
        if self.security_only and security_count == 0:
            return "skip"
        moment = now or datetime.now(timezone.utc)
        if not self.in_window(moment):
            return "skip"
        if self.in_freeze(moment):
            # A freeze outranks the mode: `auto` still applies *nothing* while the
            # moratorium is on, which is the only reading of "freeze" that means
            # anything.
            return "skip"
        if not self.in_change_window(moment):
            # A calendar outranks the mode for the same reason: `auto` may only do
            # what the operator said it may do, and "these are the hours we patch
            # in" is such a statement. The manual path is refused with the same
            # sentence by `approvals.apply_refusal`.
            return "skip"
        return "apply" if self.mode == "auto" else "approve"


def next_runs(cron: Cron, count: int = 5, now: datetime | None = None) -> list[str]:
    """The next `count` firings, ISO-formatted — what the GUI shows under the form."""
    moment = now or datetime.now(timezone.utc)
    out: list[str] = []
    for _ in range(count):
        nxt = cron.next_after(moment)
        if nxt is None:
            break
        out.append(nxt.isoformat(timespec="minutes"))
        moment = nxt
    return out


def describe(expression: str) -> str:
    """A short human sentence for a cron expression, for the timer's helper text."""
    text = (expression or "").strip().lower()
    if text in _ALIASES:
        return f"{text} — {_ALIASES[text]}"
    try:
        cron = Cron.parse(expression)
    except CronError as exc:
        return f"invalid: {exc}"
    if len(cron.minutes) == 1 and len(cron.hours) == 1:
        minute = next(iter(cron.minutes))
        hour = next(iter(cron.hours))
        if cron.days == set(range(1, 32)) and cron.months == set(range(1, 13)) and cron.weekdays == set(range(0, 7)):
            return f"every day at {hour:02d}:{minute:02d}"
        if cron.days == set(range(1, 32)) and cron.months == set(range(1, 13)):
            # CRON NUMBERS WEEKDAYS FROM SUNDAY, the names below run from Monday,
            # and indexing one list with the other is how this sentence said "Mon"
            # for every Sunday schedule while the list of next runs beside it said
            # Sunday. The names are printed Monday-first because that is how a week
            # reads here, so the cron number is rotated by six to index them.
            names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            weekdays = sorted(cron.weekdays, key=lambda d: (d + 6) % 7)
            days = ", ".join(names[(d + 6) % 7] for d in weekdays)
            return f"{days} at {hour:02d}:{minute:02d}"
        return f"at {hour:02d}:{minute:02d} on the named days and months"
    if len(cron.minutes) == 1 and cron.hours == set(range(0, 24)):
        return f"every hour at :{next(iter(cron.minutes)):02d}"
    return re.sub(r"\s+", " ", expression).strip()
