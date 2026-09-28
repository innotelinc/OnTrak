# Training evidence

How OnTrak IT Support Training turns a graded attempt into a **tamper-evident
record** that a compliance officer, auditor or insurer can rely on — and how that
record is shaped to match the assurance packets produced by **OnTrak Tix** and
**OnTrak Sentinel**.

The implementation is pure and unit-tested: `src/lib/credentials.ts`.

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

- `buildCompletionRecord` / `verifyCompletionRecord` / `certificateCode` power the
  v1.5 assessment & credentials milestone (see [ROADMAP.md](../ROADMAP.md)).
- `buildAssurancePacket` / `verifyAssurancePacket` are the export used by the
  proof-of-training flow for compliance and insurance.
