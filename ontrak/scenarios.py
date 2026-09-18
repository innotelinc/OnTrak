"""Scenario catalogue: loading, validation and selection.

A scenario is a directory::

    scenarios/net-dns-failure/
        scenario.yaml    ticket text, objectives + weights, hints, metadata
        setup.ps1        injects the fault (must end with ONTRAK-SETUP-OK)
        check.ps1        grades objectives (must call Write-OnTrakReport)
        resources/       optional extra files uploaded with setup.ps1

Objectives declared in ``scenario.yaml`` are the contract: ``check.ps1`` must
report on exactly those ids, and :meth:`ScenarioRepository.validate` enforces
that statically so a typo cannot silently score zero.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .models import CATEGORY_LABELS, Category, Objective

# Markers the guest-side helper writes around its JSON payload. Using markers
# means PowerShell banners, progress streams and stray warnings cannot corrupt
# the result: we parse only what sits between them.
JSON_BEGIN = "###ONTRAK-JSON-BEGIN###"
JSON_END = "###ONTRAK-JSON-END###"

SETUP_OK_MARKER = "ONTRAK-SETUP-OK"
SETUP_OK_HELPER = "Write-OnTrakSetupOk"
CHECK_ENTRYPOINT = "Write-OnTrakReport"
COMMON_LIB = "OnTrak.Common.ps1"

DEFAULT_PASS_SCORE = 80.0
MAX_DIFFICULTY = 4

_CATEGORY_ALIASES: dict[str, str] = {
    "hardware": Category.HARDWARE.value,
    "hw": Category.HARDWARE.value,
    "driver": Category.HARDWARE.value,
    "drivers": Category.HARDWARE.value,
    "software": Category.SOFTWARE.value,
    "apps": Category.SOFTWARE.value,
    "app": Category.SOFTWARE.value,
    "network": Category.NETWORK.value,
    "net": Category.NETWORK.value,
    "connectivity": Category.NETWORK.value,
    "os": Category.OS.value,
    "boot": Category.OS.value,
    "performance": Category.OS.value,
    "perf": Category.OS.value,
    "security": Category.SECURITY.value,
    "malware": Category.SECURITY.value,
}


class ScenarioError(RuntimeError):
    """Raised when a scenario is missing or invalid."""


@dataclass
class Scenario:
    id: str
    title: str
    category: str
    briefing: str
    objectives: list[Objective]
    directory: Path
    difficulty: int = 2
    minutes: int = 25
    pass_score: float = DEFAULT_PASS_SCORE
    hints: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    requires_internet: bool = False
    ticket: dict = field(default_factory=dict)
    reset_notes: str = ""
    resources: list[str] = field(default_factory=list)
    instance_devices: list[dict] = field(default_factory=list)
    instance_config: dict = field(default_factory=dict)
    setup_script: str = ""
    check_script: str = ""
    # Optional catalog entry id ("win11-24h2", "ubuntu-24.04") naming the platform
    # this fault should be built on. Empty means the site's golden image.
    workload: str = ""
    generated_from: list[str] = field(default_factory=list)

    # -- introspection -------------------------------------------------
    @property
    def category_label(self) -> str:
        return CATEGORY_LABELS.get(self.category, self.category.title())

    @property
    def total_weight(self) -> float:
        return sum(o.weight for o in self.objectives)

    @property
    def critical_objectives(self) -> list[Objective]:
        return [o for o in self.objectives if o.critical]

    def objective(self, objective_id: str) -> Objective | None:
        return next((o for o in self.objectives if o.id == objective_id), None)

    def hints_up_to(self, level: int) -> list[str]:
        return self.hints[: max(0, min(level, len(self.hints)))]

    def public(self, hint_level: int = 0) -> dict:
        """Portal-facing view. Never includes script bodies or unrevealed hints."""
        return {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "category_label": self.category_label,
            "difficulty": self.difficulty,
            "minutes": self.minutes,
            "briefing": self.briefing,
            "ticket": self.ticket,
            "tags": self.tags,
            "pass_score": self.pass_score,
            "requires_internet": self.requires_internet,
            "reset_notes": self.reset_notes,
            "workload": self.workload,
            "hint_count": len(self.hints),
            "hints_revealed": self.hints_up_to(hint_level),
            "objectives": [
                {
                    "id": o.id,
                    "text": o.text,
                    "weight": o.weight,
                    "critical": o.critical,
                }
                for o in self.objectives
            ],
        }


class ScenarioRepository:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self._scenarios: dict[str, Scenario] | None = None

    # -- loading -------------------------------------------------------
    def load(self, force: bool = False) -> dict[str, Scenario]:
        if self._scenarios is None or force:
            self._scenarios = self._discover()
        return self._scenarios

    def reload(self) -> dict[str, Scenario]:
        return self.load(force=True)

    def _discover(self) -> dict[str, Scenario]:
        found: dict[str, Scenario] = {}
        if not self.root.exists():
            raise ScenarioError(f"scenario directory not found: {self.root}")
        for directory in sorted(p for p in self.root.iterdir() if p.is_dir()):
            manifest = directory / "scenario.yaml"
            if not manifest.exists():
                continue
            scenario = self._load_one(directory, manifest)
            found[scenario.id] = scenario
        return found

    def _load_one(self, directory: Path, manifest: Path) -> Scenario:
        try:
            data = yaml.safe_load(manifest.read_text()) or {}
        except yaml.YAMLError as exc:
            raise ScenarioError(f"{manifest}: invalid YAML: {exc}") from exc
        if not isinstance(data, dict):
            raise ScenarioError(f"{manifest}: top level must be a mapping")

        scenario_id = str(data.get("id") or directory.name)
        objectives = [
            Objective.from_dict(item) for item in (data.get("objectives") or []) if isinstance(item, dict)
        ]
        return Scenario(
            id=scenario_id,
            title=str(data.get("title") or scenario_id),
            category=normalise_category(str(data.get("category") or Category.SOFTWARE.value)),
            briefing=str(data.get("briefing") or "").strip(),
            objectives=objectives,
            directory=directory,
            difficulty=int(data.get("difficulty", 2)),
            minutes=int(data.get("minutes", 25)),
            pass_score=float(data.get("pass_score", DEFAULT_PASS_SCORE)),
            hints=[str(h) for h in (data.get("hints") or [])],
            tags=[str(t) for t in (data.get("tags") or [])],
            requires_internet=bool(data.get("requires_internet", False)),
            ticket=dict(data.get("ticket") or {}),
            reset_notes=str(data.get("reset_notes") or "").strip(),
            resources=[str(r) for r in (data.get("resources") or [])],
            instance_devices=[d for d in (data.get("instance_devices") or []) if isinstance(d, dict)],
            instance_config=dict(data.get("instance_config") or {}),
            setup_script=str(directory / "setup.ps1"),
            check_script=str(directory / "check.ps1"),
            workload=str(data.get("workload") or ""),
            generated_from=[str(g) for g in (data.get("generated_from") or [])],
        )

    # -- access --------------------------------------------------------
    def get(self, scenario_id: str) -> Scenario:
        scenarios = self.load()
        if scenario_id not in scenarios:
            raise ScenarioError(
                f"unknown scenario {scenario_id!r}; available: {', '.join(sorted(scenarios)) or 'none'}"
            )
        return scenarios[scenario_id]

    def list(self) -> list[Scenario]:
        order = {c.value: i for i, c in enumerate(Category)}
        return sorted(
            self.load().values(),
            key=lambda s: (order.get(s.category, 99), s.difficulty, s.id),
        )

    def by_category(self) -> dict[str, list[Scenario]]:
        grouped: dict[str, list[Scenario]] = {}
        for scenario in self.list():
            grouped.setdefault(scenario.category, []).append(scenario)
        return grouped

    def ids(self) -> list[str]:
        return [s.id for s in self.list()]

    # -- validation ----------------------------------------------------
    def validate(self, scenario_ids: list[str] | None = None) -> list[str]:
        """Return a list of human-readable problems (empty means healthy).

        This is stricter than loading: it checks the objective/check-script
        contract, so ``make validate`` in CI catches the class of bug where a
        scenario scores 0% forever because a check id was renamed.
        """
        problems: list[str] = []
        try:
            scenarios = self.load(force=True)
        except ScenarioError as exc:
            return [str(exc)]

        selected = scenarios.values() if not scenario_ids else [
            s for s in scenarios.values() if s.id in set(scenario_ids)
        ]
        for scenario in selected:
            prefix = f"[{scenario.id}]"
            expected_dir = scenario.directory.name
            if scenario.id != expected_dir:
                problems.append(f"{prefix} id does not match directory name {expected_dir!r}")
            if not scenario.title or scenario.title == scenario.id:
                problems.append(f"{prefix} missing a human-readable title")
            if not scenario.briefing:
                problems.append(f"{prefix} missing briefing text (the student's ticket)")
            if not 1 <= scenario.difficulty <= MAX_DIFFICULTY:
                problems.append(f"{prefix} difficulty must be 1..{MAX_DIFFICULTY}")
            if scenario.minutes <= 0:
                problems.append(f"{prefix} minutes must be positive")
            if not 0 < scenario.pass_score <= 100:
                problems.append(f"{prefix} pass_score must be in (0, 100]")
            if not scenario.objectives:
                problems.append(f"{prefix} declares no objectives")
            if len(scenario.critical_objectives) == len(scenario.objectives) and len(scenario.objectives) > 3:
                problems.append(
                    f"{prefix} every objective is critical; keep critical for the "
                    "must-not-miss items so partial credit stays meaningful"
                )
            ids = [o.id for o in scenario.objectives]
            duplicates = {i for i in ids if ids.count(i) > 1}
            if duplicates:
                problems.append(f"{prefix} duplicate objective id(s): {', '.join(sorted(duplicates))}")
            for objective in scenario.objectives:
                if objective.weight <= 0:
                    problems.append(f"{prefix} objective {objective.id} needs weight > 0")
                if not objective.text:
                    problems.append(f"{prefix} objective {objective.id} has no text")
            # Weights total 100 so that a pass mark means the same thing in every
            # scenario, and so a student who has done 80% of the work is told so.
            if scenario.objectives and abs(scenario.total_weight - 100) > 0.01:
                problems.append(
                    f"{prefix} objective weights total {scenario.total_weight:g}, not 100"
                )

            setup_path = Path(scenario.setup_script)
            check_path = Path(scenario.check_script)
            if not setup_path.exists() or not setup_path.stat().st_size:
                problems.append(f"{prefix} setup.ps1 is missing or empty")
            else:
                setup_text = setup_path.read_text(errors="replace")
                if SETUP_OK_MARKER not in setup_text and SETUP_OK_HELPER not in setup_text:
                    problems.append(
                        f"{prefix} setup.ps1 never confirms success (needs {SETUP_OK_HELPER} "
                        f"or the literal {SETUP_OK_MARKER}); template build would reject a "
                        "partially applied fault"
                    )
            if not check_path.exists() or not check_path.stat().st_size:
                problems.append(f"{prefix} check.ps1 is missing or empty")
            else:
                check_text = check_path.read_text(errors="replace")
                if CHECK_ENTRYPOINT not in check_text:
                    problems.append(f"{prefix} check.ps1 must call {CHECK_ENTRYPOINT}")
                for objective_id in ids:
                    if not re.search(rf"['\"]{re.escape(objective_id)}['\"]", check_text):
                        problems.append(
                            f"{prefix} check.ps1 never reports objective {objective_id!r} "
                            "(it would always score as failed)"
                        )
            for resource in scenario.resources:
                if not (scenario.directory / resource).exists():
                    problems.append(f"{prefix} declared resource {resource!r} does not exist")
            for device in scenario.instance_devices:
                if not device.get("name") or not device.get("type"):
                    problems.append(
                        f"{prefix} each entry in instance_devices needs a 'name' and a 'type'"
                    )
                elif device.get("type") == "nic" and not device.get("network"):
                    problems.append(
                        f"{prefix} nic device {device['name']!r} needs a 'network' "
                        "(build would fail without one)"
                    )
        return problems


def normalise_category(value: str) -> str:
    key = value.strip().lower().replace(" ", "_")
    if key in _CATEGORY_ALIASES:
        return _CATEGORY_ALIASES[key]
    try:
        return Category(key).value
    except ValueError as exc:
        allowed = ", ".join(sorted(CATEGORY_LABELS))
        raise ScenarioError(f"unknown category {value!r}; use one of: {allowed}") from exc


def default_scenario_repository(settings) -> ScenarioRepository:
    return ScenarioRepository(settings.scenarios_dir)
