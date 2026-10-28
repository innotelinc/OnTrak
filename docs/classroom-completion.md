# The classroom-completion boundary

How the AI classroom reports a finished lesson to OnTrak, and what OnTrak does with
it.

The classroom is AthenIQ's OpenMAIC host (`classroom.<domain>`): a generated,
multi-agent lesson with its own quizzes. It grades those quizzes itself, and OnTrak
never re-marks them. What this door does is turn the classroom's outcome into a
**training record this deployment holds**: a row in its own ledger and, when the
score cleared the pass mark, a verifiable completion record. The classroom's own
progress page is not the record of record — this is — which is what makes the
training evidence portable, auditable and independent of a regenerated lesson.

- Rulebook: [`src/lib/classroom-completion-rules.ts`](../src/lib/classroom-completion-rules.ts)
- Write: [`src/lib/classroom-completion-record.ts`](../src/lib/classroom-completion-record.ts)
- Route: `POST /api/v1/classroom/completions` ([`src/app/api/v1/classroom/completions/route.ts`](../src/app/api/v1/classroom/completions/route.ts))
- Idempotency key: `ClassroomCompletion.completionId` (unique)
- The seam around it: [ai-classrooms.md](ai-classrooms.md)

## Authentication

The deployment's shared API token as a bearer token — the same `ONTRAK_API_TOKEN`
the read routes and the lab's door use. This is machine-to-machine: the classroom
has no browser session and no user to be.

```
Authorization: Bearer $ONTRAK_API_TOKEN
```

- No `ONTRAK_API_TOKEN` set → **503**, with a reason. "Nobody set a token" and
  "your token is wrong" are different problems, and only one is the operator's.
- A wrong token → **401**.

## The request

```json
{
  "format": "ontrak.classroom.completion/v1",
  "completionId": "openmaic:cls-1:learner-1:lesson-3",
  "learnerEmail": "ada@acme.test",
  "course": { "ref": "ITSP101", "title": "IT Support Foundations" },
  "lesson": { "ref": "chapter-3", "title": "Accounts and access" },
  "score": 8,
  "maxScore": 10,
  "passScore": 70,
  "startedAt": "2026-10-05T09:00:00.000Z",
  "completedAt": "2026-10-05T09:20:00.000Z",
  "checks": [
    {
      "checkId": "quiz-1",
      "label": "Recognises an expired password",
      "passed": true,
      "points": 1,
      "maxPoints": 1,
      "skill": "Account administration"
    }
  ],
  "skills": ["Helpdesk practice"]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `format` | no | When present, must be `ontrak.classroom.completion/v1`. Every field is re-checked regardless. |
| `completionId` | yes | The classroom's own id for this completion. Letters, digits, `.` `_` `:` `@` `-`, at most 200 chars. **This is the idempotency key**, and `@` is allowed because the documented key carries the learner's address. |
| `learnerEmail` | yes | Matched against the family's unique email; lower-cased on the way in. The learner must already exist. |
| `course.ref` / `course.title` | yes | The course as the classroom names it (a key or slug) and its title. Text, not a foreign key: another product's catalog can be rebuilt without deleting the evidence. |
| `lesson.ref` / `lesson.title` | yes | The lesson or chapter inside that course. |
| `score` / `maxScore` | yes | Whole numbers, `0 ≤ score ≤ maxScore`, `maxScore ≥ 1`, each at most 100 000. |
| `passScore` | no | Whole percent 0–100. Absent uses **70**. |
| `startedAt` | no | ISO-8601. When given, must not be after `completedAt`. |
| `completedAt` | yes | ISO-8601. When the classroom finished the lesson. |
| `checks` | no | At most 200, each `{ checkId, label, passed, points, maxPoints, skill? }` with `points ≤ maxPoints`. |
| `skills` | no | At most 12 names of at most 120 characters. Used only when no passed check names a `skill`; the certificate itself carries its own cap of 8 (`certificates.ts`). |

### Responses

| Status | Meaning |
| --- | --- |
| `201` | Recorded. `{ ok, id, created: true }`, plus `record` and `code` when the lesson passed. |
| `200` | This completion was already recorded. `{ ok, id, created: false }`, plus the same `record`/`code` the first delivery issued. |
| `400` | The body was not JSON. |
| `401` / `503` | Token wrong / no token configured. |
| `422` | The completion is not usable. `{ error, issues: [...] }` — **every** problem named, so the classroom operator can fix them in one pass. A learner with no account here is also 422, with the address. |

## Idempotency

`completionId` is unique in the database. A classroom may be interrupted between
finishing a lesson and reporting it, so it may send the same completion twice; the
second is answered `200` with the row it already has. Two concurrent deliveries race
on the unique index and the loser is answered the same way, so the database — not a
read-then-write check — decides the winner.

The retry check happens before the learner is resolved and **before a new record is
built**, so the code the learner was handed on the first delivery is the code a
retry returns — even if the classroom's title or score moved since.

The response carries the stored `record` and its `code` (for example
`ONTRAK-1A2B-3C4D-5E6F`). That is what makes the record usable rather than merely
stored: the classroom shows or downloads the JSON and the code, and anyone can
paste the record into this deployment's `/verify` page. A failing lesson answers
with neither, because there is nothing to verify.

## What OnTrak writes

One `ClassroomCompletion` row:

- the course and lesson references and titles as reported;
- `score`, `maxScore`, the effective `passScore`, `completedAt`, `timeSpentSec`
  (clamped to a week so a wrong clock cannot overflow the column);
- the **completion record**, when the score cleared the pass mark. It names the
  course as its task (`scenarioId` = `course.ref`, `scenarioTitle` =
  `course.title`), says `platform: "classroom"`, and carries the competencies the
  passed checks named (or the classroom's `skills` list when none did). It is
  **stored on the row**, not recomputed, so the code keeps verifying after the
  classroom is rebuilt;
- a `classroom.completion` entry in the append-only audit chain — who/what arrived,
  the score, the pass mark, and whether a record was issued.

A record is issued exactly when the reported score clears the reported pass mark
(`score-rules.ts`), so a completion the payload itself calls a failure cannot
produce a certificate.

## What is deliberately not here

- **No scenario is created.** A classroom lesson is not a scenario this app graded.
  Inventing a scenario row per generated lesson would put machine-made exercises in
  the catalog, in analytics and in every assignment picker — a worse lie than a
  record that says plainly what it is.
- **No grading.** The checks and score are the classroom's statements, recorded as
  reported. This deployment does not re-mark a quiz and does not have the lesson's
  rubric to do it with.
- **No mode claim.** The family's grading modes are `simulated` and `lab`; a
  classroom completion is neither, so the record carries **no** `mode` rather than
  defaulting to `simulated`. Absent is the weaker, honest statement, and a later
  milestone can add a `classroom` mode across the family deliberately.
- **No identity path to the classroom.** The link still carries no learner token;
  the classroom reports an address it already knows, and this door resolves it
  against its own accounts.

## Sender

A dependency-free Python client that posts this contract lives with the classroom
integration (`atheniq-work/scripts/report-classroom-completion.py`), so the operator
who finishes a lesson has one command rather than a curl incantation. It is not part
of this repository and this door does not require it: any HTTP client with the token
can report a completion.
