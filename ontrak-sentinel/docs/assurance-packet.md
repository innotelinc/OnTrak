# The compliance assurance packet

The packet is OnTrak Sentinel's signed answer to "what is this deployment's posture,
and can I check it without an account here?". It is built from the same view the
`/console/compliance` page renders, so the document and the screen cannot disagree
about a control, and it is signed with `SENTINEL_ASSURANCE_SECRET` (falling back to
`SENTINEL_SIGNING_KEY`).

Its envelope is the family's shared one — `version`, `algorithm`, `recordHash`,
`contentHash` and a `signature` over the content digest — identical to OnTrak Tix's
incident packets, so one verifier can hold both.

## What is inside

| Section | What it says |
| --- | --- |
| `controls` | Every control, its state (`OK`/`WARN`/`FAIL`) and the evidence behind it. |
| `roles`, `identities`, `alerts`, `policies` | Who and what is governed, and the backlog the queue actually holds. |
| `audit` | Where in the evidence chain the packet was cut, and whether it verified at export. |
| `retention` | The declared evidence-retention window, its source, the chain's real length and span, and how many events predate the window. |
| `controlHistory` | The control changes the chain records: `policy.update` and `enforcement.policy`, oldest first, each with what it replaced, who made it and its chain position. |

`retention` and `controlHistory` are inside the signed content. Editing either after
signing fails `verifyCompliancePacket` exactly as editing a control does.

### Retention is a declaration, not a deletion rule

`SENTINEL_EVIDENCE_RETENTION_MONTHS` (default **12**, accepted 1–120) declares the
window. An unreadable value is not fatal: the export falls back to the default and the
packet says so in its signed record, because refusing to produce an audit response over
a typo is worse than stating the fallback. The chain itself is **never trimmed** — a
packet whose evidence was shortened to match a number could not be verified — so the
record states how many events predate the window and that they are carried in full.

### Control history is read from the chain, not a second table

A "control change" is one of the two audit actions that carry a control's new shape:
`policy.update` (an identity-policy scope) and `enforcement.policy` (the Guard rails).
The history is bounded to 24 months and the newest 200 changes, and the packet states
the true total whenever it is bounded. A role that may not read the trail gets
`total: null` and a sentence explaining why — never an empty list, which would assert
that nothing ever changed.

## The three shapes

The console page links all three (`Take it with you`):

| Format | URL | Type |
| --- | --- | --- |
| JSON | `/console/compliance/packet` | `application/json` |
| CSV | `/console/compliance/packet?format=csv` | `text/csv` |
| PDF | `/console/compliance/packet?format=pdf` | `application/pdf` |

All three need a console session; an unknown `format` is a `400` naming the three. The
JSON is the record; the CSV and PDF are **renderings of it** and re-sign nothing. They
carry the record hash, content hash and signature, so a recipient can check the
spreadsheet or the printed page against the JSON it came with. The PDF is written by
hand (one page of Helvetica, one content stream, a real xref table) and is a text
rendering, not a design; if the record runs past one page it says how many lines were
not printed and points at the JSON and CSV.

## Verifying

```ts
import { verifyCompliancePacket } from "./src/lib/assurance-packet";
const result = verifyCompliancePacket(packet, sha256Hex, hmacSigner(secret));
```

Verification needs the deployment's key and nothing else: no database, no session, no
account here. The CSV's signature column and the PDF's signature line are the same
value as the JSON's `signature`, which is the check that all three describe one record.
