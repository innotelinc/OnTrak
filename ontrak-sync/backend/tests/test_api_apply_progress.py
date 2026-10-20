#!/usr/bin/env python3
"""The live package progress the dashboard asks for while an apply runs.

The apply is one synchronous POST, so the page asks a second question while the
first is unanswered. This proves that answer is the database's: a package it
reports as applied is applied, one the applier has not settled yet reads as
applying, and an idle deployment reports nothing rather than a shape that looks
like work.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

try:
    import fastapi  # noqa: F401  (imported for its absence, which is a skip)
except ImportError as exc:  # pragma: no cover — the stdlib-only runner has no FastAPI
    raise unittest.SkipTest(
        f"fastapi is not installed; this drives the HTTP layer — skipping ({exc})"
    )

from ontrak import api  # noqa: E402
from test_api_approve import ApproveApiCase, call  # noqa: E402


class ApplyProgressCase(ApproveApiCase):
    """The route, over the same real app and faked Network as the approve tests."""

    def progress(self, token: str | None = None):
        # Resolved here rather than as a default argument: the token is the parent
        # case's attribute, and a class body cannot see it.
        return call(self.app, "GET", "/api/apply/progress",
                    token=self.TOKEN if token is None else token)

    def running(self, ids: list[int], packages: list[tuple[str, str]]) -> dict:
        """The position the applier publishes for one target, built from real rows."""
        return {
            "phase": "running",
            "run_id": 7,
            "total": len(ids),
            "ids": ids,
            "host": "i1",
            "target": "monarch",
            "started_at": "2026-10-19T00:00:00+00:00",
            "updated_at": "2026-10-19T00:00:01+00:00",
            "current": [{"id": finding_id, "package": package, "manager": manager}
                        for finding_id, (package, manager) in zip(ids, packages)],
        }

    def test_an_idle_deployment_reports_nothing(self):
        # No apply running is the ordinary answer, and it must not read as an apply
        # that is somehow at zero.
        self.assertEqual({"progress": None}, self.progress().json())

    def test_the_request_needs_a_credential(self):
        self.assertEqual(401, self.progress(token="").status)

    def test_a_running_apply_reports_its_target_and_each_package(self):
        nginx_id = self.finding("nginx", status="approved")
        openssl_id = self.finding("openssl", status="approved")
        self.approve({"ids": [nginx_id, openssl_id], "apply": True})  # settles both

        state = self.running([nginx_id, openssl_id],
                             [("nginx", "apt"), ("openssl", "apt")])
        with mock.patch.object(api, "read_progress", return_value=state):
            payload = self.progress().json()["progress"]

        self.assertEqual("i1", payload["host"])
        self.assertEqual("monarch", payload["target"])
        self.assertEqual(2, payload["total"])
        self.assertEqual(2, payload["done"])
        self.assertEqual(0, payload["failed"])
        self.assertEqual(["nginx", "openssl"], [item["package"] for item in payload["packages"]])
        # The states are the findings' own, not a guess from the clock.
        self.assertEqual({"applied"}, {item["state"] for item in payload["packages"]})

    def test_a_package_still_in_flight_reads_as_applying(self):
        done_id = self.finding("nginx", status="approved")
        self.approve({"ids": [done_id], "apply": True})
        waiting_id = self.finding("openssl", status="approved")

        state = self.running([done_id, waiting_id],
                             [("nginx", "apt"), ("openssl", "apt")])
        with mock.patch.object(api, "read_progress", return_value=state):
            payload = self.progress().json()["progress"]

        states = {item["package"]: item["state"] for item in payload["packages"]}
        self.assertEqual({"nginx": "applied", "openssl": "applying"}, states)
        self.assertEqual(1, payload["done"])

    def test_a_finished_run_is_not_reported_as_running(self):
        state = {"phase": "finished", "run_id": 7, "total": 1, "ids": [], "current": []}
        with mock.patch.object(api, "read_progress", return_value=state):
            self.assertEqual({"progress": None}, self.progress().json())


if __name__ == "__main__":
    unittest.main()
