"""The console, opened in a real browser.

Everything else in OnTrak checks the console over the wire — `ontrak doctor`'s three
requests, `ontrak console verify`'s WebSocket — and all of it is what a browser sends.
None of it *is* one, and a console can be perfect on the wire and wrong on the page a
student is looking at: the frame never loads because the portal's own bootstrap page
(which clears Guacamole's stored token, see `portal.app.session_console`) is served from
another origin, the client falls back to the slower HTTP tunnel, or a keystroke lands
nowhere because nothing on the page has focus.

So this drives the real thing: it signs in to the portal, starts a scenario through it,
opens the session page in Chromium, waits for the console frame to paint, and types into
it — into a machine *this check just created*, never a student's.

It is deliberately portal-driven rather than an extra `ontrak console verify` mode.
`console verify` allocates its machine through this checkout's own state directory, and a
container stack keeps the portal's accounts and sessions in its own volume (`ontrak-state`),
so the machine a host-side allocation creates is one the portal has never heard of and its
page answers 404. Starting the session the way a student does is also the only version of
this that checks what a student does.
"""

from __future__ import annotations

import contextlib
import http.cookiejar
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from . import guac

# What to install, in the order the sentence should be read. The browser binary is
# deliberately *not* part of the requirements: it is a ~170 MB download that only a host
# running this check needs, and `PLAYWRIGHT_BROWSERS_PATH` keeps it inside the checkout
# when the operator wants that.
BROWSER_HINT = (
    "no browser engine is installed, so the console cannot be opened in one: "
    "`pip install playwright` and then `playwright install chromium` "
    "(set PLAYWRIGHT_BROWSERS_PATH to keep the download inside the checkout)"
)

# How long the console frame gets to paint once the machine is ready, and how long it
# gets to react to a keystroke. Both are generous on purpose: the first frame of a console
# crosses the gateway, the webapp and guacd, and a window that closed early would call a
# slow console broken.
PAGE_PAINT_SECONDS = 60.0
TYPING_SECONDS = 15.0

# How long the portal's own pages get to answer. Deliberately much longer than the
# gateway probes' eight seconds, and measured: `POST /login` answers with a redirect to
# the dashboard, and on a 2 vCPU range that renders slower than eight seconds — with a
# machine being cloned beside it, it timed out, which reported a portal that was merely
# busy as one that could not sign anyone in.
PORTAL_TIMEOUT_SECONDS = 60.0

# What a terminal check types into the machine it created, and what the frame must do
# about it. `echo` on purpose: it changes the screen without changing the machine, so the
# check leaves nothing behind in a template or a scenario's state even if the session it
# started is kept for a look.
TYPED_COMMAND = "echo BROWSER_OK"

# Text the Guacamole client puts on the screen when it gives up — the phrases a student
# reads back to their instructor ("the remote desktop server has encountered an error and
# has closed the connection" is the one that started this whole line of work). Matched
# case-insensitively against the visible text of the console frame, because the client
# renders its errors as page text and not as any stable element.
CONSOLE_ERROR_PHRASES = (
    "encountered an error",
    "has closed the connection",
    "unable to connect",
    "connection refused",
    "not responding",
    "server unreachable",
    "failed to connect",
)

# The result of driving a page, as a record rather than a verdict — the same shape as
# `guac.TunnelReport`, and for the same reason: the caller writes the sentence.
@dataclass
class BrowserReport:
    url: str = ""
    console_url: str = ""
    canvases: int = 0
    painted: int = 0
    hash: int = 0
    after_typing_hash: int = 0
    typed: str = ""
    changed: bool = False
    console_error: str = ""
    error: str = ""
    seconds: float = 0.0
    frames: list[str] = field(default_factory=list)


def engine_missing() -> str:
    """``""`` when a browser can be launched, else the sentence saying what to install."""
    try:
        import playwright.sync_api  # noqa: F401, PLC0415
    except Exception as exc:  # noqa: BLE001 - a missing optional dependency, reported
        return f"{BROWSER_HINT} ({exc})"
    return ""


# ---------------------------------------------------------------------------
# the portal's own HTTP surface
# ---------------------------------------------------------------------------


class PortalClient:
    """The portal as a signed-in browser talks to it: cookies kept, forms posted.

    Small on purpose. The interesting half of this check is the console frame, and the
    only reason to speak HTTP at all is that signing in and starting a machine are not
    things a *browser* has to do for the console to be exercised — clicking them would
    make this test about the dashboard's markup instead.
    """

    def __init__(self, base: str, *, timeout: float = PORTAL_TIMEOUT_SECONDS):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=guac._probe_tls_context()),
        )

    # -- plumbing ----------------------------------------------------------
    def _send(self, url: str, fields: dict[str, str] | None = None) -> tuple[int, str, str]:
        data = urllib.parse.urlencode(fields).encode("utf-8") if fields is not None else None
        request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
        try:
            with self.opener.open(request, timeout=self.timeout) as response:  # noqa: S310
                return response.status, response.read().decode("utf-8", "replace"), response.url
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), exc.url or url
        except (OSError, TimeoutError) as exc:
            # Status 0 is "no answer", which the callers say in words: a portal that is
            # busy is not yet a verdict about the console, and a traceback out of a check
            # is not a report.
            return 0, f"no answer within {self.timeout:.0f}s ({exc})", url

    def get(self, path: str) -> tuple[int, str, str]:
        return self._send(f"{self.base}{path}")

    def post(self, path: str, fields: dict[str, str]) -> tuple[int, str, str]:
        return self._send(f"{self.base}{path}", fields)

    # -- what the pages need ----------------------------------------------
    def csrf(self) -> str:
        """The form token the portal's own pages carry, straight from its cookie.

        `_check_csrf` compares the submitted value with the cookie, and the hidden input
        on every form carries the same string — so reading it from the jar is the same
        token a browser would paste into the form.
        """
        for cookie in self.jar:
            if cookie.name.endswith("csrf"):
                return cookie.value
        return ""

    def cookies(self) -> list[dict]:
        """The jar as Playwright wants it, so the *browser* is the signed-in client too.

        The domain is the address this client actually used, not the jar's own idea of it:
        `http.cookiejar` stores a host-only cookie for `localhost` under
        `localhost.local` (its suffix logic for a host with no dot), and a cookie handed to
        the browser for *that* domain is never sent to `localhost` — which is how the
        first version of this check loaded the session page as an anonymous visitor and
        reported "no console frame ever appeared". A `Domain=` attribute the portal really
        did set is kept as it stands.
        """
        host = urlparse(self.base).hostname or "localhost"
        secure = self.base.lower().startswith("https")
        return [
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain if cookie.domain_specified else host,
                "path": cookie.path or "/",
                "secure": bool(cookie.secure) or secure,
            }
            for cookie in self.jar
        ]

    # -- the two things this check does through it -------------------------
    def sign_in(self, username: str, password: str) -> tuple[bool, str]:
        """Sign in the way the login form does. ``(ok, detail)``."""
        status, body, _url = self.get("/login")
        if status != 200:
            return False, (
                f"the portal at {self.base} answered HTTP {status} for its sign-in page: {body[:200]}"
            )
        token = self.csrf()
        status, _body, url = self.post(
            "/login", {"username": username, "password": password, "csrf": token}
        )
        if "/login" in urlparse(url).path:
            return False, (
                f"the portal at {self.base} refused the sign-in for {username!r}: pass the "
                "account that can open a session with --browser-user/--browser-password (an "
                "instructor sees any session), or the range has no such local account"
            )
        return True, ""

    def start_session(self, scenario_id: str, workload: str = "", time_limit: str = "") -> tuple[int, str]:
        """Start a scenario through the portal. ``(session_id, detail)``; id 0 on failure."""
        status, body, url = self.post(
            "/sessions/start",
            {
                "scenario_id": scenario_id,
                "workload": workload,
                "time_limit": time_limit,
                "csrf": self.csrf(),
            },
        )
        if status != 200:
            return 0, f"the portal did not start {scenario_id}: HTTP {status} ({body[:200]})"
        session_id = session_id_from_url(url)
        if not session_id:
            return 0, (
                f"the portal did not start {scenario_id}: {flash_text(body) or f'it sent us to {url}'}"
            )
        return session_id, ""

    def wait_until_ready(self, session_id: int, seconds: float) -> tuple[bool, str, str]:
        """Poll the portal's own status endpoint. ``(ready, detail, protocol_state)``."""
        deadline = time.monotonic() + seconds
        last = ""
        while time.monotonic() < deadline:
            status, body, _url = self.get(f"/sessions/{session_id}/status")
            if status == 200:
                try:
                    data = json.loads(body)
                except ValueError:
                    data = {}
                state = str(data.get("state") or "")
                if data.get("ready"):
                    return True, "", state
                if state in {"error", "failed"}:
                    return False, (
                        f"the machine for session {session_id} failed to provision: "
                        f"{data.get('error') or 'no reason given'}"
                    )
                last = state or last
            else:
                last = f"HTTP {status}"
            time.sleep(2.0)
        return False, (
            f"session {session_id} was still {last or 'not ready'} after {seconds:.0f}s, so the "
            "console was never given a machine to open"
        ), ""

    def end_session(self, session_id: int) -> None:
        # Teardown never raises over a result: the check's answer is what the operator is
        # reading, and a portal that has already hung up is not a finding about a console.
        with contextlib.suppress(OSError):
            self.post(f"/sessions/{session_id}/end", {"csrf": self.csrf()})


# ---------------------------------------------------------------------------
# small parsers, kept pure so they can be tested without a portal
# ---------------------------------------------------------------------------


def session_id_from_url(url: str) -> int:
    """The session id in a redirect the portal made, or 0.

    `POST /sessions/start` answers with a redirect to the session page on success and to
    the dashboard with a flash message on failure, so the URL is the difference between
    "a machine is coming" and "the range refused".
    """
    match = re.search(r"/sessions/(\d+)(?:[/?#]|$)", url or "")
    return int(match.group(1)) if match else 0


def flash_text(body: str) -> str:
    """The message the portal is showing on the page it just rendered, or ``""``."""
    text = re.sub(r"<script.*?</script>", " ", body or "", flags=re.DOTALL | re.IGNORECASE)
    for match in re.finditer(
        r'<[^>]*class="[^"]*(?:notice|flash|alert)[^"]*"[^>]*>(.*?)</', text, re.DOTALL
    ):
        message = re.sub(r"<[^>]+>", " ", match.group(1))
        message = " ".join(message.split())
        if message:
            return message
    return ""


def console_error_in(text: str) -> str:
    """The client's own complaint, as it appears on the screen, or ``""``.

    The client renders its errors as page text, so this is a search of what the student
    would be reading — and the phrases are the ones Guacamole itself uses.
    """
    lowered = (text or "").lower()
    for phrase in CONSOLE_ERROR_PHRASES:
        if phrase in lowered:
            return phrase
    return ""


def console_address(url: str) -> str:
    """A console URL as an operator should read it: scheme, host and path only.

    The client's own URL carries the whole signed payload in its fragment — several
    hundred characters of base64 that say nothing about whether the console opened, and
    turn a one-line report into a wall of text.
    """
    parsed = urlparse(url or "")
    if not parsed.scheme or not parsed.netloc:
        return url or ""
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


def browser_verdict(report: BrowserReport, *, protocol: str = "") -> tuple[str, str]:
    """The state and the sentence for one browser report. ``(state, detail)``."""
    where = console_address(report.console_url)
    if report.error:
        return "unreachable", report.error
    if report.console_error:
        return "error", (
            f"a real browser opened {where or report.url} and the console frame told the "
            f"student {report.console_error!r} — this is the failure a student reports and "
            "no wire-level check can see"
        )
    if not report.console_url:
        return "empty", (
            f"a real browser loaded {report.url} and no console frame ever appeared: the "
            "session page embeds one only when the portal can sign a link and the machine is "
            "up, so this is the portal's own answer and not the console's"
        )
    if not report.painted:
        return "empty", (
            f"a real browser opened {where} but nothing was painted in {report.seconds:.0f}s "
            f"({report.canvases} canvas(es) on the page) — the frame is there and the screen "
            "inside it is blank"
        )
    if report.typed and not report.changed:
        return "error", (
            f"a real browser opened {where} and {report.painted} canvas(es) painted, but typing "
            f"{report.typed!r} into the console changed nothing on screen — the machine may be "
            "up and still not be listening to the student's keyboard"
        )
    if report.typed:
        return "ok", (
            f"a real browser opened {where}: {report.painted} canvas(es) painted, and typing "
            f"{report.typed!r} into the terminal changed the screen, so the student's "
            "keystrokes reach the machine"
        )
    return "ok", (
        f"a real browser opened {where} and {report.painted} canvas(es) painted "
        f"({report.canvases} on the page)"
    )


# ---------------------------------------------------------------------------
# the browser itself
# ---------------------------------------------------------------------------

# What "painted" means, asked of the page rather than of a screenshot: Guacamole draws
# into one or more canvases, so the check samples each of them, counts the pixels with any
# opacity at all, and keeps a cheap rolling hash of the sampled channels. The count answers
# "is there anything on the screen"; the hash answers "did it change when the student typed".
_FINGERPRINT_JS = """
() => {
  const out = {canvases: 0, painted: 0, hash: 0};
  for (const canvas of document.querySelectorAll('canvas')) {
    out.canvases++;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      continue;
    }
    let hash = 0;
    let opaque = 0;
    for (let i = 0; i < data.length; i += 28) {
      const alpha = data[i + 3];
      if (alpha) opaque++;
      hash = (hash * 31 + data[i] + 3 * data[i + 1] + 7 * data[i + 2] + 11 * alpha) | 0;
    }
    if (opaque) out.painted++;
    out.hash = (out.hash * 31 + hash) | 0;
  }
  return out;
}
"""


def _one_line(text: object, limit: int = 200) -> str:
    """An engine's own error as one readable line.

    Playwright boxes its install banner in box-drawing characters and wraps it over ten
    lines; a report is a sentence, and an operator reading a failure should not have to
    scroll past an ASCII box to find the reason.
    """
    flat = re.sub(r"[\u2500-\u257f]+", " ", str(text))
    flat = " ".join(flat.split())
    return flat[:limit] + ("\u2026" if len(flat) > limit else "")


def _missing_engine(playwright) -> str:
    """``""`` when a Chromium binary is actually there, else what to do about it.

    Asked before launching because "the engine was never downloaded" and "the engine is
    there and would not start" are different findings, and only the first has the obvious
    fix in its sentence.
    """
    executable = str(getattr(playwright.chromium, "executable_path", "") or "")
    if executable and not Path(executable).exists():
        return (
            f"no browser is downloaded for Playwright (it looked for {executable}): run "
            "`playwright install chromium`, or point PLAYWRIGHT_BROWSERS_PATH at the "
            "directory the engines were downloaded into"
        )
    return ""


def _console_frame(page, deadline: float):
    """The frame the portal's console iframe ends up in, or ``None`` by the deadline.

    The iframe starts on the portal's own bootstrap page (`/sessions/<id>/console`, which
    clears Guacamole's stored token) and then replaces its own location with the signed
    Guacamole URL — so the frame to watch is the one *at* the console, whichever element it
    came from.
    """
    while time.monotonic() < deadline:
        for frame in page.frames:
            if "/guacamole/" in (frame.url or ""):
                return frame
        page.wait_for_timeout(500)
    return None


def _open_page(
    page_url: str,
    *,
    cookies: list[dict],
    protocol: str,
    seconds: float = guac.TUNNEL_SECONDS,
    ignore_https_errors: bool = True,
) -> BrowserReport:
    """Load one page and drive one console frame in a real browser.

    Split out from :func:`verify_console_in_browser` because it is the part that needs
    Playwright: everything around it (signing in, starting a machine, reading the result)
    is the portal's HTTP surface, which the tests cover without a browser.
    """
    from playwright.sync_api import Error as PlaywrightError  # noqa: PLC0415
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    report = BrowserReport(url=page_url, seconds=seconds)
    with sync_playwright() as playwright:
        missing = _missing_engine(playwright)
        if missing:
            report.error = missing
            return report
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as exc:
            report.error = (
                f"a browser would not start on this host: {_one_line(exc)} — the engines are "
                "installed as root by `playwright install`, so a check running as another "
                "user cannot launch them either; point PLAYWRIGHT_BROWSERS_PATH at a "
                "directory this user can read"
            )
            return report
        context = browser.new_context(ignore_https_errors=ignore_https_errors)
        try:
            context.add_cookies(cookies)
            page = context.new_page()
            try:
                page.goto(page_url, wait_until="domcontentloaded", timeout=30000)
            except PlaywrightError as exc:
                report.error = f"the portal's page at {page_url} did not load in a browser: {exc}"
                return report
            deadline = time.monotonic() + seconds
            frame = _console_frame(page, deadline)
            report.frames = [f.url for f in page.frames]
            if frame is None:
                return report
            report.console_url = frame.url
            try:
                frame.wait_for_selector("canvas", timeout=int(seconds * 1000))
            except PlaywrightError:
                return report  # no canvas yet: `painted` stays 0 and the verdict says so
            state = {"canvases": 0, "painted": 0, "hash": 0}
            while time.monotonic() < deadline:
                try:
                    state = frame.evaluate(_FINGERPRINT_JS)
                except PlaywrightError as exc:  # the page navigated away mid-read
                    report.error = f"the console frame stopped answering the browser: {exc}"
                    return report
                if state.get("painted"):
                    break
                page.wait_for_timeout(500)
            report.canvases = int(state.get("canvases") or 0)
            report.painted = int(state.get("painted") or 0)
            report.hash = int(state.get("hash") or 0)
            try:
                text = frame.evaluate("() => document.body.innerText || ''")
            except PlaywrightError:
                text = ""
            report.console_error = console_error_in(text or "")
            if report.console_error or not report.painted:
                return report
            if protocol != "ssh":
                # An RDP desktop is verified by having painted: there is no command whose
                # effect on a GUI can be asserted without guessing at whatever window has
                # focus, and a check that types blind into a desktop proves nothing.
                return report
            try:
                # `force=True`, and a real mouse event rather than a synthetic one: what
                # this needs is for the frame to have keyboard focus. Guacamole stacks a
                # canvas per drawing layer, so the point on the topmost one is very often
                # covered by its neighbour and Playwright's actionability check refuses a
                # click the student's own browser would deliver happily. Which layer takes
                # the click is the client's business.
                frame.locator("canvas").first.click(force=True, timeout=5000)
                page.keyboard.type(TYPED_COMMAND)
                page.keyboard.press("Enter")
            except PlaywrightError as exc:
                report.error = f"the console frame would not take a keystroke: {exc}"
                return report
            report.typed = TYPED_COMMAND
            typing_deadline = time.monotonic() + min(TYPING_SECONDS, max(1.0, seconds))
            while time.monotonic() < typing_deadline:
                page.wait_for_timeout(500)
                after = frame.evaluate(_FINGERPRINT_JS)
                if int(after.get("hash") or 0) != report.hash:
                    report.changed = True
                    break
            report.after_typing_hash = int(after.get("hash") or 0)
            return report
        finally:
            context.close()
            browser.close()


def verify_console_in_browser(
    settings,
    *,
    portal_url: str,
    scenario_id: str,
    workload: str = "",
    user: str = "",
    password: str = "",
    seconds: float = guac.TUNNEL_SECONDS,
    wait_seconds: float = 300.0,
    keep: bool = False,
    driver=None,
) -> tuple[str, str, BrowserReport]:
    """A student's own path, in a real browser. ``(state, detail, report)``.

    Sign in, start the scenario through the portal, wait for the machine, open the session
    page, and drive the console frame inside it. The machine is this check's own and is
    destroyed at the end unless ``keep`` asks to leave it for a look — a check must never
    type into a student's machine, and this one never opens one.

    ``driver`` is the seam the tests use, defaulting to the Playwright page driver.
    """
    report = BrowserReport(url=portal_url)
    missing = engine_missing()
    if missing and driver is None:
        return "skipped", missing, report

    client = PortalClient(portal_url)
    ok, detail = client.sign_in(user, password)
    if not ok:
        return "refused", detail, report
    session_id, detail = client.start_session(scenario_id, workload)
    if not session_id:
        return "refused", detail, report
    report.url = f"{client.base}/sessions/{session_id}"
    try:
        ready, detail, _state = client.wait_until_ready(session_id, wait_seconds)
        if not ready:
            return "unreachable", detail, report
        scenario = None
        try:
            from .scenarios import ScenarioRepository  # noqa: PLC0415

            scenario = ScenarioRepository(settings.scenarios_dir).get(scenario_id)
        except Exception:  # noqa: BLE001 - only used to pick the console's protocol
            scenario = None
        protocol = guac.protocol_for(settings, scenario) or ""
        if not protocol:
            return (
                "skipped",
                f"scenario {scenario_id} gets no browser console on this range",
                report,
            )
        report.url = f"{client.base}/sessions/{session_id}"
        run = driver or _open_page
        report = run(
            report.url,
            cookies=client.cookies(),
            protocol=protocol,
            seconds=seconds,
        )
        report.url = report.url or f"{client.base}/sessions/{session_id}"
        return (*browser_verdict(report, protocol=protocol), report)
    finally:
        if not keep:
            client.end_session(session_id)
