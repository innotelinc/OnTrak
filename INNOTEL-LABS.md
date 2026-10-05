# Innotel Labs — Product Portfolio

Innotel Labs builds the toolchain around an IT support operation: the people who
run it, the tickets they work, and the identity and network defenses that protect
it. Each product stands alone, but they share a stack, a design language, and a
single identity layer so they compose into one working environment.

## The products

Each product keeps its own milestone scheme, because they are at different depths and
one numbering would only hide that. The **family release** is what they share: every
roadmap states which family release it is in, and this table is the one place the five
are read together.

| Product | What it is | In family release | Where it stands | Roadmap |
| --- | --- | --- | --- | --- |
| **OnTrak IT Support Training** | Browser-based, automatically-graded IT support training (Linux, Windows, Office). | **2026.09** | v1.0 shipped; v1.2 (sandboxed real shells) shipped | [ROADMAP.md](ROADMAP.md) |
| **OnTrak Tix** | Enterprise ticketing & service management for IT desks and MSPs, with incident response and insurance-grade evidence. | **2026.09** | M0–M6 shipped; M7 (intelligence & scale) in progress — the opt-in, human-approved AI assist is started | [ontrak-tix/ROADMAP.md](ontrak-tix/ROADMAP.md) |
| **OnTrak Sentinel** | Identity (IdP) and intrusion prevention (IDS/IPS) platform. | **2026.09** | S0–S3 shipped (OIDC/SAML, MFA, SCIM, directory sync, and Guard detection: the syslog listener, the normalizer and rules, triage, the compliance report and the family's assurance packet). **S4 — prevention — is the last 1.0 milestone**, and its whole operator surface has landed: what may be enforced against, by whom, with what blast radius, and how it is undone, on a `/console/enforcement` register that proposes, approves and lifts, with the expiry sweep on a timer | [ontrak-sentinel/ROADMAP.md](ontrak-sentinel/ROADMAP.md) |
| **OnTrak Sync** | Network-wide package and container update monitoring and, on approval, updating. Also owns the family's **local** account table. | **2026.09** | Deployed | [ontrak-sync/README.md](ontrak-sync/README.md) |
| **OnTrak Portal** | The centralized dashboard: one sign-in, then the product(s) a role belongs in. Holds no database. | **2026.09** | Deployed | [ontrak-portal/README.md](ontrak-portal/README.md) |
| **OnTrak Genie** | The browser console for a coding agent: it reads, edits and runs code in a workspace it cannot leave, and shows each call — and the file being written — as it happens. | **2026.09** | 0.2 published and deployed (sign-in, Vault-resolved secrets, tenancy through Distro); **0.3 complete** — the running app beside the code, a real toolchain, the approval gate's second channel, and chats and workspaces the account manages. **1.0 in progress**: a per-account ceiling Genie enforces itself, and the threat model and operator runbook written down | [ontrak-genie/README.md](ontrak-genie/README.md) |

> Product names in the OnTrak family are provisional and easy to change; the
> architecture and scope are the durable parts. OnTrak Sync and OnTrak Portal are
> the two that are deployed today alongside the training app — they came first
> because the portal is the single thing that makes four separately-deployable
> products feel like one system, and Sync is the thing that already owns the
> Network.

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
remaining half of the SCIM group sync); Sentinel Guard *decides, acts, and lets a
person undo it* — the syslog listener, the normalizer, triage, the compliance
export and now S4's whole operator surface are shipped: the rails, the stored
policy, the action's life and its reversal, the `/console/enforcement` register
that proposes, approves and lifts, and the expiry sweep on a timer that is on by
default. What S4 still owes is the **enforcement plane** alone — turning an active
block into a filtered packet at a firewall, an agent or a proxy, on the
`EnforcementTarget` seam that is already the contract it needs; Tix's M6 — the
public API, webhooks, monitoring and chat connectors, custom forms, granular roles,
audit-evidence export and the connector marketplace — is shipped, and M7
(intelligence & scale) is under way, its opt-in AI assist started; Training has no LMS/LTI and its public API
and webhooks are not started; and no Genesis launch has been carried end to end
against the live line.

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

The original order was Training → Tix → Sentinel, with each product proving an
integration the next one generalised. That held: Training proved the evidence record,
Tix proved the identity and telemetry integrations, and Sentinel has since become the
shared identity layer both of the others sign in through. The three now move in
parallel, and a family release is how their slices are named together:

| Product | Next slice |
| --- | --- |
| **Training** | v1.3 — finish identity & integrations (LTI 1.3, public API and webhooks for attempt/grading events), then v1.5's proof-of-training packets. |
| **Tix** | M7 — intelligence & scale: analytics and forecasting, enterprise hardening, and the rest of the opt-in, human-approved AI assist. M6 (public API, webhooks, monitoring, chat, custom forms, granular roles, audit export and the connector marketplace) is shipped, and the assist now proposes a classification, a summary, a draft reply and similar tickets without any path to sending. |
| **Sentinel** | S4 — the enforcement plane: turning an active action into a filtered packet at a firewall, an agent or a proxy. The rails, the path and the operator surface are all in — `/console/enforcement` proposes, approves and lifts, and the expiry sweep runs on a timer (`src/lib/enforcement-rules.ts`, `enforcement-service.ts`, `enforcement-scheduler.ts`, `console-rules.ts`). |

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

Sequencing note worth keeping: Sentinel's own gap in the shared identity layer is the
half-landed one — a synced group is a recorded fact and decides nothing until roles,
groups and attribute-based policy land, which is the remaining S1 bullet.
