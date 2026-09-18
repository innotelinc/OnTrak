from __future__ import annotations

from ontrak.models import CheckOutcome, ScoreReport, Session, SessionState
from ontrak.store import Store


def make_session(student: str = "alice", scenario_id: str = "net-dns-failure") -> Session:
    return Session(
        id=None,
        student=student,
        scenario_id=scenario_id,
        state=SessionState.REQUESTED,
        rdp_user="student",
        rdp_password="secret",
    )


def test_session_round_trip(store):
    session = store.create_session(make_session())
    assert session.id and session.id > 0

    store.update_session(session.id, state=SessionState.READY, instance="tpl-x", host_ip="10.20.0.5")
    loaded = store.get_session(session.id)
    assert loaded.state is SessionState.READY
    assert loaded.instance == "tpl-x"
    assert loaded.host_ip == "10.20.0.5"


def test_update_rejects_unknown_columns(store):
    session = store.create_session(make_session())
    try:
        store.update_session(session.id, nonsense=1)
    except ValueError as exc:
        assert "nonsense" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected ValueError")


def test_live_sessions_and_counts(store):
    store.create_session(make_session("alice"))
    done = store.create_session(make_session("bob"))
    store.update_session(done.id, state=SessionState.DESTROYED)

    assert [s.student for s in store.live_sessions_for("alice")] == ["alice"]
    assert store.live_sessions_for("bob") == []
    assert store.count_sessions(states=[SessionState.REQUESTED]) == 1
    assert store.count_sessions(states=[SessionState.DESTROYED]) == 1


def test_results_and_best_scores(store):
    session = store.create_session(make_session())
    for score, resolved in ((40.0, False), (90.0, True), (75.0, False)):
        report = ScoreReport(
            session_id=session.id,
            scenario_id=session.scenario_id,
            score=score,
            resolved=resolved,
            outcomes=[CheckOutcome(objective_id="a", passed=resolved, weight=10)],
        )
        store.add_result(report, session.student)

    latest = store.latest_report(session.id)
    assert latest.score == 75.0
    assert store.attempt_counts(session.id) == 3

    board = store.leaderboard()
    assert len(board) == 1
    assert board[0]["best"] == 90.0
    assert board[0]["attempts"] == 3
    assert board[0]["solved"] == 1


def test_events_are_recorded_and_ordered(store):
    session = store.create_session(make_session())
    store.log_event("ready", "first", session.id)
    store.log_event("checked", "second", session.id)
    events = store.events_for(session.id)
    assert [e["kind"] for e in events] == ["checked", "ready"]
    assert store.recent_events()[0]["kind"] == "checked"


def test_meta_round_trip(store):
    assert store.get_meta("nothing", "fallback") == "fallback"
    store.set_meta("schema", {"version": 2})
    assert store.get_meta("schema") == {"version": 2}
    store.set_meta("schema", 3)
    assert store.get_meta("schema") == 3


def test_authentication_and_roles(store):
    store.upsert_user("alice", "hunter2", "student", "Alice A")
    store.upsert_user("teacher", "hunter3", "instructor", "Teacher T")

    assert store.authenticate("ALICE", "hunter2")["role"] == "student"
    assert store.authenticate("alice", "wrong") is None
    assert store.authenticate("nobody", "hunter2") is None
    assert [u["username"] for u in store.list_users("instructor")] == ["teacher"]

    store.deactivate_user("alice")
    assert store.get_user("alice") is None
    assert store.authenticate("alice", "hunter2") is None


def test_upsert_user_resets_password_and_role(store):
    store.upsert_user("alice", "one", "student")
    store.upsert_user("alice", "two", "instructor")
    user = store.get_user("alice")
    assert user["role"] == "instructor"
    assert store.authenticate("alice", "two") is not None
    assert store.authenticate("alice", "one") is None


def test_roster_import(tmp_path, store):
    roster = tmp_path / "roster.csv"
    roster.write_text(
        "username,password,display_name\n"
        "alice,alicepw,Alice A\n"
        "bob,,Bob B\n"          # blank password -> default
        "carol\n"               # only a username -> default
    )
    created, updated = store.import_roster(roster, default_password="classpass")
    assert (created, updated) == (3, 0)
    assert store.authenticate("alice", "alicepw") is not None
    assert store.authenticate("bob", "classpass") is not None
    assert store.authenticate("carol", "classpass") is not None

    created, updated = store.import_roster(roster, default_password="classpass")
    assert (created, updated) == (0, 3)


def test_store_survives_reopen(tmp_path):
    path = tmp_path / "db.sqlite3"
    first = Store(path)
    session = first.create_session(make_session("dave"))
    second = Store(path)
    assert second.get_session(session.id).student == "dave"
