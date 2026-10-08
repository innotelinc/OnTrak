"""The lab-side client's contract with the family's door.

Everything here is about the two things a reporting client gets wrong: the payload
it sends and what it does with the answer. The transport is stubbed, so these
assert the bytes that *would* go on the wire and the mapping from every status the
route can answer to an outcome a caller can act on. Nothing here touches a network
or a database, and nothing here needs the lab to exist.

    python -m unittest discover -s tests
    python tests/test_client.py
"""

import json
import os
import sys
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

# The module is imported from this directory rather than installed, which is how a
# lab host will copy it, so the parent directory has to be on the path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ontrak_lab_client import (  # noqa: E402  (path set up above)
    API_TOKEN_ENV,
    BASE_URL_ENV,
    COMPLETION_ROUTE,
    LAB_COMPLETION_FORMAT,
    LabCheck,
    LabCompletion,
    LabCompletionClient,
    LabCompletionInvalid,
    LabCompletionRefused,
    LabCompletionUnavailable,
)

BASE = "https://its.ontrak.innotel.us"
TOKEN = "lab-live-test-token-0123456789"


def completion(**overrides):
    """A minimal session, the way the lab reports one."""
    values = {
        "session_id": "sess-2026-10-05-0001",
        "learner_email": "ada@acme.test",
        "score": 8,
        "max_score": 10,
        "completed_at": "2026-10-05T09:20:00.000Z",
        "scenario_slug": "broken-nic",
    }
    values.update(overrides)
    return LabCompletion(**values)


class Recorder:
    """A transport that answers with a scripted status and body, and remembers the request."""

    def __init__(self, status=201, body=None, error=None):
        self.requests = []
        self.status = status
        if body is None:
            body = b'{"ok": true, "attemptId": "att_1", "created": true}'
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.error = error

    def __call__(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.status, self.body

    def payload(self, index=0):
        return json.loads(self.requests[index].data.decode("utf-8"))

    def header(self, name, index=0):
        for key, value in self.requests[index].header_items():
            if key.lower() == name.lower():
                return value
        return None


class PayloadTest(unittest.TestCase):
    def test_a_minimal_session_sends_exactly_the_documented_keys(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion())

        body = recorder.payload()
        self.assertEqual(
            set(body),
            {"format", "sessionId", "learnerEmail", "score", "maxScore", "completedAt", "scenarioSlug"},
        )
        self.assertEqual(body["format"], LAB_COMPLETION_FORMAT)
        self.assertEqual(body["sessionId"], "sess-2026-10-05-0001")
        self.assertEqual(body["scenarioSlug"], "broken-nic")
        self.assertEqual(body["score"], 8)
        self.assertEqual(body["maxScore"], 10)
        self.assertEqual(body["completedAt"], "2026-10-05T09:20:00.000Z")

    def test_text_is_trimmed_and_the_address_is_lower_cased(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(
            completion(session_id="  sess-1  ", learner_email="  Ada@Acme.Test ")
        )

        body = recorder.payload()
        self.assertEqual(body["sessionId"], "sess-1")
        self.assertEqual(body["learnerEmail"], "ada@acme.test", "two spellings of one address are one person")

    def test_optional_fields_are_carried_when_given_and_absent_when_not(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(
            completion(
                scenario_id="scenario-1",
                pass_score=70,
                started_at="2026-10-05T09:00:00.000Z",
                checks=[
                    LabCheck("nic-up", "NIC is up", True, 4, 4),
                    LabCheck("route", "Route is present", False, 0, 6),
                ],
            )
        )

        body = recorder.payload()
        self.assertEqual(body["scenarioId"], "scenario-1")
        self.assertEqual(body["scenarioSlug"], "broken-nic", "the id wins when both are given, and both may travel")
        self.assertEqual(body["passScore"], 70)
        self.assertEqual(body["startedAt"], "2026-10-05T09:00:00.000Z")
        self.assertEqual(
            body["checks"],
            [
                {"checkId": "nic-up", "label": "NIC is up", "passed": True, "points": 4, "maxPoints": 4},
                {"checkId": "route", "label": "Route is present", "passed": False, "points": 0, "maxPoints": 6},
            ],
        )
        self.assertNotIn("timeSpentSec", body, "the family derives it from the two instants and clamps it there")

    def test_an_empty_check_list_is_omitted_rather_than_sent_as_noise(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion(checks=[]))
        self.assertNotIn("checks", recorder.payload())

    def test_instants_become_utc_iso_with_milliseconds(self):
        aware = datetime(2026, 10, 5, 11, 20, 0, 123000, tzinfo=timezone.utc)
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(
            completion(completed_at=aware, started_at="2026-10-05T09:00:00+02:00")
        )

        body = recorder.payload()
        self.assertEqual(body["completedAt"], "2026-10-05T11:20:00.123Z")
        self.assertEqual(body["startedAt"], "2026-10-05T07:00:00.000Z", "an offset is normalised, not refused")

    def test_a_datetime_without_a_timezone_is_read_as_utc(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(
            completion(completed_at=datetime(2026, 10, 5, 9, 20, 0))
        )
        self.assertEqual(recorder.payload()["completedAt"], "2026-10-05T09:20:00.000Z")


class LocalValidationTest(unittest.TestCase):
    """Refusals this side makes, so a mistake never travels to be refused there."""

    def assert_refused(self, message, **overrides):
        with self.assertRaises(LabCompletionInvalid, msg=message):
            completion(**overrides).to_payload()

    def test_a_session_id_is_a_key_not_free_text(self):
        for session_id in ["", "   ", "has space", "quote'", "x" * 121, "-leading-hyphen"]:
            self.assert_refused(f"{session_id!r} must be refused", session_id=session_id)
        # The characters the route allows survive untouched.
        self.assertEqual(completion(session_id="a.b_c-d:e123").to_payload()["sessionId"], "a.b_c-d:e123")

    def test_an_email_has_to_be_an_email(self):
        for learner_email in ["", "ada", "ada@acme", "a b@acme.test"]:
            self.assert_refused(f"{learner_email!r} must be refused", learner_email=learner_email)

    def test_a_score_that_is_not_a_score_is_refused_not_clamped(self):
        self.assert_refused("over the maximum", score=11)
        self.assert_refused("fractional", score=7.5)
        self.assert_refused("negative", score=-1)
        self.assert_refused("a boolean is not a score", score=True)
        self.assert_refused("past the cap", score=1_000_000_000, max_score=1_000_000_000)
        self.assert_refused("a scenario worth nothing cannot be graded", max_score=0)

    def test_a_scenario_has_to_be_named(self):
        self.assert_refused("neither id nor slug", scenario_id="", scenario_slug="")

    def test_a_pass_mark_is_a_percentage(self):
        self.assert_refused("past 100", pass_score=101)
        self.assert_refused("negative", pass_score=-1)
        self.assertEqual(completion(pass_score=0).to_payload()["passScore"], 0)

    def test_the_clock_has_to_agree_with_itself(self):
        self.assert_refused("not a time", completed_at="yesterday")
        self.assert_refused("absent", completed_at=None)
        self.assert_refused("start after the end", started_at="2026-10-05T10:00:00.000Z")

    def test_a_check_list_is_bounded_and_each_check_has_to_add_up(self):
        many = [LabCheck(f"c{index}", f"check {index}", True, 1, 1) for index in range(201)]
        self.assert_refused("201 checks", checks=many)
        self.assert_refused("no id", checks=[LabCheck("", "x", True, 1, 1)])
        self.assert_refused("no label", checks=[LabCheck("c1", "", True, 1, 1)])
        self.assert_refused("points over maxPoints", checks=[LabCheck("c1", "x", True, 5, 2)])
        self.assert_refused("fractional points", checks=[LabCheck("c1", "x", True, 1.5, 2)])

    def test_nothing_is_sent_when_the_completion_is_invalid(self):
        recorder = Recorder()
        with self.assertRaises(LabCompletionInvalid):
            LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion(score=99))
        self.assertEqual(recorder.requests, [], "a refused value must not reach the wire")

    def test_a_missing_token_or_address_is_refused_before_sending(self):
        recorder = Recorder()
        with self.assertRaises(LabCompletionInvalid) as caught:
            LabCompletionClient(BASE, "", transport=recorder).report(completion())
        self.assertIn(API_TOKEN_ENV, str(caught.exception))

        with self.assertRaises(LabCompletionInvalid) as caught:
            LabCompletionClient("", TOKEN, transport=recorder).report(completion())
        self.assertIn(BASE_URL_ENV, str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_the_token_and_the_address_come_from_the_environment_by_default(self):
        recorder = Recorder()
        with patch.dict(os.environ, {API_TOKEN_ENV: TOKEN, BASE_URL_ENV: f"{BASE}/"}):
            client = LabCompletionClient(transport=recorder)
            client.report(completion())

        self.assertEqual(recorder.requests[0].full_url, f"{BASE}{COMPLETION_ROUTE}", "a trailing slash is not doubled")


class TransportTest(unittest.TestCase):
    def test_the_request_is_a_bearer_post_to_the_route(self):
        recorder = Recorder()
        LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion())

        request = recorder.requests[0]
        self.assertEqual(request.full_url, f"{BASE}{COMPLETION_ROUTE}")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(recorder.header("authorization"), f"Bearer {TOKEN}")
        self.assertIn("application/json", recorder.header("content-type") or "")

    def test_a_first_delivery_is_created(self):
        result = LabCompletionClient(BASE, TOKEN, transport=Recorder(201)).report(completion())
        self.assertEqual(result.attempt_id, "att_1")
        self.assertTrue(result.created)
        self.assertEqual(result.status, 201)

    def test_a_retry_is_recognised_rather_than_duplicated(self):
        # The lab may be interrupted between grading and reporting, so the same
        # session can be sent twice. The session id is the key, so the second
        # delivery carries the same body and is answered with the attempt it has.
        recorder = Recorder(201)
        client = LabCompletionClient(BASE, TOKEN, transport=recorder)
        first = client.report(completion())

        recorder.status = 200
        recorder.body = b'{"ok": true, "attemptId": "att_1", "created": false}'
        second = client.report(completion())

        self.assertEqual(recorder.payload(0), recorder.payload(1), "a retry is the same fact, byte for byte")
        self.assertEqual(first.attempt_id, second.attempt_id)
        self.assertTrue(first.created)
        self.assertFalse(second.created)

    def test_created_falls_back_to_the_status_when_the_body_is_silent(self):
        result = LabCompletionClient(
            BASE, TOKEN, transport=Recorder(201, body={"ok": True, "attemptId": "att_1"})
        ).report(completion())
        self.assertTrue(result.created)

    def test_a_refusal_names_every_issue_the_server_sent(self):
        issues = ["`score` 11 is greater than `maxScore` 10.", "`scenarioId` names no scenario."]
        recorder = Recorder(422, body={"error": "The lab completion is not usable.", "issues": issues})

        with self.assertRaises(LabCompletionRefused) as caught:
            LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion())

        self.assertEqual(caught.exception.status, 422)
        self.assertEqual(caught.exception.issues, issues)
        self.assertIn("not usable", str(caught.exception))
        self.assertIn(issues[0], str(caught.exception), "the whole list is carried, to fix in one pass")

    def test_a_wrong_token_and_a_bad_body_are_both_refusals(self):
        for status, body in [(401, {"error": "Unauthorized."}), (400, {"error": "The body was not JSON."})]:
            with self.assertRaises(LabCompletionRefused) as caught:
                LabCompletionClient(BASE, TOKEN, transport=Recorder(status, body=body)).report(completion())
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(caught.exception.issues, [])

    def test_an_unavailable_deployment_is_worth_retrying(self):
        for status, body in [
            (503, {"error": f"This deployment has no {API_TOKEN_ENV} set, so the public API is closed."}),
            (500, b"not json at all"),
        ]:
            with self.assertRaises(LabCompletionUnavailable) as caught:
                LabCompletionClient(BASE, TOKEN, transport=Recorder(status, body=body)).report(completion())
            self.assertEqual(caught.exception.status, status)

    def test_a_transport_failure_is_retryable_and_is_not_a_refusal(self):
        recorder = Recorder(error=urllib.error.URLError("connection refused"))
        with self.assertRaises(LabCompletionUnavailable) as caught:
            LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion())
        self.assertEqual(caught.exception.status, 0)
        self.assertIn("could not be reached", str(caught.exception))

    def test_a_success_without_an_attempt_is_not_guessed_at(self):
        recorder = Recorder(201, body={"ok": True})
        with self.assertRaises(LabCompletionUnavailable):
            LabCompletionClient(BASE, TOKEN, transport=recorder).report(completion())

    def test_a_non_json_error_body_still_produces_an_outcome(self):
        with self.assertRaises(LabCompletionRefused):
            LabCompletionClient(BASE, TOKEN, transport=Recorder(422, body=b"<html>nope</html>")).report(completion())


class CredentialTest(unittest.TestCase):
    def test_the_token_is_never_printed(self):
        recorder = Recorder(401, body={"error": "Unauthorized."})
        client = LabCompletionClient(BASE, TOKEN, transport=recorder)

        with self.assertRaises(LabCompletionRefused) as caught:
            client.report(completion())

        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertNotIn(TOKEN, repr(client))
        self.assertIn("<redacted>", repr(client))

    def test_a_client_is_reusable(self):
        recorder = Recorder()
        client = LabCompletionClient(BASE, TOKEN, transport=recorder)
        for index in range(3):
            client.report(completion(session_id=f"sess-{index}"))
        self.assertEqual(len(recorder.requests), 3)
        self.assertEqual([recorder.payload(index)["sessionId"] for index in range(3)], ["sess-0", "sess-1", "sess-2"])


if __name__ == "__main__":
    unittest.main()
