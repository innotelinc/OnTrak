"""The in-memory Incus stands in for a hypervisor in demo mode and in the tests, so
its behaviour has to match the real client's in the ways the session manager relies
on — otherwise the demo would pass while the real path fails."""

from __future__ import annotations

import pytest

from ontrak.incus import IncusError, IncusNotFound
from ontrak.memory import InMemoryIncus

IMAGE = "ontrak-win-base"


def test_there_is_an_image_to_build_from():
    client = InMemoryIncus(IMAGE)
    assert client.available()
    assert client.image_exists(IMAGE)
    assert IMAGE in client.image_aliases()


def test_creating_an_instance_requires_its_image():
    client = InMemoryIncus(IMAGE)
    with pytest.raises(IncusNotFound, match="image missing-base not found"):
        client.create_instance("tpl-x", "missing-base")


def test_lifecycle_matches_the_real_client():
    client = InMemoryIncus(IMAGE)
    client.create_instance("tpl-net-dns-failure", IMAGE, ["default"])
    assert client.instance_status("tpl-net-dns-failure") == "STOPPED"
    # A stopped VM has no address, which is what the manager waits on.
    assert client.instance_ip("tpl-net-dns-failure") is None

    client.start_instance("tpl-net-dns-failure")
    assert client.instance_status("tpl-net-dns-failure") == "RUNNING"
    assert client.instance_ip("tpl-net-dns-failure")

    client.create_snapshot("tpl-net-dns-failure", "clean")
    assert client.has_snapshot("tpl-net-dns-failure", "clean")
    assert client.snapshot_names("tpl-net-dns-failure") == ["clean"]

    client.copy_instance("tpl-net-dns-failure/clean", "ontrak-pool-net-dns-failure-1")
    assert client.exists("ontrak-pool-net-dns-failure-1")
    assert client.snapshot_names("ontrak-pool-net-dns-failure-1") == []

    client.stop_instance("ontrak-pool-net-dns-failure-1")
    client.delete_instance("ontrak-pool-net-dns-failure-1", force=True)
    assert not client.exists("ontrak-pool-net-dns-failure-1")


def test_copying_a_missing_snapshot_fails_like_the_daemon():
    client = InMemoryIncus(IMAGE)
    client.add_instance("tpl-x", running=False)
    with pytest.raises(IncusNotFound, match="snapshot clean not found"):
        client.copy_instance("tpl-x/clean", "child")


def test_calls_are_recorded_for_assertions():
    client = InMemoryIncus(IMAGE)
    client.create_instance("a", IMAGE, ["default", "ontrak-student"])
    client.add_device("a", "disk", "root", bus="ide", size="8GiB")
    client.set_config("a", "limits.memory", "512MiB")
    assert ("create_instance", "a", IMAGE, ("default", "ontrak-student")) in client.calls
    assert ("a", "disk", "root", {"bus": "ide", "size": "8GiB"}) in client.devices
    assert ("a", "limits.memory", "512MiB") in client.configs


def test_there_is_no_guest_agent_to_exec_into():
    client = InMemoryIncus(IMAGE)
    with pytest.raises(IncusError, match="no guest agent"):
        client.exec_in("a", ["cmd", "/c", "echo hi"])


def test_instances_report_running_and_stopped():
    client = InMemoryIncus(IMAGE)
    client.add_instance("up", running=True)
    client.add_instance("down", running=False)
    statuses = {info.name: info.status for info in client.list_instances()}
    assert statuses == {"up": "RUNNING", "down": "STOPPED"}
    assert client.get_instance("up").running is True
    assert client.get_instance("nope") is None


def test_network_and_server_info_are_plausible_placeholders():
    client = InMemoryIncus(IMAGE)
    assert client.server_info()["environment"]["server_version"]
    assert client.network_names() == ["ontrak0"]
    assert client.run_json(["network", "list", "--format=json"])[0]["name"] == "ontrak0"


def test_adding_an_image_switches_the_golden_alias():
    client = InMemoryIncus("old-base")
    client.add_image("new-base")
    assert client.image_exists("new-base")
    assert client.image_alias == "new-base"
