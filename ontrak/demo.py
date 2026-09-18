"""Demo mode: the whole student flow, with no hypervisor and no Windows.

Why this exists: every question about OnTrak ("what does a student actually see?",
"does grading work?", "can we show this to the training team on Thursday?") otherwise
requires a Linux host with KVM, Incus and a 40-minute Windows image build. Demo mode
replaces the hypervisor with an in-memory one and the guest with a driver that reports
plausible grading results, so the portal, the lifecycle, the scoring and the instructor
view can all be exercised in five seconds.

What it deliberately does **not** do: prove the Windows path works. That needs real
hardware, and `ontrak doctor` is the check for it.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path

from .catalog import Catalog
from .config import Settings, load_settings
from .guest import BaseDriver, CommandResult
from .memory import InMemoryIncus
from .models import SessionState
from .scenarios import JSON_BEGIN, JSON_END, SETUP_OK_MARKER, ScenarioRepository
from .sessions import SessionManager
from .store import Store

DEMO_STUDENTS = ["student1", "student2", "student3", "student4", "student5", "student6"]
DEMO_PASSWORD = "demo"
DEMO_INSTRUCTOR = "instructor"


@dataclass
class DemoEnvironment:
    settings: Settings
    store: Store
    catalog: Catalog
    repository: ScenarioRepository
    incus: InMemoryIncus
    driver: DemoDriver
    manager: SessionManager


class DemoDriver(BaseDriver):
    """A guest that answers plausibly instead of actually doing anything.

    Setup scripts report the success marker. Check scripts report every objective the
    scenario declares, passing with probability ``success_rate`` (deterministic for a
    given seed), so a demo can show either a clean pass or realistic partial credit.
    """

    name = "demo"

    def __init__(
        self,
        settings: Settings,
        repository: ScenarioRepository,
        *,
        success_rate: float = 1.0,
        seed: int = 0,
    ):
        super().__init__(settings)
        self.repository = repository
        self.success_rate = max(0.0, min(1.0, float(success_rate)))
        self.seed = seed
        self.calls: list[tuple[str, str]] = []

    # -- behaviour -----------------------------------------------------
    def _scenario_for(self, remote_path: str):
        for scenario in self.repository.list():
            if scenario.id in remote_path:
                return scenario
        return None

    def _report(self, remote_path: str) -> CommandResult:
        scenario = self._scenario_for(remote_path)
        if scenario is None:
            return CommandResult(True, 0, "")
        rng = random.Random(f"{self.seed}:{scenario.id}")
        checks = []
        for objective in scenario.objectives:
            passed = rng.random() < self.success_rate
            checks.append(
                {
                    "objective": objective.id,
                    "passed": passed,
                    "detail": (
                        f"demo mode simulated {'a correct fix' if passed else 'an incomplete fix'} "
                        f"({objective.text.lower()})"
                    ),
                }
            )
        payload = json.dumps({"checks": checks})
        return CommandResult(True, 0, f"{JSON_BEGIN}\n{payload}\n{JSON_END}")

    # -- BaseDriver surface --------------------------------------------
    def run_powershell(
        self, script: str, host: str = "", instance: str = "", timeout: int = 120
    ) -> CommandResult:
        self.calls.append((instance, script[:200]))
        if "setup.ps1" in script:
            return CommandResult(True, 0, f"demo setup applied\n{SETUP_OK_MARKER}")
        if "check.ps1" in script:
            return self._report(script)
        return CommandResult(True, 0, "ok")

    def wait_ready(self, session, timeout: int | None = None) -> bool:
        return True

    def _write_bytes(
        self,
        data: bytes,
        remote_path: str,
        host: str = "",
        instance: str = "",
        timeout: int = 120,
    ) -> CommandResult:
        self.calls.append((instance, f"upload:{remote_path}:{len(data)}B"))
        return CommandResult(True, 0, "demo upload")


def build_demo_environment(
    settings: Settings | None = None,
    *,
    state_dir: str | Path | None = None,
    success_rate: float | None = None,
    seed: int | None = None,
    students: int | None = None,
) -> DemoEnvironment:
    """Wire a manager that runs entirely in memory."""
    overrides: dict = {"demo": {"enabled": True}}
    if state_dir is not None:
        overrides["paths"] = {"state": str(state_dir)}
    settings = settings or load_settings(overrides=overrides)
    if state_dir is not None:
        settings.paths.state = str(state_dir)
    settings.demo.enabled = True
    if success_rate is not None:
        settings.demo.success_rate = float(success_rate)
    if students is not None:
        settings.demo.students = int(students)
    settings.ensure_dirs()

    if settings.demo.reset_state:
        db = settings.db_path
        if db.exists():
            db.unlink()

    store = Store(settings.db_path)
    catalog = Catalog(settings.catalog_dir)
    repository = ScenarioRepository(settings.scenarios_dir)
    incus = InMemoryIncus(image_alias=settings.incus.image_alias, image_present=True)
    driver = DemoDriver(
        settings,
        repository,
        success_rate=settings.demo.success_rate,
        seed=settings.selection.seed if seed is None else seed,
    )
    manager = SessionManager(
        settings,
        store,
        repo=repository,
        incus=incus,  # type: ignore[arg-type]
        driver=driver,
        catalog=catalog,
    )
    return DemoEnvironment(
        settings=settings,
        store=store,
        catalog=catalog,
        repository=repository,
        incus=incus,
        driver=driver,
        manager=manager,
    )


def seed_accounts(env: DemoEnvironment, *, students: int | None = None) -> list[str]:
    """Create the demo roster. Idempotent: re-running just re-hashes the passwords."""
    count = int(students if students is not None else env.settings.demo.students)
    names = DEMO_STUDENTS[: max(1, min(count, len(DEMO_STUDENTS)))]
    for name in names:
        env.store.upsert_user(name, DEMO_PASSWORD, role="student", display_name=name.title())
    env.store.upsert_user(
        DEMO_INSTRUCTOR, DEMO_PASSWORD, role="instructor", display_name="Instructor"
    )
    return names


def seed_pool(
    env: DemoEnvironment,
    scenario_ids: list[str],
    *,
    per_scenario: int = 2,
    prewarm_ids: list[str] | None = None,
) -> dict[str, int]:
    """Build templates for every scenario, then prewarm only the ones asked for.

    Every template is built because automatic assignment can hand a student *any*
    scenario; only the nominated scenarios get warm VMs, which is what a real lab
    would do to keep host memory under control.
    """
    warm = set(prewarm_ids) if prewarm_ids is not None else set(scenario_ids)
    built: dict[str, int] = {}
    for scenario_id in scenario_ids:
        env.manager.ensure_template(scenario_id)
        built[scenario_id] = (
            env.manager.prewarm(scenario_id, per_scenario) if scenario_id in warm else 0
        )
    return built


def run_demo(
    *,
    scenario_ids: list[str] | None = None,
    students: int | None = None,
    success_rate: float | None = None,
    state_dir: str | Path | None = None,
    complete_sessions: bool = True,
    verbose: bool = True,
) -> dict:
    """Drive a complete class: assign, provision, grade, hand in, tear down.

    Returns a summary dict (so callers — the CLI, the tests, a notebook — do not have
    to scrape stdout).
    """
    env = build_demo_environment(success_rate=success_rate, students=students, state_dir=state_dir)
    repository = env.repository
    chosen = scenario_ids or [s.id for s in repository.list()[:3]]
    if not chosen:
        raise RuntimeError("no scenarios found; nothing to demonstrate")

    names = seed_accounts(env, students=students)

    from . import selection

    summary: dict = {
        "students": [],
        "scenarios": chosen,
        "pool": seed_pool(
            env,
            [s.id for s in repository.list()],
            per_scenario=2,
            prewarm_ids=chosen,
        ),
        "graded": [],
        "completed": [],
    }

    # An explicit scenario list means "use these"; automatic assignment is only for
    # when the caller does not care which ticket a student gets.
    auto_assign = env.settings.selection.auto_assign and not scenario_ids
    history: list[str] = []
    for index, student in enumerate(names):
        if auto_assign:
            choice = selection.choose(
                repository.list(),
                history=history,
                strategy=env.settings.selection.strategy,
                max_difficulty=env.settings.selection.max_difficulty,
                seed=env.settings.selection.seed + index,
            )
            scenario_id = choice.scenario.id
            reason = choice.explain()
        else:
            scenario_id = chosen[index % len(chosen)]
            reason = "rotated from the requested list"
        history.append(scenario_id)

        session = env.manager.allocate(
            student,
            scenario_id,
            time_limit_minutes=env.settings.session.default_time_limit,
        )
        summary["students"].append(
            {
                "student": student,
                "scenario_id": scenario_id,
                "reason": reason,
                "instance": session.instance,
                "state": session.state.value,
                "error": session.error,
                "minutes": session.time_limit_minutes,
            }
        )
        if session.state == SessionState.ERROR:
            continue

        # A student checks their work (not recorded), then hands it in (recorded).
        preview = env.manager.run_checks(session)
        if complete_sessions:
            final = env.manager.complete(session)
            summary["completed"].append(
                {
                    "student": student,
                    "scenario_id": scenario_id,
                    "score": final.score,
                    "resolved": final.resolved,
                    "state": session.state.value,
                }
            )
        summary["graded"].append(
            {
                "student": student,
                "scenario_id": scenario_id,
                "preview_score": preview.score,
                "preview_resolved": preview.resolved,
            }
        )

    summary["stats"] = env.manager.stats()
    summary["results"] = env.store.leaderboard()
    if verbose:
        print(render_demo_summary(summary))
    return summary


def render_demo_summary(summary: dict) -> str:
    lines = ["", "OnTrak demo run", "=" * 60]
    lines.append(f"scenarios: {', '.join(summary['scenarios'])}")
    pool = {k: v for k, v in (summary.get("pool") or {}).items() if v}
    if pool:
        lines.append("warm pool: " + ", ".join(f"{k} x{v}" for k, v in pool.items()))
    lines.append("")
    lines.append(f"{'student':<10} {'scenario':<24} {'instance':<28} state")
    for row in summary["students"]:
        lines.append(
            f"{row['student']:<10} {row['scenario_id']:<24} "
            f"{row['instance'] or '-':<28} {row['state']}"
            + (f"  ERROR: {row['error']}" if row["error"] else "")
        )
    if summary["completed"]:
        lines += ["", f"{'student':<10} {'scenario':<24} {'score':>6}  outcome"]
        for row in summary["completed"]:
            outcome = "passed" if row["resolved"] else "not resolved"
            lines.append(
                f"{row['student']:<10} {row['scenario_id']:<24} {row['score']:>5.0f}%  {outcome}"
            )
    lines += ["", "Only the submitted grade is stored; the preview check was discarded.", ""]
    return "\n".join(lines)
