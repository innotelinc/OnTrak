from __future__ import annotations

import json

import pytest

from ontrak.guest import NullDriver
from ontrak.models import SessionState
from ontrak.portal.app import create_app
from ontrak.scenarios import JSON_BEGIN, JSON_END

SCENARIO = "net-dns-failure"
OBJECTIVES = ["restore-resolver", "resolve-intranet", "reach-service"]

try:  # FastAPI + httpx are optional at runtime; skip cleanly if absent
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover
    TestClient = None

pytestmark = pytest.mark.skipif(TestClient is None, reason="fastapi/httpx not installed")


def pass_payload() -> str:
    checks = [{"objective": o, "passed": True, "detail": "ok"} for o in OBJECTIVES]
    return f"{JSON_BEGIN}{json.dumps({'checks': checks})}{JSON_END}"


@pytest.fixture
def app_client(settings, store, incus):
    store.upsert_user("alice", "alice-pw", "student", "Alice A")
    store.upsert_user("teacher", "teach-pw", "instructor", "Teacher T")
    driver = NullDriver(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": pass_payload()})
    app = create_app(settings, incus=incus, driver=driver)
    # A template must exist for provisioning to succeed.
    app.state.manager.ensure_template(SCENARIO)
    with TestClient(app) as client:
        yield client, app


def login(client, username: str, password: str, follow: bool = True):
    token = client.cookies.get("ontrak_csrf") or ""
    if not token:
        client.get("/login")
        token = client.cookies.get("ontrak_csrf")
    return client.post(
        "/login",
        data={"username": username, "password": password, "csrf": token or ""},
        follow_redirects=follow,
    )


def csrf(client) -> str:
    return client.cookies.get("ontrak_csrf", "")


def provision(app, student: str = "alice"):
    """Wait for the background provisioning worker and return a fresh session.

    The portal deliberately provisions in a thread, so tests must not read a
    Session object captured before that thread finished. ``provision`` is
    serialised per session and re-reads the row, which makes this deterministic.
    """
    session = app.state.store.live_sessions_for(student)[0]
    return app.state.manager.provision(session)


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
def test_health_endpoint(app_client):
    client, _ = app_client
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["scenarios"] >= 1


def test_dashboard_requires_login(app_client):
    client, _ = app_client
    response = client.get("/dashboard")
    assert response.status_code == 200
    assert "Sign in" in response.text


def test_wrong_password_is_rejected(app_client):
    client, _ = app_client
    response = login(client, "alice", "wrong-password", follow=False)
    assert response.status_code == 401
    assert "wrong password" in response.text


def test_valid_login_lands_on_the_dashboard(app_client):
    client, _ = app_client
    response = login(client, "alice", "alice-pw")
    assert response.status_code == 200
    assert "Your training machines" in response.text
    assert "Nothing resolves on the intranet" in response.text  # a scenario title


def test_logout_clears_the_session(app_client):
    client, _ = app_client
    login(client, "alice", "alice-pw")
    response = client.post("/logout", data={"csrf": csrf(client)}, follow_redirects=True)
    assert response.status_code == 200
    assert "Sign in" in response.text
    assert client.get("/dashboard").text.count("Sign in") >= 1


def test_csrf_is_enforced_on_posts(app_client):
    client, _ = app_client
    login(client, "alice", "alice-pw")
    response = client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": "forged"})
    assert response.status_code == 400


def test_instructor_area_requires_the_role(app_client):
    client, _ = app_client
    login(client, "alice", "alice-pw")
    assert client.get("/instructor").status_code == 403
    client.post("/logout", data={"csrf": csrf(client)})
    login(client, "teacher", "teach-pw")
    assert client.get("/instructor").status_code == 200


# --------------------------------------------------------------------------- #
# session flow
# --------------------------------------------------------------------------- #
def test_full_student_flow(app_client):
    client, app = app_client
    login(client, "alice", "alice-pw")

    start = client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    assert start.status_code == 200  # redirect followed

    session = provision(app)
    assert session.state is SessionState.READY

    page = client.get(f"/sessions/{session.id}")
    assert page.status_code == 200
    assert "Nothing resolves on the intranet" in page.text
    assert "guac.test" in page.text  # the console iframe points at the gateway
    assert "Check my work" in page.text

    status = client.get(f"/sessions/{session.id}/status").json()
    assert status["ready"] is True
    assert status["state"] in {"ready", "in_use"}

    checked = client.post(f"/sessions/{session.id}/check", data={"csrf": csrf(client)})
    assert checked.status_code == 200
    assert "Resolved" in checked.text
    # A practice check is shown to the student and deliberately not stored.
    assert app.state.store.latest_report(session.id) is None
    assert "not recorded" in checked.text

    # Complete & End grades once, stores that result, and destroys the machine.
    completed = client.post(f"/sessions/{session.id}/complete", data={"csrf": csrf(client)})
    assert completed.status_code == 200
    report = app.state.store.latest_report(session.id)
    assert report is not None
    assert report.score == 100.0
    assert report.resolved is True
    assert "objective-by-objective" in completed.text or "Submitted" in completed.text
    results = client.get("/results")
    assert results.status_code == 200
    assert "100%" in results.text
    assert report.resolved is True


def test_hints_unlock_only_after_an_attempt(app_client):
    client, app = app_client
    login(client, "alice", "alice-pw")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)

    blocked = client.post(f"/sessions/{session.id}/hint", data={"csrf": csrf(client)})
    assert "hints unlock after your first attempt" in blocked.text.lower()
    assert app.state.store.get_session(session.id).hint_level == 0

    client.post(f"/sessions/{session.id}/check", data={"csrf": csrf(client)})
    revealed = client.post(f"/sessions/{session.id}/hint", data={"csrf": csrf(client)})
    assert "Hint revealed" in revealed.text
    assert app.state.store.get_session(session.id).hint_level == 1


def test_reset_hands_over_a_clean_machine(app_client):
    client, app = app_client
    login(client, "alice", "alice-pw")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance
    assert instance, "provisioning should have produced an instance"

    response = client.post(f"/sessions/{session.id}/reset", data={"csrf": csrf(client)})
    assert response.status_code == 200
    reloaded = app.state.store.get_session(session.id)
    # The follow-up page render claims the fresh VM for use, so READY or IN_USE
    # are both correct here.
    assert reloaded.state in {SessionState.READY, SessionState.IN_USE}
    assert reloaded.instance == instance
    assert app.state.incus.exists(instance)
    assert app.state.incus.instance_status(instance) == "RUNNING"


def test_a_student_cannot_open_someone_elses_session(app_client):
    client, app = app_client
    other = app.state.manager.allocate("bob", SCENARIO)
    login(client, "alice", "alice-pw")

    response = client.get(f"/sessions/{other.id}")
    assert response.status_code == 200
    assert "belongs to another student" in response.text
    assert other.host_ip not in response.text  # no console, no address leak
    assert client.get(f"/sessions/{other.id}/status").status_code == 404

    # and a student cannot reset or end someone else's machine either
    assert app.state.incus.instance_status(other.instance) == "RUNNING"
    client.post(f"/sessions/{other.id}/reset", data={"csrf": csrf(client)})
    client.post(f"/sessions/{other.id}/end", data={"csrf": csrf(client)})
    assert app.state.incus.exists(other.instance)
    assert app.state.store.get_session(other.id).state is not SessionState.DESTROYED


def test_end_session_destroys_the_vm(app_client):
    client, app = app_client
    login(client, "alice", "alice-pw")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance

    response = client.post(f"/sessions/{session.id}/end", data={"csrf": csrf(client)})
    assert response.status_code == 200
    assert app.state.store.get_session(session.id).state is SessionState.DESTROYED
    assert not app.state.incus.exists(instance)


# --------------------------------------------------------------------------- #
# instructor
# --------------------------------------------------------------------------- #
def test_instructor_page_shows_pool_and_results(app_client):
    client, app = app_client
    app.state.manager.allocate("bob", SCENARIO)
    login(client, "teacher", "teach-pw")
    page = client.get("/instructor")
    assert page.status_code == 200
    assert "Capacity: templates and warm pool" in page.text
    assert "bob" in page.text
    assert "Build template" in page.text


def test_results_csv_export(app_client):
    client, app = app_client
    session = app.state.manager.allocate("bob", SCENARIO)
    app.state.manager.complete(session)
    login(client, "teacher", "teach-pw")
    response = client.get("/instructor/results.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "bob" in response.text
    assert "scenario_id" in response.text


def test_instructor_can_prewarm_and_rebuild_templates(app_client):
    client, app = app_client
    login(client, "teacher", "teach-pw")
    prewarm = client.post(
        "/instructor/prewarm",
        data={"scenario_id": SCENARIO, "count": 2, "csrf": csrf(client)},
    )
    assert prewarm.status_code == 200
    assert app.state.manager.pool_status(SCENARIO)[0].ready == 2

    rebuild = client.post(
        "/instructor/template",
        data={"scenario_id": SCENARIO, "csrf": csrf(client)},
    )
    assert rebuild.status_code == 200


def test_students_cannot_reach_instructor_actions(app_client):
    client, _ = app_client
    login(client, "alice", "alice-pw")
    response = client.post(
        "/instructor/prewarm", data={"scenario_id": SCENARIO, "count": 5, "csrf": csrf(client)}
    )
    assert response.status_code == 403
