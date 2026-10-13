"""The schedule decides when host memory is spent. The arithmetic is pure, so these
tests are time-travel rather than waiting for a clock."""

from __future__ import annotations

from datetime import datetime

import pytest

from ontrak.scheduler import Action, Schedule, Window, parse_day, parse_time

# 2026-09-14 is a Monday; 2026-09-19 is a Saturday.
MONDAY = datetime(2026, 9, 14, 8, 45)
MONDAY_CLASS = datetime(2026, 9, 14, 10, 0)
MONDAY_AFTER = datetime(2026, 9, 14, 12, 5)
SATURDAY = datetime(2026, 9, 19, 10, 0)


def window(**kwargs) -> Window:
    base = {
        "label": "morning-class",
        "days": ["mon", "wed"],
        "start": "09:00",
        "end": "12:00",
        "prewarm_minutes": 30,
        "target": 2,
        "scenarios": ["net-dns-failure"],
    }
    base.update(kwargs)
    return Window(**base)


def test_window_phases():
    w = window()
    assert w.in_prewarm(MONDAY) is True
    assert w.covers(MONDAY) is False
    assert w.covers(MONDAY_CLASS) is True
    assert w.in_prewarm(MONDAY_CLASS) is False
    assert w.just_ended(MONDAY_AFTER) is True
    assert w.covers(SATURDAY) is False
    assert w.in_prewarm(SATURDAY) is False


def test_window_rejects_an_end_before_the_start():
    with pytest.raises(ValueError, match="end must be after start"):
        window(start="12:00")
    with pytest.raises(ValueError, match="prewarm_minutes"):
        window(prewarm_minutes=-5)


def test_day_and_time_parsing():
    assert parse_day("Monday") == "mon"
    assert parse_day("THURS") == "thu"
    with pytest.raises(ValueError, match="unknown day"):
        parse_day("funday")
    assert parse_time("09:30").hour == 9
    assert parse_time("09:30:15").second == 15
    with pytest.raises(ValueError, match="HH:MM"):
        parse_time("half past nine")


def test_prewarm_fills_only_the_deficit():
    schedule = Schedule(windows=[window(target=5)])
    actions = schedule.actions(MONDAY, pool={"net-dns-failure": 3})
    assert [a.kind for a in actions] == ["prewarm"]
    assert actions[0].count == 2
    assert "wants 5, pool has 3" in actions[0].reason

    covered = schedule.actions(MONDAY, pool={"net-dns-failure": 5})
    assert covered == []


def test_no_prewarm_before_the_lead_in_opens():
    schedule = Schedule(windows=[window(prewarm_minutes=30)])
    assert schedule.actions(datetime(2026, 9, 14, 8, 20), pool={}) == []


def test_a_window_without_scenarios_falls_back_to_every_scenario():
    schedule = Schedule(windows=[window(target=1, scenarios=[])])
    actions = schedule.actions(MONDAY, pool={}, scenarios=["a", "b"])
    assert {a.scenario_id for a in actions} == {"a", "b"}
    assert all(a.count == 1 for a in actions)


def test_pool_is_drained_when_the_window_closes():
    schedule = Schedule(windows=[window()])
    actions = schedule.actions(MONDAY_AFTER, pool={"net-dns-failure": 4, "other": 0})
    assert [a.kind for a in actions] == ["drain-pool"]
    assert actions[0].count == 4
    assert "wastes host memory" in actions[0].reason


def test_idle_sessions_are_recycled_during_a_window():
    schedule = Schedule(windows=[window()])
    actions = schedule.actions(
        MONDAY_CLASS,
        pool={"net-dns-failure": 2},
        idle_sessions=[
            {"id": 4, "scenario_id": "net-dns-failure", "idle_minutes": 25},
            {"id": 5, "scenario_id": "net-dns-failure", "idle_minutes": 3},
        ],
        idle_minutes=20,
    )
    kinds = [a.kind for a in actions]
    assert kinds.count("recycle-idle") == 1
    assert "session 4" in next(a.reason for a in actions if a.kind == "recycle-idle")


def test_a_disabled_or_empty_schedule_does_nothing():
    assert Schedule(windows=[window()], enabled=False).actions(MONDAY, pool={}) == []
    assert Schedule(windows=[]).actions(MONDAY, pool={}) == []
    assert Schedule(windows=[window()]).actions(SATURDAY, pool={}) == []


def test_action_for_reports_the_phase():
    schedule = Schedule(windows=[window()])
    assert schedule.action_for(MONDAY) == "prewarming for morning-class"
    assert schedule.action_for(MONDAY_CLASS) == "open: morning-class"
    assert schedule.action_for(MONDAY_AFTER) == "just closed: morning-class"
    assert schedule.action_for(SATURDAY) == "idle"


def test_schedule_config_round_trip():
    data = {"enabled": True, "windows": [{"label": "c", "days": ["mon"], "start": "09:00", "end": "10:00", "target": 1}]}
    schedule = Schedule.from_config(data)
    assert schedule.enabled is True
    assert schedule.windows[0].label == "c"
    assert schedule.to_dict()["windows"][0]["days"] == ["mon"]
    # Unknown keys in config must not crash the parser (configs drift).
    assert Schedule.from_config({"windows": [{"label": "x", "nonsense": True}]}).windows[0].label == "x"


def test_action_serialises_for_the_cli():
    action = Action("prewarm", scenario_id="s", count=2, reason="because")
    assert action.to_dict() == {"kind": "prewarm", "scenario_id": "s", "count": 2, "reason": "because"}


def test_tick_executes_against_a_manager(settings, store, repo, incus, built_template):
    from ontrak.sessions import SessionManager

    manager = SessionManager(
        settings, store, repo=repo, incus=incus, driver=type("D", (), {"name": "null", "wait_ready": lambda *a, **k: True})()
    )
    manager.prewarm("net-dns-failure", 1)
    schedule = Schedule(windows=[window(target=1)])
    from ontrak.scheduler import Scheduler

    result = Scheduler(manager, schedule).tick(MONDAY_AFTER)
    assert result["phase"] == "just closed: morning-class"
    assert any(row["kind"] == "drain-pool" for row in result["performed"])
    assert manager.pool_status("net-dns-failure")[0].total == 0
