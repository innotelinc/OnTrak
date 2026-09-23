"""The browser console check: its parsers, its verdicts, and the flow around the page.

The page itself needs Chromium and a range, so what a browser *does* is proven on a real
one (`ontrak console browser`) rather than here. Everything around it — what the portal's
redirects mean, what the client's own complaint looks like on screen, which sentence a
report earns, and the order of sign-in, start, wait, drive and end — is a pure function or
a fake, and that is what this file covers.
"""

from __future__ import annotations

import pytest

from ontrak import browser
from ontrak.browser import BrowserReport

# ---------------------------------------------------------------------------
# parsers
# ---------------------------------------------------------------------------


def test_the_session_id_is_read_out_of_the_redirect_the_portal_made():
    """Success ends at the session page; failure ends at the dashboard with a message."""
    assert browser.session_id_from_url("https://range.test/sessions/42") == 42
    assert browser.session_id_from_url("https://range.test/sessions/42?flash=1") == 42
    assert browser.session_id_from_url("https://range.test/sessions/42#top") == 42
    # `POST /sessions/start` is the one route whose *path* is the word, not a number.
    assert browser.session_id_from_url("https://range.test/sessions/start") == 0
    assert browser.session_id_from_url("https://range.test/dashboard") == 0
    assert browser.session_id_from_url("") == 0


def test_the_flash_message_is_the_sentence_the_page_is_showing():
    body = (
        '<html><script>var notice = "not this";</script>'
        '<div class="notice warn">The range is full: 2 machines in use.</div></html>'
    )
    assert browser.flash_text(body) == "The range is full: 2 machines in use."
    assert browser.flash_text("<html><body>nothing to say</body></html>") == ""


def test_the_clients_own_complaint_is_read_off_the_screen():
    """The phrase a student reads back to their instructor, and the one that started this.

    Guacamole renders its errors as page text, so the check searches what the student
    would be looking at. The first is the sentence from the original bug report.
    """
    assert browser.console_error_in("The remote desktop server has encountered an error.") == (
        "encountered an error"
    )
    assert (
        browser.console_error_in("The remote desktop server has closed the connection.")
        == "has closed the connection"
    )
    assert browser.console_error_in("root@ontrak-sess-1:~# ls") == ""


def test_a_console_url_is_shortened_to_something_an_operator_can_read():
    """The client's URL carries the whole signed payload, and a report is a sentence."""
    url = "https://range.test/guacamole/#/client/T25UcmsAYwBqc29u?data=AAAA" + "B" * 400
    assert browser.console_address(url) == "https://range.test/guacamole/"
    assert browser.console_address("not a url") == "not a url"


# ---------------------------------------------------------------------------
# verdicts
# ---------------------------------------------------------------------------


def test_a_console_that_painted_and_answered_a_keystroke_is_ok():
    report = BrowserReport(
        url="https://range.test/sessions/7",
        console_url="https://range.test/guacamole/#/client/x?data=y",
        canvases=4,
        painted=4,
        hash=11,
        after_keystroke_hash=22,
        keystroke="echo BROWSER_OK",
        changed=True,
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="ssh")
    assert state == "ok"
    assert "https://range.test/guacamole/" in detail and "keystrokes reach the machine" in detail
    assert "data=y" not in detail, "the sentence carries the whole signed payload"


def test_a_terminal_that_paints_but_ignores_the_keyboard_is_an_error():
    """The machine is up, the console is on screen, and the student's typing goes nowhere."""
    report = BrowserReport(
        url="https://range.test/sessions/7",
        console_url="https://range.test/guacamole/#/client/x",
        canvases=4,
        painted=4,
        hash=11,
        after_keystroke_hash=11,
        keystroke="echo BROWSER_OK",
        changed=False,
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="ssh")
    assert state == "error"
    assert "changed nothing on screen" in detail


def test_the_proof_a_console_is_asked_for_follows_its_protocol():
    """A terminal is typed into; a desktop is pressed with the Windows key.

    There is no shell command a GUI has to obey, but the Windows key opens the Start
    menu, so the screen changes without the check knowing or caring what has focus —
    which is the same claim `echo BROWSER_OK` makes for a terminal, and the one a canvas
    that paints but never takes a keystroke cannot pass. An unknown protocol is asked for
    nothing, rather than sent a keystroke whose effect nothing would be able to judge.
    """
    assert browser.console_proof("ssh") == (
        "type",
        browser.TYPED_COMMAND,
        browser.TYPED_COMMAND,
    )
    assert browser.console_proof("rdp") == (
        "press",
        browser.DESKTOP_KEY,
        browser.DESKTOP_KEY_SPOKEN,
    )
    assert browser.console_proof("") == ("", "", "")


def test_a_desktop_that_answers_the_windows_key_is_ok():
    report = BrowserReport(
        url="https://range.test/sessions/8",
        console_url="https://range.test/guacamole/#/client/x",
        canvases=2,
        painted=2,
        hash=11,
        after_keystroke_hash=31,
        keystroke=browser.DESKTOP_KEY_SPOKEN,
        changed=True,
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="rdp")
    assert state == "ok"
    assert "pressing the Windows key" in detail and "keys reach the desktop" in detail


def test_a_desktop_that_ignores_the_windows_key_is_the_finding():
    """The desktop painted and the machine is up, and the student's keyboard goes nowhere."""
    report = BrowserReport(
        url="https://range.test/sessions/8",
        console_url="https://range.test/guacamole/#/client/x",
        canvases=2,
        painted=2,
        hash=11,
        after_keystroke_hash=11,
        keystroke=browser.DESKTOP_KEY_SPOKEN,
        changed=False,
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="rdp")
    assert state == "error"
    assert "pressing the Windows key on the desktop changed nothing" in detail
    assert "still not be listening to the student's keyboard" in detail


def test_a_frame_that_painted_answers_for_itself_when_nothing_was_asked():
    """No proof was asked for (an unknown protocol), so the report says what was seen."""
    report = BrowserReport(
        url="https://range.test/sessions/8",
        console_url="https://range.test/guacamole/#/client/x",
        canvases=2,
        painted=2,
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="rdp")
    assert state == "ok" and "2 canvas(es) painted" in detail


def test_the_client_showing_the_student_an_error_is_the_finding_itself():
    report = BrowserReport(
        url="https://range.test/sessions/9",
        console_url="https://range.test/guacamole/",
        canvases=1,
        painted=1,
        console_error="has closed the connection",
        seconds=30,
    )
    state, detail = browser.browser_verdict(report, protocol="rdp")
    assert state == "error" and "has closed the connection" in detail


def test_a_session_page_with_no_frame_at_all_says_what_that_means():
    """The portal embeds a frame only when it can sign a link *and* the machine is up."""
    report = BrowserReport(url="https://range.test/sessions/10", frames=["https://range.test/login"])
    state, detail = browser.browser_verdict(report, protocol="ssh")
    assert state == "empty"
    assert "no console frame ever appeared" in detail


def test_a_frame_that_paints_nothing_is_its_own_finding():
    report = BrowserReport(
        url="https://range.test/sessions/11",
        console_url="https://range.test/guacamole/",
        canvases=3,
        painted=0,
        seconds=60,
    )
    state, detail = browser.browser_verdict(report, protocol="ssh")
    assert state == "empty"
    assert "blank" in detail and "3 canvas(es) on the page" in detail


def test_an_engine_that_will_not_start_is_not_a_verdict_about_the_console():
    report = BrowserReport(url="https://range.test/sessions/12", error="a browser could not be started")
    state, detail = browser.browser_verdict(report, protocol="ssh")
    assert state == "unreachable" and detail.startswith("a browser could not be started")


# ---------------------------------------------------------------------------
# the flow: sign in, start, wait, drive, end
# ---------------------------------------------------------------------------


class FakePortal:
    """The portal's HTTP surface, answering the way the real one does."""

    def __init__(self, *, signs_in=True, starts=7, ready=True, wait_detail="not ready"):
        self.base = "https://range.test"
        self.signs_in = signs_in
        self.starts = starts
        self.ready = ready
        self.wait_detail = wait_detail
        self.started: list[tuple] = []
        self.ended: list[int] = []

    def sign_in(self, username, password):
        self.credentials = (username, password)
        return (True, "") if self.signs_in else (False, "the portal refused the sign-in")

    def start_session(self, scenario_id, workload="", time_limit=""):
        self.started.append((scenario_id, workload))
        return (self.starts, "") if self.starts else (0, "the portal did not start it")

    def wait_until_ready(self, session_id, seconds):
        return (True, "", "in_use") if self.ready else (False, self.wait_detail, "")

    def cookies(self):
        return [{"name": "ontrak_session", "value": "x", "domain": "range.test", "path": "/"}]

    def end_session(self, session_id):
        self.ended.append(session_id)


@pytest.fixture
def portal(monkeypatch):
    fake = FakePortal()
    monkeypatch.setattr(browser, "PortalClient", lambda *a, **k: fake)
    monkeypatch.setattr(browser, "engine_missing", lambda: "")
    return fake


def _driver():
    """A stand-in for the Playwright page driver, reporting whatever the test needs.

    It answers the proof the protocol asks for — the same as the real driver, which is
    what makes the flow tests meaningful for a desktop as well as a terminal.
    """

    def drive(page_url, *, cookies, protocol, seconds):
        drive.seen = (page_url, cookies, protocol, seconds)
        action, _keys, spoken = browser.console_proof(protocol)
        return BrowserReport(
            url=page_url,
            console_url="https://range.test/guacamole/#/client/x",
            canvases=4,
            painted=4,
            hash=1,
            after_keystroke_hash=2,
            keystroke=spoken,
            changed=bool(action),
            seconds=seconds,
        )

    return drive


def test_the_check_signs_in_starts_the_scenario_and_ends_the_machine_it_made(settings, portal):
    settings.guac.linux_ssh = True  # the suite's own default is off; see conftest
    state, detail, report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
        driver=_driver(),
    )
    assert state == "ok" and "keystrokes reach the machine" in detail
    assert portal.credentials == ("admin", "pw")
    assert portal.started == [("linux-user-lifecycle", "")]
    assert portal.ended == [7], "the check left its machine behind"
    assert report.console_url.endswith("#/client/x")


def test_a_windows_scenario_is_driven_as_a_desktop(settings, portal):
    """A Linux scenario and a Windows one are two consoles, and the proof is the protocol's.

    `sw-app-crash` is a Windows scenario, so its console is RDP: the driver is handed
    ``rdp`` and asks for the Windows key rather than typing a shell command into a shell
    that is not there. Everything else is the same shape — its own machine, and destroyed
    again afterwards.
    """
    drive = _driver()
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="sw-app-crash",
        user="admin",
        password="pw",
        driver=drive,
    )
    assert drive.seen[2] == "rdp", "a Windows scenario was driven as a terminal"
    assert state == "ok" and "keys reach the desktop" in detail
    assert portal.ended == [7], "the check left its machine behind"


def test_keep_leaves_the_machine_for_a_look(settings, portal):
    settings.guac.linux_ssh = True
    browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
        keep=True,
        driver=_driver(),
    )
    assert portal.ended == []


def test_a_refused_sign_in_says_which_door_to_use(settings, portal):
    """An instructor sees any session, and the account has to be one that can sign in."""
    portal.signs_in = False
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="wrong",
        driver=_driver(),
    )
    assert state == "refused" and "refused the sign-in" in detail


def test_a_scenario_the_portal_will_not_start_is_reported_with_its_own_reason(settings, portal):
    portal.starts = 0
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
        driver=_driver(),
    )
    assert state == "refused" and "did not start it" in detail
    assert portal.ended == [], "there was no session to end"


def test_a_machine_that_never_comes_up_is_not_a_console_finding(settings, portal):
    portal.ready = False
    portal.wait_detail = "session 7 was still allocating after 300s"
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
        driver=_driver(),
    )
    assert state == "unreachable" and "still allocating" in detail
    assert portal.ended == [7], "a check that gave up still destroys the machine it made"


def test_a_scenario_with_no_console_is_skipped_rather_than_opened(settings, portal):
    """`guac.linux_ssh: false` is a posture: the portal embeds no frame, and says why."""
    settings.guac.linux_ssh = False
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
        driver=_driver(),
    )
    assert state == "skipped" and "no browser console" in detail


def test_no_engine_at_all_is_reported_with_what_to_install(settings, monkeypatch):
    monkeypatch.setattr(browser, "engine_missing", lambda: browser.BROWSER_HINT)
    state, detail, _report = browser.verify_console_in_browser(
        settings,
        portal_url="https://range.test",
        scenario_id="linux-user-lifecycle",
        user="admin",
        password="pw",
    )
    assert state == "skipped"
    assert "pip install playwright" in detail and "playwright install chromium" in detail


def test_the_check_never_types_into_a_machine_it_did_not_start(settings, monkeypatch):
    """There is no flag that points this at a student's session, and this keeps it so."""
    import inspect

    parameters = inspect.signature(browser.verify_console_in_browser).parameters
    assert "session" not in parameters and "session_id" not in parameters
    assert "scenario_id" in parameters
