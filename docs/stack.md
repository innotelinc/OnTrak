# OnTrak in the Innotel Platform Stack

**Role: TrainingOps** — the self-hosted platform where an IT support operation is
*taught*, *run* and *evidenced*: graded simulations for the people, an MSP-grade
service desk for the work, and a shared identity and evidence layer for both.

Canonical definition of the stack lives in
[innotelinc/innotel-platform-stack](https://github.com/innotelinc/innotel-platform-stack).
This document only states OnTrak's place in it.

## Boundaries

**Owns**

- **Training** — scenarios, simulated Linux/Windows/Office machines, attempt
  lifecycle, objective evaluation, completion records and certificates.
- **The service desk** — tickets, queues, SLAs, canned responses and templates,
  time tracking and rate cards, invoice-ready billing exports.
- **Multi-client MSP operation** — clients, contacts, per-client promises,
  per-client rate cards and reporting, cross-client scoping and act-as
  guardrails.
- **Incident response and assurance** — incident duties and playbooks, war-room
  comms, objection-locked evidence with a retention clock, tenant-authored
  notification wording kept as sent, and the signed assurance packet.
- **Its own audit chain** — append-only, hash-chained records of every
  privileged action, verifiable without trusting the application that wrote it.
- **The Network's update state** — which host and container is behind on which
  package, and what was applied when (OnTrak Sync).
- **The family's front door** — routing a signed-in person to the product their
  role belongs in (OnTrak Portal). The portal owns the *routing decision* and
  nothing else: no accounts, no data, no second authorisation system.
- **Identity and network defence** — OnTrak Sentinel, built in this repository: the
  family's own IdP (OIDC/SAML/SCIM, MFA, sessions, access reviews) *and* its
  IDS/IPS (Guard — the syslog, NetFlow/IPFIX and OTLP listeners, the normalizer,
  the detection rules, triage and policy-gated enforcement), sharing one
  hash-chained evidence log. A deployment can sign in against it instead of
  Cerulean, and it federates to Cerulean where that is the directory.
- **CodeOps** — a coding agent you can watch (OnTrak Genie): a browser console and
  a terminal CLI over one server, working inside a workspace it cannot leave, with
  every write and every risky command stopping at an approval gate before it lands.

**Consumes**

- **Identity (Cerulean, running Authentik)** — OIDC sign-in for staff, students,
  technicians, analysts and sysadmins, with a local credential fallback so each
  app deploys standalone. In this Network the directory is already Cerulean's
  Authentik; **OnTrak Sync owns the local account table**, which is what the
  portal's password sign-in delegates to and what a LAN with no route to the
  provider signs in against.
- **Secrets (Cerulean Vault)** — runtime secret resolution
  (`vault://<mount>/<path>#<key>`).
- **Trust (Cerulean)** — DNS records, the stack wildcard certificate and the NPM
  proxy host for each app. OnTrak never speaks to the NPM API itself.
- **Storage (ONYX)** — where deployments choose object storage for attachments
  and evidence bytes instead of local disk.

**Does not own**

- Identity, secrets, DNS, TLS or edge routing — those are platform services and
  are consumed, never re-implemented.
- Billing infrastructure — Magnate owns subscriptions and entitlements. OnTrak's
  time and rate cards are *operational* billing (what a desk bills a client for
  hours worked), and deliberately stop there: no payment processing, no
  subscription lifecycle, no entitlements.
- Telephony (Zeus) and e-signature (Signara) — integrated when a deployment has
  them, not replaced.

## Service map

| Component | Technology | Job |
|---|---|---|
| `ontrak-tix` | Next.js 15, React 19, TypeScript, Prisma, PostgreSQL | The service desk: tickets, SLAs, clients, time, billing, incidents, assurance |
| OnTrak IT Support Training | Next.js 15, React 19, TypeScript, Prisma, PostgreSQL, xterm.js | Graded Linux/Windows/Office simulations, attempts, certificates |
| OnTrak Lab (not built from this repository) | Python, FastAPI, Guacamole, its own SQLite | The hands-on half: starts a real machine for a `lab`-tagged task and grades it. Runs from its own repository and host, maps its two roles onto the vocabulary below at sign-in ([lab-identity.md](lab-identity.md)), and reports a finished session to `POST /api/v1/lab/completions` ([lab-completion.md](lab-completion.md)) |
| `ontrak-portal` | Next.js 15, React 19, TypeScript, no database | The family's front door: one sign-in, then the products a role belongs in. Routes by role and authorises nothing — every product re-checks the caller itself |
| `ontrak-sync` | Python 3.12 + FastAPI + SQLite (API), Next.js 16 dashboard | Network package/container update monitoring and approved updating; the family's local account table and its capability model |
| `ontrak-genie` | Node/TypeScript, no database; browser console and terminal CLI over one server | The family's coding agent: state a task and watch it read, edit and run commands in a workspace it cannot leave, with every write and risky command stopping at an approval gate |
| `ontrak-sentinel` | Node/TypeScript, Prisma, PostgreSQL; framework-free, server-rendered console | The family's own IdP **and** IDS/IPS: OIDC/SAML/SCIM, MFA, sessions and access reviews, and Guard's detection and policy-gated enforcement, on one hash-chained evidence log. The family stack runs it as `sentinel-app`; `npm run serve` runs it alone |
| Audit chain | Append-only rows, hash-chained per tenant | Tamper-evident history shared by every app |
| Evidence store | Filesystem or object storage behind an object-lock port | Incident artifacts under a retention window nobody can shorten |

Shared engineering layers, identical across the web apps: pure logic in
`src/lib/**/*-rules.ts` with unit tests, a store port with a Prisma adapter and
an in-memory adapter for tests, server-side trust boundaries, and an audit event
for every privileged write. OnTrak Sync follows the same shape in Python — pure
parsers and cron arithmetic (`scanners.py`, `policy.py`) behind a `unittest` suite,
and one module (`applier.py`) that is the only code allowed to change a machine.

One vocabulary of roles and capabilities crosses all five products this repository
builds: `ADMIN`, `SYSADMIN`, `ANALYST`, `TECHNICIAN`, `INSTRUCTOR`, `STUDENT`. It
exists so a claim from the directory means the same thing to every product, and so
nothing has to be translated at a boundary — a translation table is where
`instructor` silently becomes `student` after a migration. OnTrak Lab maps its own
two roles onto that vocabulary at sign-in rather than widening it.

## In the ecosystem

- **Identity** — staff sign in through Authentik; the portal routes them to the
  product their role belongs in, and every product re-checks the role on the
  server for each privileged action rather than trusting a session claim. The
  portal holds no accounts: its password form delegates to OnTrak Sync, which
  owns the family's local account table.
- **Secrets & trust** — the apps read a `.env` that either carries a Vault
  reference the deployment resolves or the resolved value where no resolver
  exists. Public hosts and certificates come from Cerulean.
- **Revenue** — where a deployment sells seats, Magnate owns the subscription;
  OnTrak only ever asks whether an entitlement exists.
- **Source of truth** — feature work and platform scope live in this repo's
  [ROADMAP.md](../ROADMAP.md) and [ontrak-tix/ROADMAP.md](../ontrak-tix/ROADMAP.md);
  the ecosystem definition lives in the stack repo, never here.

## Where OnTrak integrates with other platforms

| Platform | Direction | What crosses |
|---|---|---|
| Cerulean (Authentik) | consumes | OIDC issuer, client ID/secret, redirect URIs |
| Cerulean Vault | consumes | Runtime secrets |
| Cerulean DNS/TLS | consumes | Host records and the wildcard certificate |
| Magnate | consumes (optional) | Seat entitlement check |
| ONYX | consumes (optional) | Object storage for attachments and evidence |
| Zeus / Signara | consumes (optional) | Telephony for a desk's voice channel; signature on an agreement packet |

Nothing in the list is a hard dependency: OnTrak is designed to boot and be
useful with none of them configured, and to gain each one without a rewrite.

## Licences

This repository's own code is MIT ([LICENSE](../LICENSE)). Third-party material that
ships beside it keeps its own licence, which applies to its output rather than to this
repository's code, and no upstream source is vendored or re-licensed here.

The machines OnTrak Lab runs are the operator's licences, not this repository's. The
lab fetches Microsoft **evaluation** media, which expires (90 days for desktop, 180 for
Server), and never redistributes retail Windows or Office media: retail media is
supplied by the operator from their own licences, and volume licensing stays with
whoever runs the host. The lab's own repository is the source for that rule
([OnTrak-dev](https://github.com/innotelinc/OnTrak-dev), `docs/catalog.md`); this
paragraph exists so that a reader of the family's architecture meets it as a
responsibility rather than as a surprise after a class has been booked onto it.
