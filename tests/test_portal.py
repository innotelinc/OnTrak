from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ontrak.models import Session, SessionState
from ontrak.portal.app import LAB_NETWORK, _machine_address
from ontrak.tickets import WRITEUP_ACTION
from tests.helpers import synthesise_ticket

from .conftest import csrf, login

SCENARIO = "net-dns-failure"
OBJECTIVES = ["restore-resolver", "resolve-intranet", "reach-service"]


@pytest.fixture
def app_client(app_env):
    """The shared portal fixture — this suite is its oldest and largest user."""
    return app_env


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


def test_a_signed_in_student_lands_on_the_dashboard(app_client):
    client, _ = app_client
    login(client, "alice")
    response = client.get("/dashboard")
    assert response.status_code == 200
    assert "Your training machines" in response.text
    assert "Nothing resolves on the intranet" in response.text  # a scenario title


def test_logout_clears_the_session(app_client):
    client, _ = app_client
    login(client, "alice")
    response = client.post("/logout", data={"csrf": csrf(client)}, follow_redirects=True)
    assert response.status_code == 200
    assert "Sign in" in response.text
    assert client.get("/dashboard").text.count("Sign in") >= 1


def test_csrf_is_enforced_on_posts(app_client):
    client, _ = app_client
    login(client, "alice")
    response = client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": "forged"})
    assert response.status_code == 400


def test_instructor_area_requires_the_role(app_client):
    client, _ = app_client
    login(client, "alice")
    assert client.get("/instructor").status_code == 403
    client.post("/logout", data={"csrf": csrf(client)})
    login(client, "teacher")
    assert client.get("/instructor").status_code == 200


# --------------------------------------------------------------------------- #
# session flow
# --------------------------------------------------------------------------- #
def test_full_student_flow(app_client):
    client, app = app_client
    login(client, "alice")

    start = client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    assert start.status_code == 200  # redirect followed

    session = provision(app)
    # `is_usable`, not bare READY: the POST above follows its redirect into the
    # session page, and a page view claims a READY machine (READY -> IN_USE) —
    # which of the two the student lands on depends on whether the provisioning
    # thread finished before that page was rendered. Both are equally usable,
    # which is what the rest of this test already asserts about the state.
    assert session.state.is_usable

    page = client.get(f"/sessions/{session.id}")
    assert page.status_code == 200
    assert "Nothing resolves on the intranet" in page.text
    # The frame points at our own bootstrap page rather than at the gateway, so the
    # stored Guacamole token can be cleared before the gateway URL is opened. See the
    # console-bootstrap tests below.
    assert f'src="/sessions/{session.id}/console"' in page.text
    # The frame can fill the screen, and the console can pop out into its own tab
    # where it is the top-level document.
    assert "allowfullscreen" in page.text
    assert "Full screen" in page.text
    assert f'href="/sessions/{session.id}/console"' in page.text
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

    # Complete & End grades once, stores that result, and destroys the machine. The
    # write-up is part of the submission, so it is filled in like a student would —
    # including the submitting control the buttons carry (the ticket's own `action`
    # field is data, not a command: see tickets.WRITEUP_ACTION).
    form = app.state.manager.ticket_form_for(session)
    completed = client.post(
        f"/sessions/{session.id}/complete",
        data={**synthesise_ticket(form), WRITEUP_ACTION: "complete", "csrf": csrf(client)},
    )
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


def test_a_resolved_practice_check_leaves_the_student_still_holding_the_session(app_client):
    """The machine passes, and the student must still be able to write it up.

    This is the flow a classroom walks: run the repair, press Check my work, see it
    pass, and then hand the session in. The check used to move the session to
    `passed`, which the page reads as *submitted* — it announced a destroyed machine,
    dropped the console, the write-up and the hand-in button, and left the student with
    no way to submit the work they had just proved.
    """
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)

    checked = client.post(f"/sessions/{session.id}/check", data={"csrf": csrf(client)})
    assert "Resolved" in checked.text
    assert app.state.store.get_session(session.id).state is SessionState.IN_USE

    page = checked.text
    assert "Check my work" in page
    assert f'src="/sessions/{session.id}/console"' in page
    assert "Complete &amp; End" in page or "Complete & End" in page
    assert "machine has been destroyed" not in page


def test_a_submitted_session_offers_nothing_it_cannot_do(app_client):
    """The other half, on the page the student reaches after handing in.

    The machine is gone by then, so a Check button can only answer with "session has no
    VM" — an internal error where the student expected feedback — and the page has to
    say where the grade is instead.
    """
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    form = app.state.manager.ticket_form_for(session)
    client.post(
        f"/sessions/{session.id}/complete",
        data={**synthesise_ticket(form), WRITEUP_ACTION: "complete", "csrf": csrf(client)},
    )
    assert app.state.store.get_session(session.id).state is SessionState.PASSED

    page = client.get(f"/sessions/{session.id}")
    assert page.status_code == 200
    assert "Check my work" not in page.text
    assert "Reset machine" not in page.text
    assert "machine has been destroyed" in page.text
    assert f"/results?session={session.id}" in page.text


# --------------------------------------------------------------------------- #
# the console bootstrap
#
# Guacamole keeps its auth token in the browser's localStorage and re-authenticates
# with it on every load, and the gateway *reuses the session that token belongs to* —
# so a fresh, correctly signed payload is ignored and the console opens the machine
# that browser used last. A student moving from session #3 to #4 sat watching the
# destroyed #3 report "the remote desktop server has encountered an error", and no
# cache-buster on the Guacamole URL could fix it, because the stored token decides.
# These pin the fix: the frame loads our own page, which drops that token first.
# --------------------------------------------------------------------------- #
def _session_with_a_machine(client, app):
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    return provision(app)


def test_the_bootstrap_drops_the_stored_token_when_the_console_is_our_own_origin(app_client):
    """`auto` (the default) puts the console on the portal's origin, so it can clear."""
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.settings.guac.base_url = "auto"

    page = client.get(f"/sessions/{session.id}/console")
    assert page.status_code == 200
    assert "GUAC_AUTH_TOKEN" in page.text  # the clear, before the gateway is opened
    assert "/guacamole/#/?data=" in page.text


def test_the_bootstrap_leaves_a_console_on_another_origin_alone(app_client):
    """A console on a different origin has storage this page cannot reach.

    Nothing is gained by pretending otherwise: the frame must still open, and the
    honest reading of "cannot tell" is "do not clear someone else's key".
    """
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.settings.guac.base_url = "http://guac.test/guacamole/"

    page = client.get(f"/sessions/{session.id}/console")
    assert page.status_code == 200
    assert "http://guac.test/guacamole/#/?data=" in page.text
    assert "GUAC_AUTH_TOKEN" not in page.text


def test_the_session_page_states_a_console_on_another_origin(app_client):
    """A pinned console loses the stored-token clear, so the page says what that means.

    The student cannot fix this and would otherwise just see the wrong machine, so the
    one sentence belongs where they are looking, not only in a log.
    """
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.settings.guac.base_url = "http://guac.test/guacamole/"

    page = client.get(f"/sessions/{session.id}")
    assert "The console is on a different site from this portal" in page.text
    assert "http://guac.test" in page.text


def test_the_session_page_is_quiet_when_the_console_follows_its_own_address(app_client):
    """`auto` is the default and the supported posture: no warning on a healthy range."""
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.settings.guac.base_url = "auto"

    page = client.get(f"/sessions/{session.id}")
    assert "The console is on a different site from this portal" not in page.text


def test_a_pending_session_says_the_console_is_coming_not_that_it_is_unset(app_client):
    """Mid-allocation, the page must not blame the operator for a console that is not there yet.

    The copy used to fall through to "no browser console is configured" — telling a
    student their instructor had not set one up while the machine was simply still
    booting. That is a sentence about a fault where there was only a wait.
    """
    client, app = app_client
    login(client, "alice")
    # A session the student owns, mid-allocation: no instance, no address yet.
    session = app.state.store.create_session(
        Session(id=None, student="alice", scenario_id=SCENARIO, state=SessionState.ALLOCATING)
    )

    page = client.get(f"/sessions/{session.id}")
    assert page.status_code == 200
    assert "Preparing your machine" in page.text
    assert "The console appears as soon as your machine has an address." in page.text
    assert "No browser console is configured" not in page.text
    assert "the instructor needs to set guac.base_url" not in page.text


def test_the_bootstrap_is_not_a_way_into_another_students_machine(app_client):
    """It hands out a signed console URL, so it is guarded like the session page."""
    client, app = app_client
    other = app.state.manager.allocate("bob", SCENARIO)
    login(client, "alice")

    page = client.get(f"/sessions/{other.id}/console", follow_redirects=True)
    assert "belongs to another student" in page.text
    assert "/guacamole/#/?data=" not in page.text


def test_the_bootstrap_says_so_when_there_is_no_console(app_client):
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.settings.guac.base_url = ""

    page = client.get(f"/sessions/{session.id}/console", follow_redirects=True)
    assert page.status_code == 200
    assert "no browser console for this machine" in page.text


def test_instructor_watch_goes_through_the_same_bootstrap(app_client):
    """A tab opened by an instructor has the same stale-token problem a frame does."""
    client, app = app_client
    session = _session_with_a_machine(client, app)
    client.post("/logout", data={"csrf": csrf(client)})
    login(client, "teacher")

    response = client.get(f"/instructor/sessions/{session.id}/console", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == f"/sessions/{session.id}/console"


# --------------------------------------------------------------------------- #
# the heartbeat
#
# The idle reaper frees a machine nobody is sitting in front of, and it reads activity
# from this app — but a student works *inside the console*, which the gateway serves
# from its own upstream. Nothing they do in the machine reaches the portal, so a session
# whose page was opened once and then left alone looked abandoned: session #8 of a live
# range, a 45-minute limit, was destroyed `idle_20m` twenty-one minutes in, mid-scenario,
# with its console frame still on screen. The machine had not failed — it was reclaimed.
# These pin the fix and its two edges: only a machine on screen is kept, and only its own
# student can keep it.
# --------------------------------------------------------------------------- #
def _idle_for(app, session, minutes: int) -> str:
    """Move a session's activity clock back, as if nobody had touched it for `minutes`."""
    when = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    app.state.store.update_session(session.id, last_activity_at=when)
    return when


def _machine_for(app, student: str) -> Session:
    """A provisioned machine for a second student (the suite's `provision` is alice's)."""
    app.state.manager.allocate(student, SCENARIO)
    return provision(app, student)


def test_a_live_session_page_pings_the_heartbeat(app_client):
    """The page has to carry the beat, and say what it is for."""
    client, app = app_client
    session = _session_with_a_machine(client, app)

    page = client.get(f"/sessions/{session.id}")
    assert f"/sessions/{session.id}/heartbeat" in page.text
    assert "with no sign of you" in page.text


def test_the_heartbeat_is_what_keeps_a_machine_a_student_is_working_in(app_client):
    """Two sessions idle past the window; only the one that beats survives the reaper.

    Same staleness on both rows, one difference: the student's page is open behind the
    console and pings. That difference is the whole bug — and the machine that goes
    without it is the one the range used to take back mid-scenario.
    """
    client, app = app_client
    idle = app.state.settings.session.idle_recycle_minutes
    working = _session_with_a_machine(client, app)
    forgotten = _machine_for(app, "bob")
    for session in (working, forgotten):
        _idle_for(app, session, idle + 10)

    beat = client.get(f"/sessions/{working.id}/heartbeat")
    assert beat.status_code == 200
    assert beat.json()["state"] in {"ready", "in_use"}

    assert app.state.manager.reap(refill=False)["recycled"] == [forgotten.id]
    survived = app.state.store.get_session(working.id)
    assert survived.state in {SessionState.READY, SessionState.IN_USE}
    assert survived.host_ip, "the working student's machine was taken back anyway"


def test_a_finished_session_cannot_be_kept_alive_by_a_stale_tab(app_client):
    """The beat is a presence signal, not a revival: a destroyed row stays untouched.

    A student's page left open on a machine that has since gone must not hold the row
    active — it is the *absence* of a machine that makes the point moot, and the page
    stops beating as soon as it reloads on the reaper's own state change.
    """
    client, app = app_client
    session = _session_with_a_machine(client, app)
    app.state.manager.recycle(session, reason="ended by an instructor")
    stale = _idle_for(app, session, 5)

    response = client.get(f"/sessions/{session.id}/heartbeat")
    assert response.status_code == 200
    assert response.json()["state"] == "destroyed"
    assert app.state.store.get_session(session.id).last_activity_at == stale
    assert "/heartbeat" not in client.get(f"/sessions/{session.id}").text


def test_a_machine_kept_for_a_debrief_is_kept_by_the_page_that_shows_it(app_client):
    """`destroy_on_complete: false` promises the machine until the clock runs out.

    A submitted session's machine is still reaped for idleness like any other, so without a
    beat the page said one thing ("taken back when this session's clock runs out") while the
    reaper did another — twenty minutes of a student reading their own console and the
    machine goes.
    """
    client, app = app_client
    app.state.settings.session.destroy_on_complete = False
    session = _session_with_a_machine(client, app)

    form = app.state.manager.ticket_form_for(session)
    client.post(
        f"/sessions/{session.id}/complete",
        data={**synthesise_ticket(form), WRITEUP_ACTION: "complete", "csrf": csrf(client)},
    )
    submitted = app.state.store.get_session(session.id)
    assert submitted.state is SessionState.PASSED
    assert submitted.host_ip, "the debrief machine was thrown away anyway"
    page = client.get(f"/sessions/{session.id}")
    assert f"/sessions/{session.id}/heartbeat" in page.text, "a kept machine stops beating"

    _idle_for(app, submitted, app.state.settings.session.idle_recycle_minutes + 10)
    client.get(f"/sessions/{session.id}/heartbeat")
    assert app.state.manager.reap(refill=False)["recycled"] == []
    assert app.state.store.get_session(session.id).host_ip


def test_the_heartbeat_is_not_a_way_into_another_students_session(app_client):
    """A beacon that writes to the session is guarded like the page that reads it."""
    client, app = app_client
    _machine_for(app, "bob")
    other = app.state.store.live_sessions_for("bob")[0]
    login(client, "alice")

    assert client.get(f"/sessions/{other.id}/heartbeat").status_code == 404


def test_starting_a_scenario_this_range_cannot_run_is_refused(app_client):
    """The refusal has to happen before a session row exists.

    The whole point of asking first is that the student does not end up holding a
    session whose only content is an operator's template error — a spent slot that
    also has to be cleaned up. So this asserts the message *and* the absence of the
    row the old path would have created.
    """
    client, app = app_client
    login(client, "alice")

    response = client.post(
        "/sessions/start", data={"scenario_id": "sw-app-crash", "csrf": csrf(client)}
    )
    assert response.status_code == 200  # the redirect was followed
    assert "not available on this range yet" in response.text
    assert not app.state.store.list_sessions(scenario_id="sw-app-crash")
    assert app.state.store.live_sessions_for("alice") == []


def test_the_dashboard_flags_a_scenario_that_cannot_start(app_client):
    client, app = app_client
    login(client, "alice")
    page = client.get("/dashboard")
    assert page.status_code == 200
    # The card is still shown (a student may want to ask for it) but it carries the
    # reason and no start button, instead of looking identical to a working one.
    assert "sw-app-crash" in page.text
    assert "not available on this range yet" in page.text
    # ...and no start form: the hidden scenario_id input is how a card submits.
    assert 'value="sw-app-crash"' not in page.text
    # The scenario that can run still has its button.
    assert f'value="{SCENARIO}"' in page.text


def test_hints_unlock_only_after_an_attempt(app_client):
    client, app = app_client
    login(client, "alice")
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
    login(client, "alice")
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


def test_saving_the_writeup_does_not_hand_the_session_in(app_client):
    """The ticket's own ``action`` field must not shadow the submit button.

    Ten of the shipped scenarios ask "what you changed" as a field called ``action``,
    and the write-up fields share one HTML form with the three submitting buttons.
    With the control named ``action`` too, the field was serialised first, so the
    handler read the student's prose, matched neither save nor preview, and fell
    through to Complete & End: clicking *Save draft* graded the machine and destroyed
    it. The regression is invisible to a test that only posts a full submission.
    """
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance

    saved = client.post(
        f"/sessions/{session.id}/complete",
        data={"action": "Edited the resolver config", WRITEUP_ACTION: "save", "csrf": csrf(client)},
    )
    assert "saved as a draft" in saved.text.lower()
    still = app.state.store.get_session(session.id)
    assert still.state.is_live, f"saving a draft closed the session: {still.state}"
    assert app.state.store.latest_report(session.id) is None
    assert app.state.incus.exists(instance)

    previewed = client.post(
        f"/sessions/{session.id}/complete",
        data={"action": "Edited the resolver config", WRITEUP_ACTION: "preview", "csrf": csrf(client)},
    )
    assert "preview" in previewed.text.lower()
    assert app.state.store.get_session(session.id).state.is_live
    assert app.state.incus.exists(instance)


def test_a_submission_with_no_control_button_is_not_a_completion(app_client):
    """A POST that arrives without the submitting control must not grade and destroy.

    Browsers always send the button that was clicked; a hand-built request does not.
    Defaulting that case to Complete & End made an accidental submission fatal, so it
    defaults to the draft save instead.
    """
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance

    response = client.post(f"/sessions/{session.id}/complete", data={"csrf": csrf(client)})
    assert "saved as a draft" in response.text.lower()
    assert app.state.store.latest_report(session.id) is None
    assert app.state.incus.exists(instance)
    assert app.state.store.get_session(session.id).state.is_live


def test_a_refused_console_key_is_explained_to_the_student(app_client, monkeypatch):
    """A gateway that refuses our key must not present as a blank iframe.

    The portal signs every console link and never sees the gateway's answer, so a
    gateway with a different key — or one without the JSON auth extension — left the
    student looking at an empty frame, and nothing in either log said why. The page
    says so now, in words a student can hand to an instructor.
    """
    from ontrak.portal import app as portal_app

    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)

    monkeypatch.setattr(
        portal_app.guac,
        "probe_gateway",
        lambda settings, **kwargs: (
            "refused",
            "the console gateway rejected a payload signed with guac.secret_key "
            "(HTTP 403). Its JSON_SECRET_KEY differs from this key",
        ),
    )
    # The page render that followed the POST already cached a verdict; make this
    # render ask again rather than reusing it.
    app.state.console_gateway = None

    page = client.get(f"/sessions/{session.id}")
    assert "The console cannot open right now" in page.text
    assert "JSON_SECRET_KEY" in page.text
    assert "not a fault in your virtual machine" in page.text
    # The console is still offered: a stale verdict must not remove a working one.
    assert f'src="/sessions/{session.id}/console"' in page.text


def test_a_healthy_console_key_shows_no_warning(app_client, monkeypatch):
    from ontrak.portal import app as portal_app

    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    monkeypatch.setattr(
        portal_app.guac, "probe_gateway", lambda settings, **kwargs: ("ok", "accepted")
    )
    app.state.console_gateway = None

    page = client.get(f"/sessions/{session.id}")
    assert "The console cannot open right now" not in page.text
    assert f'src="/sessions/{session.id}/console"' in page.text


def test_a_student_cannot_open_someone_elses_session(app_client):
    client, app = app_client
    other = app.state.manager.allocate("bob", SCENARIO)
    login(client, "alice")

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
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance

    response = client.post(f"/sessions/{session.id}/end", data={"csrf": csrf(client)})
    assert response.status_code == 200
    assert app.state.store.get_session(session.id).state is SessionState.DESTROYED
    assert not app.state.incus.exists(instance)


# --------------------------------------------------------------------------- #
# the machine's address, and ending from the list
# --------------------------------------------------------------------------- #
LINUX_SCENARIO = "linux-ownership-chown-repair"


def test_the_session_page_always_carries_the_machine_address(app_client):
    """The address is on the page, not something a student has to ask for."""
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)

    page = client.get(f"/sessions/{session.id}").text
    assert session.host_ip in page
    assert f":{app.state.settings.guest.rdp_port}" in page
    # The old copy sent the student to their instructor for a string the portal
    # already held, which is one question per session and nothing at all when no
    # instructor is watching.
    assert "give you the address" not in page
    assert "hand you an RDP address" not in page


def test_a_linux_machine_says_how_it_is_reached(app_client):
    """A Linux guest is a shell, so the page says which shell and where."""
    _, app = app_client
    settings = app.state.settings
    scenario = app.state.repo.get(LINUX_SCENARIO)
    session = Session(id=1, student="alice", scenario_id=LINUX_SCENARIO, host_ip="10.20.0.9")

    # Default posture: the image runs no sshd, so the shell is the guest's own
    # console and the address is all there is to hand over.
    settings.guac.linux_ssh = False
    address = _machine_address(settings, scenario, session)
    assert (address["transport"], address["target"]) == ("shell", "10.20.0.9")

    # With an sshd in the image, the reachable form is the command itself.
    settings.guac.linux_ssh = True
    address = _machine_address(settings, scenario, session)
    assert address["transport"] == "SSH"
    assert address["target"] == f"ssh root@10.20.0.9 -p {settings.guest.ssh_port}"

    windows = app.state.repo.get(SCENARIO)
    address = _machine_address(settings, windows, session)
    assert address["transport"] == "RDP"
    assert address["target"] == f"10.20.0.9:{settings.guest.rdp_port}"
    # Every form is an address on the lab's bridge — nothing here routes from the
    # internet, which is what the page has to say alongside it.
    assert address["reach"] == LAB_NETWORK

    # Nothing to show until the guest has an address of its own.
    empty = Session(id=2, student="alice", scenario_id=LINUX_SCENARIO)
    assert _machine_address(settings, scenario, empty)["host"] == ""


def test_the_address_says_where_it_works(app_client):
    """The address identifies the machine; the console is what reaches it.

    The guests are on the lab's own bridge, so `10.20.0.x` is unroutable from a
    student's network. The page used to hand that address over as "still yours to
    connect to directly", which tells a remote student to ssh somewhere their laptop
    cannot go; it now names the network the address belongs to and the console as the
    way in.
    """
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)

    page = client.get(f"/sessions/{session.id}").text
    assert session.host_ip in page
    # Rendered, so the apostrophe in LAB_NETWORK arrives HTML-escaped: assert on the
    # words rather than on the Python string.
    assert "internal network" in page
    assert "does not route from outside it" in page
    assert "still yours to connect to directly" not in page


def test_a_linux_session_gets_a_shell_console_in_the_browser(app_client):
    """A Linux machine's console is an SSH shell, signed and embedded.

    With no route to the guests from outside the lab, this is the only way into a
    Linux machine for a remote student, so it is asserted end to end: the signed
    payload asks for ssh on the guest's port, and the page embeds that link instead of
    the copy that said there was no remote desktop to open.
    """
    from ontrak import guac

    client, app = app_client
    settings = app.state.settings
    settings.guac.linux_ssh = True
    login(client, "alice")
    # A live Linux machine, placed directly: this fixture has no guest to install an
    # sshd into, and what is under test is the console the portal signs and embeds
    # for such a machine, not the install that precedes it.
    session = app.state.manager.create_session("alice", LINUX_SCENARIO)
    session.host_ip = "10.20.0.9"
    session.state = SessionState.IN_USE
    app.state.store.save_session(session)

    payload = guac.build_payload(settings, session, app.state.repo.get(LINUX_SCENARIO))
    connection = next(iter(payload["connections"].values()))
    assert connection["protocol"] == "ssh"
    assert connection["parameters"]["hostname"] == session.host_ip
    assert connection["parameters"]["port"] == str(settings.guest.ssh_port)

    page = client.get(f"/sessions/{session.id}").text
    assert '<iframe id="console"' in page
    assert "no remote desktop to open here" not in page


def test_the_provisioning_copy_names_the_platform_being_started(app_client):
    """The site's golden image is a Windows build; a Linux session is not that."""
    client, app = app_client
    login(client, "alice")
    # create_session does not provision, so the wait card is what renders.
    session = app.state.manager.create_session("alice", LINUX_SCENARIO)

    page = client.get(f"/sessions/{session.id}").text
    assert "Preparing your machine" in page
    # The platform the session is actually built for, not the site's Windows golden
    # image - which is what the copy used to name for every scenario.
    label = app.state.catalog.get(session.workload).label
    assert f"waiting for {label} to come up" in page
    assert "waiting for Windows to come up" not in page


def test_the_dashboard_ends_a_session(app_client):
    """Ending belongs on the list of machines, not behind a page load each."""
    client, app = app_client
    login(client, "alice")
    client.post("/sessions/start", data={"scenario_id": SCENARIO, "csrf": csrf(client)})
    session = provision(app)
    instance = session.instance

    page = client.get("/dashboard").text
    assert f'action="/sessions/{session.id}/end"' in page
    assert session.host_ip in page  # the list answers "where is my machine"

    client.post(f"/sessions/{session.id}/end", data={"csrf": csrf(client)})
    assert app.state.store.get_session(session.id).state is SessionState.DESTROYED
    assert not app.state.incus.exists(instance)
    # And the offer goes away with the machine.
    assert f'action="/sessions/{session.id}/end"' not in client.get("/dashboard").text


def test_the_instructor_list_carries_the_connection_detail(app_client):
    """An instructor reaches a machine from the list, so the address is on it."""
    client, app = app_client
    session = app.state.manager.allocate("bob", SCENARIO)
    login(client, "teacher")

    page = client.get("/instructor").text
    # The target as it is used, not the bare IP: a Windows guest is `<ip>:<rdp_port>`
    # and a Linux one is the ssh command or the address itself.
    assert f"{session.host_ip}:{app.state.settings.guest.rdp_port}" in page


# --------------------------------------------------------------------------- #
# instructor
# --------------------------------------------------------------------------- #
def test_instructor_page_shows_pool_and_results(app_client):
    client, app = app_client
    app.state.manager.allocate("bob", SCENARIO)
    login(client, "teacher")
    page = client.get("/instructor")
    assert page.status_code == 200
    assert "Capacity: templates and warm pool" in page.text
    assert "bob" in page.text
    assert "Build template" in page.text


def test_results_csv_export(app_client):
    client, app = app_client
    session = app.state.manager.allocate("bob", SCENARIO)
    app.state.manager.complete(session)
    login(client, "teacher")
    response = client.get("/instructor/results.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "bob" in response.text
    assert "scenario_id" in response.text


def test_instructor_can_prewarm_and_rebuild_templates(app_client):
    client, app = app_client
    login(client, "teacher")
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
    login(client, "alice")
    response = client.post(
        "/instructor/prewarm", data={"scenario_id": SCENARIO, "count": 5, "csrf": csrf(client)}
    )
    assert response.status_code == 403
