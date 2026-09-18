"""Grading: turn guest output into a score report.

The guest contract is intentionally tiny. ``check.ps1`` prints one JSON object
between two markers::

    ###ONTRAK-JSON-BEGIN###
    {"checks":[{"objective":"restore-dns","passed":false,"detail":"still 10.20.0.99"}]}
    ###ONTRAK-JSON-END###

Anything else on stdout (banners, warnings, native command noise) is ignored.
Objectives the script does not report are recorded as *unreported* and count as
failures, which is the safe default: a check that crashed must not look like a
pass. :mod:`ontrak.scenarios` validation exists to keep that from happening by
accident.
"""

from __future__ import annotations

import json
import re

from .models import CheckOutcome, ScoreReport, iso
from .scenarios import JSON_BEGIN, JSON_END, Scenario

_MARKER_RE = re.compile(
    re.escape(JSON_BEGIN) + r"(.*?)" + re.escape(JSON_END), re.DOTALL
)
_OBJECTIVE_KEYS = ("objective", "objective_id", "id", "check", "name")
_PASSED_KEYS = ("passed", "pass", "ok", "success")
_DETAIL_KEYS = ("detail", "message", "evidence", "note")


class GradingError(RuntimeError):
    """Raised when the guest output cannot be interpreted at all."""


def extract_payload(text: str) -> dict:
    """Pull the JSON payload out of raw guest output."""
    matches = _MARKER_RE.findall(text or "")
    if not matches:
        raise GradingError(
            "no grading payload found between the OnTrak markers; check.ps1 must call "
            "Write-OnTrakReport"
        )
    raw = matches[-1].strip()  # last payload wins (in case of a retry loop)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GradingError(f"grading payload is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise GradingError("grading payload must be a JSON object with a 'checks' list")
    return data


def _first(item: dict, keys: tuple[str, ...], default=None):
    for key in keys:
        if key in item and item[key] is not None:
            return item[key]
    return default


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"true", "yes", "1", "pass", "passed", "ok"}


def collect_checks(payload: dict) -> dict[str, CheckOutcome]:
    """Return ``{objective_id: outcome}``, last failure winning on duplicates."""
    items = payload.get("checks")
    if items is None:
        items = payload.get("results") or payload.get("objectives") or []
    if isinstance(items, dict):  # tolerate {"objective": bool} shorthand
        items = [{"objective": k, "passed": v} for k, v in items.items()]
    outcomes: dict[str, CheckOutcome] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        objective_id = str(_first(item, _OBJECTIVE_KEYS, "") or "").strip()
        if not objective_id:
            continue
        outcome = CheckOutcome(
            objective_id=objective_id,
            passed=_as_bool(_first(item, _PASSED_KEYS, False)),
            detail=str(_first(item, _DETAIL_KEYS, "") or ""),
        )
        if objective_id in outcomes:
            # Same objective reported twice (e.g. an early-exit retry): the
            # failure wins, so a flapping probe cannot fake a pass.
            if not outcome.passed:
                outcomes[objective_id] = outcome
            continue
        outcomes[objective_id] = outcome
    return outcomes


def evaluate(scenario: Scenario, session_id: int, guest_output: str) -> ScoreReport:
    """Grade ``guest_output`` against ``scenario``."""
    report = ScoreReport(session_id=session_id, scenario_id=scenario.id, created_at=iso())
    if not scenario.objectives:
        report.error = f"scenario {scenario.id} declares no objectives"
        return report

    try:
        payload = extract_payload(guest_output)
    except GradingError as exc:
        report.error = str(exc)
        report.resolved = False
        report.score = 0.0
        report.outcomes = [
            CheckOutcome(
                objective_id=o.id,
                passed=False,
                detail="grading could not run",
                weight=o.weight,
                critical=o.critical,
                reported=False,
            )
            for o in scenario.objectives
        ]
        return report

    reported = collect_checks(payload)
    known_ids = {o.id for o in scenario.objectives}
    for objective in scenario.objectives:
        outcome = reported.get(objective.id)
        if outcome is None:
            report.outcomes.append(
                CheckOutcome(
                    objective_id=objective.id,
                    passed=False,
                    detail="check did not report this objective",
                    weight=objective.weight,
                    critical=objective.critical,
                    reported=False,
                )
            )
        else:
            outcome.weight = objective.weight
            outcome.critical = objective.critical
            report.outcomes.append(outcome)

    unmapped = sorted(set(reported) - known_ids)
    if unmapped:
        # Not fatal: a scenario may add extra telemetry. Surfaced as a note so it
        # is visible while authoring instead of being silently dropped.
        report.notes.append(
            "check.ps1 reported unknown objective id(s): " + ", ".join(unmapped)
        )

    total = scenario.total_weight or 1.0
    earned = sum(o.weight for o in report.outcomes if o.passed)
    report.score = round(100.0 * earned / total, 1)
    critical_failed = [o for o in report.outcomes if o.critical and not o.passed]
    report.resolved = not critical_failed and report.score >= scenario.pass_score
    return report


def render_feedback(scenario: Scenario, report: ScoreReport, *, show_hints: bool = True) -> list[dict]:
    """Per-objective feedback rows for the portal and CLI."""
    rows = []
    for outcome in report.outcomes:
        objective = scenario.objective(outcome.objective_id)
        rows.append(
            {
                "objective_id": outcome.objective_id,
                "text": objective.text if objective else outcome.objective_id,
                "passed": outcome.passed,
                "critical": outcome.critical,
                "weight": outcome.weight,
                "detail": outcome.detail,
                "reported": outcome.reported,
                "hint": (objective.hint if objective and show_hints and not outcome.passed else ""),
            }
        )
    return rows


def feedback_text(scenario: Scenario, report: ScoreReport) -> str:
    """Plain-text report used by the CLI and by e-mail/CSV exports."""
    lines = [
        f"Scenario: {scenario.title} ({scenario.id})",
        f"Score:    {report.score:.1f}%  "
        f"({'RESOLVED' if report.resolved else 'not yet resolved'}; pass mark "
        f"{scenario.pass_score:.0f}%, critical objectives must all pass)",
    ]
    if report.error:
        lines.append(f"Error:    {report.error}")
    lines.append("")
    for row in render_feedback(scenario, report, show_hints=False):
        mark = "PASS" if row["passed"] else "FAIL"
        flag = " [critical]" if row["critical"] else ""
        lines.append(f"  [{mark}] {row['text']}{flag} ({row['weight']:.0f} pts)")
        if row["detail"]:
            lines.append(f"         {row['detail']}")
    return "\n".join(lines)
