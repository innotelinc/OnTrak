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
