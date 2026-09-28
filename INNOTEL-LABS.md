# Innotel Labs — Product Portfolio

Innotel Labs builds the toolchain around an IT support operation: the people who
run it, the tickets they work, and the identity and network defenses that protect
it. Each product stands alone, but they share a stack, a design language, and a
single identity layer so they compose into one working environment.

## The products

| Product | What it is | Status | Roadmap |
| --- | --- | --- | --- |
| **OnTrak IT Support Training** | Browser-based, automatically-graded IT support training (Linux, Windows, Office). | v1 shipped | [ROADMAP.md](ROADMAP.md) |
| **OnTrak Tix** | Enterprise ticketing & service management for IT desks and MSPs, with incident response and insurance-grade evidence. | M0 in progress | [ontrak-tix/ROADMAP.md](ontrak-tix/ROADMAP.md) |
| **OnTrak Sentinel** | Identity (IdP) and intrusion prevention (IDS/IPS) platform. | Planned (after OnTrak Tix) | [ontrak-sentinel/ROADMAP.md](ontrak-sentinel/ROADMAP.md) |

> Product names in the OnTrak family are provisional and easy to change; the
> architecture and scope are the durable parts.

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

1. **OnTrak IT Support Training v1.1–v1.5** — depth, integrations, training
   evidence (in progress; see its roadmap).
2. **OnTrak Tix M0–M3** — tickets, SLAs, IdP + telemetry ingest, incident
   response and assurance.
3. **OnTrak Sentinel** — the dedicated IdP and IDS/IPS platform, built after Tix,
   then adopted back by Tix and Training as the shared identity layer.

Sequencing is deliberate: Tix proves the identity and telemetry integrations that
Sentinel later generalises; Training proves the evidence-record format that both
Tix and Sentinel reuse.
