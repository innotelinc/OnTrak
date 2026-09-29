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
| **OnTrak Sync** | Network-wide package and container update monitoring and, on approval, updating. Also owns the family's **local** account table. | Deployed | [ontrak-sync/README.md](ontrak-sync/README.md) |
| **OnTrak Portal** | The centralized dashboard: one sign-in, then the product(s) a role belongs in. Holds no database. | Deployed | [ontrak-portal/README.md](ontrak-portal/README.md) |

> Product names in the OnTrak family are provisional and easy to change; the
> architecture and scope are the durable parts. OnTrak Sync and OnTrak Portal are
> the two that are deployed today alongside the training app — they came first
> because the portal is the single thing that makes four separately-deployable
> products feel like one system, and Sync is the thing that already owns the
> Network.

## How they fit together

```
                  ┌────────────────────────────────────────────────┐
   browser ──────▶│  OnTrak Portal — the front door                │
   one sign-in    │  routes by role · owns no accounts, no data    │
                  └───────────────────────┬────────────────────────┘
                                          │  the product(s) that role belongs in
    ┌──────────────┬──────────────────────┼──────────────────────┬──────────────┐
    ▼              ▼                      ▼                      ▼              ▼
┌────────────┐┌────────────┐      ┌────────────┐      ┌────────────┐  ┌────────────┐
│ OnTrak IT  ││ OnTrak Tix │      │ OnTrak     │      │ OnTrak     │  │ Cerulean   │
│ Support    ││ ticketing  │      │ Sentinel   │      │ Sync       │  │ identity,  │
│ Training   ││ & desk     │      │ IdP+IDS/IPS│      │ Network +   │  │ DNS, TLS,  │
│            ││            │      │            │      │ accounts   │  │ edge       │
└────────────┘└────────────┘      └────────────┘      └────────────┘  └────────────┘
 trains the    runs the work       protects both       keeps them      trusts all of
 people                                                current         them
```

- **One identity layer, six roles.** `ADMIN`, `SYSADMIN`, `ANALYST`,
  `TECHNICIAN`, `INSTRUCTOR` and `STUDENT` mean the same thing to every product,
  and the same group in Cerulean grants the same thing everywhere. Nothing is
  copied into a product, so a role change takes effect on the next sign-in. In the
  deployed Network Cerulean's Authentik is the directory; **OnTrak Sync owns the
  family's local account table**, which is the path used when the provider cannot
  be reached, and which the portal's password form delegates to rather than
  inventing a second login. OnTrak Sentinel is the product that will generalise
  this further.
- **The portal decides *where*, never *what*.** Every product still authorises the
  caller from its own credential. A tile the portal declines to draw is a
  courtesy; the product behind it is the thing that refuses.
- **Ticket ↔ scenario bridge.** OnTrak Tix tickets can be redacted into training
  scenarios; solved scenarios become knowledge-base articles.
- **Telemetry → incident → training loop.** Sentinel detects; Tix responds and
  documents; Training closes the human gap so teams improve from real incidents.
- **Network ↔ desk loop.** OnTrak Sync reports what is behind on which host, and
  what was applied and when; an update that goes wrong is exactly the ticket Tix
  and the training range exist to explain.
- **Shared evidence model.** Tix's assurance packets and Training's
  proof-of-training packets use one signed, tamper-evident record format, so an
  auditor or insurer can consume both.
- **Shared engineering standards.** Next.js + React + TypeScript + Prisma +
  PostgreSQL, pure `*-rules.ts` logic modules, server-side trust boundaries, and a
  driver/adapter seam everywhere a backend might be swapped. OnTrak Sync is the
  deliberate exception: Python + FastAPI + SQLite, because it is the one product
  whose job is to reach machines the others run on, and it needs no ORM between
  itself and a shell.

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

Two things jumped the queue, and both for the same reason — they are what makes
the other four add up to a system rather than four logins:

- **OnTrak Portal** shipped first because routing by role is the one job that
  cannot live inside any of the products without one of them becoming the
  authority on the others.
- **OnTrak Sync** shipped with it because it already reaches every machine in the
  Network, and because it is the natural owner of a local account table: it is the
  service that has to work when the identity provider does not.

When Sentinel's IdP is built, it takes over the directory role and Sync keeps the
local accounts — the split that exists today, with Cerulean's Authentik in the
directory seat.
