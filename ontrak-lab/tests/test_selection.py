"""Selection decides what a student is asked to do, so the tests pin both the
choice and the explanation. An assignment nobody can explain is worse than a manual
one."""

from __future__ import annotations

import pytest

from ontrak.catalog import Catalog
from ontrak.models import Category
from ontrak.scenarios import ScenarioRepository
from ontrak.selection import Choice, choose, eligible, history_from_sessions


@pytest.fixture()
def repo(settings) -> ScenarioRepository:
    return ScenarioRepository(settings.scenarios_dir)


@pytest.fixture()
def catalog(settings) -> Catalog:
    return Catalog(settings.catalog_dir)


def test_only_scenarios_the_workload_declares(repo, catalog):
    entry = catalog.get("ubuntu-24.04")
    pool, rejected = eligible(repo.list(), workload=entry)
    assert pool
    assert all(s.category in entry.scenario_families for s in pool)
    assert rejected
    assert all(reason for _, reason in rejected)


def test_containers_never_get_hardware_scenarios(repo, catalog):
    pool, rejected = eligible(repo.list(), workload=catalog.get("debian-12"))
    assert all(s.category != Category.HARDWARE.value for s in pool)
    assert any(s.category == Category.HARDWARE.value for s, _ in [(repo.get(i), r) for i, r in rejected])


def test_a_vm_workload_can_host_hardware_scenarios(repo, catalog):
    pool, _ = eligible(repo.list(), workload=catalog.get("win11-24h2"))
    assert any(s.category == Category.HARDWARE.value for s in pool)


def test_max_difficulty_filters_and_explains(repo):
    pool, rejected = eligible(repo.list(), max_difficulty=1)
    assert all(s.difficulty <= 1 for s in pool)
    assert any("above the cap" in reason for _, reason in rejected)


def test_choose_is_deterministic_for_a_seed(repo):
    first = choose(repo.list(), seed=7)
    second = choose(repo.list(), seed=7)
    assert first.scenario.id == second.scenario.id
    assert first.reasons


def test_history_steers_away_from_repeats(repo):
    first = choose(repo.list(), seed=1)
    second = choose(repo.list(), history=[first.scenario.id], seed=1)
    assert second.scenario.id != first.scenario.id
    assert any("already served" in reason for reason in second.reasons) or any(
        "not yet served" in reason for reason in second.reasons
    )


def test_balanced_spreads_across_categories(repo):
    """Simulate a class of 12 and check the assignment is not all one family."""
    history: list[str] = []
    for index in range(12):
        choice = choose(repo.list(), history=history, seed=index)
        history.append(choice.scenario.id)
    assert len(set(history)) >= 4
    assert len({repo.get(s).category for s in history}) >= 3


def test_strategies(repo):
    hardest = choose(repo.list(), strategy="hardest")
    easiest = choose(repo.list(), strategy="easiest")
    assert hardest.scenario.difficulty >= easiest.scenario.difficulty
    assert hardest.score > 0 > easiest.score
    random_choice = choose(repo.list(), strategy="random", seed=3)
    assert isinstance(random_choice, Choice)


def test_unknown_strategy_is_refused(repo):
    with pytest.raises(ValueError, match="unknown strategy"):
        choose(repo.list(), strategy="vibes")


def test_no_scenarios_is_refused():
    with pytest.raises(ValueError, match="no scenarios available"):
        choose([])


def test_impossible_workload_is_refused_with_the_reason(repo, catalog):
    entry = catalog.get("ubuntu-24.04")
    with pytest.raises(ValueError, match="no scenario fits this workload"):
        choose(repo.list(), workload=entry, max_difficulty=0)


def test_explanation_names_the_scenario_and_why(repo, catalog):
    choice = choose(repo.list(), workload=catalog.get("win11-24h2"), seed=2)
    text = choice.explain()
    assert choice.scenario.id in text
    assert "score" in text
    assert choice.reasons


def test_history_helper_accepts_sessions_and_rows():
    class Row:
        def __init__(self, scenario_id):
            self.scenario_id = scenario_id

    class Loose:
        def __init__(self, scenario):
            self.scenario = scenario

    assert history_from_sessions([Row("a"), Loose("b"), Row("")]) == ["a", "b"]
