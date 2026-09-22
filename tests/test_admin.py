"""The instructor admin panel.

Two properties matter here, and only one of them is obvious:

* the panel is role-gated — a student cannot read the roster, the results or the
  audit log, and nobody anonymous gets in;
* **the panel renders when the hypervisor does not.** Every live machine fact on
  these pages comes from the `incus` CLI, and an operator opens the panel exactly
  when something is wrong. A 500 because Incus was unreachable hides the accounts,
  tickets, results and audit log that are all still perfectly readable — which is
  how this was found: the container had no Incus socket and `/admin` returned 500.
"""

from __future__ import annotations

import pytest

from ontrak.guest import NullDriver
from ontrak.incus import IncusError
from ontrak.portal.admin import templates_by_scenario
from ontrak.sessions import POOL_SNAPSHOT, TEMPLATE_RECIPE_KEY

from .conftest import as_instructor, as_student, login
from .helpers import FakeIncus

# Exactly what `admin/_template_state.html` renders for the third state. Written out
# rather than imported so the test fails if the macro's markup drifts, not just if the
# word disappears.
STALE_BADGE = 'class="badge warn">stale'

ADMIN_PAGES = [
    "/admin",
    "/admin/users",
    "/admin/scenarios",
    "/admin/platforms",
    "/admin/tickets",
    "/admin/sessions",
    "/admin/schedule",
    "/admin/results",
    "/admin/audit",
]


class UnreachableIncus(FakeIncus):
    """An Incus the portal cannot talk to: no socket, no daemon, no answer.

    Exactly the container's situation when the host socket is not mounted, and
    the one the admin panel met first.
    """

    def _boom(self, *args, **kwargs):
        raise IncusError(["list", "--format=json"], 1, "The incus daemon doesn't appear to be started")

    list_instances = _boom
    exists = _boom
    instance_ip = _boom
    image_aliases = _boom
    server_info = _boom


@pytest.fixture
def broken_app(settings, store, repo):
    """A portal wired to an unreachable hypervisor."""
    from fastapi.testclient import TestClient

    from ontrak.portal.app import create_app

    store.upsert_user("teacher", "instructor", "Teacher T")
    store.upsert_user("alice", "student", "Alice A")
    incus = UnreachableIncus(image_alias=settings.incus.image_alias)
    app = create_app(settings, incus=incus, driver=NullDriver(settings))
    with TestClient(app) as client:
        yield client, app


# --------------------------------------------------------------------------- #
# access control
# --------------------------------------------------------------------------- #
def test_anonymous_visitors_are_sent_to_the_login_page(app_env):
    client, _ = app_env
    for path in ADMIN_PAGES:
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 303, path
        assert response.headers["location"].startswith("/login")


def test_students_cannot_read_the_panel(app_env):
    client, _ = app_env
    as_student(client, "alice")
    for path in ADMIN_PAGES:
        assert client.get(path).status_code == 403, path


def test_the_machine_readable_snapshot_is_protected_too(app_env):
    client, _ = app_env
    assert client.get("/admin/state.json", follow_redirects=False).status_code == 303
    as_student(client, "alice")
    assert client.get("/admin/state.json").status_code == 403


# --------------------------------------------------------------------------- #
# the pages, with a working hypervisor
# --------------------------------------------------------------------------- #
def test_every_admin_page_renders_for_an_instructor(app_env):
    client, _ = app_env
    as_instructor(client)
    for path in ADMIN_PAGES:
        response = client.get(path)
        assert response.status_code == 200, path
        assert "onTrak" in response.text or "OnTrak" in response.text, path


def test_the_overview_counts_what_the_portal_stored(app_env):
    client, app = app_env
    as_instructor(client)
    page = client.get("/admin").text
    # Two accounts were seeded by the fixture, and scenarios come from the repo.
    assert "alice" in page or "teacher" in page
    assert "net-dns-failure" in page


def test_the_overview_shows_the_address_students_should_use(app_env):
    """A LAN range has no DNS name to hand out, so the panel prints the address it was
    opened on — the one an instructor can read out and that the console follows."""
    client, _ = app_env
    as_instructor(client)
    page = client.get(
        "/admin", headers={"host": "192.168.1.24:8443", "x-forwarded-proto": "https"}
    ).text
    assert "Students reach this range at" in page
    assert "https://192.168.1.24:8443/" in page


def test_the_state_snapshot_answers_in_json(app_env):
    client, _ = app_env
    as_instructor(client)
    payload = client.get("/admin/state.json").json()
    assert payload["users"]["student"] >= 1
    assert payload["users"]["instructor"] >= 1
    assert payload["scenarios"] >= 1
    assert set(payload) >= {"sessions", "tickets", "pool", "templates", "events"}


def test_results_export_as_csv(app_env):
    client, _ = app_env
    as_instructor(client)
    response = client.get("/admin/results.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "student,scenario_id,machine_score" in response.text


# --------------------------------------------------------------------------- #
# template freshness, shown where the operator already is
# --------------------------------------------------------------------------- #
def test_a_stale_template_is_visible_in_the_panel(app_env):
    """A clean snapshot of an *older* fault is the one wrong machine the panel could not
    show.

    Everything else about it looks healthy: the template exists, the snapshot is clean,
    the build reported ready. Only the recipe stamp says that the machine a student
    would be handed is running yesterday's fault under today's ticket — and finding
    that used to mean running a probe beside the page. This is the read that has to be
    on the page itself.
    """
    client, app = app_env
    as_instructor(client)
    incus = app.state.manager.incus
    name = app.state.settings.incus.template_name("net-dns-failure")

    # The fixture built it, so it is genuinely fresh to begin with — otherwise the
    # assertion below would pass for the wrong reason.
    assert incus.has_snapshot(name, POOL_SNAPSHOT)
    assert STALE_BADGE not in client.get("/admin/scenarios").text

    # An older build of the same scenario: the snapshot is still there, still clean.
    incus.set_config(name, TEMPLATE_RECIPE_KEY, "recipe-from-an-older-checkout")

    for path in ("/admin/scenarios", "/admin/platforms"):
        page = client.get(path).text
        assert STALE_BADGE in page, path
        assert "rebuild" in page.lower(), path
    assert "older recipe" in client.get("/admin").text


def test_the_panel_does_not_cry_stale_over_a_healthy_pool(app_env):
    """The other half, and the one that decides whether the badge is believed."""
    client, _ = app_env
    as_instructor(client)
    for path in ("/admin/scenarios", "/admin/platforms"):
        page = client.get(path).text
        assert STALE_BADGE not in page, path
        assert 'class="badge ok">ready' in page, path


def test_templates_are_grouped_by_scenario_not_by_platform():
    """The scenarios table has a scenario id in hand, so a view keyed
    ``scenario@workload`` silently showed every multi-platform scenario as unbuilt."""
    grouped = templates_by_scenario(
        [
            {"scenario_id": "id-locked-account", "workload": "ubuntu-24.04"},
            {"scenario_id": "id-locked-account", "workload": "debian-12"},
            {"scenario_id": "net-dns-failure", "workload": ""},
        ]
    )
    assert sorted(grouped) == ["id-locked-account", "net-dns-failure"]
    assert [row["workload"] for row in grouped["id-locked-account"]] == [
        "debian-12",
        "ubuntu-24.04",
    ]
    assert len(grouped["net-dns-failure"]) == 1


# --------------------------------------------------------------------------- #
# the panel with no hypervisor (the container's case)
# --------------------------------------------------------------------------- #
def test_the_panel_renders_when_incus_is_unreachable(broken_app):
    client, _ = broken_app
    as_instructor(client)
    for path in ADMIN_PAGES:
        response = client.get(path)
        assert response.status_code == 200, path


def test_the_panel_says_what_failed_instead_of_tracing_it(broken_app):
    client, _ = broken_app
    as_instructor(client)
    page = client.get("/admin").text
    assert "Hypervisor reads failed" in page
    assert "incus daemon" in page
    # And it says the data that is *not* unavailable is still there.
    assert "unaffected" in page


def test_the_instructor_page_renders_when_incus_is_unreachable(broken_app):
    """`/instructor` was the page that did not survive a missing hypervisor.

    It guarded its pool read and not its template read, so the whole page answered
    500 with a traceback in the log — on exactly the host an instructor is most
    likely to open it from. The admin panel had this test; this page did not, which
    is why it shipped.
    """
    client, _ = broken_app
    as_instructor(client)
    response = client.get("/instructor")
    assert response.status_code == 200
    assert "could not read the templates" in response.text
    assert "incus daemon" in response.text
    # And the page is still the page: the parts that do not need Incus are there.
    assert "Instructor console" in response.text


def test_the_instructor_banner_does_not_stick_to_later_pages(broken_app, settings):
    """A failure is reported by the response that met it, not forever after.

    The message used to be stored on the app, so the first failure left a
    "could not read the pool" banner on every page from then on — including after
    the hypervisor came back, which is the case that misleads.
    """
    client, app = broken_app
    as_instructor(client)
    assert "could not read" in client.get("/instructor").text

    # The hypervisor comes back.
    app.state.manager.incus = FakeIncus(image_alias=settings.incus.image_alias)
    assert "could not read" not in client.get("/instructor").text


def test_the_dashboard_still_works_without_a_hypervisor(broken_app):
    """A student with no reachable Incus gets an error, not a stack trace."""
    client, _ = broken_app
    login(client, "alice")
    assert client.get("/dashboard").status_code == 200


def test_pool_dependent_actions_report_failure_instead_of_500(broken_app):
    from .conftest import csrf

    client, _ = broken_app
    as_instructor(client)
    response = client.post(
        "/admin/maintenance",
        data={"action": "reap", "csrf": csrf(client)},
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert "fail" in response.text.lower() or "Reaped" in response.text
