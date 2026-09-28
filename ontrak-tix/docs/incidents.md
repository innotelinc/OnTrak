# Incident response (M3)

An incident is not a ticket with a scarier label. It is a **declared** event with
a severity someone chose, a phase it moves through, and named people who own
parts of the response — and a timeline written as things happened, never
reconstructed afterwards.

This covers the parts of **M3 — Incident response & defensible documentation**
(see `ROADMAP.md`) that have landed: the lifecycle, the severity matrix, the
incident roles, runbook-style **playbooks with step tracking**, **evidence
collection with a chain of custody and legal hold**, and the one-click signed
**Assurance Packet** — all surfaced in a console at `/incidents`. Object-lock
(WORM) evidence storage and the war-room timeline assembled from other sources
are what remains.

## Pieces

| Concern | Where |
| --- | --- |
| Pure rules: severity matrix, phases, roles, validation | `src/lib/incident-rules.ts` |
| Service: declare, advance, staff, timeline | `src/lib/incident-service.ts` |
| Prisma adapter | `src/lib/incident-store-prisma.ts` |
| Pure rules: playbook steps, plan by severity, progress | `src/lib/playbook-rules.ts` |
| Pure rules: evidence validation, custody, legal hold, manifest | `src/lib/evidence-rules.ts` |
| Service: start/step the playbook, record evidence, custody, holds, manifest | `src/lib/incident-docs-service.ts` |
| Prisma adapter | `src/lib/incident-docs-store-prisma.ts` |
| Models | `prisma/schema.prisma` (`Incident`, `IncidentEvent`, `PlaybookStep`, `EvidenceItem`, `CustodyEntry`, `LegalHold`) |
| Console | `src/app/(desk)/incidents/page.tsx`, `src/components/IncidentList.tsx`, `src/app/actions/incidents.ts` |
| Manifest download | `src/app/api/incidents/[id]/manifest/route.ts` |
| Pure rules: the packet, its digests, its signature | `src/lib/assurance-rules.ts` |
| The signing key (HMAC over `contentHash`) | `src/lib/assurance-sign.ts` |
| Service: assemble the packet from the record and the audit chain | `src/lib/assurance-service.ts` |
| Packet download | `src/app/api/incidents/[id]/packet/route.ts` |
| Tests | `tests/tix-m3-incidents.test.ts`, `tests/tix-m3-playbooks.test.ts`, `tests/tix-m3-assurance.test.ts` |

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

## The console

`/incidents` is staff-only (any staff role holding `ticket:read:any`; a requester
is redirected to the portal). It declares incidents, shows the header roll-up
(open, at SEV2 or above, without a commander), and per incident renders the
severity/phase chips (with a `legal hold` marker when one is in force), the four
role cards, the playbook, the evidence list — each item with its custody trail,
its current holder and a hand-off form — the legal-hold panel, the timeline, and
links to download the manifest and the signed packet.

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

- Object-lock (WORM) storage for the artifacts themselves — the record stores
  references, not bytes, and nothing enforces retention at the storage layer yet.
- The war-room timeline assembled automatically from *other* sources (logins,
  alerts, approvals) — today the timeline is what the incident operations write.
- Regulatory/notification tracking, comms templates and the post-incident review
  with tracked actions.
- A verification *tool* for a third party who holds only the packet and the key:
  `verifyAssurancePacket` is the function, and nothing ships that exposes it.
