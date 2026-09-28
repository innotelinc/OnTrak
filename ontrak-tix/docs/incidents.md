# Incident response (M3)

An incident is not a ticket with a scarier label. It is a **declared** event with
a severity someone chose, a phase it moves through, and named people who own
parts of the response — and a timeline written as things happened, never
reconstructed afterwards.

This covers the parts of **M3 — Incident response & defensible documentation**
(see `ROADMAP.md`) that have landed: the lifecycle, the severity matrix, the
incident roles, runbook-style **playbooks with step tracking**, **evidence
collection with a chain of custody, object-lock (WORM) storage and legal hold**,
regulatory **notification duties** with **drafted notices**, the **post-incident
review** with tracked actions, the **war-room timeline** assembled from the
incident log, the audit chain, the alert stream and the decisions taken, the
**retention sweep** that acts on a closed lock without being asked, and the
one-click signed **Assurance Packet** — all surfaced in a console at
`/incidents`, checkable by a third party with `npm run verify:packet`, and
sweepable with `npm run sweep:retention`.

## Pieces

| Concern | Where |
| --- | --- |
| Pure rules: severity matrix, phases, roles, validation | `src/lib/incident-rules.ts` |
| Service: declare, advance, staff, timeline | `src/lib/incident-service.ts` |
| Prisma adapter | `src/lib/incident-store-prisma.ts` |
| Pure rules: playbook steps, plan by severity, progress | `src/lib/playbook-rules.ts` |
| Pure rules: evidence validation, custody, legal hold, manifest | `src/lib/evidence-rules.ts` |
| Pure rules: object lock (keys, retention modes, put/purge decisions) | `src/lib/object-lock-rules.ts` |
| The write-once filesystem object store | `src/lib/object-lock-file.ts` |
| Service: start/step the playbook, record evidence, custody, holds, artifacts, manifest | `src/lib/incident-docs-service.ts` |
| Prisma adapter | `src/lib/incident-docs-store-prisma.ts` |
| Pure rules: notification regimes, duties and their clocks | `src/lib/regulatory-rules.ts` |
| Pure rules: the notices a duty drafts (templates, placeholders, readiness) | `src/lib/comms-rules.ts` |
| Pure rules: the review, its findings and tracked actions | `src/lib/review-rules.ts` |
| Service: track/send/waive notifications, publish the review, run its actions | `src/lib/compliance-service.ts` |
| Pure rules: assemble the war-room timeline from other sources | `src/lib/war-room-rules.ts` |
| Service: read the log, the chain, the alerts and the decisions, and merge them | `src/lib/war-room-service.ts` |
| Offline packet verifier for a third party | `scripts/verify-packet.ts` (`npm run verify:packet`) |
| Retention sweep: decide what the clock allows, then carry it out | `planRetentionSweep` (`src/lib/object-lock-rules.ts`), `IncidentDocsService.sweepRetention` |
| Scheduled entry point and operator script | `src/app/api/incidents/retention-sweep/route.ts`, `scripts/retention-sweep.ts` (`npm run sweep:retention`) |
| Models | `prisma/schema.prisma` (`Incident`, `IncidentEvent`, `PlaybookStep`, `EvidenceItem`, `CustodyEntry`, `LegalHold`, `EvidenceArtifact`, `IncidentNotification`, `IncidentReview`, `IncidentReviewAction`) |
| Console | `src/app/(desk)/incidents/page.tsx`, `src/components/IncidentList.tsx`, `src/app/actions/incidents.ts` |
| Manifest download | `src/app/api/incidents/[id]/manifest/route.ts` |
| Pure rules: the packet, its digests, its signature | `src/lib/assurance-rules.ts` |
| The signing key (HMAC over `contentHash`) | `src/lib/assurance-sign.ts` |
| Service: assemble the packet from the record and the audit chain | `src/lib/assurance-service.ts` |
| Packet download | `src/app/api/incidents/[id]/packet/route.ts` |
| Tests | `tests/tix-m3-incidents.test.ts`, `tests/tix-m3-playbooks.test.ts`, `tests/tix-m3-object-lock.test.ts`, `tests/tix-m3-war-room.test.ts`, `tests/tix-m3-compliance.test.ts`, `tests/tix-m3-comms.test.ts`, `tests/tix-m3-retention.test.ts`, `tests/tix-m3-assurance.test.ts`, `tests/tix-m3-verifier.test.ts`, `tests/tix-m3-retention-live.test.ts` (opt-in) |
| Browser sweep (opt-in, `ONTRAK_TIX_BASE_URL`) | `tests/browser/tix.spec.ts` at the repo root — WCAG A/AA on the staff surfaces plus the flows end to end |

## Severity from a matrix

Severity is not a mood. It comes from **impact × urgency**:

| | CRITICAL | HIGH | MEDIUM | LOW |
| --- | --- | --- | --- | --- |
| **EXTENSIVE** | SEV1 | SEV1 | SEV2 | SEV2 |
| **SIGNIFICANT** | SEV1 | SEV2 | SEV2 | SEV3 |
| **MODERATE** | SEV2 | SEV2 | SEV3 | SEV3 |
| **MINOR** | SEV3 | SEV3 | SEV4 | SEV4 |

It is a table rather than a formula because a desk argues about the table, not
about the arithmetic. The inputs are stored on the incident next to the outcome,
so "why was this a SEV2?" has an answer six months later — and an explicit
severity may override the matrix, which is recorded too.

`targetAcknowledgeMinutes` gives the duty roster a commitment per severity
(SEV1 in minutes, SEV4 in hours). It is not a customer SLA; an incident is not a
promise to a customer.

## The lifecycle

```
DETECTED ──▶ TRIAGED ──▶ CONTAINED ──▶ ERADICATED ──▶ RECOVERED ──▶ REVIEWED
                ▲            │              │              │
                └────────────┘◀─────────────┘◀─────────────┘   (a regression)
```

Moves are forward by one rung, with one deliberate exception: an incident can go
**back to `CONTAINED`** from any later phase, because something "eradicated" that
comes back is the same incident contained again — not a new one. `REVIEWED` is the
only end state, and even it re-opens to `CONTAINED`.

`advance` stamps `resolvedAt` on `RECOVERED` and `reviewedAt` on `REVIEWED`, so
the two numbers a post-incident review needs are captured at the moment they
happened rather than inferred from the timeline.

## Roles, and one real gate

Four roles: **commander**, **comms lead**, **scribe**, **liaison**. For a SEV1 or
SEV2 the first two required are commander and scribe, and a **SEV1/SEV2 cannot be
triaged** while they are unfilled. An incident with no commander is how a response
stalls silently, so the lifecycle refuses to pretend it is under way.

## The timeline

Every operation that changes an incident also appends an `IncidentEvent`
(`declared`, `phase`, `role`, `note`). The events are append-only — corrections
are new events — and the same operations emit hash-chained audit events
(`incident.declare`, `incident.phase`, `incident.role`), so the incident's story
is both readable by a responder and tamper-evident for an auditor.

## Playbooks with step tracking

A playbook is the runbook for the incident, and it is planned **by severity**
rather than written per incident. `DEFAULT_INCIDENT_PLAYBOOK` in
`playbook-rules.ts` is a nine-step response — declare, notify, assess, comms,
contain, preserve, eradicate, restore, review — and each template carries the
severity it first applies at (the stakeholder-comms step starts at SEV2, for
instance), so a SEV4 does not get a comms plan it does not need.

`planPlaybook(severity)` turns those templates into the incident's steps.
Declaring an incident **auto-starts** it, so an incident always has a runbook;
`startPlaybook` is idempotent, returning the existing steps unchanged if it is
called again.

A step is `PENDING`, `DONE` or `SKIPPED`, and the transitions are deliberately
narrow:

- a step is completed or **skipped with a reason** — a skip without a reason is
  refused, because "we didn't do it" is the answer an auditor asks about;
- a `DONE` or `SKIPPED` step is **not** flipped back by completing it again; it
  has to be **reopened** first, which leaves both the original outcome and the
  reopening in the record rather than quietly overwriting one with the other.

`playbookProgress` rolls the steps up to `done`/`skipped`/`total` and `nextStep`
names what a responder should do next. Every start, step change and reopening
writes an `IncidentEvent` (`playbook`) and a hash-chained `incident.playbook.*`
audit event, so the runbook's history is as defensible as the incident's.

## Evidence, and the manifest

Evidence is recorded, not uploaded: an item has a **kind** (`LOG`, `SNAPSHOT`,
`SCREENSHOT`, `FILE`, `NOTE`, `LINK`), a **label**, a **reference** (a storage key
or URL), an optional **SHA-256**, the collector and the collected-at time. The
rules require the label and reference and reject a malformed hash, so a row that
cannot be pointed at a real artifact does not enter the record.

Recording evidence appends an `IncidentEvent` and an `incident.evidence.record`
audit event, and the items roll up into a **manifest** — printer-friendly JSON at
`GET /api/incidents/<id>/manifest`, also offered as a download from the console.
The manifest carries each item's own digest plus a single `manifestHash`.

One detail is load-bearing: the `manifestHash` deliberately **excludes**
`generatedAt`. It is a fingerprint of *what is in the packet*, not of when someone
pressed the button — so re-exporting an unchanged incident produces the identical
hash and the hash can be quoted next to a packet. `generatedAt` still travels in
the document, and the mint is written to the audit chain as `incident.manifest`
with the digest, so a manifest that was produced is itself recorded.

## Chain of custody and legal hold

Recording evidence writes its **first custody entry** in the same operation as
the item, so a trail can never start mid-way. Custody then changes by
**hand-off**: `fromActor` and `toActor`, a timestamp, and a required reason.

A hand-off is refused when the trail is already broken, and a transfer must start
from the item's *current* holder — the holder is derived by walking the trail
(`custodyIntegrity`), not by trusting the last row written. A gap in the trail is
therefore a real error rather than a cosmetic one. Recording a transfer also
appends an `IncidentEvent` (`custody`) and an `incident.custody.transfer` audit
event, so "who held the disk, and why did it move?" is answerable from the
incident and from the chain.

A **legal hold** is a deliberate act with a reason and a name attached. It
outranks routine retention: `retentionDecision` reports `blocked` for as long as
one is in force, whatever the dates say. Placing a second hold while one is
active is refused (one is enough information for a reader), and releasing one is
recorded by setting `releasedBy`/`releasedAt` rather than deleting the row — the
history of holds is part of the record, and the audit log carries
`incident.hold.place` and `incident.hold.release`.

## Object lock: the bytes themselves

A reference is a claim; the bytes are the evidence. Uploading a file to an
incident stores it under **object lock** (`object-lock-rules.ts`,
`ONTRAK_TIX_EVIDENCE_DIR`).

- **The key is derived from the content** — `evidence/<tenant>/<incident>/<sha256>`
  (`artifactKeyFor`). "Put different bytes under an existing key" is therefore not
  a request a caller can make, and re-uploading identical bytes is the *same
  object*: it records another collection rather than colliding or replacing
  anything.
- **Two retention modes.** `COMPLIANCE` cannot be removed early by anyone,
  including an administrator — that is the point of it. `GOVERNANCE` is locked for
  the same window, but a privileged caller may remove it early and the record says
  that they did. The default is `COMPLIANCE`, overridable per deployment with
  `ONTRAK_TIX_EVIDENCE_LOCK_MODE`; either way the window is written down as a date
  (`retainUntil`), so a reader does not have to know our defaults.
- **A legal hold outranks the clock in both directions.** `objectPurgeDecision`
  blocks an artifact still inside its window *and* one whose window has already
  closed, until somebody releases the hold on the record. "The clock ran out" and
  "you may destroy this" are different answers.

Removing bytes is deliberately stronger than recording them: it needs a
`tenant:manage` role, a reason, and a lock that permits it, and the removal is
written as a timeline entry (`Artifact purged`) plus an `incident.evidence.purge`
audit event carrying whether GOVERNANCE was bypassed. The row is not deleted —
`purgedAt` is stamped, so the manifest keeps listing the artifact and the
deletion is itself part of the record.

The write-once rule is enforced wherever it can actually be enforced. The
filesystem store opens each file with the `wx` flag, so two racing uploads cannot
both create it, and marks it read-only; honestly, a root user on the box can
still `chmod` and delete it. That is exactly why the retention decision is
enforced in the service and why the lock is a database row, and why
`objectLockHeaders` hands out the S3 `x-amz-object-lock-*` headers an object-locked
bucket needs — adopting one is a matter of handing those over, not rediscovering
the semantics.

Storing bytes is one operation, not two, because the halves must not be able to
drift: the evidence item's `reference` *is* the object key and its `sha256` is the
digest that key was derived from. Each store appends an `Artifact locked` timeline
entry and an `incident.evidence.store` audit event.

The browser sweep exercises this against a real server and a real database: it
uploads a file from the console, sees it stored under `COMPLIANCE` with its
retention date, uploads the same bytes again and is told they were already
stored, then asks to remove them — refused for an agent (a `tenant:manage` role
is required) and refused again for an administrator, in the rule's own words,
with the artifact still locked afterwards.

### The retention sweep

A lock that nobody acts on is the same as no lock: a purged artifact would sit
there for ten years because somebody had to press a button. `sweepRetention`
(`incident-docs-service.ts`) walks the tenant's artifacts **whose window has
closed and which are still stored**, and decides each one with the *same*
`objectPurgeDecision` a manual purge uses — so a scheduled sweep and an
administrator's button cannot disagree about a `COMPLIANCE` artifact.

What it does per artifact, in the same operation: deletes the bytes, stamps the
tombstone, appends an `Artifact purged` timeline entry, and writes an
`incident.evidence.purge` audit event with `sweep: true`. It then writes one
`incident.retention.sweep` event for the run itself — **including a run that
found nothing**, because a gap in a sweep's history is itself a finding. Every
one of those is written under `system:retention-sweep`: nobody pressed anything,
and the record should say so.

The report is the other half of it. Alongside the purges it returns what it
*left alone* and why — still inside the window, in a mode that will not shorten,
or held — because "why is this evidence still here?" is the question a sweep
gets asked. A legal hold stops it in both directions, exactly as it stops a
manual purge.

It is safe to schedule as often as you like: a purged artifact is out of the
worklist (its `purgedAt` is set), so a second run purges nothing. Three ways to
run it, all the same code path:

- `POST /api/incidents/retention-sweep` — the scheduler's entry point, `Bearer`
  authenticated with `ONTRAK_TIX_CRON_SECRET`. `?tenant=acme` limits it to one
  tenant and `?dryRun=1` reports without changing anything.
- `npm run sweep:retention -- --dry-run` — the same run from a terminal or a
  non-HTTP scheduler, using the deployment's own database and storage directly.
  Its exit codes separate "the sweep ran" (0) from "it could not run" (1/2).
- `IncidentDocsService.sweepRetention` — for a worker that already holds the
  service, and for the tests.

The Postgres integration test (`tests/tix-db.test.ts`) proves it against a real
database and a real filesystem: two incidents, one artifact each, a legal hold on
the second — the sweep removes the first's bytes *and* its row's contents, leaves
the held one's files alone, then takes them once the hold is released, with the
audit chain still verifying afterwards. And `tests/tix-m3-retention-live.test.ts`
(opt-in, like the SSO live test) proves the *endpoint*: it POSTs to a running app
the way a cron would, checks that an unauthenticated call is a 401 and an unknown
tenant a 404, that a dry run changes nothing, then that the real run removes the
file from the app's own evidence directory, stamps the tombstone, writes the
timeline line and the audit events, and purges nothing on a second run.

## The war-room timeline

The incident timeline is what the operations wrote. The **war-room timeline** is
the incident seen from every source at once: the incident log, the tenant's
hash-chained audit log, the alert stream, and the decisions taken about the
incident, merged into one ordered view (`war-room-rules.ts`).

Two rules give it its value:

- **The same fact seen by two systems is one entry**, attested by both, rather
  than two lines that look like two events (`correlate`).
- **Nothing is invented.** Reading a timeline writes nothing, so assembling it
  cannot change the record it is describing, and an event that only one source
  knows about is kept and labelled with that source.

It is staff-only and tenant-scoped, and the console renders it with the sources
behind each line, so "who knew, and when" is answerable without cross-referencing
four screens.

## Notification duties and the review

An incident usually owes somebody a call, with a deadline attached. Regimes are
**suggested from the incident's own facts** (`suggestedRegimes` — severity,
personal data, regulated sector), tracked deliberately rather than assumed, and
then run on a clock measured from detection (or declaration, per the regime):
`notificationState` reports `DUE_SOON` before the deadline and `OVERDUE` after it,
and marking one sent late records that it was late rather than pretending
otherwise. A duty can be waived, with a reason, and `notificationSummary` rolls
them up.

The **post-incident review** is published once, with findings and lessons, and it
carries tracked **actions** — an owner, a due date, a status that moves only the
legal way, and an `OVERDUE` state derived from the date rather than stored. An
incident is not finished while an action is open, which is what makes
`reviewCompleteness` and the packet's `packetCompleteness` mean something.

## The notice itself

A tracked clock only helps if the thing being sent is written for the duty. Each
regime therefore comes with a **draft** (`comms-rules.ts`): a subject, a body and
a line of guidance on what a message of that kind must not forget. The incident's
own facts are substituted in by the same `{{name}}` engine the M1 canned
responses use — `COMMS_PLACEHOLDERS` is a *superset* of the M1 variables, so a
desk's existing canned wording can be adopted unchanged as an incident draft
(`cannedAsCommsTemplate`).

Two details carry the design:

- **A template may leave a field open on purpose.** The subjects affected, the
  categories of data, the material impact — nobody can derive those from an
  incident row, and a breach notice that leaves them blank is not a notice. They
  are named as fill-ins, so the console says "3 fields to complete", and the
  service **refuses to record the notice as sent** while one is unresolved. The
  rule is mechanical: `commsIssues` reports what is still `{{unresolved}}`.
- **A missing value is left visible.** Substitution never blanks a placeholder it
  cannot fill, so a draft with a typo says `{{detectedAt}}` rather than reading as
  finished prose — which is how this rule set caught its own camel-case bug.

The console offers the applicable drafts on an open duty — with the generic ones
flagged as generic when no template names that regime — pre-fills an editable
textarea, and records the text **as sent** on the obligation, next to the duty it
answered. The timeline line names the draft it came from and the audit event
carries the template key, so the wording is traceable without trusting the email
system.

## Verifying a packet without us

The packet promises that a third party can check it holding nothing but the file
and the key. `npm run verify:packet -- PACKET.json` is that tool: it imports the
packet rules, the signer and the verifier and nothing else — no Prisma, no
session, no `db.ts`, no network — so it runs from a checkout that has never been
configured with this deployment's environment. It exits `0` for verified, `1` for
a failed verification and `2` for a usage or read error, because "the packet is
forged" and "the file is missing" are different answers and a script that
conflates them is not usable in a pipeline.

## The console

`/incidents` is staff-only (any staff role holding `ticket:read:any`; a requester
is redirected to the portal). It declares incidents, shows the header roll-up
(open, at SEV2 or above, without a commander), and per incident renders the
severity/phase chips (with a `legal hold` marker when one is in force), the four
role cards, the playbook, the evidence list — each item with its custody trail,
its current holder and a hand-off form — the **artifacts under lock** with the
retention each one carries, the notification duties and the review, the legal-hold
panel, the timeline, the assembled **war-room** view, and links to download the
manifest and the signed packet.

Two things it deliberately does **not** do:

- It offers only the **legal next moves**. The phase buttons are built from
  `canAdvance`, so "move to eradicated" never appears on a triaged incident — the
  page cannot propose a transition the service would refuse.
- An actor without `ticket:update` sees a read-only console: no declare form, no
  role pickers, no playbook or evidence controls.

## The Assurance Packet

`GET /api/incidents/<id>/packet` is the document that leaves the building. It
bundles the incident's facts and lifecycle, the playbook and what happened to
each step, the evidence manifest (with every item's digest), the custody trail and
any legal hold, the append-only timeline, an excerpt of the tenant's hash-chained
audit log for this incident **with the chain head it was read at and that head's
verification result**, and the policy versions in force.

The packet is assembled from the manifest plus the chain — one source for the
record, so a packet cannot disagree with the manifest it cites.

### Three hashes, three jobs

| Field | Covers | Moves when |
| --- | --- | --- |
| `recordHash` | the incident record (facts, playbook, evidence, custody, hold, timeline, policies) | the record changes |
| `contentHash` | the record **and** the audit anchor | the chain grows |
| `signature` | an HMAC over `contentHash`, with the deployment's key | never, for the same packet |

The split matters. `recordHash` is a *stable* fingerprint: export an unchanged
record today and next year and the two packets carry the same `recordHash`, which
is how an archived packet is compared against a fresh one. `contentHash` is about
*this* packet, since where in history it was cut is part of what it is. And the
signature covers `contentHash`, so nothing in the packet — anchor included — can
be edited without the key. `verifyAssurancePacket` checks all of it offline, from
the file alone.

`packetCompleteness` answers the roadmap's metric honestly: a packet is complete
only when the incident is reviewed, the playbook has no open steps, evidence was
collected with a custody trail, the timeline is non-empty, and the audit chain
verified.

The signing key is `ONTRAK_TIX_ASSURANCE_SECRET`, falling back to the session
secret so a fresh checkout can still export; a deployment that hands packets to
third parties should set its own, and the signer is resolved when a packet is
exported rather than at boot.

## What is not here yet

- **A tenant's own incident templates.** The drafts a duty offers are shipped
  defaults, and a desk's M1 canned responses can be adopted from them
  (`cannedAsCommsTemplate`), but there is no screen yet for authoring an incident
  notification template per tenant and regime.
- **A real object-locked backend.** The rules, the lock row and the S3 headers are
  here, and the filesystem store enforces write-once for the process that goes
  through it, but a shared bucket with object lock enabled is what would enforce
  the retention date against *every* writer, including someone with the storage
  credentials.
- **Sweep scheduling is yours.** The sweep exists and is idempotent, but nothing
  in this repository schedules it: point a cron, a worker or a Kubernetes job at
  the endpoint or the script. A deployment that never does gets a lock that
  nobody acts on, which is the failure mode it was written to remove.
