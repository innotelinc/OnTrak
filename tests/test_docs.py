"""The status docs, held to the one claim in them that is mechanically checkable.

`docs/roadmap.md` and the README's Status section both say how big the suite is, and
both have been wrong at the same time: the roadmap said 280 tests while the README said
481, and the suite was neither. A number in prose is run by nothing, so it drifts in
silence — and a reader with two disagreeing numbers cannot tell which one is stale,
which is worse than either being stale alone.

So the count is checked against pytest itself, and the two documents have to agree with
the collector. Adding a test is therefore a two-line doc edit; that is the cost of the
number being true, and it is cheaper than a status page nobody can trust.

Everything else in those documents — what is proven, what needs a lab host, what is out
of scope — is prose and is reviewed by hand. A test that greps a sentence for its wording
fails on the next rewrite and teaches nothing, so it is deliberately not attempted here.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The two documents that state the size of the suite.
CLAIMS = ("README.md", "docs/roadmap.md")

# `493 tests`, `481 tests`. Deliberately narrow: it matches the number a status line
# states and not, say, a count of scenarios or a test's own fixture data.
STATED = re.compile(r"(\d+)\s+tests\b")


def _collected() -> int:
    """How many tests pytest collects, asked of pytest rather than guessed at.

    Collection only, in a subprocess. Counting the test functions by parsing this tree
    would be wrong the moment one of them is parametrized, and running the suite from
    inside itself would recurse; `--collect-only` imports the modules and boots nothing.

    The repository's own tooling suite (`scripts/tests`, run by `unittest discover` in
    CI) is not part of this count and is not part of the documents' claim.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-p", "no:cacheprovider"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    match = re.search(r"(\d+)\s+tests? collected", proc.stdout)
    if not match:
        raise AssertionError(
            "pytest would not say how many tests it collects, so the status docs cannot "
            f"be checked against it:\n{proc.stdout}\n{proc.stderr}"
        )
    return int(match.group(1))


def test_the_stated_test_count_is_the_one_pytest_collects():
    collected = _collected()
    problems = []
    for name in CLAIMS:
        text = (REPO_ROOT / name).read_text(encoding="utf-8")
        found = STATED.findall(text)
        if not found:
            problems.append(f"{name} states no test count; the status line is the claim")
            continue
        if len(found) > 1:
            problems.append(f"{name} states more than one test count: {found}")
        for stated in found:
            if int(stated) != collected:
                problems.append(f"{name} says {stated} tests; pytest collects {collected}")

    assert not problems, (
        "the status docs disagree with the suite — update the count in "
        + " and ".join(CLAIMS)
        + ":\n  "
        + "\n  ".join(problems)
    )
