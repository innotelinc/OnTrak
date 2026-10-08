"""Report a finished lab session to the OnTrak family.

OnTrak Lab (OnTrak-dev) grades a task against a live machine. When a session ends,
the family expects one POST describing it, so that the attempt, its checks and its
certificate land in the family's single ledger with ``gradingMode = 'lab'``
(docs/consolidation-audit.md, Q3).

This module is the lab-side half of that boundary, and it lives in the OnTrak
repository on purpose: OnTrak-dev must stay unchanged, so the call the lab would
make is kept here instead, to be copied onto a lab host. See README.md in this
directory.

Nothing outside the Python standard library is imported. The lab host is a service
with its own pinned dependencies, and a reporting client does not deserve to add
one to them.

The rulebook it mirrors is ``src/lib/lab-completion-rules.ts`` and the door it calls
is ``POST /api/v1/lab/completions``. Where the two could disagree the server wins,
because the server is the side that writes.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable, Optional, Sequence, Tuple

#: The format this door accepts. The server re-checks every field regardless, so
#: this is a name for the contract rather than the thing that validates it.
LAB_COMPLETION_FORMAT = "ontrak.lab.completion/v1"

#: The route, relative to the deployment's base address.
COMPLETION_ROUTE = "/api/v1/lab/completions"

#: The deployment's shared API token. The same variable the family's own read
#: routes use (``src/app/api/v1/_access.ts``), read from the environment when the
#: caller does not pass one.
API_TOKEN_ENV = "ONTRAK_API_TOKEN"

#: Where the family lives, for a caller that passes no base address, e.g.
#: ``https://its.ontrak.innotel.us``.
BASE_URL_ENV = "ONTRAK_LAB_COMPLETION_BASE_URL"

#: Bounds this client enforces locally, so a mistake is caught before it travels.
#: They mirror the server's caps one for one; the server refuses rather than
#: truncates, and so does this.
MAX_SESSION_ID = 120
MAX_LEARNER_EMAIL = 254
MAX_SCENARIO_REF = 200
MAX_LAB_CHECKS = 200
MAX_CHECK_ID = 200
MAX_CHECK_LABEL = 200
MAX_SCORE = 100_000

#: A session id is a key, not free text: letters, digits, dot, underscore, colon
#: and hyphen, and it starts with a letter or a digit.
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class LabCompletionError(Exception):
    """Base class, so a caller can catch the family of failures in one clause."""


class LabCompletionInvalid(LabCompletionError, ValueError):
    """Refused here, before anything was sent.

    The value is wrong, so sending it again changes nothing. Fix it and report
    again; there is no retry that makes this one work.
    """


class LabCompletionRefused(LabCompletionError):
    """The deployment answered a 4xx: it understood the request and said no.

    ``issues`` carries the server's own list when it sent one (a 422 names every
    problem at once on purpose, so the operator can fix them in one pass).
    """

    def __init__(self, status: int, message: str, issues: Optional[Sequence[str]] = None) -> None:
        self.status = status
        self.message = message
        self.issues = list(issues or [])
        detail = f"HTTP {status}: {message}"
        if self.issues:
            detail = f"{detail} ({'; '.join(self.issues)})"
        super().__init__(detail)


class LabCompletionUnavailable(LabCompletionError):
    """The deployment could not record it: a 5xx, or it could not be reached.

    Worth retrying. The boundary is idempotent on the session id, so a retry of a
    completion that did land answers 200 with the attempt it already has rather
    than creating a second one.
    """

    def __init__(self, status: int, reason: str) -> None:
        self.status = status
        self.reason = reason
        super().__init__(f"HTTP {status}: {reason}" if status else reason)


@dataclass(frozen=True)
class LabCheck:
    """One graded check, as the family's ``CheckResult`` expects it."""

    check_id: str
    label: str
    passed: bool
    points: int = 0
    max_points: int = 0

    def validate(self, index: int) -> None:
        check_id = _text(self.check_id)
        label = _text(self.label)
        if not check_id or len(check_id) > MAX_CHECK_ID:
            raise LabCompletionInvalid(
                f"Check {index} needs a `checkId` of at most {MAX_CHECK_ID} characters."
            )
        if not label or len(label) > MAX_CHECK_LABEL:
            raise LabCompletionInvalid(
                f"Check {index} needs a `label` of at most {MAX_CHECK_LABEL} characters."
            )
        if not isinstance(self.passed, bool):
            raise LabCompletionInvalid(f"Check {index} needs a boolean `passed`.")
        points = _count(self.points, MAX_SCORE)
        if points is None:
            raise LabCompletionInvalid(
                f"Check {index} needs a whole, non-negative `points` (max {MAX_SCORE})."
            )
        max_points = _count(self.max_points, MAX_SCORE)
        if max_points is None:
            raise LabCompletionInvalid(
                f"Check {index} needs a whole, non-negative `maxPoints` (max {MAX_SCORE})."
            )
        if points > max_points:
            raise LabCompletionInvalid(
                f"Check {index} awards {points} of {max_points}; points cannot exceed maxPoints."
            )

    def to_payload(self) -> dict:
        return {
            "checkId": _text(self.check_id),
            "label": _text(self.label),
            "passed": self.passed,
            "points": self.points,
            "maxPoints": self.max_points,
        }


@dataclass(frozen=True)
class LabCompletion:
    """One finished session, as the lab knows it.

    ``session_id`` is the idempotency key: the family stores it as
    ``Attempt.labSessionId``, which is unique, so reporting the same session twice
    is recognised rather than duplicated. A sweep that runs on a schedule can
    therefore re-report freely.

    ``timeSpentSec`` is deliberately absent: the family derives it from
    ``started_at`` and ``completed_at`` and clamps it to a week, so sending it
    would only invite the two sides to disagree.
    """

    session_id: str
    learner_email: str
    score: int
    max_score: int
    completed_at: Any
    scenario_id: str = ""
    scenario_slug: str = ""
    pass_score: Optional[int] = None
    started_at: Any = None
    checks: Sequence[LabCheck] = field(default_factory=tuple)

    def validate(self) -> None:
        """Refuse locally anything the family would refuse, before it is sent."""
        session_id = _text(self.session_id)
        if not session_id:
            raise LabCompletionInvalid("The lab completion has no `sessionId`.")
        if len(session_id) > MAX_SESSION_ID:
            raise LabCompletionInvalid(f"`sessionId` is longer than {MAX_SESSION_ID} characters.")
        if not SESSION_ID.match(session_id):
            raise LabCompletionInvalid(
                "`sessionId` may contain only letters, digits, dot, underscore, colon and hyphen."
            )

        learner_email = _text(self.learner_email).lower()
        if not learner_email:
            raise LabCompletionInvalid("The lab completion has no `learnerEmail`.")
        if len(learner_email) > MAX_LEARNER_EMAIL or not EMAIL.match(learner_email):
            raise LabCompletionInvalid(f"`{learner_email[:60]}` is not an email address.")

        if len(_text(self.scenario_id)) > MAX_SCENARIO_REF or len(_text(self.scenario_slug)) > MAX_SCENARIO_REF:
            raise LabCompletionInvalid(
                f"A scenario reference is longer than {MAX_SCENARIO_REF} characters."
            )
        if not _text(self.scenario_id) and not _text(self.scenario_slug):
            raise LabCompletionInvalid(
                "The lab completion names no scenario (`scenario_id` or `scenario_slug`)."
            )

        score = _count(self.score, MAX_SCORE)
        if score is None:
            raise LabCompletionInvalid(f"`score` must be a whole number between 0 and {MAX_SCORE}.")
        max_score = _count(self.max_score, MAX_SCORE)
        if max_score is None or max_score == 0:
            raise LabCompletionInvalid(f"`maxScore` must be a whole number between 1 and {MAX_SCORE}.")
        if score > max_score:
            raise LabCompletionInvalid(f"`score` {score} is greater than `maxScore` {max_score}.")

        if self.pass_score is not None and _count(self.pass_score, 100) is None:
            raise LabCompletionInvalid(
                "`passScore`, when given, must be a whole number between 0 and 100."
            )

        if self.completed_at is None or (isinstance(self.completed_at, str) and not self.completed_at.strip()):
            raise LabCompletionInvalid("`completedAt` must be an ISO-8601 date-time.")
        completed = _instant(self.completed_at)
        if self.started_at is not None:
            started = _instant(self.started_at)
            if started > completed:
                raise LabCompletionInvalid("`started_at` is after `completed_at`.")

        if len(self.checks) > MAX_LAB_CHECKS:
            raise LabCompletionInvalid(
                f"`checks` carries {len(self.checks)} entries; at most {MAX_LAB_CHECKS} are accepted."
            )
        for index, check in enumerate(self.checks):
            check.validate(index)

    def to_payload(self) -> dict:
        """The JSON body the route reads. Validates first, so a bad value never travels."""
        self.validate()
        payload: dict = {
            "format": LAB_COMPLETION_FORMAT,
            "sessionId": _text(self.session_id),
            # Lower-cased here as well as there: the family matches this against its
            # unique email, and two spellings of one address are one person.
            "learnerEmail": _text(self.learner_email).lower(),
            "score": self.score,
            "maxScore": self.max_score,
            "completedAt": _iso(self.completed_at),
        }
        # Absent rather than empty, so the minimal report reads like the documented
        # minimal body and a reader can see at a glance what the lab actually knew.
        if _text(self.scenario_id):
            payload["scenarioId"] = _text(self.scenario_id)
        if _text(self.scenario_slug):
            payload["scenarioSlug"] = _text(self.scenario_slug)
        if self.pass_score is not None:
            payload["passScore"] = self.pass_score
        if self.started_at is not None:
            payload["startedAt"] = _iso(self.started_at)
        if self.checks:
            payload["checks"] = [check.to_payload() for check in self.checks]
        return payload


@dataclass(frozen=True)
class LabCompletionResult:
    """What the family answered. ``created`` is false when the session was already known."""

    attempt_id: str
    created: bool
    status: int


#: A transport takes the prepared request and returns ``(status, body)``. The
#: default opens a real connection; a test passes a stub. It is the seam that lets
#: the payload be asserted without a network, which is why it is a parameter.
Transport = Callable[[urllib.request.Request], Tuple[int, bytes]]


class LabCompletionClient:
    """POSTs one completion per finished session, and maps the answer to an outcome."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        timeout: float = 10.0,
        transport: Optional[Transport] = None,
    ) -> None:
        resolved_base = _text(base_url if base_url is not None else os.environ.get(BASE_URL_ENV, ""))
        self._base_url = resolved_base.rstrip("/")
        resolved_token = _text(token if token is not None else os.environ.get(API_TOKEN_ENV, ""))
        self._token = resolved_token
        self._timeout = timeout
        # The default transport carries the timeout, so a caller that set one is not
        # silently left with an unbounded socket. A stub passed in is used as given.
        self._transport = transport or partial(_urlopen_transport, timeout=timeout)

    # The token is a credential: it is never in a repr, and never in a message.
    def __repr__(self) -> str:
        return f"LabCompletionClient(base_url={self._base_url!r}, token=<redacted>, timeout={self._timeout!r})"

    def report(self, completion: LabCompletion) -> LabCompletionResult:
        """Report one finished session.

        Raises ``LabCompletionInvalid`` when the completion or the client's own
        configuration is wrong (nothing was sent), ``LabCompletionRefused`` when the
        deployment refused it (4xx: fix and report again), and
        ``LabCompletionUnavailable`` when it could not be recorded (5xx or a
        transport failure: retry, which is safe because the session id is the key).
        """
        payload = completion.to_payload()

        if not self._base_url:
            raise LabCompletionInvalid(
                "No base address: pass one, or set "
                f"{BASE_URL_ENV} to where the family is served."
            )
        if not self._token:
            raise LabCompletionInvalid(
                f"No API token: pass one, or set {API_TOKEN_ENV} on the lab host. "
                "The family answers 503 until it has one too."
            )

        request = urllib.request.Request(
            f"{self._base_url}{COMPLETION_ROUTE}",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

        try:
            status, body = self._transport(request)
        except urllib.error.HTTPError as error:
            # urlopen raises for a 4xx/5xx; that is still an answer, so read it.
            status, body = error.code, error.read()
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise LabCompletionUnavailable(status=0, reason=f"the deployment could not be reached: {reason}") from error

        return _interpret(status, body)


def report_completion(
    completion: LabCompletion,
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    *,
    transport: Optional[Transport] = None,
) -> LabCompletionResult:
    """Report one completion without building a client, for a one-shot caller."""
    return LabCompletionClient(base_url, token, transport=transport).report(completion)


def _interpret(status: int, body: bytes) -> LabCompletionResult:
    """The route's answers, as the outcomes a caller can act on."""
    document = _decode(body)

    if status in (200, 201):
        attempt_id = _text(document.get("attemptId"))
        if not attempt_id:
            # A 2xx without the attempt it recorded is not something to guess at,
            # and a retry is harmless (the session id is still the key).
            raise LabCompletionUnavailable(
                status=status, reason="the deployment recorded nothing it could name."
            )
        return LabCompletionResult(
            attempt_id=attempt_id,
            created=bool(document.get("created", status == 201)),
            status=status,
        )

    if 400 <= status < 500:
        raise LabCompletionRefused(
            status=status,
            message=_text(document.get("error")) or "the deployment refused the completion.",
            issues=document.get("issues") if isinstance(document.get("issues"), list) else None,
        )

    # 503 is in here too: "this deployment has no token configured" is somebody
    # else's to fix, and it is worth trying again once they have. Retrying cannot
    # duplicate anything, because the session id is the key.
    raise LabCompletionUnavailable(
        status=status,
        reason=_text(document.get("error")) or "the deployment could not record the completion.",
    )


def _urlopen_transport(request: urllib.request.Request, timeout: float | None = None) -> Tuple[int, bytes]:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def _decode(body: bytes) -> dict:
    """A JSON object, or an empty one: a body that is not JSON is not a crash."""
    if not body:
        return {}
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _count(value: Any, maximum: int) -> Optional[int]:
    """A non-negative whole number within ``maximum``, or ``None``.

    ``True`` is refused as a number even though Python says it is an ``int``: a
    boolean where a score belongs is a mistake, not a 1.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > maximum:
        return None
    return value


def _instant(value: Any) -> datetime:
    """A timezone-aware UTC instant from a datetime or an ISO-8601 string."""
    if isinstance(value, datetime):
        moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError as error:
            raise LabCompletionInvalid(f"`{text[:40]}` is not an ISO-8601 date-time.") from error
        return _instant(parsed)
    if value is None:
        raise LabCompletionInvalid("A date-time is required here.")
    raise LabCompletionInvalid(f"`{value!r}` is not an ISO-8601 date-time.")


def _iso(value: Any) -> str:
    """UTC, with milliseconds and a trailing Z: exactly what the server parses."""
    moment = _instant(value)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"
