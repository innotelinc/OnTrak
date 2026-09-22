from __future__ import annotations

import json
import re
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
    assert "never asserts the fault is observable" in joined
    assert "Write-OnTrakReport" in joined
    assert "never reports objective 'missing-check'" in joined


def test_confirming_success_without_asserting_the_fault_is_refused(tmp_path):
    """Confirming and verifying are different promises, and only one is worth anything.

    A setup that injects a fault, does not check it, and then confirms success hands the
    student a ticket with nothing behind it and a grader that passes them for doing
    nothing. That is not hypothetical: it is what every Windows template did while the
    build hard-powered-off a guest that had not flushed, and nothing caught it because
    the scenario files never changed and no script ever looked.
    """
    half = tmp_path / "half"
    half.mkdir()
    (half / "scenario.yaml").write_text(
        """
id: half
title: Half
category: network
briefing: nothing here
objectives:
  - id: the-only-one
    text: reported
    weight: 10
""".strip()
    )
    # Injects nothing, checks nothing, and confirms success anyway.
    (half / "setup.ps1").write_text('Write-OnTrakStep "pretending"\nWrite-OnTrakSetupOk -Note "done"\n')
    (half / "check.ps1").write_text(
        "Add-OnTrakCheck -Objective 'the-only-one' -Passed $true\nWrite-OnTrakReport\n"
    )
    joined = "\n".join(ScenarioRepository(tmp_path).validate())
    assert "never asserts the fault is observable" in joined
    assert "Require-OnTrak" in joined


def test_category_aliases():
    assert normalise_category("Drivers") == Category.HARDWARE.value
    assert normalise_category("Malware") == Category.SECURITY.value
    assert normalise_category("perf") == Category.OS.value
    with pytest.raises(ScenarioError):
        normalise_category("interpretive-dance")


def test_by_category_groups_everything(repo):
    grouped = repo.by_category()
    assert sum(len(v) for v in grouped.values()) == len(repo.list())


def test_the_public_view_never_carries_the_ticket_rubric(repo):
    """The reported bug: the session page printed the form beside the student.

    ``ticket:`` holds both the request's header (who reported it, on what) and
    ``form:`` — the field list with its weights, hints and the terms a competent
    answer must contain (`all_of: [750]`, `min_words: 6`). The page rendered the
    block as a key/value table, so the student saw the answers in the very card
    they were meant to answer from.
    """
    scenario = repo.get("linux-dir-tree-build")
    assert scenario.ticket.get("form"), "the fixture scenario must declare a form"

    public = scenario.public()
    assert public["ticket"], "the header should still reach the page"
    assert set(public["ticket"]) == {"From", "System", "Priority", "Channel", "Reported"}
    assert public["ticket"]["From"] == "Dana Okafor (Platform team)"

    # Structural, not a word search: "form" is a substring of "platform" in the
    # briefing, and `weight` is a legitimate key on an objective. What must never
    # arrive is the rubric itself — the field spec, its terms or its hints.
    assert all(isinstance(v, str) for v in public["ticket"].values())
    rendered = json.dumps(public["ticket"])
    for leak in ("min_words", "all_of", "any_of", "hint", "fields", "title"):
        assert leak not in rendered, f"{leak!r} leaked into the ticket header"
    assert "Change record" not in rendered, "the form's own title leaked"


def test_a_ticket_header_drops_everything_that_is_not_a_label(repo):
    scenario = repo.get("linux-dir-tree-build")
    header = scenario.ticket_header
    assert header["System"] == "build-02 (Ubuntu)"
    assert "Form" not in header
    # A nested structure cannot become a table cell, whatever key it arrives under.
    assert all(isinstance(value, str) for value in header.values())


def test_a_scenario_without_a_ticket_reports_an_empty_header(repo):
    # A scenario written before the ticket system has no block at all, so the
    # header must be empty rather than raise: the session page calls it for every
    # scenario, ticket or not.
    scenario = repo.get("linux-dir-tree-build")
    scenario.ticket = {}
    assert scenario.ticket_header == {}
    assert scenario.public()["ticket"] == {}


# --------------------------------------------------------------------------- #
# what the Windows scripts call, and what the library actually offers
# --------------------------------------------------------------------------- #
# A check script is the grading contract, and it calls the shared PowerShell library
# by name. Nothing checked that the name existed or that it took the switch being
# passed. A mistyped switch is a parameter-binding error at grading time, and the
# objective it belongs to then fails for every student however correct their work is
# — which is exactly how `Test-OnTrakReportField -Pattern` (five calls in the
# phishing scenario's check) silently capped that scenario at half marks: the report
# objectives could never pass.
#
# The scripts only run inside a Windows guest, so this is the one place a mistake in
# them is cheap to find.

_PS_FUNCTION = re.compile(r"^function\s+([A-Za-z][\w-]*)\s*\{", re.M)
_PS_ON_TRAK_NAME = re.compile(r"\b[A-Za-z]+-OnTrak[A-Za-z]+\b")
_PS_CALL = re.compile(r"\b([A-Za-z]+-OnTrak[A-Za-z]+)\b(.*)$")
_PS_SWITCH = re.compile(r"-([A-Za-z][\w]*)")
_PS_STRING = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"")

# PowerShell's own comparison and string operators look exactly like switches, so
# `-eq`, `-and` and friends must never be read as parameters.
_PS_OPERATORS = {
    "and",
    "as",
    "band",
    "bnot",
    "bor",
    "bxor",
    "ceq",
    "cge",
    "cgt",
    "cle",
    "clike",
    "clt",
    "cmatch",
    "cne",
    "cnotcontains",
    "cnotlike",
    "cnotmatch",
    "contains",
    "creplace",
    "csplit",
    "eq",
    "f",
    "ge",
    "gt",
    "icontains",
    "ieq",
    "ige",
    "igt",
    "ile",
    "ilike",
    "ilt",
    "imatch",
    "in",
    "ine",
    "inotcontains",
    "inotlike",
    "inotmatch",
    "ireplace",
    "is",
    "isnot",
    "isplit",
    "join",
    "le",
    "like",
    "lt",
    "match",
    "ne",
    "not",
    "notcontains",
    "notin",
    "notlike",
    "notmatch",
    "or",
    "replace",
    "shl",
    "shr",
    "split",
    "xor",
}


def _power_shell_functions(text: str) -> dict[str, set[str]]:
    """Every ``function Name { ... }`` in the library, and its declared parameters.

    Attributes are stripped before the parameter names are read, because
    ``[Parameter(Mandatory = $true, ParameterSetName = 'Field')]`` is full of
    ``$``-tokens that are not parameters.
    """
    functions: dict[str, set[str]] = {}
    for match in _PS_FUNCTION.finditer(text):
        name = match.group(1)
        tail = text[match.end() :]
        param = re.search(r"\bparam\s*\(", tail)
        params: set[str] = set()
        if param:
            depth = 1
            index = param.end()
            while index < len(tail) and depth:
                if tail[index] == "(":
                    depth += 1
                elif tail[index] == ")":
                    depth -= 1
                index += 1
            block = _PS_STRING.sub("", tail[param.end() : index])
            block = re.sub(r"\[[^\]]*\]", "", block)
            params = {m.group(1) for m in re.finditer(r"\$([A-Za-z_][\w]*)", block)}
        functions[name] = params
    return functions


def _power_shell_library(settings) -> dict[str, set[str]]:
    source = Path(settings.scenarios_dir) / "_lib" / "OnTrak.Common.ps1"
    return _power_shell_functions(source.read_text())


def _switches_after(function: str, rest: str) -> list[tuple[str, str]]:
    """The switches ``function`` is passed, read from the text after its name.

    Only switches at bracket depth zero belong to this call: an operator inside a
    grouping — ``-Passed ((-not $x) -and $y)`` — is not a parameter, and neither
    is a nested helper's switch. A quoted string is skipped whole, and a second
    call on the same line ends this one (``finditer`` will read it on its own).
    """
    found: list[tuple[str, str]] = []
    depth = 0
    index = 0
    while index < len(rest):
        char = rest[index]
        if char in "'\"":
            quote = char
            index += 1
            while index < len(rest):
                if rest[index] == quote:
                    if index + 1 < len(rest) and rest[index + 1] == quote:
                        index += 2
                        continue
                    break
                index += 1
            index += 1
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth <= 0 and char in "|;":
            break
        if depth == 0 and char == "-":
            match = _PS_SWITCH.match(rest[index:])
            if match:
                word = match.group(1)
                if word.lower() not in _PS_OPERATORS:
                    found.append((function, word))
                index += match.end()
                continue
        elif depth == 0 and char.isalpha() and _PS_ON_TRAK_NAME.match(rest[index:]):
            break  # another call's argument list starts here
        index += 1
    return found


def _power_shell_calls(text: str) -> list[tuple[str, str]]:
    """``(function, switch)`` for every switch each call passes.

    Backtick continuations are joined first: the scripts wrap long calls, and a
    switch on the next line is still a switch of that call.
    """
    joined = re.sub(r"`\r?\n\s*", " ", text)
    calls: list[tuple[str, str]] = []
    for line in joined.splitlines():
        for match in _PS_CALL.finditer(line):
            calls.extend(_switches_after(match.group(1), match.group(2)))
    return calls


def _windows_scripts(settings) -> list[Path]:
    root = Path(settings.scenarios_dir)
    return sorted(path for path in root.glob("*/check.ps1")) + sorted(
        path for path in root.glob("*/setup.ps1")
    )


def test_every_powershell_helper_a_scenario_calls_exists(settings):
    declared = _power_shell_library(settings)
    unknown: list[str] = []
    for path in _windows_scripts(settings):
        for name in set(_PS_ON_TRAK_NAME.findall(path.read_text())):
            if name not in declared:
                unknown.append(f"{path.parent.name}/{path.name}: {name}")
    assert not unknown, "scripts call helpers the library does not define:\n  " + "\n  ".join(
        sorted(unknown)
    )


# --------------------------------------------------------------------------- #
# the shell scripts: a variable they read has to be one something sets
# --------------------------------------------------------------------------- #
# The mirror of the check above, for the Linux half. A `$VAR` that nothing assigns
# does not fail loudly in a script like these: inside a pipeline the unbound
# expansion kills only that stage, so the pipeline still reports success and the
# redirect leaves an empty file behind it.
#
# That is not hypothetical either. `linux-sudo-delegation` records the blanket rules
# the image already ships (Ubuntu ships two) so that grading can judge the rules a
# student *added*; the recording line read `$SUDOERS_DIR`, which that script never
# defined. The baseline came out empty, the check fell back to blaming the student
# for the distribution's own sudoers, and the build reported success throughout.

_SHELL_ASSIGN = re.compile(
    r"(?:^|[\s;(])(?:local\s+|export\s+|declare\s+(?:-\w+\s+)?|readonly\s+)?"
    r"([A-Za-z_][A-Za-z0-9_]*)="
)
_SHELL_FOR = re.compile(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b")
_SHELL_EXPAND = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)")
# Set by the shell, by the guest image, or by the harness — nothing in the scripts
# assigns them, and none of them is a scenario's own variable.
_SHELL_AMBIENT = {
    "BASH_SOURCE",
    "BASH_VERSION",
    "DEBIAN_FRONTEND",
    "FUNCNAME",
    "HOME",
    "HOSTNAME",
    "IFS",
    "LANG",
    "LC_ALL",
    "LINENO",
    "PATH",
    "PIPESTATUS",
    "PPID",
    "PWD",
    "RANDOM",
    "SECONDS",
    "SHELL",
    "TMPDIR",
    "USER",
}


_SHELL_COMMENT = re.compile(r"(?m)^\s*#.*$")


def _shell_names(text: str) -> set[str]:
    return set(_SHELL_ASSIGN.findall(_SHELL_COMMENT.sub("", text))) | set(
        _SHELL_FOR.findall(text)
    )


def test_every_variable_a_scenario_shell_script_reads_is_one_something_sets(settings):
    root = Path(settings.scenarios_dir)
    # The shared library is sourced by every script, so what *it* assigns is in scope
    # for all of them.
    shared = _shell_names((root / "_lib" / "ontrak-common.sh").read_text())
    problems: list[str] = []
    for path in sorted(root.glob("*/*.sh")):
        # Comments explain the scripts and name variables freely; they are not code.
        text = _SHELL_COMMENT.sub("", path.read_text())
        known = _shell_names(text) | shared | _SHELL_AMBIENT
        missing = sorted(name for name in set(_SHELL_EXPAND.findall(text)) if name not in known)
        if missing:
            problems.append(f"{path.relative_to(root)}: {', '.join(missing)}")
    assert not problems, (
        "scripts read variables nothing assigns (silent on a pipeline stage):\n  "
        + "\n  ".join(problems)
    )


def test_every_switch_a_scenario_passes_is_one_the_helper_declares(settings):
    # PowerShell parameter names are case-insensitive, so `-HostName` and `-Hostname`
    # are the same parameter and must not be reported as a mismatch.
    declared = {
        name: {param.lower() for param in params}
        for name, params in _power_shell_library(settings).items()
    }
    problems: list[str] = []
    for path in _windows_scripts(settings):
        for function, switch in _power_shell_calls(path.read_text()):
            if function in declared and switch.lower() not in declared[function]:
                problems.append(f"{path.parent.name}/{path.name}: {function} -{switch}")
    assert not problems, (
        "switches the helper does not declare (a binding error at grading time):\n  "
        + "\n  ".join(sorted(set(problems)))
    )
