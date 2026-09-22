"""The portal's own housekeeping (``ontrak/maintenance.py``).

Why this suite exists: the reaper was only ever run by a command. On the container
stack there is no cron, so an expired session kept its machine and the student's page
sat at ``in_use`` with ``0:00`` on it — which is exactly how it was reported. What is
asserted here is that the portal now does that work itself, that it does *not* quietly
start creating machines (pool refill is an operator's decision), and that the daily
history prune deletes only what it is allowed to.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from ontrak import maintenance
from ontrak.guest import NullDriver
from ontrak.models import ScoreReport, Session, SessionState, iso, utcnow


def _finished_session(store, *, days_ago: int, student: str = "alice"):
    when = utcnow() - timedelta(days=days_ago)
    return store.create_session(
        Session(
            id=None,
            student=student,
            scenario_id="net-dns-failure",
            state=SessionState.DESTROYED,
            instance=f"ontrak-sess-closed-{student}",
            created_at=iso(when),
            last_activity_at=iso(when),
        )
    )


class _Stub:
    """A manager that records what the loop asked it to do."""

    def __init__(self, *, reap=None, prune=None):
        self.calls: list[tuple] = []
        self._reap = reap
        self._prune = prune

    def reap(self, *, refill: bool = True) -> dict:
        self.calls.append(("reap", refill))
        if self._reap is not None:
            raise self._reap
        return {"recycled": [], "refilled": {}}

    def prune_history(self, *, days=None, now=None):
        self.calls.append(("prune_history", days))
        if self._prune is not None:
            raise self._prune
        return {"deleted": 0, "sessions": [], "kept": [], "live": [], "dry_run": False}


# --------------------------------------------------------------------------- #
# one pass
# --------------------------------------------------------------------------- #
def test_a_tick_reaps_sessions_and_never_refills_the_pool(settings):
    """Machine accounting is a promise; machine *creation* is capacity policy.

    A background thread that boots machines on a host somebody sized for one student is
    the surprise this whole thing must not spring, so the loop asks for the session
    half of `reap` and no more.
    """
    stub = _Stub()
    result = maintenance.tick(stub, settings)
    assert stub.calls == [("reap", False), ("prune_history", None)]
    assert result["error"] == ""
    assert result["reaped"] == {"recycled": [], "refilled": {}}


def test_a_failing_reap_does_not_stop_the_prune(settings):
    """A hypervisor that is down must not also mean history never ages out."""
    stub = _Stub(reap=RuntimeError("incus is not running"))
    result = maintenance.tick(stub, settings)
    assert ("prune_history", None) in stub.calls
    assert "incus is not running" in result["error"]


def test_a_failing_prune_is_reported_and_swallowed(settings):
    """The loop is a daemon nobody watches: an exception here would end housekeeping
    silently, which is the state this module exists to remove."""
    stub = _Stub(prune=RuntimeError("database is locked"))
    result = maintenance.tick(stub, settings)
    assert "database is locked" in result["error"]


# --------------------------------------------------------------------------- #
# the loop itself
# --------------------------------------------------------------------------- #
def test_the_loop_runs_a_pass_immediately_and_then_stops(settings):
    """A portal restarted after a class should take back the last class's machines,
    not wait an interval to notice them."""
    settings.session.maintenance_enabled = True
    settings.session.maintenance_interval_seconds = 3600  # one pass, no second one
    stub = _Stub()
    loop = maintenance.start(stub, settings)
    assert loop is not None
    try:
        assert stub.calls[:2] == [("reap", False), ("prune_history", None)]
    finally:
        loop.stop()
    assert not loop.thread.is_alive()


def test_the_loop_is_off_when_the_range_says_so(settings):
    """An instructor-observed session may need to outlive its own timer."""
    settings.session.maintenance_enabled = False
    assert maintenance.start(_Stub(), settings) is None


def test_the_portal_starts_and_stops_the_loop_with_itself(settings, store, repo, incus):
    """The wiring, not just the function: a container stack has no cron, so the loop
    has to be part of the app's own lifetime."""
    from fastapi.testclient import TestClient

    from ontrak.portal.app import create_app

    settings.session.maintenance_enabled = True
    settings.session.maintenance_interval_seconds = 3600  # one pass, no second one
    app = create_app(settings, incus=incus, driver=NullDriver(settings))
    with TestClient(app):
        assert isinstance(app.state.maintenance, maintenance.Loop)
        assert app.state.maintenance.thread.is_alive()
    assert app.state.maintenance is None


# --------------------------------------------------------------------------- #
# history, on a clock
# --------------------------------------------------------------------------- #
def test_prune_history_deletes_finished_rows_once_a_day(manager, store):
    old = _finished_session(store, days_ago=60)

    first = manager.prune_history()
    assert first is not None
    assert first["sessions"] == [old.id]
    assert store.get_session(old.id) is None

    # ...and then not again inside the interval, however often a tick calls it.
    assert manager.prune_history() is None
    # A day later is a different matter.
    assert manager.prune_history(now=utcnow() + timedelta(hours=25)) is not None


def test_prune_history_keeps_a_session_a_grade_points_at(manager, store):
    graded = _finished_session(store, days_ago=60)
    store.add_result(
        ScoreReport(session_id=graded.id, scenario_id="net-dns-failure", score=90.0, resolved=True),
        "alice",
    )
    result = manager.prune_history()
    assert result["kept"] == [graded.id]
    assert store.get_session(graded.id) is not None
    assert store.latest_report(graded.id) is not None


def test_prune_history_can_be_switched_off(settings, manager, store):
    """`history_days: 0` means keep everything, and means it for the loop too."""
    settings.session.history_days = 0
    old = _finished_session(store, days_ago=365)
    assert manager.prune_history() is None
    assert store.get_session(old.id) is not None


def test_prune_history_uses_the_configured_retention(settings, manager, store):
    settings.session.history_days = 7
    week_old = _finished_session(store, days_ago=3)
    month_old = _finished_session(store, days_ago=30, student="bob")

    result = manager.prune_history()

    assert result["sessions"] == [month_old.id]
    assert store.get_session(week_old.id) is not None


def test_reap_can_skip_the_pool_refill(manager, store, incus, built_template, settings):
    """The loop's half of `reap`: sessions expire, nothing new is created."""
    settings.pool.default_target = 2
    session = manager.allocate("alice", "net-dns-failure")
    store.update_session(session.id, expires_at=iso(utcnow() - timedelta(minutes=1)))

    result = manager.reap(refill=False)

    assert session.id in result["recycled"]
    assert result["refilled"] == {}
    assert not [name for name in incus.instances if name.startswith("ontrak-pool")]


@pytest.mark.parametrize("days_ago,expected", [(1, 0), (60, 1)])
def test_the_daily_prune_ignores_recent_history(manager, store, days_ago, expected):
    _finished_session(store, days_ago=days_ago)
    result = manager.prune_history()
    assert len(result["sessions"]) == expected
