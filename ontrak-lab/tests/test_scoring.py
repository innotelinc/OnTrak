from __future__ import annotations

import json

import pytest

from ontrak.models import Objective
from ontrak.scenarios import JSON_BEGIN, JSON_END, Scenario
from ontrak.scoring import (
    GradingError,
    collect_checks,
    evaluate,
    extract_payload,
    feedback_text,
    render_feedback,
)


def make_scenario(tmp_path, pass_score: float = 80.0) -> Scenario:
    return Scenario(
        id="unit-scenario",
        title="Unit scenario",
        category="network",
        briefing="Something is broken.",
        directory=tmp_path,
        pass_score=pass_score,
        objectives=[
            Objective(
                id="must-fix", text="The critical thing", weight=50, critical=True, hint="check the route"
            ),
            Objective(id="nice-to-have", text="The secondary thing", weight=30, hint="check the service"),
            Objective(id="write-it-up", text="Notes", weight=20),
        ],
        hints=["first hint"],
    )


def guest_output(checks: list[dict], noise: str = "[noise] banner text\n") -> str:
    return f"{noise}{JSON_BEGIN}\n{json.dumps({'checks': checks})}\n{JSON_END}\nnoise after\n"


def test_all_objectives_pass_scores_100_and_resolves(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output(
        [
            {"objective": "must-fix", "passed": True, "detail": "gateway answers"},
            {"objective": "nice-to-have", "passed": True},
            {"objective": "write-it-up", "passed": True},
        ]
    )
    report = evaluate(scenario, session_id=7, guest_output=output)
    assert report.score == 100.0
    assert report.resolved is True
    assert report.passed_count == 3
    assert report.session_id == 7


def test_partial_credit_is_weighted(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output(
        [
            {"objective": "must-fix", "passed": True},
            {"objective": "nice-to-have", "passed": False, "detail": "still broken"},
            {"objective": "write-it-up", "passed": True},
        ]
    )
    report = evaluate(scenario, 1, output)
    assert report.score == 70.0  # 50 + 20 of 100
    assert report.resolved is False  # below the pass mark of 80
    assert [o.objective_id for o in report.failed] == ["nice-to-have"]


def test_missing_objective_counts_as_failed_and_unreported(tmp_path):
    scenario = make_scenario(tmp_path)
    report = evaluate(scenario, 1, guest_output([{"objective": "must-fix", "passed": True}]))
    unreported = [o for o in report.outcomes if not o.reported]
    assert {o.objective_id for o in unreported} == {"nice-to-have", "write-it-up"}
    assert all(not o.passed for o in unreported)
    assert report.score == 50.0


def test_critical_failure_blocks_resolution_even_with_a_high_score(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output(
        [
            {"objective": "must-fix", "passed": False, "detail": "no route"},
            {"objective": "nice-to-have", "passed": True},
            {"objective": "write-it-up", "passed": True},
        ]
    )
    report = evaluate(scenario, 1, output)
    assert report.score == 50.0
    assert report.resolved is False


def test_pass_mark_is_per_scenario(tmp_path):
    scenario = make_scenario(tmp_path, pass_score=50.0)
    output = guest_output(
        [
            {"objective": "must-fix", "passed": True},
            {"objective": "nice-to-have", "passed": False},
            {"objective": "write-it-up", "passed": False},
        ]
    )
    report = evaluate(scenario, 1, output)
    assert report.score == 50.0
    assert report.resolved is True


def test_missing_payload_is_an_error_not_a_pass(tmp_path):
    scenario = make_scenario(tmp_path)
    report = evaluate(scenario, 1, "the script crashed before reporting\n")
    assert report.error
    assert report.score == 0.0
    assert report.resolved is False
    assert all(not o.passed and not o.reported for o in report.outcomes)


def test_malformed_json_is_an_error(tmp_path):
    scenario = make_scenario(tmp_path)
    report = evaluate(scenario, 1, f"{JSON_BEGIN}\n{{not json\n{JSON_END}")
    assert "not valid JSON" in report.error


def test_extract_payload_rejects_rubbish():
    with pytest.raises(GradingError):
        extract_payload("nothing to see")


def test_shorthand_dict_payload(tmp_path):
    scenario = make_scenario(tmp_path)
    payload = {"checks": {"must-fix": True, "nice-to-have": True, "write-it-up": False}}
    report = evaluate(scenario, 1, f"{JSON_BEGIN}{json.dumps(payload)}{JSON_END}")
    assert report.score == 80.0
    assert report.resolved is True  # critical passed and score met the mark


def test_a_flapping_probe_cannot_fake_a_pass():
    outcomes = collect_checks(
        {
            "checks": [
                {"objective": "tcp", "passed": True},
                {"objective": "tcp", "passed": False, "detail": "second probe failed"},
            ]
        }
    )
    assert outcomes["tcp"].passed is False
    assert outcomes["tcp"].detail == "second probe failed"


def test_unknown_objective_ids_are_surfaced_as_notes(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output([{"objective": "renamed-id", "passed": True}])
    report = evaluate(scenario, 1, output)
    assert report.notes and "renamed-id" in report.notes[0]
    assert report.score == 0.0


def test_boolean_coercion_accepts_common_shapes(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output(
        [
            {"objective": "must-fix", "ok": "yes"},
            {"objective": "nice-to-have", "success": 1},
            {"objective": "write-it-up", "pass": "PASSED"},
        ]
    )
    report = evaluate(scenario, 1, output)
    assert report.score == 100.0


def test_feedback_rows_and_text(tmp_path):
    scenario = make_scenario(tmp_path)
    output = guest_output(
        [
            {"objective": "must-fix", "passed": True, "detail": "ok"},
            {"objective": "nice-to-have", "passed": False, "detail": "still broken"},
            {"objective": "write-it-up", "passed": False},
        ]
    )
    report = evaluate(scenario, 1, output)
    rows = {r["objective_id"]: r for r in render_feedback(scenario, report)}
    assert rows["must-fix"]["passed"] is True
    assert rows["nice-to-have"]["hint"]  # failed objectives expose their hint
    assert rows["must-fix"]["hint"] == ""
    text = feedback_text(scenario, report)
    assert "Score:" in text and "not yet resolved" in text and "still broken" in text


def test_report_round_trips_through_json(tmp_path):
    from ontrak.models import ScoreReport

    scenario = make_scenario(tmp_path)
    report = evaluate(scenario, 3, guest_output([{"objective": "must-fix", "passed": True}]))
    restored = ScoreReport.from_dict(json.loads(json.dumps(report.to_dict())))
    assert restored.score == report.score
    assert restored.to_dict() == report.to_dict()
