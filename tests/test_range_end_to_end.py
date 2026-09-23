"""The whole student lifecycle, end to end, on a real machine.

Every other file in this suite tests one layer with the layers underneath it doubled:
the session manager against ``FakeIncus`` and ``NullDriver``, the portal against
those, the theme against rendered markup. That is the right way to pin behaviour, and
it is deliberately blind to one thing — whether the layers agree with each other on a
real range. A fault that never made it into the snapshot, a check that grades the
injection rather than the student's work, a page that drops the hand-in button once
the practice check passes: all three pass every unit test there is.

This walks the thing whole, through the portal's own routes, with the shipped
configuration and the real guest transports — the door, the instructor creating the
account, the student signing in, a session and its machine, the address off the page,
an untouched grade, the repair, the grade that follows it, the write-up, the hand-in,
and what each of those leaves on the page.

It boots a virtual machine, so it is skipped unless it is asked for::

    ONTRAK_E2E=1 make test
    ONTRAK_E2E=1 .venv/bin/python -m pytest tests/test_range_end_to_end.py -q

Its state is its own — a scratch database in a temporary directory — so the range's
real accounts, results and audit trail are untouched. It does use the range's real
Incus project and its machine names, so run it on a range, not on a machine that is
mid-class.
"""

from __future__ import annotations

import html
import os
import re
import time
from pathlib import Path

import pytest

from .helpers import synthesise_ticket

REPO_ROOT = Path(__file__).resolve().parent.parent

# One Linux pair on purpose: it is the whole lifecycle in ~15 seconds, where a Windows
# pair is the same lifecycle plus several minutes of boot. The Windows transport is
# exercised by the template builds, and the flow itself is platform-independent.
SCENARIO = "id-locked-account"
WORKLOAD = "ubuntu-24.04"

STUDENT = "alice"
PASSWORD = "TrainMe!12345"

# What a technician would type in the guest to undo the fault. The second grade is read
# after this, so the walk proves marking follows the student's work rather than the
# injection — the half of the claim a manifest cannot make (see scripts/grade-sweep.py).
REPAIR = (
    "set -u\n"
    'IDP="python3 /var/lib/ontrak/lib/idp.py --state /var/lib/ontrak-idp/directory.json"\n'
    '$IDP --actor helpdesk --reason "verified caller against the directory before changing access"'
    " unlock aisha.khan\n"
    '$IDP --actor helpdesk --reason "revoking the session left open on the old laptop"'
    " revoke-session aisha.khan-laptop\n"
    "$IDP status aisha.khan\n"
)

pytestmark = pytest.mark.skipif(
    not os.environ.get("ONTRAK_E2E"),
    reason="boots a machine on the real range — set ONTRAK_E2E=1 to run it",
)


# --------------------------------------------------------------------------- #
# a live range
# --------------------------------------------------------------------------- #
def _env_file(path: Path) -> dict[str, str]:
    """Read a compose-style ``.env`` into a mapping, without running it.

    A shell ``eval`` is the wrong tool: this file is compose's and the app's *data*, not a
    script, and evaluating it runs whatever an operator put in it. The quoting that lets a
    value with a space survive `set -a; . ./.env` is stripped again here, the way compose
    strips it — and a different environment is a different recipe for every template, so
    reading the *right* file is the difference between a green run and a red one.
    ``scripts/grade-sweep.py`` reads it the same way, for the same reason.
    """
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


@pytest.fixture
def live_range(tmp_path):
    """The shipped configuration, a scratch database, and the real hypervisor.

    Yields ``(client, app)``. ``create_app`` gets the same Incus client the CLI builds
    and *no* driver, so the guest transports are the shipped ones — WinRM for Windows,
    SSH for Linux — rather than a double, and the machine under the walk is a VM.

    ``environ`` is assembled here rather than read from ``os.environ`` because the
    suite's own fixture strips every ``ONTRAK_*`` variable: this is the one test whose
    subject *is* the deployment's configuration, so it brings its own copy of it.
    """
    try:
        from fastapi.testclient import TestClient
    except ImportError:  # pragma: no cover - only without fastapi installed
        pytest.skip("fastapi/httpx not installed")

    from ontrak.config import load_settings
    from ontrak.incus import IncusClient
    from ontrak.portal.app import create_app

    if not IncusClient.available():
        pytest.skip("incus is not installed on this host — this walk needs a hypervisor")

    settings = load_settings(
        environ={**os.environ, **_env_file(REPO_ROOT / ".env")},
        overrides={
            # Scratch: the range's accounts, results and audit trail stay alone.
            "paths": {"state": str(tmp_path / "state")},
            # No loops behind the walk. This drives the lifecycle by hand, and a reaper
            # or a template sweep firing mid-session is a different experiment.
            "session": {"maintenance_enabled": False, "auto_templates": False},
        },
    )
    settings.ensure_dirs()
    app = create_app(settings, incus=IncusClient(settings))

    # A scenario this range cannot start is an operator's prerequisite, not a failure
    # of the thing under test — and the manager can say which it is before anything is
    # booted (that is what the portal asks before it takes a session request).
    reason = app.state.manager.scenario_availability(SCENARIO, WORKLOAD)
    if reason:
        pytest.skip(f"this range cannot start {SCENARIO}@{WORKLOAD}: {reason}")

    with TestClient(app) as client:
        yield client, app


# --------------------------------------------------------------------------- #
# driving the portal the way a browser does
# --------------------------------------------------------------------------- #
def _post(client, path: str, **fields):
    """Submit a form, with the CSRF token the last rendered page minted for us."""
    return client.post(path, data={"csrf": client.cookies.get("ontrak_csrf", ""), **fields})


def _flash(response) -> str:
    """The message the app showed after a redirect — its half of the conversation."""
    match = re.search(r'class="flash"[^>]*>(.*?)</div>', response.text, re.S)
    if not match:
        return ""
    text = re.sub(r"<[^>]+>", "", match.group(1))
    # Unescape so the walk's own log reads as the page reads: the app writes
    # "Complete & End" and the template escapes it to ``&amp;``.
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _status(client, session_id: int) -> dict:
    """The JSON the machine page polls — the only view of the machine from outside."""
    return client.get(f"/sessions/{session_id}/status").json()


def _controls(html: str, session_id: int) -> str:
    """Which of the session page's controls a browser would find on that page.

    Read off the form actions and the frame's src rather than the button *labels*:
    "Reset" appears in the footer copy of every page, so a substring search reports a
    control that is not there — and, worse, would report one as present on a submitted
    session, which is exactly the state this walk has to be able to tell apart.
    """
    found = []
    for name, target in (
        ("check", f'action="/sessions/{session_id}/check"'),
        ("reset", f'action="/sessions/{session_id}/reset"'),
        ("hand-in", f'action="/sessions/{session_id}/complete"'),
        ("console", f'src="/sessions/{session_id}/console"'),
        ("destroyed-copy", "machine has been destroyed"),
    ):
        if target in html:
            found.append(name)
    return ", ".join(found) or "nothing"


def _session_id_in(url) -> int:
    match = re.search(r"/sessions/(\d+)", str(url))
    assert match, f"no session id in {url}"
    return int(match.group(1))


# --------------------------------------------------------------------------- #
# the walk
# --------------------------------------------------------------------------- #
def test_a_student_walks_a_scenario_from_start_to_hand_in(live_range):
    from ontrak import auth

    client, app = live_range
    settings = app.state.settings
    store = app.state.store
    manager = app.state.manager
    session_id: int | None = None
    notes: list[str] = []

    def note(message: str) -> None:
        notes.append(message)

    try:
        # ---- the door ------------------------------------------------------------ #
        # A fresh range offers exactly one page to create the first instructor; a range
        # an operator has already seeded (ONTRAK_PORTAL__ADMIN_PASSWORD) closes that page
        # and its credentials are the way in. Both are the real door — the walk has to
        # know which one it is looking at rather than assume.
        page = client.get("/setup")
        if str(page.url).endswith("/login"):
            password = (settings.portal.admin_password or "").strip()
            assert password, "no /setup page and no operator credentials: this range has no door"
            signed_up = _post(
                client,
                "/login",
                username=settings.portal.admin_username or "admin",
                password=password,
            )
            note(f"door: seeded range — {_flash(signed_up)}")
        else:
            assert page.status_code == 200, f"/setup -> {page.status_code}"
            signed_up = _post(
                client,
                "/setup",
                username="admin",
                display_name="Range Admin",
                password=PASSWORD,
                confirm=PASSWORD,
            )
            note(f"door: first run — {_flash(signed_up)}")
        assert auth.COOKIE_NAME in client.cookies, "the door did not sign anybody in"

        # ---- the instructor creates the student's account ------------------------ #
        accounts = _post(
            client,
            "/admin/users",
            action="create",
            username=STUDENT,
            display_name="Alice Ahmad",
            role="student",
            password=PASSWORD,
        )
        assert STUDENT in accounts.text, "the created account is not on the accounts page"
        note(f"account: {_flash(accounts)}")

        # ---- the student signs in ------------------------------------------------ #
        _post(client, "/logout")
        client.get("/login")
        signed_in = _post(client, "/login", username=STUDENT, password=PASSWORD)
        assert auth.COOKIE_NAME in client.cookies, f"the student could not sign in: {_flash(signed_in)}"
        dashboard = client.get("/dashboard").text
        assert SCENARIO in dashboard, "the student's dashboard does not offer the scenario"
        note(f"sign-in: {_flash(signed_in)}")

        # ---- start a session ----------------------------------------------------- #
        started = _post(client, "/sessions/start", scenario_id=SCENARIO, workload=WORKLOAD)
        assert "/sessions/" in str(started.url), (
            f"no session was started: {_flash(started) or started.text[:200]}"
        )
        session_id = _session_id_in(started.url)
        note(f"session #{session_id}: {_flash(started)}")

        # ---- wait for the machine, the way the page's own poller does ------------ #
        data: dict = {}
        deadline = time.time() + 420
        while time.time() < deadline:
            data = _status(client, session_id)
            if data["ready"] or data["state"] == "error":
                break
            time.sleep(5)
        assert data.get("state") != "error", f"provisioning failed: {data.get('error')}"
        assert data.get("ready"), f"the machine never became usable: {data}"

        page = client.get(f"/sessions/{session_id}").text
        assert data["host_ip"] in page, "the address the student is told is not on the page"
        note(f"machine: {data['host_ip']} ({data['workload']}), handed over as {data['state']}")

        # ---- grade the untouched machine ----------------------------------------- #
        untouched = _post(client, f"/sessions/{session_id}/check")
        first = _flash(untouched)
        assert "Not resolved" in first, f"an untouched machine was not reported broken: {first}"
        assert _status(client, session_id)["resolved"] is False
        note(f"untouched: {first}")

        # ---- the repair, and the grade that follows it --------------------------- #
        row = store.get_session(session_id)
        repair = manager.shell_driver.run_shell(
            REPAIR, host=row.host_ip, instance=row.instance, timeout=300
        )
        assert repair.ok, f"the repair itself failed: exit {repair.exit_code}: {repair.stderr}"

        fixed = _post(client, f"/sessions/{session_id}/check")
        second = _flash(fixed)
        assert "Resolved" in second, f"a correct repair was not graded as resolved: {second}"
        assert "100%" in second, f"a correct repair did not score full marks: {second}"
        assert _status(client, session_id)["resolved"] is True
        note(f"repaired:  {second}")

        # A practice check reports on the machine; it does not submit anything. So the
        # page has to still offer the console, the check and the hand-in — and it must
        # not claim the machine is gone while the student is sitting in front of it.
        controls = _controls(fixed.text, session_id)
        note(f"  page after a passing check: {controls}")
        assert "check" in controls, "the check button went missing after a passing check"
        assert "hand-in" in controls, "a student cannot hand in a session they passed"
        assert "destroyed-copy" not in controls, "the page claims a live machine was destroyed"
        if _status(client, session_id)["console_available"]:
            assert "console" in controls, "the console disappeared after a passing check"
        assert _status(client, session_id)["ready"] is True, "a check ended the session"

        # ---- the write-up, then the hand-in -------------------------------------- #
        form = manager.ticket_form_for(store.get_session(session_id))
        assert form is not None, "this scenario has no write-up form after all"
        values = synthesise_ticket(form)
        previewed = _post(client, f"/sessions/{session_id}/ticket", ontrak_writeup="preview", **values)
        assert "preview" in _flash(previewed).lower(), f"the write-up did not preview: {_flash(previewed)}"
        note(f"write-up preview: {_flash(previewed)}")

        handed_in = _post(client, f"/sessions/{session_id}/complete", ontrak_writeup="complete", **values)
        assert "Submitted" in handed_in.text, f"the hand-in did not confirm: {_flash(handed_in)}"
        note(f"hand-in: {_flash(handed_in)}")

        # ---- the record it left, and the machine it retired ---------------------- #
        row = store.get_session(session_id)
        assert row.state.is_submitted, f"a handed-in session is in state {row.state.value}"
        assert not app.state.incus.exists(row.instance), "the machine outlived the submission"
        results = store.results_for_student(STUDENT)
        assert results, "nothing was recorded for the submission"
        note(
            f"recorded: machine {results[0].machine_score:.0f}% "
            f"final {results[0].score:.0f}% resolved={results[0].resolved}"
        )
        assert results[0].resolved, "a repaired machine and a written ticket did not resolve"
        page = client.get(f"/results?session={session_id}").text
        assert f"session {session_id}" in page, "the results page does not show the submission"

        # ---- what a finished session still offers -------------------------------- #
        # The student's next move is to reopen it, or to press something on it, and this
        # is the half of the lifecycle no unit test walks.
        page = client.get(f"/sessions/{session_id}").text
        controls = _controls(page, session_id)
        note(f"  page after hand-in: {controls}")
        assert "check" not in controls, "a submitted session still offers a check"
        assert "reset" not in controls, "a submitted session still offers a reset"
        assert "hand-in" not in controls, "a submitted session can be handed in twice"
        assert "destroyed-copy" in controls, "the page does not say the machine is gone"

        # Handing it in again is refused on purpose rather than by the machine being
        # gone: a reloaded form is a scripted retry, and the second grade would be the
        # same session marked twice.
        again = _post(client, f"/sessions/{session_id}/complete", ontrak_writeup="complete", **values)
        assert "already handed in" in _flash(again), f"a second hand-in was not refused: {_flash(again)}"
        assert len(store.results_for_student(STUDENT)) == 1, "the session was marked twice"
        note(f"  hand in twice: {_flash(again)}")
    finally:
        # A failed walk must not leave a VM behind. The hand-in destroys its own.
        if session_id is not None:
            row = store.get_session(session_id)
            if row is not None and row.state.is_live:
                try:
                    manager.end(row, reason="end-to-end walk")
                    note("cleaned up the session")
                except Exception as exc:  # noqa: BLE001 - cleanup must not mask the failure
                    note(f"cleanup of session #{session_id} failed: {exc}")
        print("\n".join(["", "== the walk ==", *notes]))
