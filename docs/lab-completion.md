# The lab-completion boundary

How OnTrak Lab reports a finished session on a real machine to the family, and what
the family does with it.

This is the answer to **Q3** in the consolidation audit
([consolidation-audit.md](consolidation-audit.md) §9): the family owns the graded
`Attempt`; the lab owns only its own operational session record. One ledger means
one certificate path, one analytics query and one assurance packet, so a lab result
lands beside the simulated ones with `gradingMode = 'lab'` and every figure that
states its grader keeps telling the truth.

- Rulebook: [`src/lib/lab-completion-rules.ts`](../src/lib/lab-completion-rules.ts)
- Route: `POST /api/v1/lab/completions` ([`src/app/api/v1/lab/completions/route.ts`](../src/app/api/v1/lab/completions/route.ts))
- Idempotency key: `Attempt.labSessionId` (unique)

## Authentication

The deployment's shared API token, presented as a bearer token — the same
`ONTRAK_API_TOKEN` the read routes use. This is a machine-to-machine call: the lab
has no browser and no user to be, so a session cookie is not an option.

```
Authorization: Bearer $ONTRAK_API_TOKEN
```

- No `ONTRAK_API_TOKEN` set on the family deployment → **503**, with a reason.
  "Nobody set a token" and "your token is wrong" are different problems, and only
  one of them is the lab operator's to fix.
- A wrong token → **401**.

## The request

```json
{
  "format": "ontrak.lab.completion/v1",
  "sessionId": "sess-2026-10-05-0001",
  "learnerEmail": "ada@acme.test",
  "scenarioSlug": "broken-nic",
  "score": 8,
  "maxScore": 10,
  "passScore": 70,
  "startedAt": "2026-10-05T09:00:00.000Z",
  "completedAt": "2026-10-05T09:20:00.000Z",
  "checks": [
    { "checkId": "nic-up", "label": "NIC is up", "passed": true, "points": 4, "maxPoints": 4 }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `format` | no | When present, must be `ontrak.lab.completion/v1`. Every field is re-checked regardless. |
| `sessionId` | yes | The lab's own session id. Letters, digits, `.` `_` `:` `-`, at most 120 chars. **This is the idempotency key.** |
| `learnerEmail` | yes | Matched against the family's unique email; lower-cased on the way in. |
| `scenarioId` *or* `scenarioSlug` | one of them | Which task the session ran. `scenarioId` wins if both are given. **The scenario must be tagged `lab`.** |
| `score` / `maxScore` | yes | Whole numbers, `0 ≤ score ≤ maxScore`, `maxScore ≥ 1`, each at most 100 000. |
| `passScore` | no | Whole percent 0–100. Absent uses the scenario's own pass mark. |
| `startedAt` | no | ISO-8601. When given, must not be after `completedAt`. |
| `completedAt` | yes | ISO-8601. The grading instant. |
| `checks` | no | At most 200, each `{ checkId, label, passed, points, maxPoints }` with `points ≤ maxPoints`. |

### Responses

| Status | Meaning |
| --- | --- |
| `201` | Recorded. `{ ok, attemptId, created: true }`. |
| `200` | This session was already recorded. `{ ok, attemptId, created: false }`. |
| `400` | The body was not JSON. |
| `401` / `503` | Token wrong / no token configured. |
| `422` | The completion is not usable. `{ error, issues: [...] }` — **every** problem named, so the lab operator can fix them in one pass. |

## Idempotency

`sessionId` becomes `Attempt.labSessionId`, which is **unique**. The lab may be
interrupted between grading and reporting, so it may send the same completion
twice; the second is recognised and answered `200` with the attempt it already has,
rather than creating a second attempt. Two concurrent deliveries race on the unique
index and the loser is answered the same way, so the database — not a
read-then-write check — decides the winner. This is the same shape the desk's
scenario drafts use for `sourceRef`.

The retry check happens before the learner or scenario is resolved, so a retry gets
the same answer even if the learner or scenario has changed since the first delivery.

## What the family writes

One transaction creates, for a completion that is new:

- an `Attempt` — `status GRADED`, `gradingMode 'lab'`, `labSessionId sessionId`, the
  score, `timeSpentSec` (clamped to a week so a wrong clock cannot overflow the
  column), `startedAt`/`gradedAt` from the body, and `seed = sessionId` so a replay
  is deterministic;
- its `CheckResult` rows, when the body carried checks;
- a **certificate**, when the score clears the pass mark — a completion record whose
  signed content includes `mode: "lab"`, so a pasted record says a live machine
  graded it (audit §9/Q7).

Then it records an `attempt.lab_completion` entry in the append-only audit chain
(carrying the mode), and announces the grading the same way a simulated submission
does: the webhook consumer sees `data.mode = "lab"`, and any learning-platform
passthrough is a no-op because a lab attempt has no launch.

## Caveats

- **Executed against a booted family stack, but not against a lab.** The route has now
  been driven end to end: `sess-2026-10-08-0001` was filed against `net-dns-failure` in a
  running deployment and answered `201`, the retry `200` with the same `attemptId`, the
  attempt recorded `GRADED` with `gradingMode = 'lab'` and a certificate whose content
  carries `mode: "lab"`, and a completion against a simulated scenario refused `422`. What
  that proves is this side of the boundary. The request was typed by hand: **no lab host
  exists here**, so nothing has sent a real session's id, and the scenario it was filed
  against had to be put in the catalogue first (`npm run lab:import`, which is what makes
  a row carry the `lab` tag at all). The rules are also covered by unit tests
  (`tests/lab-completion.test.ts`).
- **OnTrak-dev is unchanged.** OnTrak Lab's half of this boundary is the call it makes
  after its own `check.ps1` run, idempotently, with this deployment's token. That code is
  drafted **out of tree**, in this repository, precisely so OnTrak-dev stays untouched:
  [`integrations/lab-completion-client/`](../integrations/lab-completion-client/README.md)
  is a dependency-free Python client for exactly this route, with its own tests. It has not
  been installed on a lab host, so no completion has travelled from a real session.- **The scenario has to be tagged `lab`.** The boundary refuses a completion filed
  against a simulated task, so the task's declared mode and its evidence never
  disagree. `npm run lab:import` (see [consolidation-audit.md](consolidation-audit.md)
  §7 Step 5) is what writes those rows: the lab's 14 scenarios, published and tagged.
- **A lab scenario has no simulated start, deliberately.** It carries no simulated
  checks — the lab grades it against a live machine — so starting one here would grade
  nothing and still be filed as lab-graded. The student page draws the lab door instead
  of the start button, and `startAttempt` refuses the POST; `simulatedStartRefusal` in
  `src/lib/lab-rules.ts` is the rule both ask.
