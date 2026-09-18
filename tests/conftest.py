from __future__ import annotations

from pathlib import Path

import pytest

from ontrak.config import load_settings
from ontrak.guest import NullDriver
from ontrak.scenarios import ScenarioRepository
from ontrak.sessions import SessionManager
from ontrak.store import Store

from .helpers import FakeIncus

REPO_ROOT = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = REPO_ROOT / "scenarios"

GUAC_KEY = "0123456789abcdef0123456789abcdef"

try:  # FastAPI + httpx are optional at runtime; skip cleanly if absent
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover
    TestClient = None


@pytest.fixture
def settings(tmp_path):
    """Settings pointed at a temp state dir and the real scenario catalogue."""
    return load_settings(
        overrides={
            "paths": {"scenarios": str(SCENARIOS_DIR), "state": str(tmp_path / "state")},
            "guest": {
                "driver": "null",
                "user": "student",
                "password": "TrainMe!12345",
                "boot_timeout_seconds": 1,
                "ready_timeout_seconds": 1,
            },
            "session": {
                "ttl_minutes": 90,
                "idle_recycle_minutes": 30,
                "max_per_student": 1,
                "check_timeout_seconds": 5,
            },
            "incus": {"image_alias": "ontrak-win-base", "network": "ontrak0"},
            "pool": {"default_target": 0, "targets": {}, "max_total": 4},
            "guac": {"secret_key": GUAC_KEY, "base_url": "http://guac.test/guacamole/"},
            "portal": {"secret": "test-portal-secret", "admin_password": "admin-pass"},
        }
    )


@pytest.fixture
def store(settings):
    settings.ensure_dirs()
    return Store(settings.db_path)


@pytest.fixture
def repo(settings):
    return ScenarioRepository(settings.scenarios_dir)


@pytest.fixture
def incus(settings):
    return FakeIncus(image_alias=settings.incus.image_alias)


@pytest.fixture
def driver(settings):
    """Guest transport double that pretends fault injection succeeded."""
    return NullDriver(settings, responses={"setup.ps1": "ONTRAK-SETUP-OK\n"})


@pytest.fixture
def manager(settings, store, repo, incus, driver):
    return SessionManager(settings, store, repo=repo, incus=incus, driver=driver)


@pytest.fixture
def built_template(manager, incus):
    """A ready template for net-dns-failure, as if infra/build-templates.sh ran."""
    manager.ensure_template("net-dns-failure")
    return incus


# --------------------------------------------------------------------------- #
# the portal
# --------------------------------------------------------------------------- #
ALICE = ("alice", "alice-pw")
TEACHER = ("teacher", "teach-pw")


@pytest.fixture
def app_env(settings, store, incus):
    """A live portal with one student, one instructor and a built template.

    Yields ``(client, app)``. Shared by the portal and admin-panel suites so both
    exercise the same wiring the entrypoint does, rather than a re-declared app.
    """
    if TestClient is None:  # pragma: no cover - exercised only without fastapi
        pytest.skip("fastapi/httpx not installed")
    from ontrak.portal.app import create_app

    store.upsert_user("alice", "alice-pw", "student", "Alice A")
    store.upsert_user("teacher", "teach-pw", "instructor", "Teacher T")
    driver = NullDriver(
        settings, responses={"setup.ps1": "ONTRAK-SETUP-OK", "check.ps1": _pass_payload()}
    )
    app = create_app(settings, incus=incus, driver=driver)
    app.state.manager.ensure_template("net-dns-failure")
    with TestClient(app) as client:
        yield client, app


def _pass_payload() -> str:
    from ontrak.scenarios import JSON_BEGIN, JSON_END

    checks = [
        {"objective": o, "passed": True, "detail": "ok"}
        for o in ("restore-resolver", "resolve-intranet", "reach-service")
    ]
    import json

    return f"{JSON_BEGIN}{json.dumps({'checks': checks})}{JSON_END}"


def login(client, username: str, password: str, follow: bool = True):
    """Sign in, minting a CSRF cookie first the way the browser flow does."""
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


def as_student(client, username: str = "alice"):
    login(client, username, "alice-pw")
    return client


def as_instructor(client):
    login(client, *TEACHER)
    return client
