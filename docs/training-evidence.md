# Training evidence

How OnTrak IT Support Training turns a graded attempt into a **tamper-evident
record** that a compliance officer, auditor or insurer can rely on — and how that
record is shaped to match the assurance packets produced by **OnTrak Tix** and
**OnTrak Sentinel**.

The model is pure and unit-tested: `src/lib/credentials.ts`. The wiring that
builds a record from a graded attempt is `src/lib/certificates.ts`, and a
certificate can be checked by anyone at `/verify` — see [Where it is wired
in](#where-it-is-wired-in) below.

## Why it exists

A pass/fail number in a UI proves nothing six months later. A *completion record*
proves **who** was trained on **what**, **when**, and **with what outcome**, in a
form whose integrity can be checked without trusting the database it came from.
That is the difference between "the dashboard said 82%" and evidence of due
diligence.

## The completion record

A `CompletionRecord` is a small, self-describing statement:

| Field | Meaning |
| --- | --- |
| `format` | `ontrak.training.completion/v1` — fixed, so consumers can branch safely. |
| `id` | Deterministic id derived from the digest (`crt_…`). |
| `learnerId` / `learnerName` | Who completed the work. |
| `scenarioId` / `scenarioTitle` / `platform` | What they completed. |
| `passed` / `score` / `maxScore` / `percent` | The outcome. |
| `skills` | Competencies demonstrated (e.g. `networking`, `linux-permissions`). |
| `completedAt` | Grading time, ISO-8601 UTC. |
| `issuer` | The deployment/organisation that issued the record. |
| `digest` | Hash over the canonical record — the tamper-evident seal. |

### Canonicalisation and digest

The digest is `hash(canonicalize(payload))`, where `canonicalize` is a
deterministic JSON serialisation: object keys are sorted, `undefined` values are
dropped, and `undefined` inside arrays becomes `null`. The consequence is that
two records with the same content always produce the same digest, regardless of
field insertion order — so integrity checks are stable across systems and
languages.

The hash function is **injected** rather than hard-coded, so the same logic runs
with SHA-256 in a Node process today and an HSM-backed signer later without
changing the model.

`verifyCompletionRecord(record, hash)` recomputes the digest and compares. Any
edit — even flipping `passed` — changes the digest and fails verification.

### Human-readable code

`certificateCode(record)` derives a short code from the digest:

```
ONTRAK-1a2b-3c4d-5e6f
```

It is printed on a certificate so a person can read it back over the phone and
an auditor can look it up without handling raw hashes.

## The assurance packet

Individual records are bundled into an `AssurancePacket`
(`ontrak.assurance.packet/v1`):

- `issuer`, `generatedAt`
- `records[]` — the completion records
- `digest` — a hash over the canonical packet, **including every record**

Because the packet digest covers the record set, **removing or reordering records
invalidates the packet**, not just editing one. `verifyAssurancePacket` checks the
packet format, every contained record, and the packet digest.

A packet is what you hand to an auditor or attach to an insurance claim: "here is
the signed list of who was trained, on what, when, and how well."

## Shared format across Innotel Labs

The same canonical-JSON + SHA-256 + injected-hash pattern is used by
`ontrak-sentinel/src/lib/audit-chain.ts`, whose hash-chained, append-only log is
the evidence spine for identity and network events. OnTrak Tix's incident
assurance packets follow the same shape. One mental model, three products:

```
training completion record  ─┐
sentinel audit chain          ├─▶ canonical JSON → SHA-256 digest → signed packet
tix incident assurance packet ┘
```

> The goal is an honest, complete record. The model records facts and outcomes;
> it does not editorialise or assign blame.

## Where it is wired in

A pass issues a certificate. Clearing the scenario's pass mark puts a
**Certificate** card on the attempt report (`/student/results/<id>`) showing the
code, the learner, when it was completed, the issuing organisation, the
competencies demonstrated, and — behind a disclosure — the raw record JSON. The
results index lists the code against every passed attempt.

- `certificateForAttempt` / `certificateCodeForAttempt` (`src/lib/certificates.ts`)
  build a record from the attempt's own facts and sign it with SHA-256; the
  record is then **stored on the attempt** (see below).
- `verifyCompletionRecord` / `verifyAssurancePacket` back the public `/verify`
  page (`src/app/verify`), where anyone can paste a record or a packet and have
  it re-hashed — no account, no database, and no need to trust this deployment's
  data to check it.
- `buildAssurancePacket` is the export used by the proof-of-training flow for
  compliance and insurance (see [ROADMAP.md](../ROADMAP.md), v1.5).

### Records are issued once and then stored

An attempt carries the certificate it earned in three columns on `Attempt`:
`certificate` (the record), `certificateIssuedAt`, and `certificateRevokedAt`.
The record is written the moment the attempt first clears the pass mark — by the
student's own submission (`submitAttempt`) or by an instructor's re-grade
(`regradeAttempt`) — and after that it is **kept exactly as issued**.

That is what makes the printed code durable. A re-grade recalculates the score,
but it does not rewrite the certificate: the learner's copy still hashes to the
same digest and still verifies, and the report says plainly that the attempt was
re-graded after the fact. The decision of what a given grading should do lives in
`certificateAction` (`src/lib/certificate-rules.ts`) and is unit tested:

| After grading | Existing record | Action |
| --- | --- | --- |
| pass | none / revoked | **issue** a fresh record |
| pass | live | **keep** it untouched |
| fail | live | **revoke** it (`certificateRevokedAt`) |
| fail | none / revoked | nothing |

The one thing a re-grade can take away is a certificate whose pass no longer
stands — the corrected grading says the work did not meet the mark, and the
report shows the revoked record rather than hiding it. Note the honest limit:
`/verify` is database-free by design, so a revoked record's **artifact** still
verifies as intact, and the revocation is visible in the product, not in the
JSON. Revocation is not written into the signed content, because a self-contained
record cannot carry a decision made later.

An attempt graded before records were stored (or one whose stored JSON is
unrecognisable) still shows a certificate: the report falls back to deriving one,
and the next grading stores it properly.

### Issuer

The `issuer` field defaults to the product name and is set per deployment with
`ONTRAK_ISSUER`, so an organisation's certificates are attributed to *it* rather
than to the software. The issuer is part of the signed content, which is exactly
the argument for storing records: changing `ONTRAK_ISSUER` changes the codes
issued from then on, and — unlike the derived-records trade-off it replaced — it
does **not** invalidate the certificates already handed out.
