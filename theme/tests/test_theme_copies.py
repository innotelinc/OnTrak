#!/usr/bin/env python3
"""Every product ships the same theme, and this is what proves it.

The family's rule is one palette: `theme/ontrak-theme.{css,js}` is the canonical
copy and each app carries a byte-identical one, because every app is built from its
own directory and cannot import a file outside its build context.

A rule like that rots quietly — somebody adds `--brand-alt` to one app's copy, it
looks right in that app, and six weeks later two products disagree about what
"attention" looks like. So the rule is a test rather than a sentence in a README.

Run:  python3 theme/tests/test_theme_copies.py
"""

from __future__ import annotations

import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CANONICAL = ROOT / "theme"
NAMES = ("ontrak-theme.css", "ontrak-theme.js")

# Where a product keeps its copy, relative to the repository root. An app that has
# not been converted yet is simply absent from this list, which is why the test
# passes on a partially-rolled-out family and fails the moment a converted app's
# copy drifts.
APPS = (
    "ontrak-portal/src/theme",
    "ontrak-tix/src/theme",
    "ontrak-sentinel/src/theme",
    "ontrak-sync/web/app/theme",
    "src/theme",  # the training range at the repository root
)


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main() -> int:
    failures: list[str] = []
    canonical = {}
    for name in NAMES:
        source = CANONICAL / name
        if not source.is_file():
            failures.append(f"the canonical copy is missing: theme/{name}")
            continue
        canonical[name] = digest(source)

    checked = 0
    for app in APPS:
        folder = ROOT / app
        if not folder.is_dir():
            continue
        for name in NAMES:
            copy = folder / name
            if not copy.is_file():
                failures.append(f"{app}/{name} is missing (the app has a theme folder)")
                continue
            checked += 1
            if digest(copy) != canonical[name]:
                failures.append(
                    f"{app}/{name} has drifted from theme/{name} "
                    f"({digest(copy)} != {canonical[name]}) — copy the canonical file over it"
                )

    if failures:
        print("theme copies are not identical:")
        for line in failures:
            print(f"  ✗ {line}")
        print("\nfix: cp theme/ontrak-theme.css theme/ontrak-theme.js <app>/<folder>/")
        return 1

    print(f"theme: {checked} file(s) verified identical to the canonical copy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
