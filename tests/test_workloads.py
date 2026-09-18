"""The workload matrix: templates, pools and sessions keyed by (scenario, platform).

The bug class this exists to prevent is subtle and expensive: one pool for a scenario
that is offered on Windows 11 *and* Ubuntu, so a Linux student is handed a Windows
machine (or, worse, a Windows student is handed a Linux one and nothing grades).
"""

from __future__ import annotations

import pytest

from ontrak.catalog import Catalog
from ontrak.guest import NullDriver
from ontrak.models import SessionState
from ontrak.scenarios import ScenarioRepository
from ontrak.sessions import SessionError, SessionManager
from tests.helpers import FakeIncus

LINUX_SCENARIO = "linux-perms-chmod-repair"
WINDOWS_SCENARIO = "net-dns-failure"
LINUX_IMAGE = "images:ubuntu/24.04"
DEBIAN_IMAGE = "images:debian/12"


@pytest.fixture()
def catalog(settings):
    return Catalog(settings.catalog_dir)


@pytest.fixture()
def incus(settings):
    """Incus double with the workload images a Linux scenario needs published."""
    return FakeIncus(image_alias=settings.incus.image_alias, images={LINUX_IMAGE, DEBIAN_IMAGE})


@pytest.fixture()
def shell_driver(settings):
    """Guest double that answers the shell contract, since these scenarios are Linux."""
    return NullDriver(
        settings,
        responses={
            "setup.ps1": "ONTRAK-SETUP-OK",
            "setup.sh": "ONTRAK-SETUP-OK",
            "check.sh": "###ONTRAK-JSON-BEGIN###{\"checks\":[]}###ONTRAK-JSON-END###",
        },
    )


@pytest.fixture()
def linux_manager(settings, store, repo, incus, shell_driver):
    return SessionManager(
        settings,
        store,
        repo=repo,
        incus=incus,
        driver=shell_driver,
        shell_driver=shell_driver,
        catalog=Catalog(settings.catalog_dir),
    )


def test_a_scenario_offered_on_two_platforms_yields_two_pairs(linux_manager):
    pairs = {(scenario.id, workload) for scenario, workload in linux_manager.workload_pairs()}
    assert (LINUX_SCENARIO, "ubuntu-24.04") in pairs
    assert (LINUX_SCENARIO, "debian-12") in pairs
    # A scenario that names no platform is still offered once, on the golden image.
    assert (WINDOWS_SCENARIO, "") in pairs


def test_template_names_are_distinct_per_platform(linux_manager, incus):
    ubuntu = linux_manager.ensure_template(LINUX_SCENARIO, workload="ubuntu-24.04")
    debian = linux_manager.ensure_template(LINUX_SCENARIO, workload="debian-12")
    assert ubuntu != debian
    assert ubuntu == "tpl-linux-perms-chmod-repair-ubuntu-24-04"
    assert incus.has_snapshot(ubuntu, "clean")
    assert incus.has_snapshot(debian, "clean")
    # The base image came from the catalog entry, not the site golden image.
    images = {call[2] for call in incus.calls if call[0] == "create_instance"}
    assert LINUX_IMAGE in images and DEBIAN_IMAGE in images


def test_a_platform_the_scenario_does_not_offer_is_rejected(linux_manager):
    with pytest.raises(SessionError, match="not offered on workload"):
        linux_manager.ensure_template(LINUX_SCENARIO, workload="win11-24h2")


def test_pools_are_kept_apart_per_platform(linux_manager, incus):
    linux_manager.ensure_template(LINUX_SCENARIO, workload="ubuntu-24.04")
    linux_manager.ensure_template(LINUX_SCENARIO, workload="debian-12")
    assert linux_manager.prewarm(LINUX_SCENARIO, 1, workload="ubuntu-24.04") == 1
    assert linux_manager.prewarm(LINUX_SCENARIO, 1, workload="debian-12") == 1

    rows = {
        status.workload: status
        for status in linux_manager.pool_status(LINUX_SCENARIO)
    }
    assert rows["ubuntu-24.04"].ready == 1
    assert rows["debian-12"].ready == 1
    assert rows["ubuntu-24.04"].platform == "linux"

    # Draining one platform must leave the other alone.
    assert linux_manager.drain_pool(LINUX_SCENARIO, workload="ubuntu-24.04") == 1
    rows = {status.workload: status for status in linux_manager.pool_status(LINUX_SCENARIO)}
    assert rows["ubuntu-24.04"].ready == 0
    assert rows["debian-12"].ready == 1


def test_a_session_claims_only_its_own_platforms_pool(linux_manager, incus):
    linux_manager.ensure_template(LINUX_SCENARIO, workload="ubuntu-24.04")
    linux_manager.ensure_template(LINUX_SCENARIO, workload="debian-12")
    linux_manager.prewarm(LINUX_SCENARIO, 1, workload="ubuntu-24.04")

    session = linux_manager.create_session("dana", LINUX_SCENARIO, workload="debian-12")
    assert session.workload == "debian-12"
    provisioned = linux_manager.provision(session)
    assert provisioned.state == SessionState.READY
    # The warm Ubuntu machine was not handed to a Debian session: it was cloned instead.
    assert "ubuntu" not in provisioned.instance
    assert provisioned.instance == f"ontrak-sess-{LINUX_SCENARIO}-debian-12-{provisioned.id}"


def test_default_workload_is_the_scenarios_first_declared_platform(linux_manager):
    session = linux_manager.create_session("kim", LINUX_SCENARIO)
    assert session.workload == "ubuntu-24.04"


def test_pool_targets_can_be_set_per_platform(linux_manager):
    linux_manager.settings.pool.targets = {f"{LINUX_SCENARIO}@debian-12": 5, LINUX_SCENARIO: 2}
    linux_manager.ensure_template(LINUX_SCENARIO, workload="ubuntu-24.04")
    linux_manager.ensure_template(LINUX_SCENARIO, workload="debian-12")

    rows = {status.workload: status for status in linux_manager.pool_status(LINUX_SCENARIO)}
    assert rows["debian-12"].target == 5
    assert rows["ubuntu-24.04"].target == 2


def test_pool_names_round_trip_for_every_pair(linux_manager):
    parser = linux_manager.settings.incus.parse_pool_name
    parser_known = linux_manager.settings.incus.known_workloads
    assert "ubuntu-24.04" in parser_known  # the manager told the namer what exists
    for scenario, workload in linux_manager.workload_pairs():
        name = linux_manager.settings.incus.pool_name(scenario.id, 3, workload)
        parsed = parser(name)
        assert parsed == (scenario.id, workload, 3), name


def test_an_identity_scenario_is_allowed_on_a_linux_container(linux_manager):
    """The catalog gates which scenario families a platform may host."""
    session = linux_manager.create_session("sam", "id-locked-account", workload="debian-12")
    assert session.workload == "debian-12"
    # ...and a platform that does not declare the family is refused.
    with pytest.raises(SessionError):
        linux_manager.create_session("sam2", "id-locked-account", workload="win11-24h2")


def test_workload_can_be_chosen_for_a_scenario_that_declares_none(linux_manager):
    session = linux_manager.create_session("pat", WINDOWS_SCENARIO, workload="debian-12")
    assert session.workload == "debian-12"


def test_unknown_workload_is_rejected(linux_manager):
    with pytest.raises(SessionError, match="unknown workload"):
        linux_manager.create_session("pat", WINDOWS_SCENARIO, workload="windows-not-a-thing")


def test_build_templates_reports_one_status_per_pair(linux_manager):
    results = linux_manager.build_templates([LINUX_SCENARIO], workloads=["debian-12"])
    assert results == {f"{LINUX_SCENARIO}@debian-12": "ready"}


def test_template_status_lists_every_pair(settings, store, incus, shell_driver):
    repository = ScenarioRepository(settings.scenarios_dir)
    manager = SessionManager(
        settings, store, repo=repository, incus=incus, driver=shell_driver,
        shell_driver=shell_driver, catalog=Catalog(settings.catalog_dir),
    )
    rows = manager.template_status()
    keys = {(row["scenario_id"], row["workload"]) for row in rows}
    assert (LINUX_SCENARIO, "ubuntu-24.04") in keys
    assert all(row["exists"] is False for row in rows)
