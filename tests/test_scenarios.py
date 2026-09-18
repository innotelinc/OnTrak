from __future__ import annotations

from pathlib import Path

import pytest

from ontrak.models import Category
from ontrak.scenarios import ScenarioError, ScenarioRepository, normalise_category


def test_every_shipped_scenario_validates(repo):
    problems = repo.validate()
    assert problems == [], "\n".join(problems)


def test_all_five_survey_categories_are_covered(repo):
    categories = {scenario.category for scenario in repo.list()}
    assert categories == {c.value for c in Category}


def test_objectives_are_reported_by_their_check_script(repo):
    for scenario in repo.list():
        check_text = Path(scenario.check_script).read_text()
        for objective in scenario.objectives:
            assert f"'{objective.id}'" in check_text or f'"{objective.id}"' in check_text


def test_scenario_ids_match_their_directory(repo):
    for scenario in repo.list():
        assert scenario.id == scenario.directory.name


def test_get_unknown_scenario_raises(repo):
    with pytest.raises(ScenarioError, match="unknown scenario"):
        repo.get("does-not-exist")


def test_hints_reveal_progressively(repo):
    scenario = repo.get("sec-malware-persistence")
    assert scenario.hints_up_to(0) == []
    assert scenario.hints_up_to(1) == scenario.hints[:1]
    assert scenario.hints_up_to(99) == scenario.hints


def test_public_view_hides_scripts(repo):
    scenario = repo.get("net-dns-failure")
    public = scenario.public(hint_level=2)
    assert "setup.ps1" not in str(public)
    assert public["hint_count"] == len(scenario.hints)
    assert len(public["hints_revealed"]) == 2
    assert {o["id"] for o in public["objectives"]} == {o.id for o in scenario.objectives}


def test_weights_and_critical_flags_are_sane(repo):
    for scenario in repo.list():
        assert scenario.objectives
        assert all(o.weight > 0 for o in scenario.objectives)
        assert sum(o.weight for o in scenario.objectives) == 100, (
            f"{scenario.id} weights should total 100 for a predictable pass mark"
        )
        assert 0 < len(scenario.critical_objectives) < len(scenario.objectives)


def test_hardware_scenario_declares_its_extra_device(repo):
    scenario = repo.get("hw-driver-device")
    assert scenario.instance_devices, "the device scenario needs a second NIC"
    device = scenario.instance_devices[0]
    assert device["type"] == "nic" and device["network"]


def test_validate_catches_a_broken_scenario(tmp_path):
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "scenario.yaml").write_text(
        """
id: broken
title: Broken
category: network
briefing: nothing here
objectives:
  - id: missing-check
    text: never reported
    weight: 10
""".strip()
    )
    (broken / "setup.ps1").write_text("# no marker\n")
    (broken / "check.ps1").write_text("# no report call\n")
    problems = ScenarioRepository(tmp_path).validate()
    joined = "\n".join(problems)
    assert "setup.ps1 is missing or empty" not in joined  # it exists, just wrong
    assert "ONTRAK-SETUP-OK" in joined
    assert "Write-OnTrakReport" in joined
    assert "never reports objective 'missing-check'" in joined


def test_category_aliases():
    assert normalise_category("Drivers") == Category.HARDWARE.value
    assert normalise_category("Malware") == Category.SECURITY.value
    assert normalise_category("perf") == Category.OS.value
    with pytest.raises(ScenarioError):
        normalise_category("interpretive-dance")


def test_by_category_groups_everything(repo):
    grouped = repo.by_category()
    assert sum(len(v) for v in grouped.values()) == len(repo.list())
