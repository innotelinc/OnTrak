# Integrations — the public API and webhooks

Training evidence is only useful if it leaves the platform. This app is the
system of record for **who was trained, on what, when and how well**; everything
below exists so an LMS, a skills matrix or a spreadsheet somebody maintains can
be told about it without a human in the middle.

Two surfaces, one dataset:

* a **webhook** so a consumer hears about a grading as it happens, and
* a **read API** so the same consumer can catch up after it was down, plus a
  **CSV** path for the people who will never run an integration.

Set `ONTRAK_API_TOKEN` for the read API and the roster import;
`ONTRAK_WEBHOOK_URL` + `ONTRAK_WEBHOOK_SECRET` for delivery. An unconfigured
deployment answers `503` with a reason rather than `401`, because "nobody set a
token" and "your token is wrong" are different problems and only one of them is
the caller's to fix.

## Authentication

Every route is bearer-authenticated against one shared secret:

```bash
curl -H "Authorization: Bearer $ONTRAK_API_TOKEN" \
  "https://training.example.edu/api/v1/results?since=2026-10-01T00:00:00Z"
```

Comparison is over fixed-length digests, so the response time cannot be used to
learn the secret a byte at a time. The secret is *not* a session cookie: a script
has no browser and no user to be, and letting it in by session would make every
instructor's login an API credential.

## Reads

| Route | Answers |
| --- | --- |
| `GET /api/v1/results` | Graded attempts, newest first, as JSON |
| `GET /api/v1/results/export` | The same page as a CSV file |
| `GET /api/v1/roster` | Who is enrolled, and in which classes |
| `GET /api/v1/roster/export` | The roster as a CSV file |
| `GET /api/v1/webhook-deliveries` | What was sent, and what came back |

`/api/v1/results` filters: `since` (ISO-8601, matched against `gradedAt`),
`scenarioId`, `cohortId`, `status` (comma-separated; defaults to everything that
finished, which includes `EXPIRED` and `ABANDONED`), `limit` (default 100, max
500) and `cursor`.

Paging is a **keyset**, not an offset: the response carries `nextCursor`, and a
full page always has one, so a loop terminates on a null instead of guessing.
A `Cookie`-free, stateless read of a table that is still being written cannot use
an offset — rows shift underneath it and records are skipped silently, which is
exactly the bug a reconciliation feed must not have.

Each result carries the learner, the scenario, the cohort, the score, the pass
mark, per-check outcomes, and the certificate if one was issued. It is the same
object the webhook's `data` field holds, so one parser serves both.

## A grading, as it happens

One POST per **new** grading. A re-grade is a *second* event rather than a
correction: a consumer that stored the original score has to learn the new one,
and it can tell them apart by `data.gradedAt`.

```
POST https://lms.example.edu/hooks/ontrak
content-type: application/json
user-agent: ontrak-training-webhooks/1
x-ontrak-signature: t=1759660802,sha256=6f4b…
```

```json
{
  "id": "evt_9c1f…",
  "event": "attempt.graded",
  "version": 1,
  "deliveredAt": "2026-10-05T09:20:02.000Z",
  "data": {
    "attemptId": "cmumaw…",
    "status": "GRADED",
    "learner": { "id": "…", "email": "ada@acme.test", "name": "Ada" },
    "scenario": { "id": "…", "title": "Fix a broken NIC", "platform": "LINUX" },
    "cohort": { "id": "…", "name": "Autumn intake" },
    "score": 8,
    "maxScore": 10,
    "passScore": 7,
    "passed": true,
    "startedAt": "2026-10-05T09:00:00.000Z",
    "submittedAt": "2026-10-05T09:20:00.000Z",
    "gradedAt": "2026-10-05T09:20:01.000Z",
    "timeSpentSec": 1200,
    "certificate": { "code": "ONTRAK-ABCD-EF01-2345", "digest": "…", "issuedAt": "…", "revokedAt": null },
    "checks": [
      { "checkId": "c1", "label": "Interface is up", "passed": true, "points": 4, "maxPoints": 4 }
    ]
  }
}
```

Three properties make it usable from the other end of a network:

* **`id` is derived from the grading**, not from the delivery: `(event,
  attemptId, gradedAt)`. A retry keeps the same id, so a consumer that stores
  events dedupes by id and can never apply one grading twice.
* **The body is canonical JSON** (keys sorted, `undefined` dropped). The bytes
  signed are the bytes sent.
* **The timestamp is inside the signature**, so it cannot be edited to widen the
  replay window.

### Verifying a delivery

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verified(secret, header, rawBody, toleranceSec = 300) {
  const match = /^t=(\d+),sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(match[2].toLowerCase()));
}
```

Sign the **raw** body — re-serialising the parsed JSON is a different byte string
and will not verify. Refuse anything outside the tolerance even though the HMAC
is right: that is what the timestamp is for.

**Answer 2xx or nothing useful happens.** A `200` settles the delivery as
`DELIVERED`. Anything else — including a timeout after five seconds — is
recorded as `FAILED` with your status and your own response text, and the
grading is *not* affected. Do the work idempotently and answer quickly.

## When a delivery is missed

Nothing is retried on a timer. A consumer that was down, and an operator who was
not watching, can both see exactly what is outstanding:

```bash
curl -H "Authorization: Bearer $ONTRAK_API_TOKEN" \
  "https://training.example.edu/api/v1/webhook-deliveries?status=FAILED"
```

```json
{ "deliveries": [ { "eventId": "evt_9c1f…", "attemptId": "cmumaw…", "status": "FAILED",
                    "attempts": 3, "lastStatus": 502, "lastError": "HTTP 502: bad gateway" } ],
  "outstanding": 1, "configured": true, "url": "https://lms.example.edu/hooks/ontrak" }
```

Then send them again, at most 100 at a time:

```bash
curl -X POST -H "Authorization: Bearer $ONTRAK_API_TOKEN" \
  "https://training.example.edu/api/v1/webhook-deliveries?limit=20"
```

`attempts` counts tries rather than successes, so a consumer that was down for an
hour is visible as five attempts and not as one sent message. Gaps are also
closable the other way — `GET /api/v1/results?since=…` is the same data, and a
consumer that trusts the API more than its own inbox can run entirely on it.

## Rosters in and out

`GET /api/v1/roster/export` writes exactly the columns the importer reads, so the
file an administrator opens is the file they can hand straight back:

```csv
email,name,role,cohorts,active,local_password
ada@acme.test,Ada,STUDENT,Autumn;Spring,yes,yes
```

Read by column name, so a spreadsheet with the columns in another order works.
Blank `role` is a learner; a blank `name` is derived from the address; `cohorts`
are separated by `;` because a class name may contain a comma; `local_password`
is written but **never read**.

```bash
curl -X POST -H "Authorization: Bearer $ONTRAK_API_TOKEN" \
  -H "Content-Type: text/csv" --data-binary @roster.csv \
  "https://training.example.edu/api/v1/roster?dryRun=1"
```

```json
{ "dryRun": true, "rows": 240, "created": 231, "updated": 9, "memberships": 118,
  "refused": [ { "line": 42, "reason": "not-an-email is not an email address" } ],
  "unmatchedCohorts": ["Spring intake"] }
```

* Unusable rows are **named by line** and the rest still import. An import that
  half-applies and then dies is worse than one that reports and continues.
* A cohort name the import does not recognise is **reported, not invented**. The
  class may be created later under the instructor who owns it; a membership
  pointing at a row nobody owns would be a class with no teacher.
* `?dryRun=1` writes nothing and reports the same counts, which is how a
  five-thousand-row file should be checked the first time.
* A user created here has **no local password**, exactly like one provisioned by
  the identity provider: a roster says who exists, not what their secret is. A
  deployment with no provider sets passwords from the admin console afterwards.
* An update touches only `name`, `role` and `active`. A re-import cannot clear a
  password or break the link between an account and the provider's subject.

`refused` entries never stop a later correct row for the same address from
importing — only a *second accepted* row for one address in the same file is
refused, because that is a file disagreeing with itself.
