#!/usr/bin/env python3
"""The approve button, driven through the real HTTP application.

`test_applier.py` proves the *decision* to install is made correctly. This proves
the thing an operator actually presses does what the button says: that
`POST /api/findings/approve {"apply": true}` records the approval, runs the apply
through the same lock and the same code path as `/api/apply`, and reports both —
in one request, with nothing left waiting for a second button.

It is deliberately NOT a mock of the route. The app is built by `create_app()`
and called as an ASGI application: FastAPI does the routing, Pydantic parses the
body, the bearer token is authenticated, the capability is checked, and the real
`approve_and_apply` runs. Only the two modules that touch the Network are faked,
because a test cannot apt-get a package.

WHY THIS SKIPS WITHOUT FASTAPI. The Network's suite is stdlib-only on purpose
(see README → Tests and `.github/workflows/ci.yml`), and `ontrak.api` imports
FastAPI. The module therefore skips when FastAPI is absent rather than failing,
and it is exercised where FastAPI *is* installed — the backend image, whose
`Dockerfile` runs `python tests/run-all.py` and refuses to build if this fails.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

try:
    import fastapi  # noqa: F401  (imported for its absence, which is a skip)
except ImportError as exc:  # pragma: no cover — the CI runner has no FastAPI
    raise unittest.SkipTest(
        "fastapi is not installed; this drives the HTTP layer, which only the "
        f"backend image has (see requirements.txt) — skipping ({exc})"
    )

from ontrak import api, applier, db, identity  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from test_applier import FakeRemote  # noqa: E402


class _Response:
    """The bits of an HTTP response this test reads."""

    __slots__ = ("status", "headers", "body")

    def __init__(self):
        self.status = 0
        self.headers: list[tuple[bytes, bytes]] = []
        self.body = b""

    def json(self):
        return json.loads(self.body.decode("utf-8") or "null")


def call(app, method: str, path: str, *, body=None, token: str | None = None) -> _Response:
    """Drive the ASGI app once, in-process, and collect what it sent back.

    A hand-rolled ASGI client rather than `fastapi.testclient.TestClient`, which
    needs `httpx` — a test-only dependency this project does not carry, and adding
    one to run a test would defeat the point of the suite being runnable anywhere
    the service runs.
    """
    raw = b"" if body is None else json.dumps(body).encode("utf-8")
    headers = []
    if body is not None:
        headers.append((b"content-type", b"application/json"))
    if token:
        headers.append((b"authorization", f"Bearer {token}".encode("utf-8")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 40000),
        "server": ("testserver", 80),
    }
    response = _Response()
    state = {"delivered": False}

    async def receive():
        # One request, then disconnect. FastAPI reads the body once and never asks
        # for a second chunk, so this is the whole exchange.
        if not state["delivered"]:
            state["delivered"] = True
            return {"type": "http.request", "body": raw, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            response.status = message["status"]
            response.headers = list(message.get("headers", []))
        elif message["type"] == "http.response.body":
            response.body += message.get("body", b"")

    asyncio.run(app(scope, receive, send))
    return response


class ApproveApiCase(unittest.TestCase):
    """A real app over a throwaway database, with only the Network faked."""

    TOKEN = "an-integration-token"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            hosts=(Host("i1", "192.168.1.51", "both"),),
            db_path=Path(self.tmp.name) / "ontrak.sqlite3",
            api_token=self.TOKEN,
            scheduler_enabled=False,          # no timer thread in a unit test
            admin_password="a-long-enough-one",
        )
        self.app = api.create_app(self.settings)
        self.conn = self.app.state.conn

        self.fake = FakeRemote()
        patcher = mock.patch.multiple(
            applier,
            ssh=self.fake.ssh,
            incus_exec=self.fake.incus_exec,
            docker_in_container=self.fake.docker_in_container,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def finding(self, package: str = "nginx", status: str = "pending") -> int:
        target_id = db.ensure_target(self.conn, host="i1", kind="container", name="monarch")
        db.record_finding(self.conn, target_id=target_id, manager="apt", package=package,
                          current="1.0", candidate="1.1")
        row = self.conn.execute(
            "SELECT id FROM findings WHERE manager='apt' AND package=?", (package,)
        ).fetchone()
        db.set_status(self.conn, [row["id"]], status)
        self.conn.commit()
        return row["id"]

    def status_of(self, package: str = "nginx"):
        return self.conn.execute(
            "SELECT status, detail FROM findings WHERE package=?", (package,)
        ).fetchone()

    def approve(self, body: dict, token: str | None = TOKEN):
        return call(self.app, "POST", "/api/findings/approve", body=body, token=token)


class ApproveThroughTheApi(ApproveApiCase):
    def test_the_request_needs_a_credential(self):
        # `/api/findings/approve` installs packages; it is not one of the open
        # routes, and an anonymous POST must be refused before anything runs.
        finding = self.finding()
        response = self.approve({"ids": [finding], "apply": True}, token=None)
        self.assertEqual(401, response.status)
        self.assertEqual([], self.fake.calls)

    def test_the_token_path_approves_and_installs_in_one_call(self):
        finding = self.finding()
        response = self.approve({"ids": [finding], "apply": True})
        self.assertEqual(200, response.status, response.body)
        payload = response.json()
        # The response is both: 1 approved, and the apply outcome merged in.
        self.assertEqual(1, payload["approved"])
        self.assertEqual(1, payload["applied"])
        self.assertEqual(0, payload["failed"])
        self.assertIsNotNone(payload["run_id"])
        self.assertEqual("applied", self.status_of()["status"])
        # And the install actually ran, rather than a status being written.
        self.assertTrue(any(entry[0] == "apt-install" for entry in self.fake.calls))

    def test_approve_without_apply_only_records_the_decision(self):
        # The bare API still means "record it" — the one-click behaviour is opt-in
        # per request, which is what keeps a scripted approve from installing.
        finding = self.finding()
        response = self.approve({"ids": [finding]})
        self.assertEqual(200, response.status)
        self.assertEqual({"approved": 1}, response.json())
        self.assertEqual("approved", self.status_of()["status"])
        self.assertEqual([], self.fake.calls)

    def test_all_pending_approves_and_installs_each_finding(self):
        self.finding(package="nginx")
        self.finding(package="curl")
        response = self.approve({"all_pending": True, "apply": True})
        self.assertEqual(200, response.status)
        payload = response.json()
        self.assertEqual(2, payload["approved"])
        self.assertEqual(2, payload["applied"])
        self.assertEqual("applied", self.status_of("nginx")["status"])
        self.assertEqual("applied", self.status_of("curl")["status"])

    def test_approving_an_already_applied_finding_reruns_it(self):
        # Approve is an explicit instruction, so a finding that was applied earlier
        # is re-approved and re-run: apt re-checks it with `--only-upgrade` and
        # reports it current, which is cheap, and it is what somebody who presses
        # "do the updates" on a row is asking for.
        finding = self.finding(status="applied")
        response = self.approve({"ids": [finding], "apply": True})
        self.assertEqual(200, response.status)
        self.assertEqual(1, response.json()["applied"])
        self.assertEqual("applied", self.status_of()["status"])


class Refusals(ApproveApiCase):
    def test_applying_needs_sync_apply_as_well_as_sync_approve(self):
        # No shipped role holds `sync:approve` without `sync:apply` — every role
        # that can approve can also apply — so the guard is exercised by taking
        # `sync:apply` away from the role that does. The session still holds
        # `sync:approve`, which is what the route's dependency checks.
        finding = self.finding()
        user = identity.create_user(self.conn, username="approver",
                                    password="a-long-enough-one", role="SYSADMIN")
        token, _ = identity.create_session(self.conn, user.id)
        full = identity.role_capabilities

        def without_apply(role: str):
            return tuple(c for c in full(role) if c != "sync:apply")

        with mock.patch.object(identity, "role_capabilities", without_apply):
            response = self.approve({"ids": [finding], "apply": True}, token=token)
        self.assertEqual(403, response.status)
        self.assertIn("sync:apply", response.json()["detail"])
        # The refusal is before any write: the finding is untouched and nothing ran.
        self.assertEqual("pending", self.status_of()["status"])
        self.assertEqual([], self.fake.calls)

    def test_a_run_in_flight_refuses_a_second_approve(self):
        # One lock for scans and applies, so an approval-triggered apply cannot run
        # alongside another run and put two apt transactions on the same host.
        finding = self.finding()
        self.assertTrue(api.RUN_LOCK.acquire(blocking=False))
        self.addCleanup(api.RUN_LOCK.release)
        response = self.approve({"ids": [finding], "apply": True})
        self.assertEqual(409, response.status)
        self.assertEqual([], self.fake.calls)


if __name__ == "__main__":
    unittest.main()
