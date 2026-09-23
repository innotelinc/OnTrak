"""The CI workflows, held to the claims they make.

A workflow is code that nobody runs until it matters, and it fails silently in both
directions. ``ci.yml`` can stop gating a push without any test noticing, and the
nightly range walk can stop walking the range while reporting green — the test it
runs skips itself whenever there is no hypervisor, and a skipped pytest is a green
pytest. Both are one-line edits away, so the properties that make each workflow worth
having are pinned here.

PyYAML is a runtime dependency of the control plane, so parsing here costs nothing.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

NIGHTLY = "range-nightly.yml"
CI = "ci.yml"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _triggers(workflow: dict) -> dict:
    """The ``on:`` block, whatever YAML made of the key.

    PyYAML resolves the bare scalar ``on`` as the boolean ``True`` under YAML 1.1, so
    a workflow's triggers arrive under ``True`` rather than ``"on"``. Reading either is
    what keeps this test about the workflow and not about the parser's dialect.
    """
    return workflow.get("on") or workflow.get(True) or {}


def _scripts(workflow: dict) -> list[str]:
    """Every shell line a step runs, plus the environment it runs under.

    The environment is included on purpose: ``ONTRAK_E2E`` is how the walk is switched
    on, and it is set as a step's ``env:`` rather than inside the script — a check that
    read only ``run:`` would miss the one line that makes the job do anything.
    """
    lines = []
    for job in (workflow.get("jobs") or {}).values():
        for step in job.get("steps") or []:
            if step.get("run"):
                lines.append(step["run"])
            for key, value in (step.get("env") or {}).items():
                lines.append(f"{key}={value}")
    return lines


# --------------------------------------------------------------------------- #
# the nightly range walk
# --------------------------------------------------------------------------- #
def test_the_walk_is_scheduled_and_can_be_asked_for_by_hand():
    workflow = _load(NIGHTLY)
    triggers = _triggers(workflow)
    schedule = triggers.get("schedule") if isinstance(triggers, dict) else None
    assert schedule, "the range walk is not scheduled — nothing walks the range"
    assert any(entry.get("cron") for entry in schedule), "the schedule has no cron"
    assert "workflow_dispatch" in triggers, "the walk cannot be run on demand"


def test_the_walk_only_runs_where_incus_really_is():
    """The label is the gate: a GitHub-hosted runner has no hypervisor, and the walk
    would skip itself there and report success."""
    job = _load(NIGHTLY)["jobs"]["range-walk"]
    labels = job["runs-on"]
    assert "self-hosted" in labels, labels
    assert "incus" in labels, labels


def test_the_walk_turns_on_the_flag_its_test_is_gated_on():
    workflow = _load(NIGHTLY)
    text = "\n".join(_scripts(workflow))
    assert "ONTRAK_E2E" in text, "the walk never sets the flag the test skips without"
    assert "tests/test_range_end_to_end.py" in text, "the walk does not run the walk"


def test_a_skipped_walk_is_an_error_rather_than_a_pass():
    """The whole reason the workflow exists instead of a cron line.

    `test_range_end_to_end.py` skips itself without a hypervisor, a template or a
    startable scenario. Every one of those is a real answer, and every one of them
    would otherwise be reported as a green nightly that tested nothing.
    """
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "skipped" in text, "nothing reads the skip count"
    assert "::error::" in text, "a skipped walk does not report anything"


def test_the_nightly_opens_every_linux_console():
    """The walk is blind to the console: gateway, webapp and guacd can all be down while
    every assertion it makes passes, and the student sees a blank iframe."""
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "console verify --linux" in text, "the nightly never opens a console"
    assert "--workloads" in text, (
        "the sweep opens one platform per scenario, so a scenario offered on two images "
        "has half its consoles unchecked"
    )
    assert "--base-url" in text, "the sweep is given no address to open a tunnel on"


def test_the_nightly_opens_the_console_in_a_real_browser():
    """The wire sweep is not the student's page: it never loads the session page, never
    runs the bootstrap that clears Guacamole's stored token, and never sends a keystroke."""
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "console browser" in text, "the nightly never opens the student's page in a browser"
    assert "playwright install" in text, "the browser check is asked to run with no engine installed"
    assert "--browser-password" in text, "the browser check would drive the page as nobody"
    # No credentials, no browser check — and a step that found neither must fail rather
    # than skip itself, which is the silent pass this whole workflow exists to prevent.
    assert "ONTRAK_BROWSER_PASSWORD" in text and "ONTRAK_PORTAL__ADMIN_PASSWORD" in text


def test_the_nightly_opens_a_windows_console_too():
    """A terminal and a desktop are two consoles, and both are a student's page.

    The wire sweep is Linux-only by design — a Linux guest is the one with an SSH console —
    so without this the page a Windows student sits in front of is opened by nothing
    automated here: a desktop whose canvas paints and never takes a keystroke, or a frame
    that never loads for an RDP connection, would pass every other step in the job.
    """
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "ONTRAK_BROWSER_WINDOWS_SCENARIO" in text, "the nightly opens no Windows console"
    assert "sw-app-crash" in text, "the Windows console the check opens has no default"
    assert "linux-user-lifecycle" in text, "the Linux console the check opens has no default"
    # Both go to one run, as two machines one at a time — and the only way to leave the
    # Windows half out is an env var that says so in the log, because a scenario that
    # quietly dropped out of the run is the silent pass this job exists to prevent.
    assert "${scenarios[@]}" in text, "the two consoles are not opened by the same check"
    assert "=off" in text and "::notice::" in text, (
        "a range without Windows media has no visible way to leave the Windows half out"
    )


def test_the_console_sweep_cannot_pass_without_opening_anything():
    """`0 of 14 console(s) opened, 14 skipped` exits 0.

    A range whose Linux templates predate `guac.linux_ssh`, or one whose catalogue has no
    Linux scenario, produces exactly that — and it reads as a green nightly that opened
    nothing, which is the same lie the walk's own skip check is here to catch.
    """
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "console(s) opened" in text, "nothing reads the sweep's summary line"
    assert "Linux consoles opened" in text, "a sweep that opened fewer than it asked for would pass"


def test_the_walk_never_deletes_machines():
    """It runs against a range a class may be using, and a session's instance name
    cannot be told apart from a student's by name alone."""
    text = "\n".join(_scripts(_load(NIGHTLY)))
    assert "incus delete" not in text, "the nightly deletes instances"
    assert "--force" not in text, "the nightly force-removes something"


# --------------------------------------------------------------------------- #
# ci.yml, unchanged in intent and now checked
# --------------------------------------------------------------------------- #
def test_ci_still_gates_pushes_and_pull_requests():
    triggers = _triggers(_load(CI))
    assert isinstance(triggers, dict), triggers
    assert "push" in triggers, "ci.yml no longer runs on push"
    assert "pull_request" in triggers, "ci.yml no longer runs on pull requests"


def test_ci_still_runs_the_control_plane_checks():
    text = "\n".join(_scripts(_load(CI)))
    for command in ("ruff check", "pytest -q"):
        assert command in text, f"ci.yml no longer runs {command!r}"
