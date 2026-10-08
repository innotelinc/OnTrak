"""Report one completion with the shipping client, for a live test to read.

This is not a unit test: `unittest` collects `test*.py`, and this file is named
so it will not be collected. It is the seam `tests/lab-client-live.test.ts` uses
to drive the client's **real** transport, because the 28 cases beside it stub the
transport out and therefore prove the payload without proving the request.

It uses only the client's public surface, so a run that succeeds here is evidence
about the interface a lab host will actually call, not about this script.

  python3 live_probe.py <client-dir> <base-url> <sessionId> <scenarioSlug> \
      <learnerEmail> <token>

Prints one line of JSON and exits 0 when the client produced an outcome of its
own (success or refusal alike). Exits 1 when something escaped the client, so a
crash is never mistaken for a mapped refusal.
"""

import json
import sys
import traceback

sys.path.insert(0, sys.argv[1])

from ontrak_lab_client import (  # noqa: E402
    LabCheck,
    LabCompletion,
    LabCompletionRefused,
    report_completion,
)

base, session, slug, email, token = sys.argv[2:7]

completion = LabCompletion(
    session_id=session,
    learner_email=email,
    score=8,
    max_score=10,
    completed_at="2026-10-05T09:20:00Z",
    started_at="2026-10-05T09:00:00Z",
    scenario_slug=slug,
    pass_score=70,
    checks=[LabCheck(check_id="nic-up", label="NIC is up", passed=True, points=4, max_points=4)],
)

try:
    result = report_completion(completion, base, token)
    print(json.dumps({
        "ok": True,
        "attempt_id": result.attempt_id,
        "created": result.created,
        "status": result.status,
    }))
except LabCompletionRefused as error:
    print(json.dumps({
        "ok": False,
        "error": "refused",
        "status": error.status,
        "issues": error.issues,
    }))
except Exception:  # noqa: BLE001 - anything else is a crash, not a mapped outcome
    print(json.dumps({"ok": False, "error": "unexpected", "detail": traceback.format_exc()}))
    sys.exit(1)
