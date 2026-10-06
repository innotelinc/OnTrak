# Integrations — the public API, webhooks, LTI 1.3, and directory sync

Training evidence is only useful if it leaves the platform. This app is the
system of record for **who was trained, on what, when and how well**; everything
below exists so an LMS, a skills matrix or a spreadsheet somebody maintains can
be told about it without a human in the middle.

Three surfaces, one dataset:

* a **webhook** so a consumer hears about a grading as it happens, and
* a **read API** so the same consumer can catch up after it was down, plus a
  **CSV** path for the people who will never run an integration, and
* a **SCIM 2.0** surface so a directory can push people *in* without a human or a
  spreadsheet.

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

## Launching a scenario from an LMS

A webhook tells a system *that* something happened. LTI is the other direction:
the learner never opens this app directly — they click a link in their course, and
the LMS launches them here. This deployment is the LTI **tool**; the LMS is the
platform. Two routes, and both are refused with 503 and a reason when
`ONTRAK_LTI_ISSUER` is unset, so a deployment with no platform is untouched.

```
POST /api/lti/login    the platform's third-party-initiated login
POST /api/lti/launch   where the platform posts the signed assertion
```

Register **`<ONTRAK_TRAINING_BASE_URL>/api/lti/launch`** as the tool's redirect
URI, and give the platform the public half of `ONTRAK_LTI_PRIVATE_KEY` under
`ONTRAK_LTI_KEY_ID`. Nothing else is discovered: LTI 1.3 has no discovery
document, so the endpoints and the deployment ids are configuration.

What a launch does here:

* The assertion is verified against the platform's JWKS, then its `iss`, `aud`,
  `azp`, `nonce`, `deployment_id`, version and message type are checked against
  the registration. Each refusal is its own sentence — a wrong nonce, a launch
  from another platform, deep linking — rather than one generic "invalid".
* The LIS role becomes this product's role: `Instructor` and its cousins to
  INSTRUCTOR, `Administrator` to ADMIN, `Learner`/`Member` to STUDENT. An
  instructor who is also a learner is an instructor; a role this deployment does
  not know becomes `ONTRAK_LTI_DEFAULT_ROLE`.
* The account is found or created by the platform subject (namespaced
  `lti:<issuer>#<sub>`, so two platforms' subject `1` are two people) and matched
  by email on a first launch. The learner then lands on their own home page.

**A launch and a sign-in through a directory are two ways in, and a deployment
should offer one.** A person who arrives through both is matched by email, so they
are one account either way, but the stored provider subject follows whichever
signed in last. See `docs/integrations.md`'s sibling, the SSO section of the
README.

### The grade goes back

If the launch carries an Assignment & Grade Services endpoint with the score
scope, the grading context — which platform, which subject, the line item — is
kept with the browser and copied onto the **attempt** when the learner starts one.
Grading then writes the score to that line item:

* a `client_credentials` access token minted per write, from an RS256 assertion
  signed with `ONTRAK_LTI_PRIVATE_KEY`;
* `application/vnd.ims.lis.v1.score+json` with both `activityProgress` and
  `gradingProgress` set to their completed values, because a platform holds a
  score without them as provisional and it never reaches a gradebook;
* a `timestamp` of when the attempt was graded, so the platform orders it the way
  this product did.

A passback that cannot happen never fails a grading. It leaves the grade exactly
where it is and says which of the three reasons applies — there was no line item,
the launch was not granted the score scope, or this deployment has no platform
credentials. The learner's score is real whether or not somebody else's server
took a copy of it.

## A directory that pushes people in

Everything above is this app being *asked*. A directory is the other direction:
it decides who exists and tells this app, over **SCIM 2.0**. Set
`ONTRAK_SCIM_TOKEN` and the app becomes a SCIM 2.0 **service provider** at
`/api/scim/v2` — the same protocol OnTrak Sentinel speaks at its own `/scim/v2`,
so a connector can be pointed at either.

```
GET    /api/scim/v2/ServiceProviderConfig   what this surface supports
GET    /api/scim/v2/Users                   list, filtered and paged
POST   /api/scim/v2/Users                   create one person
GET    /api/scim/v2/Users/{id}
PUT    /api/scim/v2/Users/{id}              replace (PUT semantics)
PATCH  /api/scim/v2/Users/{id}              add / replace / remove
DELETE /api/scim/v2/Users/{id}              deactivate (204)
GET    /api/scim/v2/Groups                  the classes that exist
GET    /api/scim/v2/Groups/{id}
PATCH  /api/scim/v2/Groups/{id}             replace the membership
```

Authenticate every call but discovery with the token:

```bash
curl -H "Authorization: Bearer $ONTRAK_SCIM_TOKEN" \
     -H "Content-Type: application/scim+json" \
     "https://training.example.edu/api/scim/v2/Users?filter=userName%20eq%20%22ada%40example.edu%22"
```

Like the read API, an unconfigured deployment answers `503` with a reason and a
wrong token answers `401` with a `WWW-Authenticate: Bearer` challenge — "nobody
set a token" and "your token is wrong" are different problems, and only one is
the caller's. `GET /api/scim/v2/ServiceProviderConfig` needs no token and is
where a connector should look first: it advertises `Patch` support honestly and
says `Bulk`, `changePassword` and `sort` are **false**, so a connector does not
discover that by trial and error.

A push does what a roster import does, and the reasoning is the same:

* An account provisioned here has **no local password** — a directory says who
exists, not what their secret is.
* People are matched by `externalId` first, then by email, so a rename at the
directory **moves** the account (and its attempts and certificates) instead of
creating a second one. A create that would collide with an existing email or
`externalId` is refused `409` with SCIM's `uniqueness`. The `externalId` this app
stores for a directory push is the directory's own id; an LTI or SSO subject is
namespaced separately, so the two never fight over one column.
* `active: false` — or a `DELETE`, which is the same decision — **deactivates**
the account; it never erases the attempts and certificates behind it. Sentinel
owns the harder "end the sessions and revoke the tokens" behaviour for the family
identity; this surface only stops the person signing in here.
* `resourceRole` (or a `roles` array) carries the role; `STUDENT` is the default
for a push that names none, and the vocabulary is the same three roles the app
uses everywhere.
* Filtering is deliberately a **subset**: `eq` on `userName`, `externalId`,
  `displayName` and `id`, with the `:` schema prefix Entra sends
  (`urn:ietf:params:scim:schemas:core:2.0:User:userName`) stripped first.
  Anything else is refused `invalidFilter` rather than silently ignored.
* Both PATCH shapes are read: Entra's path form
  (`{op, path, value}`) and Okta's object form (`{op, value: {…}}`). Unsupported
  operations are refused by name — an `add` where the attribute may not be added,
  an unknown path.

**Classes are not the directory's to invent.** A `Group` here is a cohort owned by
an instructor, so `POST /Groups`, renaming a group and deleting one are all
refused `mutability`: a sync may replace *who is in* a class (membership is
replaced wholesale, and the members who stay keep their `joinedAt` and mentor
flag), but it may not create a class nobody teaches or disband one. A membership
naming a person who does not exist is refused `invalidValue`.

Every accepted push is audited as `scim.user.provision`, `scim.user.update`,
`scim.user.deprovision` or `scim.group.members`, so "where did this account come
from?" has an answer.

Finally, note what this surface is **not**: it does not poll. A scheduled sync is
the directory's job — this app accepts a push whenever the directory sends one,
and a deployment that stops receiving pushes simply stops changing. The
[OnTrak Sync](ontrak-sync/README.md) host-inventory product is the family's
scheduled-sync example if a connector needs a model.
