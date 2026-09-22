"""The stylesheet and the templates are one contract, and nothing else checks it.

Re-skinning the portal is supposed to be a handful of variables, and that is only true
while every class a template asks for is one the stylesheet defines. Nothing notices when
it is not: the page renders, its content assertions pass, and it just looks wrong — or,
for a layout class, silently reassembles itself.

That is not hypothetical. ``col-console`` and ``col-side`` are the two columns of every
lesson, session and admin page, and no stylesheet had ever defined them, so the layout
existed only in the class names. These tests make the gap visible instead of leaving it
to whoever next opens the page and wonders why the sidebar is at the bottom.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from ontrak.models import Session, SessionState

from .conftest import csrf, login

PORTAL = Path(__file__).resolve().parent.parent / "ontrak" / "portal"
TEMPLATES = PORTAL / "templates"
STYLESHEET = PORTAL / "static" / "app.css"
ICON = PORTAL / "static" / "favicon.svg"

SCENARIO = "net-dns-failure"

_JINJA = re.compile(r"\{%.*?%\}|\{\{.*?\}\}|\{#.*?#\}", re.S)
_CLASS_ATTR = re.compile(r"""class\s*=\s*["']([^"']*)["']""")
_INLINE_STYLE = re.compile(r"<style[^>]*>(.*?)</style>", re.S | re.I)
_SELECTOR = re.compile(r"\.(-?[A-Za-z_][A-Za-z0-9_-]*)")


def _stylesheet_classes() -> set[str]:
    return set(_SELECTOR.findall(STYLESHEET.read_text()))


def _locally_styled_classes() -> set[str]:
    """Classes a page styles in its own <style> block.

    The console page owns its spinner that way, and a rule is a rule: what matters is
    that something styles the name, not where the rule lives.
    """
    styled: set[str] = set()
    for path in TEMPLATES.rglob("*.html"):
        for block in _INLINE_STYLE.findall(path.read_text()):
            styled |= set(_SELECTOR.findall(block))
    return styled


def _rendered_classes(html: str) -> set[str]:
    """The classes in a response body — what the browser actually receives."""
    found: set[str] = set()
    for attr in _CLASS_ATTR.findall(html):
        found.update(attr.split())
    return found


def _template_classes() -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for path in sorted(TEMPLATES.rglob("*.html")):
        text = _JINJA.sub(" ", path.read_text())
        for attr in _CLASS_ATTR.findall(text):
            for token in attr.split():
                found.setdefault(token, set()).add(str(path.relative_to(TEMPLATES)))
    return found


def test_every_class_a_template_uses_is_one_something_styles():
    defined = _stylesheet_classes() | _locally_styled_classes()
    used = _template_classes()
    # A name built by concatenation — `class="state-{{ session.state.value }}"` — is not
    # a name anyone can look up; the stylesheet styles its prefixes instead.
    unresolved = sorted(
        name for name in used if name not in defined and not name.endswith("-")
    )
    assert not unresolved, (
        "templates use classes that nothing styles:\n  "
        + "\n  ".join(f"{name} ({', '.join(sorted(used[name]))})" for name in unresolved)
    )


def test_the_stylesheet_and_the_mark_are_served(app_env):
    client, _ = app_env
    css = client.get("/static/app.css")
    assert css.status_code == 200
    # Tokens, not hard-coded colours: a re-skin is a handful of variables.
    assert ":root" in css.text
    assert "--accent" in css.text

    icon = client.get("/static/favicon.svg")
    assert icon.status_code == 200
    assert icon.text.lstrip().startswith("<svg")


def test_pages_carry_the_stylesheet_the_mark_and_the_theme_colour(app_env):
    client, _ = app_env
    login(client)
    page = client.get("/dashboard")
    assert page.status_code == 200
    assert "/static/app.css" in page.text
    assert "/static/favicon.svg" in page.text
    assert 'name="theme-color"' in page.text


def test_the_sign_in_page_is_themed_too(app_env):
    """The door is the first thing anyone sees; it is not allowed to be the plain one."""
    client, _ = app_env
    page = client.get("/dashboard")  # signed out: renders the sign-in page
    assert page.status_code == 200
    assert "/static/app.css" in page.text
    assert "/static/favicon.svg" in page.text


# --------------------------------------------------------------------------- #
# every page, as the app actually sends it
# --------------------------------------------------------------------------- #
# The checks above read the source of the templates. These read the bytes the app
# sends back, which is the stronger claim and the only one that catches a class
# assembled at render time — ``class="state-{{ session.state.value }}"`` — or a
# name that only one branch of a template ever emits. That is why it bootstraps a
# real machine and a real ticket: without them the session, console and ticket
# pages never render, and a crawl of the rest proves nothing about them.
#
# It also *drives the write paths* before it reads, and for the same reason one step
# on: a panel is a set of forms, and a form that succeeds and leaves the estate in a
# shape the next render cannot describe is the very same defect — on a page nothing
# can reach without doing the write first. An empty estate hides all of it: no
# account row, no matched template, no warm machine, so none of the markup that
# draws them, and a crawl that only reads never notices the difference.

# The pages that need no machine. Two of them are not HTML — a CSV and a JSON
# snapshot — and a redirect is fine; what the crawl refuses is a 500.
STANDALONE_PAGES = [
    "/dashboard",
    "/results",
    "/lessons",
    "/instructor",
    "/instructor/results.csv",
    "/admin",
    "/admin/users",
    "/admin/signin",
    "/admin/scenarios",
    "/admin/platforms",
    "/admin/tickets",
    "/admin/sessions",
    "/admin/schedule",
    "/admin/results",
    "/admin/results.csv",
    "/admin/audit",
    "/admin/state.json",
    "/healthz",
]

_HTML = "text/html"


@dataclass
class Crawl:
    """What the instructor's browser would have: the pages, and the writes behind them.

    ``writes`` is the POST half — kept because a form is a page too, and the response
    it gets is the first thing that can break. ``pages`` are the GETs read *after*
    those writes, so they are the first render of the estate the writes left behind.
    """

    app: Any
    pages: list[tuple[str, Any]] = field(default_factory=list)
    writes: list[tuple[str, Any]] = field(default_factory=list)

    def body(self, path: str) -> str:
        """The body the app sent for a path in this crawl."""
        for label, response in self.pages:
            if label == path:
                assert response.status_code == 200, f"{path} -> {response.status_code}"
                return response.text
        raise AssertionError(f"{path} was not crawled")


# (label, path, form fields). Every one of these is something the panel is *for*, and
# every one of them answers with a redirect back to the page it changed — which is what
# makes the crawl below a render of the new estate rather than the old one.
WRITE_PATHS: list[tuple[str, str, dict[str, str]]] = [
    (
        "create an account",
        "/admin/users",
        {
            "action": "create",
            "username": "pat.student",
            "display_name": "Pat Student",
            "role": "student",
            "password": "TrainMe!12345",
        },
    ),
    ("rebuild a template", "/admin/maintenance", {"action": "templates", "scenario_id": SCENARIO}),
    ("prewarm the pool", "/instructor/prewarm", {"scenario_id": SCENARIO, "count": "1"}),
    ("tick the schedule", "/admin/schedule/tick", {}),
]


def _drive_write_paths(client, app) -> list[tuple[str, Any]]:
    """Do the panel's work, so the crawl reads a range that has actually been used."""
    # A pool with no target prewarms nothing, so the write would prove nothing about
    # the pool table. Set one the way an operator would — in config, for this class.
    app.state.settings.pool.targets = {**app.state.settings.pool.targets, SCENARIO: 1}
    return [
        (
            label,
            client.post(
                path,
                data={"csrf": csrf(client), **fields},
                follow_redirects=False,
            ),
        )
        for label, path, fields in WRITE_PATHS
    ]


@pytest.fixture
def crawl(app_env) -> Crawl:
    """Drive every GET page as the instructor — the one account that sees them all.

    A machine is provisioned first so the pages that only exist beside one are part of
    the crawl rather than 404s, and the write paths are driven before the read so the
    tables and counters have something in them.
    """
    client, app = app_env
    session = app.state.store.create_session(
        Session(id=None, student="alice", scenario_id=SCENARIO, state=SessionState.ALLOCATING)
    )
    session = app.state.manager.provision(session)
    login(client, "teacher")

    writes = _drive_write_paths(client, app)

    paths = list(STANDALONE_PAGES)
    paths += [f"/lessons/{lesson.id}" for lesson in app.state.lessons.list()]
    paths += [
        f"/sessions/{session.id}",
        f"/sessions/{session.id}/console",
        f"/instructor/sessions/{session.id}/console",
        f"/admin/tickets/{session.id}",
        "/",
    ]
    return Crawl(
        app=app,
        pages=[(path, client.get(path, follow_redirects=False)) for path in paths],
        writes=writes,
    )


def test_no_page_fails_to_render(crawl):
    broken = [
        f"{path} -> {response.status_code}"
        for path, response in crawl.pages
        if response.status_code >= 500
    ]
    assert not broken, "pages that 500 during a crawl:\n  " + "\n  ".join(broken)


def test_no_write_path_fails_to_render(crawl):
    """A form that answers 500 has broken the panel; one that answers 200 did nothing.

    Both halves matter and they are the same test: these routes either report a failure
    to the page they return to or they redirect there, and a write that quietly stopped
    redirecting is a change nobody sees land.
    """
    wrong = [
        f"{label} -> {response.status_code}"
        for label, response in crawl.writes
        if not 300 <= response.status_code < 400
    ]
    assert not wrong, "write paths that did not redirect:\n  " + "\n  ".join(wrong)


def test_the_write_paths_are_visible_on_the_next_render(crawl):
    """Each write has to be *in* the estate the page then describes.

    A redirect is not evidence that anything happened: the account has to be on the
    accounts page, and the prewarm has to have produced a machine the pool reports.
    """
    assert "pat.student" in crawl.body("/admin/users")

    pool = crawl.app.state.manager.pool_status(SCENARIO)
    assert any(row.ready >= 1 for row in pool), pool
    # And the read that reports it succeeded, rather than the page falling back to its
    # "could not read the warm pool" banner — which is what a broken write path looks
    # like once the page is re-skinned around it.
    assert "could not read" not in crawl.body("/instructor")


def test_every_class_the_app_renders_is_one_something_styles(crawl):
    """The rendered counterpart of the template check above.

    Deep-links the class audit to real output: a class that only appears once a
    session is ready, once an account has been created, or once a machine is warm is
    checked here and nowhere else.
    """
    styled = _stylesheet_classes() | _locally_styled_classes()
    rendered: dict[str, set[str]] = {}
    for path, response in crawl.pages:
        if response.status_code != 200 or _HTML not in response.headers.get("content-type", ""):
            continue
        for name in _rendered_classes(response.text):
            rendered.setdefault(name, set()).add(path)

    # A crawl that rendered nothing would pass this vacuously, so the pages that
    # only exist beside a machine have to have answered. `col-console` is the
    # session layout; `badge state-*` is every state chip on the panel. `flash` is
    # the banner a write path leaves for the page it redirects to — the one class in
    # this crawl that *cannot* appear without doing the write, which is what keeps
    # `writes` above load-bearing rather than decorative.
    assert {"col-console", "badge", "state-ready", "flash"} <= set(rendered), sorted(rendered)

    # By the time a class is in the response it is a whole name — "state-ready",
    # "diff-3" — because the template already ran. So this asks for an exact rule,
    # where the source-level check above can only ask about a prefix.
    unresolved = sorted(name for name in rendered if name not in styled)
    assert not unresolved, (
        "rendered pages carry classes that nothing styles:\n  "
        + "\n  ".join(f"{name} ({', '.join(sorted(rendered[name]))})" for name in unresolved)
    )
