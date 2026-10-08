# The lab-completion client

The lab-side half of the completion boundary: a small Python client that reports a
finished session on a real machine to the family, so the attempt, its checks and
its certificate land in the family's single ledger with `gradingMode = 'lab'`.

- The contract: [`docs/lab-completion.md`](../../docs/lab-completion.md)
- The door it calls: `POST /api/v1/lab/completions`
  ([`src/app/api/v1/lab/completions/route.ts`](../../src/app/api/v1/lab/completions/route.ts))
- The rulebook it mirrors: `src/lib/lab-completion-rules.ts`

## Why this lives here

The lab is a Python platform with its own repository, and that repository **must
stay unchanged** by the consolidation. So the call the lab would make after a
session is kept here instead: out of tree, in the repo that owns the contract, with
its own tests, ready to be copied onto a lab host by whoever runs one.

**Nothing in the lab's own repository was modified.** Its portal still signs in
only through its own provider, and its code still knows nothing about this route.
Adding the call is a lab operator's change, made on the lab host from this
directory.

## Installing it on a lab host

The client is standard library only, so there is nothing to install.

```
cp -r integrations/lab-completion-client /opt/ontrak-lab-client
```

Then either import it directly:

```python
import sys
sys.path.insert(0, "/opt/ontrak-lab-client")
from ontrak_lab_client import LabCheck, LabCompletion, LabCompletionClient
```

or copy the single package next to the code that calls it:

```
cp -r integrations/lab-completion-client/ontrak_lab_client /srv/ontrak-lab/
```

Run its tests with:

```
cd integrations/lab-completion-client && python -m unittest discover -s tests
```

## Configuration

| Variable | Used for | Notes |
| --- | --- | --- |
| `ONTRAK_API_TOKEN` | the bearer token | Read only when the client is constructed without a `token` argument. The **same value** must be set on the family deployment: the family answers `503` when it has no token of its own and `401` when the two disagree. |
| `ONTRAK_LAB_COMPLETION_BASE_URL` | where the family is served | Read only when the client is constructed without a `base_url` argument. A trailing slash is dropped. Example: `https://its.ontrak.innotel.us`. |

The token is a credential. It is never written to a log line, never included in a
`repr`, and never included in an exception message.

## A worked example

Before: the lab has just finished a session. Its own code has the session id, the
learner, the task's slug and the score it computed.

```python
from ontrak_lab_client import LabCheck, LabCompletion, LabCompletionClient

completion = LabCompletion(
    session_id=session.id,                 # the idempotency key
    learner_email=session.learner_email,
    score=report.score,
    max_score=report.max_score,
    completed_at=report.completed_at,      # a datetime or an ISO-8601 string
    scenario_slug="broken-nic",            # the task it ran
    started_at=session.started_at,
    checks=[
        LabCheck(check.check_id, check.label, check.passed, check.points, check.max_points)
        for check in report.checks
    ],
)
```

After: one call, and the session is on the family's ledger.

```python
client = LabCompletionClient("https://its.ontrak.innotel.us", "the shared token")
result = client.report(completion)

if result.created:
    log.info("lab session %s recorded as attempt %s", completion.session_id, result.attempt_id)
else:
    log.info("lab session %s was already recorded as attempt %s", completion.session_id, result.attempt_id)
```

Sending the same `session_id` twice is safe. The family stores it as a unique
column, so a retry is recognised and answered with the attempt it already has,
which is what makes a scheduled sweep that re-reports unrecorded sessions safe to
run.

## What the answers mean

The client maps every answer to one of three outcomes, because the right reaction
to each is different.

| Outcome | When | What to do |
| --- | --- | --- |
| `LabCompletionResult` | `201` recorded, `200` already recorded | Done. `created` says which. |
| `LabCompletionInvalid` | The value is wrong here, or no token or address is configured. Nothing was sent. | Fix it. Retrying changes nothing. |
| `LabCompletionRefused` | A `4xx`: `401` wrong token, `400` body was not JSON, `422` the completion is not usable. `issues` carries the server's whole list. | Fix the report or the token. Retrying cannot help. |
| `LabCompletionUnavailable` | A `5xx` (including `503`, which means the family deployment has no token configured yet) or a transport failure, with `status` of `0`. | Retry. Nothing will be duplicated. |

```python
from ontrak_lab_client import LabCompletionRefused, LabCompletionUnavailable

try:
    result = client.report(completion)
except LabCompletionRefused as refused:
    # The lab's own problem: a bad value, or a token the family does not accept.
    log.error("the family refused session %s: %s", completion.session_id, refused)
except LabCompletionUnavailable as unavailable:
    # Somebody else's, or the network's. Leave it for the next sweep.
    log.warning("could not report session %s yet: %s", completion.session_id, unavailable)
```

## What the family does with it

One transaction creates an `Attempt` with `status GRADED`, `gradingMode 'lab'` and
`labSessionId` set to the session id, its `CheckResult` rows when the report
carried checks, and a certificate when the score clears the pass mark. The
certificate's signed content carries `mode: "lab"`, so a pasted record says a live
machine graded it. The grading is then announced exactly as a simulated submission
is, so a webhook consumer sees `data.mode = "lab"`.

Two rules worth knowing before reporting:

- **The scenario must be tagged `lab`** on the family side. The boundary refuses a
  completion filed against a simulated task, so a task's declared mode and its
  evidence can never disagree.
- **The scenario and the learner must already exist in the family.** An unknown
  email or an unknown slug is a `422`, not a new account.

## Caveats

- **This client has never reported to a running family from a live lab.** There is
  no lab host in this repository's environment, so the client is covered by its own
  offline tests and the server side by its own. Nobody has driven the pair
  end to end across two hosts.
- **The family derives `timeSpentSec`** from `started_at` and `completed_at` and
  clamps it to a week, so the client does not send it and cannot disagree.
- **`checks` are optional.** A session reported without them records an attempt
  with no per-check detail; the score and the certificate are unaffected.
