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

## The chain: what happens to the certificate next

A code a learner can paste into `/verify` is worth exactly what the database that
issued it is worth. The family's trust chain is the other half: **AthenIQ issues** the
credential (the learning platform whose enrolment entitled the learner to the range),
**Signara signs** it (the stack's only document-signing surface), and **ONYX stores**
the signed artifact (the stack's only object storage).

The range drives that chain itself, from
[`src/lib/certificate-chain.ts`](../src/lib/certificate-chain.ts) — AthenIQ's own
certificate bridge signs *course* completions, and a lab session is not one: it is this
product's grade of a live machine, reported over the route above. Writing into another
product's tables to describe work it never saw is the thing being avoided, so instead
the sheet goes straight to Signara and the result is stored here. `ONTRAK_CERT_ISSUER`
keeps AthenIQ's name on the credential it is entitled through, and the sheet prints it.

**It runs after the row is written, and it never decides whether anybody passed.** The
completion and its code stand whether the chain signs or not; every outcome is a value
that is recorded rather than an exception that could roll a learner's result back. A
signing key that expired is an operator's morning, and a result destroyed by somebody
else's outage is not the same failure.

### The settings

The chain is **off** until every one of these is set — a half-configured chain is
refused rather than started, because a certificate that is neither local nor signed is
one nobody can use:

| Setting | What it is |
| --- | --- |
| `ONTRAK_SIGNARA_API_URL` | Signara's API base |
| `ONTRAK_SIGNARA_API_KEY` | A machine key minted in Signara's portal |
| `ONTRAK_CERT_SIGNER_NAME` / `ONTRAK_CERT_SIGNER_EMAIL` | Who signs — a person, not the product |
| `ONTRAK_ONYX_S3_ENDPOINT` / `_ACCESS_KEY` / `_SECRET_KEY` | ONYX's S3 surface and its own pair |
| `ONTRAK_ONYX_S3_BUCKET` / `_REGION` | Where artifacts live (`ontrak-certificates` by default) |
| `ONTRAK_CERT_ISSUER` | Who issued it — `AthenIQ` by default |
| `ONTRAK_TRAINING_VERIFY_URL` | Printed on the sheet, so the sheet carries the way to check itself |

The bucket is the one thing the chain assumes and cannot make for itself, so it is
bootstrapped once per ONYX with this repository's own SigV4 code:

```
npm run certs:bucket      # PUT /<bucket>, then reads the store back
```

It signs with the same `sigv4Headers` the uploads use, so a bucket that appears is
proof ONYX accepts this implementation before a certificate depends on it. Re-running
it is safe: an existing bucket is reported as such. The artifact is
`certificates/<year>/<code>.pdf` — the learner's code, not the attempt id, because the
code is what somebody holding a printed sheet actually has — with the provenance record
beside it as `.json`.

### The four outcomes

| Outcome | Meaning |
| --- | --- |
| `off` | Nothing is configured. Silent, on every completion: the deployment keeps the local record exactly as it did before this existed. |
| `misconfigured` | Some of it is set. The recorded reason **names the variables**, because "the certificate was not signed" without that is a support ticket rather than a fix. The chain does not start. |
| `signed` | Signara signed it (a request id) and the artifact is on ONYX (an object key). |
| `signed-unstored` | Signed and not stored — an ONYX credential to fix, named so somebody can finish the job. |
| `refused` | One leg said no: `upload` (the PDF), `request` (the signing request) or `sign`. The reason is the provider's own words. Every outcome except `signed` is also written to stderr, so it is in the container log and not only in the audit chain. |

All of them are recorded against the attempt as `attempt.certificate_chain` in the
append-only audit chain — so "was this certificate signed, and where is it kept?" is a
question this product answers rather than one an operator asks three services.

## Caveats

- **Driven end to end against the live stack, and refused at Signara's door — for a
  provisioning reason, not a code one.** A real completion was filed
  (`sess-2026-10-13-chain-verify-1`, `linux-perms-chmod-repair`, 9/10, answered `201`) and
  the chain ran. It stopped at the **upload** step with Signara's own sentence:

  > No active tenant. Join or create an organization to use this endpoint.

  The key itself is accepted — Signara's `/api/v1/auth/me` answers with the key's own
  identity (`apikey:…`, display name `ontrak-training-cert-chain`) — but the account it
  belongs to is in no organization, and every document and signature endpoint is
  tenant-scoped, so it answers `403` to all of them.

  **It cannot be fixed from this side, and the key cannot fix it for itself.**
  `POST /api/v1/organizations` is the one endpoint that would create the tenant, and it
  refuses the key's own principal deterministically — `500 An unexpected error occurred`
  for every name tried (`{"name":"OnTrak"}`, with a slug, with a space) — while the
  tenant-scoped endpoints stay `403` afterwards. Its validation is otherwise happy with
  just a name, so this is Signara's own failure to create an organization for the
  principal an API key presents. **Setting up the tenant is therefore an operator's job in
  Signara's portal**, with a user account, followed by a key whose account is in that
  organization; the range cannot get past the upload until then, and the refusal it will
  record is the sentence above.

  Nothing about the chain's own steps has been reached yet, either: the document,
  signing-request and signature calls are pinned by `tests/certificate-chain.test.ts`
  against a stub transport, and no live run has got past the first.

  The refusal is recorded exactly as designed, which is the half worth noting: the outcome
  is `refused` in the append-only audit chain against the attempt, with the provider's own
  words, and the same line goes to stderr. (The first version of that reader reported only
  `FORBIDDEN (403)` — NestJS puts the sentence in `message`, as an array — so the reason
  above is what the fix now records.)
- **The ONYX leg is proven against the live store.** `npm run certs:bucket` puts the
  bucket with the same SigV4 code the uploads use: it exists, the signature is accepted,
  and a `GET` lists it.
- **Reported from a live lab host, once.** The route has been driven end to end twice.
  First with a hand-typed body: `sess-2026-10-08-0001` against `net-dns-failure`, answered
  `201`, retry `200` with the same `attemptId`, `GRADED` with `gradingMode = 'lab'` and a
  certificate whose content carries `mode: "lab"`, and a completion against a simulated
  scenario refused `422`.

  Then from a lab host with a real machine behind it: a session was allocated, graded and
  completed on the lab's own command line, and the installed client
  (`/opt/ontrak-lab-client`, copied from this repository) reported it as
  `capstone-linux-perms-chmod-repair-1`. The family answered `201` — attempt GRADED,
  `gradingMode = 'lab'`, four `CheckResult` rows carrying the lab's objective ids and
  points — and the retry `200` with the same attempt id. The scenario it was filed
  against had to be in the catalogue first (`npm run lab:import`, which is what makes a row
  carry the `lab` tag at all). The rules are also covered by unit tests
  (`tests/lab-completion.test.ts`).
- **What the lab host did not exercise.** No Windows or Office session: the golden image
  needs operator-supplied Microsoft media and a 30–60 minute build, and the host used here
  reports nested-AMD KVM without SMM, so it would take the lab's emulated path. The
  console (Guacamole) was up on the lab host but driven by no browser, so the websocket
  tunnel through its own gateway is still unmeasured. The reporting script that made the
  call lives on the lab host rather than in either repository, because it needs the lab's
  own session store; this document is the contract it follows.
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
