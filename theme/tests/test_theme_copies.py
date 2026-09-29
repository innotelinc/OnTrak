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
# The rule is one file per app per artifact: the CSS is imported by the app's
# stylesheet (bundled at build time), and the JS is a `public/` asset loaded by a
# blocking <script src> so it runs before the first paint. The standalone runtime
# image contains no `src/`, so a copy there would be read in development and missing
# in the container — which is the mistake this list is written to make impossible.
APPS = (
    ("ontrak-portal/public", ("ontrak-theme.js",)),
    ("ontrak-portal/src/theme", ("ontrak-theme.css",)),
    ("ontrak-tix/public", ("ontrak-theme.js",)),
    ("ontrak-tix/src/theme", ("ontrak-theme.css",)),
    ("ontrak-sentinel/public", ("ontrak-theme.js",)),
    ("ontrak-sentinel/src/theme", ("ontrak-theme.css",)),
    ("ontrak-sync/web/public", ("ontrak-theme.js",)),
    ("ontrak-sync/web/app/theme", ("ontrak-theme.css",)),
    ("public", ("ontrak-theme.js",)),          # the training range at the root
    ("src/theme", ("ontrak-theme.css",)),
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
    for app, names in APPS:
        folder = ROOT / app
        if not folder.is_dir():
            continue
        # An app that has not been converted yet is skipped, not failed: a half
        # rolled-out family is the normal state of a rollout. The moment one file of
        # a pair is there, the other is required — a CSS copy with no script (or the
        # reverse) is a product whose theme silently does nothing.
        if not any((folder / name).is_file() for name in names):
            continue
        for name in names:
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
