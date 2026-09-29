# Innotel Labs — Product Portfolio

Innotel Labs builds the toolchain around an IT support operation: the people who
run it, the tickets they work, and the identity and network defenses that protect
it. Each product stands alone, but they share a stack, a design language, and a
single identity layer so they compose into one working environment.

## The products

Each product keeps its own milestone scheme, because they are at different depths and
one numbering would only hide that. The **family release** is what they share: every
roadmap states which family release it is in, and this table is the one place the three
are read together.

| Product | What it is | In family release | Where it stands | Roadmap |
| --- | --- | --- | --- | --- |
| **OnTrak IT Support Training** | Browser-based, automatically-graded IT support training (Linux, Windows, Office). | **2026.09** | v1.0 shipped; v1.2 (sandboxed real shells) shipped | [ROADMAP.md](ROADMAP.md) |
| **OnTrak Tix** | Enterprise ticketing & service management for IT desks and MSPs, with incident response and insurance-grade evidence. | **2026.09** | M0–M5 shipped; M6 (platform & integrations) largely shipped | [ontrak-tix/ROADMAP.md](ontrak-tix/ROADMAP.md) |
| **OnTrak Sentinel** | Identity (IdP) and intrusion prevention (IDS/IPS) platform. | **2026.09** | S0–S2 shipped (OIDC/SAML, MFA, SCIM, directory sync); S3 (Guard detection) started | [ontrak-sentinel/ROADMAP.md](ontrak-sentinel/ROADMAP.md) |

> Product names in the OnTrak family are provisional and easy to change; the
> architecture and scope are the durable parts.

## Family releases

A family release is a **date, not a version number**: the three products ship
independently, and what makes a release is that the parts which only work *together*
were exercised together. Naming it after the month says that plainly, and avoids
implying that Training v1.2 and Tix M6 are the same amount of work.

### 2026.09 — the family, wired end to end

What is in it, and what it is therefore claiming:

| Claim | Where it is proven |
| --- | --- |
| Tix and Training sign in through Sentinel (OIDC), MFA enforced, sessions and tokens revoked on offboarding | Sentinel S1/S2, `tests/sentinel-oidc.test.ts`, `tests/sso-live.test.ts` (training), `tests/tix-m2-sso-local-idp.test.ts` |
| A directory provisions and deprovisions into Sentinel, and a desk's people reach the provider without a button | Sentinel S2 directory sync + SCIM server; Tix's outbound SCIM push and `sweep:scim` |
| A ticket can be worked with the desk's own fields, on the desk's own form per queue | Tix M6 custom fields and forms |
| A scenario can run real bash in a sandbox, and grade the same | Training v1.2, `tests/sim-container.test.ts` |
| Telemetry becomes an alert linked to an identity, and an incident | Sentinel S3 (normalizer, rules, dedupe, correlation); Tix telemetry ingest and RMM promotion |
| The whole stack runs together | `.github/workflows/ci.yml` — the **Family stack** job brings up all six containers with `make all-up` |

**Not in it:** Sentinel identities are recorded but a group decides nothing yet (the
remaining half of the SCIM group sync); Sentinel Guard has no streaming listener and no
triage UI; Tix's connector marketplace and enterprise controls are still open; Training
has no LMS/LTI and its public API and webhooks are not started.

## How they fit together

```
                    ┌─────────────────────────────────────────────┐
                    │              Innotel Labs                    │
                    └─────────────────────────────────────────────┘
                                       │
      ┌────────────────────────────────┼────────────────────────────────┐
      ▼                                ▼                                ▼
┌───────────────┐              ┌───────────────┐               ┌───────────────┐
│ OnTrak         │  evidence →  │ OnTrak Tix    │  identity →   │ OnTrak         │
│ IT Support     │  ◀──────────  │ ticketing &  │  ◀──────────  │ Sentinel       │
│ Training       │  scenarios   │ service desk  │   alerts →    │ IdP + IDS/IPS  │
└───────────────┘              └───────────────┘               └───────────────┘
      trains the people          runs the work                 protects both
```

- **One identity layer.** OnTrak Sentinel is the IdP for the family (OIDC/SAML +
  SCIM); OnTrak Tix and Training consume it, with a local-auth fallback so each
  can deploy standalone.
- **Ticket ↔ scenario bridge.** OnTrak Tix tickets can be redacted into training
  scenarios; solved scenarios become knowledge-base articles.
- **Telemetry → incident → training loop.** Sentinel detects; Tix responds and
  documents; Training closes the human gap so teams improve from real incidents.
- **Shared evidence model.** Tix's assurance packets and Training's
  proof-of-training packets use one signed, tamper-evident record format, so an
  auditor or insurer can consume both.
- **Shared engineering standards.** Next.js + React + TypeScript + Prisma +
  PostgreSQL, pure `*-rules.ts` logic modules, server-side trust boundaries, and a
  driver/adapter seam everywhere a backend might be swapped.

## Shared engineering conventions

- **Pure logic is separated and unit-tested** (`src/lib/**/*-rules.ts` and the
  simulator), so it runs in the browser, on the server, and in tests.
- **Never trust the client.** State that determines a score or a legal record is
  recomputed server-side.
- **Every privileged action is audited**, with append-only, hash-chained history
  where a record may face an auditor.
- **Adapters behind seams.** Simulation drivers, identity providers and security
  telemetry sources each sit behind one interface so a vendor can be swapped.

## Roadmap sequencing

The original order was Training → Tix → Sentinel, with each product proving an
integration the next one generalised. That held: Training proved the evidence record,
Tix proved the identity and telemetry integrations, and Sentinel has since become the
shared identity layer both of the others sign in through. The three now move in
parallel, and a family release is how their slices are named together:

| Product | Next slice |
| --- | --- |
| **Training** | v1.3 — finish identity & integrations (LTI 1.3, public API and webhooks for attempt/grading events), then v1.5's proof-of-training packets. |
| **Tix** | the rest of M6 — the connector marketplace pattern and the enterprise controls (granular roles, audit-evidence export, retention/legal hold), then M7. |
| **Sentinel** | the rest of S3 — a streaming listener per protocol, rule versioning, triage UI and the detection-coverage map — then S4, enforcement. |

Sequencing note worth keeping: Sentinel's own gap in the shared identity layer is the
half-landed one — a synced group is a recorded fact and decides nothing until roles,
groups and attribute-based policy land, which is the remaining S1 bullet.
