"""Automatic scenario assignment.

A student should not have to choose which fault to hunt, and an instructor should not
have to hand out scenarios one by one. Selection picks a scenario that (a) the chosen
workload can actually run and (b) the class has not seen to death.

The scoring is deliberately explainable: every choice returns the reasons it was made
so the instructor view can answer "why did this student get that ticket?" without
re-running the algorithm.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass, field

from .catalog import CatalogEntry
from .models import Category
from .scenarios import Scenario

STRATEGIES = ("balanced", "random", "family", "hardest", "easiest")

# Categories that make sense when there is no guest automation at all: the student
# can still be graded on what an observed fix looked like, and the ticket is the
# point. Everything else would produce silent zeros.
MANUAL_FRIENDLY = {Category.HARDWARE.value, Category.SOFTWARE.value, Category.NETWORK.value, Category.OS.value}

TARGET_DIFFICULTY = 2.5


@dataclass
class Choice:
    scenario: Scenario
    score: float
    reasons: list[str] = field(default_factory=list)
    rejected: list[tuple[str, str]] = field(default_factory=list)  # (scenario id, why not)

    def explain(self) -> str:
        head = f"{self.scenario.id} (score {self.score:.2f})"
        return " | ".join([head, *self.reasons])


def eligible(
    scenarios: list[Scenario],
    *,
    workload: CatalogEntry | None = None,
    max_difficulty: int | None = None,
) -> tuple[list[Scenario], list[tuple[str, str]]]:
    """Filter scenarios down to what the workload can host, with reasons for the rest."""
    kept: list[Scenario] = []
    rejected: list[tuple[str, str]] = []
    allowed_families = set(workload.scenario_families) if workload else set()

    for scenario in scenarios:
        if max_difficulty is not None and scenario.difficulty > max_difficulty:
            rejected.append((scenario.id, f"difficulty {scenario.difficulty} above the cap {max_difficulty}"))
            continue
        if workload is not None:
            if workload.kind == "container" and scenario.category == Category.HARDWARE.value:
                rejected.append((scenario.id, "hardware scenarios need a VM, not a container"))
                continue
            if scenario.category == Category.HARDWARE.value and not workload.profile.get("devices"):
                rejected.append((scenario.id, "no devices to break in this workload profile"))
                continue
            if allowed_families and scenario.category not in allowed_families:
                rejected.append(
                    (scenario.id, f"workload declares families {', '.join(sorted(allowed_families))}")
                )
                continue
            if scenario.requires_internet and workload.automation == "none":
                rejected.append((scenario.id, "scenario needs internet, workload has no automation to verify it"))
                continue
        kept.append(scenario)
    return kept, rejected


def _score(
    scenario: Scenario,
    *,
    workload: CatalogEntry | None,
    history: list[str],
    category_counts: Counter,
) -> tuple[float, list[str]]:
    score = 0.0
    reasons: list[str] = []

    if workload is not None:
        if scenario.category in set(workload.scenario_families):
            score += 3.0
            reasons.append(f"family {scenario.category} is supported by {workload.id}")
        elif workload.kind == "vm":
            score += 0.5
            reasons.append("any VM scenario is runnable on this workload")

    recent = history.count(scenario.id)
    if recent:
        penalty = min(6.0, 3.0 * recent)
        score -= penalty
        reasons.append(f"already served {recent}x in this class")
    else:
        score += 2.0
        reasons.append("not yet served in this class")

    if category_counts:
        fewest = min(category_counts.values())
        if category_counts.get(scenario.category, 0) <= fewest:
            score += 2.0
            reasons.append(f"category {scenario.category} is the least used so far")

    distance = abs(scenario.difficulty - TARGET_DIFFICULTY)
    score -= distance
    reasons.append(f"difficulty {scenario.difficulty} ({'close to' if distance <= 0.5 else 'further from'} the usual 2-3)")

    if scenario.requires_internet:
        score -= 1.0
        reasons.append("needs internet access, so it is deprioritised")
    return score, reasons


def choose(
    scenarios: list[Scenario],
    *,
    workload: CatalogEntry | None = None,
    history: list[str] = (),
    strategy: str = "balanced",
    max_difficulty: int | None = None,
    seed: int | None = None,
) -> Choice:
    """Pick one scenario. Deterministic for a given seed and history."""
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy {strategy!r}; use one of {', '.join(STRATEGIES)}")
    if not scenarios:
        raise ValueError("no scenarios available to choose from")

    pool, rejected = eligible(scenarios, workload=workload, max_difficulty=max_difficulty)
    if not pool:
        raise ValueError(
            "no scenario fits this workload"
            + (f" ({rejected[0][1]})" if rejected else "")
        )

    rng = random.Random(seed)
    history = list(history)
    category_counts = Counter(_categories_of(history, scenarios))

    if strategy == "random":
        chosen = rng.choice(pool)
        return Choice(chosen, 0.0, ["random strategy"], rejected)
    if strategy == "hardest":
        chosen = max(pool, key=lambda s: (s.difficulty, s.id))
        return Choice(chosen, float(chosen.difficulty), ["hardest available"], rejected)
    if strategy == "easiest":
        chosen = min(pool, key=lambda s: (s.difficulty, s.id))
        return Choice(chosen, float(-chosen.difficulty), ["easiest available"], rejected)
    if strategy == "family":
        if workload is not None and workload.scenario_families:
            wanted = set(workload.scenario_families)
            narrowed = [s for s in pool if s.category in wanted]
            pool = narrowed or pool
        chosen = min(pool, key=lambda s: (history.count(s.id), s.difficulty))
        return Choice(chosen, 1.0, [f"family strategy, fewest prior runs ({history.count(chosen.id)})"], rejected)

    scored: list[Choice] = []
    for scenario in pool:
        score, reasons = _score(
            scenario, workload=workload, history=history, category_counts=category_counts
        )
        scored.append(Choice(scenario, score, reasons, rejected))
    best = max(scored, key=lambda c: (c.score, c.scenario.id))
    if history:
        best.reasons.append(f"chosen over {len(scored) - 1} other candidate(s)")
    return best


def _categories_of(history: list[str], scenarios: list[Scenario]) -> list[str]:
    by_id = {s.id: s.category for s in scenarios}
    return [by_id[sid] for sid in history if sid in by_id]


def history_from_sessions(sessions: list) -> list[str]:
    """Flatten a class's session history into the list :func:`choose` expects."""
    out: list[str] = []
    for session in sessions:
        scenario_id = getattr(session, "scenario_id", None) or getattr(session, "scenario", None)
        if scenario_id:
            out.append(str(scenario_id))
    return out
