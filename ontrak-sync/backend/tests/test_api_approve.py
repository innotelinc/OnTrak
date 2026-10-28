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
from datetime import datetime, timezone
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

from ontrak import api, applier, db, identity, registry  # noqa: E402
from ontrak.config import Host, Settings  # noqa: E402
from ontrak.scheduler import load_policy  # noqa: E402
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


#: The integration token every case signs in with. It lives at module level as
#: well as on the case because a default argument is evaluated in the scope
#: *around* the class, where a base class's attribute is not a name — a subclass
#: writing `token=TOKEN` in its signature would raise NameError at import.
TOKEN = "an-integration-token"


class ApproveApiCase(unittest.TestCase):
    """A real app over a throwaway database, with only the Network faked."""

    TOKEN = TOKEN

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
        # A login goes through `registry`, which holds its own transport reference,
        # so it is doubled too (see the same note in test_applier).
        reg_patcher = mock.patch.multiple(
            registry,
            docker_in_container=self.fake.docker_in_container,
        )
        reg_patcher.start()
        self.addCleanup(reg_patcher.stop)

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


class ApprovalWorkflow(ApproveApiCase):
    """2.1: an approval is a named, expiring decision, and apply reads it.

    The routes are driven for real (see the module docstring) so what is pinned is
    the thing an operator's click reaches: the approval records who decided, an
    apply refuses a decision that is anonymous or expired *with the reason*, and the
    calendar refuses an apply outside the windows the deployment declared. The
    scheduler's `auto` path is pinned from the other side — the same
    `apply_findings` the timer calls still installs with no approval record at all,
    because an unattended apply is the policy's decision and the calendar is what
    bounds it.
    """

    def set_policy(self, **fields):
        by_key = load_policy(self.conn, self.settings).as_dict()
        by_key.update(fields)
        db.set_setting(self.conn, "policy", by_key)
        self.conn.commit()

    def apply(self, body: dict, token: str | None = TOKEN):
        return call(self.app, "POST", "/api/apply", body=body, token=token)

    def approval_of(self, package: str = "nginx"):
        return self.conn.execute(
            "SELECT status, approved_by, approved_at, approval_expires_at, approval_reason"
            " FROM findings WHERE package=?", (package,)
        ).fetchone()

    def test_an_approval_records_who_decided_and_why(self):
        finding = self.finding()
        response = self.approve({"ids": [finding], "reason": "CVE-2026-1234"})
        self.assertEqual(200, response.status)
        approval = self.approval_of()
        self.assertEqual(api.SERVICE_ACTOR, approval["approved_by"])
        self.assertIsNotNone(approval["approved_at"])
        self.assertEqual("CVE-2026-1234", approval["approval_reason"])

    def test_the_policy_ttl_stamps_an_expiry_at_approval_time(self):
        # Fixed when the decision is recorded, so changing the form later does not
        # move a deadline somebody is planning around.
        self.set_policy(approval_ttl_hours=24)
        finding = self.finding()
        self.approve({"ids": [finding]})
        self.assertIsNotNone(self.approval_of()["approval_expires_at"])

    def test_apply_refuses_an_approval_that_names_nobody(self):
        # A row approved before this existed, or by a script that passed no actor.
        finding = self.finding(status="approved")
        response = self.apply({"ids": [finding]})
        self.assertEqual(409, response.status)
        self.assertIn("no named approver", response.json()["detail"])
        self.assertEqual([], self.fake.calls)
        self.assertEqual("approved", self.approval_of()["status"])

    def test_apply_refuses_an_expired_approval_with_the_deadline(self):
        finding = self.finding()
        self.approve({"ids": [finding], "reason": "out of hours",
                      "expires_at": "2020-01-01T00:00:00Z"})
        response = self.apply({"ids": [finding]})
        self.assertEqual(409, response.status)
        self.assertIn("expired at 2020-01-01T00:00:00Z", response.json()["detail"])
        self.assertEqual([], self.fake.calls)

    def test_a_live_approval_applies(self):
        finding = self.finding()
        self.approve({"ids": [finding], "reason": "scheduled patch"})
        response = self.apply({"ids": [finding]})
        self.assertEqual(200, response.status, response.body)
        self.assertEqual(1, response.json()["applied"])
        self.assertEqual("applied", self.approval_of()["status"])
        self.assertTrue(any(entry[0] == "apt-install" for entry in self.fake.calls))

    def test_a_pending_finding_cannot_be_forced_through_apply(self):
        # `/api/apply` is the manual path; it installs decisions, not candidates.
        finding = self.finding()
        response = self.apply({"ids": [finding]})
        self.assertEqual(409, response.status)
        self.assertIn("is pending", response.json()["detail"])
        self.assertEqual([], self.fake.calls)

    def test_apply_refuses_outside_the_maintenance_calendar(self):
        now = datetime.now(timezone.utc)
        self.set_policy(maintenance_windows=[{
            "name": "Patch night",
            "weekdays": list(range(7)),
            "start_hour": (now.hour + 2) % 24,
            "end_hour": (now.hour + 3) % 24,
        }])
        finding = self.finding()
        self.approve({"ids": [finding], "reason": "scheduled patch"})
        response = self.apply({"ids": [finding]})
        self.assertEqual(409, response.status)
        self.assertIn("outside the maintenance calendar", response.json()["detail"])
        self.assertEqual([], self.fake.calls)

    def test_the_one_click_path_is_refused_by_the_calendar_too(self):
        # A second button must not be a way around the window: the click is the
        # approval, so only the calendar can refuse it — and it does, before anything
        # is written.
        now = datetime.now(timezone.utc)
        self.set_policy(maintenance_windows=[{
            "name": "Patch night",
            "weekdays": list(range(7)),
            "start_hour": (now.hour + 2) % 24,
            "end_hour": (now.hour + 3) % 24,
        }])
        finding = self.finding()
        response = self.approve({"ids": [finding], "apply": True})
        self.assertEqual(409, response.status)
        self.assertIn("outside the maintenance calendar", response.json()["detail"])
        self.assertEqual([], self.fake.calls)
        self.assertEqual("pending", self.approval_of()["status"])
        self.assertIsNone(self.approval_of()["approved_by"])

    def test_the_timer_is_not_asked_for_a_human_approval(self):
        # The unattended path calls `apply_findings` directly — that is the whole of
        # its authority — so it must not trip the rule `/api/apply` enforces. What
        # bounds it is the calendar, through `Policy.action_for`, which `test_policy`
        # pins. This is the other half: an `auto` apply with no approval record at all
        # still installs, because the policy is the approval.
        finding = self.finding()
        policy = load_policy(self.conn, self.settings)
        policy.mode = "auto"
        outcome = applier.apply_findings(self.conn, self.settings, policy,
                                         finding_ids=[finding], trigger="schedule")
        self.assertEqual(1, outcome["applied"])
        self.assertEqual("applied", self.approval_of()["status"])

    def test_the_worklist_carries_the_approval_so_a_page_can_show_it(self):
        finding = self.finding()
        self.approve({"ids": [finding], "reason": "CVE-2026-1234"})
        listed = db.list_findings(self.conn, status="approved")[0]
        self.assertEqual(api.SERVICE_ACTOR, listed["approved_by"])
        self.assertEqual("CVE-2026-1234", listed["approval_reason"])


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


class RollbackThroughTheApi(ApproveApiCase):
    """2.2's undo, driven through the real route.

    The planner is tested in `test_rollback.py`; what is pinned here is the surface
    an operator's request reaches: the capability, the refusal sentences, and that a
    rollback of a run that moved nothing changes nothing.
    """

    def rollback(self, body: dict, token: str | None = TOKEN):
        return call(self.app, "POST", "/api/rollback", body=body, token=token)

    def applied(self, package: str = "nginx") -> int:
        finding = self.finding(package=package)
        applied = self.approve({"ids": [finding], "apply": True})
        self.assertEqual(200, applied.status, applied.body)
        return applied.json()["run_id"]

    def test_the_request_needs_a_credential(self):
        run_id = self.applied()
        self.fake.calls.clear()
        response = self.rollback({"run_id": run_id}, token=None)
        self.assertEqual(401, response.status)
        self.assertEqual([], self.fake.calls)

    def test_a_rollback_puts_the_recorded_version_back(self):
        run_id = self.applied()
        self.fake.installed_versions["nginx"] = "1.1"
        response = self.rollback({"run_id": run_id})
        self.assertEqual(200, response.status, response.body)
        payload = response.json()
        self.assertEqual(1, payload["rolled_back"])
        self.assertEqual(0, payload["failed"])
        self.assertIsNotNone(payload["run_id"])
        self.assertEqual("pending", self.status_of()["status"])
        installs = [call for call in self.fake.calls if call[0] == "apt-rollback"]
        self.assertEqual(1, len(installs))
        self.assertIn("nginx=1.0", installs[0][2])

    def test_an_unknown_run_is_a_404(self):
        response = self.rollback({"run_id": 4242})
        self.assertEqual(404, response.status)

    def test_a_run_that_moved_nothing_is_a_409_with_the_reason(self):
        run_id = db.start_run(self.conn, "apply", "manual:test")
        db.finish_run(self.conn, run_id, status="ok")
        self.conn.commit()
        response = self.rollback({"run_id": run_id})
        self.assertEqual(409, response.status)
        self.assertIn("nothing to roll back", response.json()["detail"])

    def test_a_second_rollback_is_refused_with_the_first_run_id(self):
        run_id = self.applied()
        self.fake.installed_versions["nginx"] = "1.1"
        first = self.rollback({"run_id": run_id})
        self.assertEqual(200, first.status)
        second = self.rollback({"run_id": run_id})
        self.assertEqual(409, second.status)
        self.assertIn(f"#{first.json()['run_id']}", second.json()["detail"])

    def test_a_run_in_flight_refuses_the_rollback(self):
        run_id = self.applied()
        self.assertTrue(api.RUN_LOCK.acquire(blocking=False))
        self.addCleanup(api.RUN_LOCK.release)
        response = self.rollback({"run_id": run_id})
        self.assertEqual(409, response.status)
        self.assertEqual("a scan or apply is already running", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
