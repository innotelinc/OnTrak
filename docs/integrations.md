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

Each result carries the learner, the scenario, the cohort, the mode that graded
it, the score, the pass mark, per-check outcomes, and the certificate if one was
issued. It is the same object the webhook's `data` field holds, so one parser
serves both; the CSV export carries the same fields, with `mode` appended as the
last column.

`mode` is always present (`simulated` or `lab`) and never null. A simulated pass
and a pass on a real machine were produced by different graders, so a consumer
that aggregates scores has to keep them apart — the field is there so it can.

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
    "mode": "simulated",
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

### Registering the passback key

The incoming launch and the outgoing score are secured in opposite directions,
which is easy to get half-right. The platform signs the assertion and *we* verify
it against the platform's key set; to write a score we then sign a client assertion
with **our** key, and the platform can only check it if it was handed our public
half first. One keypair covers both halves of that exchange, and `make lti-key`
mints it:

```bash
make lti-key                 # id: ontrak-training-1, or override ONTRAK_LTI_KEY_ID
```

It writes nothing to disk. It prints two things that go to two places:

1. **the deployment.** `ONTRAK_LTI_KEY_ID` and the escaped one-line
   `ONTRAK_LTI_PRIVATE_KEY` go in the deployment's `.env`, beside
   `ONTRAK_LTI_TOKEN_ENDPOINT` — the platform's token endpoint, from the
   registration. With those three set, a graded attempt writes its score.
2. **the platform.** The printed **public JWKS** goes to whoever administers the
   LTI registration, pasted in under the *same* key id. Most platforms take a JWKS
   or a JWK here rather than a certificate.

**Better than a paste, where the platform offers it:** the deployment serves its own
public key set at `GET /api/lti/jwks.json` — `<ONTRAK_TRAINING_BASE_URL>/api/lti/jwks.json`
— so a registration can point at a *Keyset URL* and hold no copy of the key. The
route derives the public half from `ONTRAK_LTI_PRIVATE_KEY` on the way out, which
makes it the same key as the paste (byte for byte the same output as
`make lti-key ARGS=--from-env`), so the two ways of registering cannot disagree. It
answers `503` naming what is wrong when the deployment has no usable registration or
no keypair, and nothing needs a credential to read it — a key set is public by
construction.

A tool whose `kid` the platform does not have is refused at the token endpoint, and
that refusal is indistinguishable from a wrong key — so the two halves are
registered together or not at all. The public half is safe to share; the private
half is a credential and belongs in the environment, never in the repository.
`ONTRAK_LTI_TOKEN_ENDPOINT` set without a private key is not an error that stops a
launch: it is a launch that works and a grade that stays here, and the app says so
rather than pretending.

A key a deployment already holds can be re-published without minting a second one —
which would leave the two sides disagreeing:

```bash
make lti-key ARGS=--from-env            # the public JWKS for ONTRAK_LTI_PRIVATE_KEY
make lti-key ARGS="--from-env --pem"    # ...as a PEM, for Moodle's "RSA key" field
```

Moodle offers a field for each shape: *Public key type: Keyset URL* takes the URL
above, and *Public key type: RSA key* takes the PEM printed by
`make lti-key ARGS="--from-env --pem"`. The end-to-end Moodle walkthrough — which
field takes which URL, which identifier goes in which variable, the role mapping,
and how to rotate the key — is [docs/moodle-lti.md](moodle-lti.md).

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

### Driving it from Entra or Okta

Both connectors take the same two settings, and both should read the discovery
document before anything else — it needs no token, so a connector cannot fail it by
getting the credential wrong, and it is where `Patch` support and the `Bulk`/`sort`
refusals are stated rather than discovered by trial:

| Setting | Value |
| --- | --- |
| Tenant / SCIM base URL | `<ONTRAK_TRAINING_BASE_URL>/api/scim/v2` |
| Authentication | Bearer token (header token) |
| Token | the value of `ONTRAK_SCIM_TOKEN` on this deployment |

```bash
curl -sS "https://its.example.test/api/scim/v2/ServiceProviderConfig" | jq '.patch, .filter'
```

**Microsoft Entra ID** — a non-gallery enterprise application:

1. **Entra admin center → Enterprise applications → New application → Create your
   own application**, and choose "Integrate any other application you don't find in
   the gallery (Non-gallery)". Name it for this training app.
2. **Provisioning → Get started → Provisioning Mode: Automatic.**
3. Under **Admin Credentials**, set **Tenant URL** to the base URL above and
   **Secret Token** to `ONTRAK_SCIM_TOKEN`, then **Test Connection**. Entra reports
   the failure it received, so a `401` here is the token and a `400` is the URL.
4. **Mappings.** Entra's defaults are close, with one exception. Keep
   `userName ← userPrincipalName` (it is exactly this app's `userName`) and map
   `externalId ← mailNickname` (or `objectId`), which is what makes a second sync
   update the identity it already created rather than making a twin. Entra's default
   mapping also references `name.givenName` and `name.familyName`, which this app
   does not emit — it carries `name.formatted` and `displayName` — so point the name
   at `displayName` and leave the sub-attributes unmapped.
5. **Settings.** Scope the sync to the groups that should be provisioned rather than
   "all users": this app cannot tell a test push from a real one, so a first sync
   against everybody is a real sync. Enable provisioning; the first cycle can take
   up to 40 minutes.

**Okta** — a SCIM 2.0 Test App with header authentication:

1. **Admin Console → Applications → Create App Integration → SCIM 2.0 Test App
   (Header Auth).** Header auth is the right variant: this app authenticates with a
   bearer token, not Basic auth or OAuth.
2. On the **Provisioning** tab, choose **Configure API Integration**, tick **Enable
   API Integration**, enter the base URL and the token, then **Test API
   Credentials** and **Save**.
3. Under **To App**, enable **Create Users**, **Update User Attributes** and
   **Deactivate Users**.
4. **Push Groups** for class membership, and see the note on groups below first.

**Attribute mapping.** This app serves an allowlist rather than an echo, and only
`name.formatted` is emitted under `name` (no `givenName`/`familyName`), and there is
no `emails` array — the address *is* `userName`:

| SCIM attribute | What it is here |
| --- | --- |
| `userName` | the account's email address; required, and must be an email |
| `externalId` | the directory's own immutable id; matched **first**, so a rename moves the account instead of duplicating it |
| `displayName` / `name.formatted` | the person's name |
| `roles` (or `role`) | `STUDENT`, `INSTRUCTOR` or `ADMIN`; a push that names none creates a `STUDENT` |
| `active` | whether the person may sign in here; `false` — or a `DELETE` — deactivates and never erases their attempts |

**Groups are cohorts, not the directory's to invent.** A connector may replace *who
is in* a class, but a cohort has to exist first — `POST /Groups` is refused
`mutability`, because a class with no owning instructor is a class with no teacher.
Create the cohort in this app (an instructor owns it), then let the connector push
its membership; the members who stay keep their `joinedAt` and mentor flag.

**The filter subset** a connector will actually exercise is a single `eq` on
`userName`, `externalId`, `displayName` or `id` — Entra's schema-prefixed form
(`urn:ietf:params:scim:schemas:core:2.0:User:userName`) is stripped and accepted.
`co`, `sw`, `pr`, `and`, `or` and parentheses are refused `invalidFilter` rather than
answered with a narrower result. Pages are 1-based `startIndex`/`count`, default 100
and at most 200; `count=0` returns the totals alone. Sorting is not implemented, and
neither Entra nor Okta needs it.

**Finally: the schedule is the directory's.** This surface never reaches out — it
accepts whatever the connector sends, when the connector sends it. Set the sync
interval in Entra's or Okta's provisioning settings; a deployment that stops
receiving pushes simply stops changing, which is why the audit trail
(`scim.user.provision`, `scim.user.update`, `scim.user.deprovision`,
`scim.group.members`) is the way to see whether the schedule is still running. For
an operator's walkthrough — minting the token, where it lives, and how to rotate it —
see [docs/family-operations.md](family-operations.md).
