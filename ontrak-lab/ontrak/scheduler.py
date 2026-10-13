"""Scheduled prewarming and teardown.

A class starts at 09:00. If every student's first action is "provision me a VM", the
first five minutes are spent watching a clone bar and the host takes a burst of load.
Both problems disappear if the pool is warm before the class and drained after it.

So a schedule is a list of windows, and each window drives three things:

* **prewarm** — fill the pool for its scenarios so a student gets a VM in seconds,
* **drain** — when the window ends, delete unclaimed pool VMs and recycle idle sessions,
* **guard** — keep the pool at target while the window is open (and only then).

Everything here is pure computation plus a thin executor, so the arithmetic is
testable without a hypervisor: :meth:`Schedule.actions` decides, :class:`Scheduler`
performs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta

DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_ALIASES = {
    "mon": "mon", "monday": "mon",
    "tue": "tue", "tues": "tue", "tuesday": "tue",
    "wed": "wed", "weds": "wed", "wednesday": "wed",
    "thu": "thu", "thur": "thu", "thurs": "thu", "thursday": "thu",
    "fri": "fri", "friday": "fri",
    "sat": "sat", "saturday": "sat",
    "sun": "sun", "sunday": "sun",
}


def parse_day(value: str) -> str:
    key = str(value).strip().lower()
    if key in DAY_ALIASES:
        return DAY_ALIASES[key]
    raise ValueError(f"unknown day {value!r}; use {', '.join(DAY_NAMES)}")


def parse_time(value: str | time) -> time:
    if isinstance(value, time):
        return value
    text = str(value).strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    raise ValueError(f"time {value!r} must look like HH:MM")


@dataclass
class Window:
    """A period during which the lab is expected to be busy."""

    start: str = "09:00"
    end: str = "12:00"
    days: list[str] = field(default_factory=lambda: [d for d in DAY_NAMES[:5]])
    label: str = "class"
    prewarm_minutes: int = 30
    target: int = 2
    scenarios: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.days = [parse_day(d) for d in (self.days or DAY_NAMES[:5])]
        self.start_time = parse_time(self.start)
        self.end_time = parse_time(self.end)
        if self.end_time <= self.start_time:
            raise ValueError(f"window {self.label!r}: end must be after start")
        if self.prewarm_minutes < 0:
            raise ValueError(f"window {self.label!r}: prewarm_minutes cannot be negative")

    # -- queries -------------------------------------------------------
    def covers(self, when: datetime) -> bool:
        """Is the window open at this instant?"""
        if DAY_NAMES[when.weekday()] not in self.days:
            return False
        return self.start_time <= when.time() < self.end_time

    def in_prewarm(self, when: datetime) -> bool:
        """Are we inside the prewarm lead-in for a window starting later today?"""
        if DAY_NAMES[when.weekday()] not in self.days:
            return False
        opens = when.replace(
            hour=self.start_time.hour, minute=self.start_time.minute, second=0, microsecond=0
        )
        begins = opens - timedelta(minutes=self.prewarm_minutes)
        return begins <= when < opens

    def just_ended(self, when: datetime, within_minutes: int = 15) -> bool:
        """Did the window close recently? (drives the drain, once per tick)"""
        if DAY_NAMES[when.weekday()] not in self.days:
            return False
        closes = when.replace(
            hour=self.end_time.hour, minute=self.end_time.minute, second=0, microsecond=0
        )
        return timedelta(0) <= (when - closes) < timedelta(minutes=within_minutes)


@dataclass
class Action:
    kind: str  # prewarm | drain-pool | recycle-idle
    scenario_id: str = ""
    count: int = 0
    reason: str = ""

    def to_dict(self) -> dict:
        return {"kind": self.kind, "scenario_id": self.scenario_id, "count": self.count, "reason": self.reason}


@dataclass
class Schedule:
    windows: list[Window] = field(default_factory=list)
    enabled: bool = True

    @classmethod
    def from_config(cls, data: dict | None) -> Schedule:
        data = data or {}
        windows = []
        for raw in data.get("windows") or []:
            if isinstance(raw, dict):
                windows.append(Window(**{k: v for k, v in raw.items() if k in Window.__dataclass_fields__}))
        return cls(windows=windows, enabled=bool(data.get("enabled", True)))

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "windows": [
                {
                    "label": w.label,
                    "days": w.days,
                    "start": w.start,
                    "end": w.end,
                    "prewarm_minutes": w.prewarm_minutes,
                    "target": w.target,
                    "scenarios": w.scenarios,
                }
                for w in self.windows
            ],
        }

    def action_for(self, when: datetime) -> str:
        """What phase is this instant in, for operator visibility."""
        for window in self.windows:
            if window.covers(when):
                return f"open: {window.label}"
            if window.in_prewarm(when):
                return f"prewarming for {window.label}"
            if window.just_ended(when):
                return f"just closed: {window.label}"
        return "idle"

    # -- the decision --------------------------------------------------
    def actions(
        self,
        when: datetime,
        *,
        pool: dict[str, int] | None = None,
        idle_sessions: list[dict] | None = None,
        scenarios: list[str] | None = None,
        idle_minutes: int = 20,
    ) -> list[Action]:
        """Work out what should happen right now.

        ``pool`` maps scenario id to the number of *available* (claimed-able) VMs, so
        the prewarm only fills a genuine deficit — a class mid-session does not trigger
        a second wave of VMs.
        """
        if not self.enabled or not self.windows:
            return []
        pool = pool or {}
        scenarios = scenarios or []
        actions: list[Action] = []

        for window in self.windows:
            if window.covers(when) or window.in_prewarm(when):
                phase = "open" if window.covers(when) else "prewarm"
                for scenario_id in (window.scenarios or scenarios):
                    have = int(pool.get(scenario_id, 0))
                    deficit = int(window.target) - have
                    if deficit > 0:
                        actions.append(
                            Action(
                                "prewarm",
                                scenario_id=scenario_id,
                                count=deficit,
                                reason=f"{phase} window {window.label!r} wants {window.target}, pool has {have}",
                            )
                        )
                if phase == "open":
                    for session in idle_sessions or []:
                        if float(session.get("idle_minutes", 0)) >= idle_minutes:
                            actions.append(
                                Action(
                                    "recycle-idle",
                                    scenario_id=str(session.get("scenario_id", "")),
                                    count=1,
                                    reason=f"session {session.get('id')} idle {session.get('idle_minutes')} min during {window.label!r}",
                                )
                            )

        if any(window.just_ended(when) for window in self.windows):
            for scenario_id, have in sorted(pool.items()):
                if have > 0:
                    actions.append(
                        Action(
                            "drain-pool",
                            scenario_id=scenario_id,
                            count=have,
                            reason="class window closed; pooling VMs idle wastes host memory",
                        )
                    )
        return actions


class Scheduler:
    """Executes :meth:`Schedule.actions` against a live session manager."""

    def __init__(self, manager, schedule: Schedule):
        self.manager = manager
        self.schedule = schedule

    def _pool_map(self) -> dict[str, int]:
        """Unclaimed (handout-ready) VMs per scenario.

        ``ready`` rather than ``total``: VMs a student is currently using must not
        count towards a window's target, or the prewarm would build a second wave
        and the drain would try to delete a machine someone is working on.
        """
        out: dict[str, int] = {}
        for status in self.manager.pool_status():
            out[status.scenario_id] = int(status.ready)
        return out

    def tick(self, when: datetime | None = None, *, idle_minutes: int | None = None) -> dict:
        when = when or datetime.now()
        from .config import (  # local import keeps this module import-light
            load_settings,
        )

        settings = getattr(self.manager, "settings", None) or load_settings()
        idle_minutes = idle_minutes if idle_minutes is not None else settings.session.idle_recycle_minutes

        from .models import SessionState

        available = self._pool_map()
        scenarios = list(self.manager.repository.ids()) if self.manager.repository else []
        idle = []
        for session in self.manager.store.list_sessions(states=[SessionState.IN_USE]):
            idle.append(
                {
                    "id": session.id,
                    "scenario_id": session.scenario_id,
                    "idle_minutes": self.manager.session_age_minutes(session),
                }
            )

        plan = self.schedule.actions(
            when, pool=available, idle_sessions=idle, scenarios=scenarios, idle_minutes=idle_minutes
        )
        performed: list[dict] = []
        for action in plan:
            try:
                if action.kind == "prewarm":
                    created = self.manager.prewarm(action.scenario_id, action.count)
                    performed.append({**action.to_dict(), "created": created})
                elif action.kind == "drain-pool":
                    removed = self.manager.drain_pool(action.scenario_id)
                    performed.append({**action.to_dict(), "removed": removed})
                elif action.kind == "recycle-idle":
                    performed.append({**action.to_dict(), "performed": True})
            except Exception as exc:  # noqa: BLE001 - keep going, report at the end
                performed.append({**action.to_dict(), "error": str(exc)})
        return {
            "when": when.isoformat(timespec="seconds"),
            "phase": self.schedule.action_for(when),
            "planned": [a.to_dict() for a in plan],
            "performed": performed,
        }
