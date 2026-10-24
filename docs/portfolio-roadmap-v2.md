# OnTrak portfolio roadmap — 2.0 and beyond

> **This is the portfolio TODO list.** One row per product, one checklist per
> version. The per-product roadmaps carry the detail and the history; this file
> carries the order of work and the goal each version has to meet.
>
> Re-baselined 2026-10-24. Every product in the family now shares one comparable
> version line: **the shipped state is 2.0.0**, the next minor milestones are
> 2.1, 2.2, …, and the next major directions are 3.0 and 4.0.

## 1. The convention

| Segment | Meaning | Example |
| --- | --- | --- |
| **x.0** | A major feature set — a product-defining capability, not a batch of fixes | 2.0 = the shipped product; 3.0 = enterprise/scale line |
| **x.y** | A minor milestone — one shippable capability with its own exit test | 2.1, 2.2 … |
| **x.y.z** | A patch/release-train bump | 2.0.1 |

Rules:

- A version is **done** when its exit line is met and its tests pass. A checklist
  item without a test is not done.
- Numbers only move forward. A deferred item moves to the next version; it does
  not disappear.
- The current shipped state is **2.0.0**, not "1.x with extras". Older milestone
  names (M0–M7, S0–S6, v0.1–v1.6) stay in the per-product roadmaps as history and
  are mapped to 2.0 in each file.
- Every product's `package.json` / `pyproject.toml` / `VERSION` reports 2.0.0.

## 2. Portfolio at a glance

| Product | Host | Codebase | Version | 2.0 state | Next |
| --- | --- | --- | --- | --- | --- |
| **OnTrak ITS** (TrainingOps) | `its.ontrak.technology` | `ontrak-work` (root) | 2.0.0 | shipped | 2.1 Review & approval |
| **OnTrak Tix** (ServiceOps) | `tix.ontrak.technology` | `ontrak-work/ontrak-tix` | 2.0.0 | shipped | 2.1 Scale fixes |
| **OnTrak Sentinel** (IdP + Guard) | `sentinel.ontrak.technology` | `ontrak-work/ontrak-sentinel` | 2.0.0 | shipped | 2.1 Vendor adapters |
| **OnTrak Sync** (Updates) | `sync.ontrak.technology` | `ontrak-work/ontrak-sync` | 2.0.0 | shipped | 2.1 Approval workflows |
| **OnTrak Genie** (CodeOps) | `genie.ontrak.technology` | `ontrak-work/ontrak-genie` | 2.0.0 | shipped | 2.1 CLI parity |
| **OnTrak Engineer** (RE add-on) | `re.genie.innotel.us` | `ontrak-work/ontrak-genie` (`src/engineer.ts`) | 2.0.0 | shipped | 2.1 Evidence export |
| **Uncensored Godmode** (metered agent) | `uc.genie.innotel.us` | `ontrak-work/g0dm0d3` | 2.0.0 | shipped | 2.1 Run history |
| **OnTrak Class** (classroom) | `classroom.innotel.us` | `atheniq-work` + OpenMAIC | 2.0.0 | shipped | 2.1 Completion handoff |
| **OnTrak Lab** (hands-on VMs) | `lab.ontrak.technology` | `ontrak-work/ontrak-lab` | 2.0.0 | shipped | 2.1 Microsoft products |
| *OnTrak Portal* (front door, supporting) | `ontrak.technology` | `ontrak-work/ontrak-portal` | 2.0.0 | shipped | 2.1 Self-service |

**2.0 is the whole shipped surface, family-wide:** one SSO identity (Cerulean
Authentik) with break-glass only, one Unity theme, role-scoped Portal tiles with
health lights, the training range, the service desk, the IdP/IPS, the update
console, the coding console, the metered agent front doors, the classroom, and
the VM lab. The 2.0 exit is verified by each product's own suite plus the
family-level tests (`tests/family-stack.test.ts`, `tests/classroom.test.ts`,
`ontrak-portal/tests/portal-rules.test.ts`).

## 3. The TODO list

Legend: `[x]` done in 2.0.0 · `[ ]` open · `[~]` in progress.

### 3.1 OnTrak ITS → 2.1 Authoring at scale, 2.2 Assessment depth, 3.0 Enterprise training

**2.0.0 — shipped baseline** `[x]`

- `[x]` Linux/Windows/Office simulators, clickable Windows desktop, deterministic
  server-side grading, re-grade, hint penalties.
- `[x]` RBAC, scenario authoring + validator, cohorts/assignments, admin control
  room, student experience, PWA/offline shell.
- `[x]` Real bash sandbox driver behind the `ShellDriver` seam, with graceful
  fallback and per-scenario `simulated | container` fidelity.
- `[x]` The lab's real guests ported in (`/lab`, instructor fleet, admin panel,
  lessons, ticket rubric).
- `[x]` SSO (OIDC), SCIM 2.0 service provider, LTI 1.3 launch + AGS passback,
  public API, signed webhooks, CSV roster/results, JWKS publication.
- `[x]` Certificates stored on the attempt, skills matrix, cohort proof-of-training
  packet, `/verify`, the learning loop (ticket → article + scenario draft).
- `[x]` Localization mechanism (UI dictionaries + per-scenario overlays), axe and
  browser a11y sweeps, versioned Prisma migrations.

**2.1 — Authoring at scale** — *Goal: a catalog a team can maintain.*

- `[x]` Scenario versioning: draft → publish, with one-click rollback and a
  readable change history per scenario.
- `[x]` Import/export bundles so a scenario set moves between deployments
  (`scenario-bundle.ts`, `/api/v1/scenarios/<id>/export`, the import form).
- `[ ]` Collaborative authoring: comments, review and an approval step before
  publish (two authors, one reviewer).
- `[ ]` Exit: two authors co-edit a scenario through review to publish, with full
  history and one-click rollback, proven by a test.

**2.2 — Assessment depth** — *Goal: more than pass/fail.*

- `[ ]` Partial credit per check and rubric bands (e.g. 0 / half / full) that the
  server-side grader computes and the report explains.
- `[ ]` Competency tagging per check, feeding the existing skills matrix.
- `[ ]` Optional timing-integrity controls (tab/focus loss recorded, not punished
  by default) for higher-stakes assessment.
- `[ ]` Exit: a scenario grades partial credit identically on re-grade, and every
  certificate's competencies trace back to the checks that earned them.

**2.3 — Content & locale completeness** — *Goal: the mechanism has content.*

- `[ ]` Spanish overlays for the ten bundled scenarios.
- `[ ]` Per-locale catalog `title`/`summary` columns (today staff metadata is
  English-only).
- `[ ]` Exit: a cohort can run a bundled scenario end to end in Spanish.

**3.0 — Enterprise training platform** — *Goal: multi-organisation, evidence-grade,
assistive.*

- `[ ]` Multi-tenant organisations with isolated catalogs, branding and reporting.
- `[ ]` BI/warehouse export and scheduled reporting.
- `[ ]` Opt-in AI tutor: hints, misconception detection, scenario suggestions —
  assistive only, never auto-grading.
- `[ ]` Retention controls, deeper audit trail, SSO/SCIM at org scale.
- `[ ]` Exit: two organisations run isolated catalogs and reports under one
  deployment with audited, retained records.

**4.0 — The open credential network** — *Goal: evidence that travels.*

- `[ ]` A scenario marketplace with signed, versioned packs.
- `[ ]` Portable credentials verifiable outside this deployment.
- `[ ]` Cross-organisation competency mapping.

### 3.2 OnTrak Tix → 2.1 Scale, 2.2 HA, 3.0 Evidence-grade assurance

**2.0.0 — shipped baseline** `[x]`: M0–M7 — intake, tickets, SLA, clients,
billing, automation, knowledge, incidents, evidence and assurance packets, SOC 2
controls, backup/DR, load rehearsal recorded.

**2.1 — Scale fixes** — *Goal: a million-ticket tenant can work.*

- `[ ]` Page the inbox worklist at the database instead of reading every ticket.
- `[ ]` Hold the reference mark in a row instead of deriving it from every
  reference already issued.
- `[ ]` Re-run `npm run load-test` and record the new p95s against §10 targets.
- `[ ]` Exit: the 1M-ticket rehearsal meets the stated p95 for the worklist read
  and for create.

**2.2 — Availability** — *Goal: a write survives a node loss.*

- `[ ]` Multi-region/HA for ticket writes; p95 read < 300 ms, write < 500 ms at
  load.
- `[ ]` Exit: a failover rehearsal loses no ticket and no audit-chain link.

**2.3 — Reporting at scale** — `[ ]` Scheduled CSV/PDF exports; warehouse
connector. Exit: a nightly export lands without a person running it.

**2.4 — Config as code** — `[ ]` Export/import queues, SLA calendars, custom
fields, macros; environment promotion. Exit: a staging configuration promotes to
production byte-identically.

**3.0 — Evidence-grade assurance** — `[ ]` Auditor evidence-request portal,
tamper alarms on the audit chain, third-party timestamping.

**4.0 — The policy-bound desk** — `[ ]` AI triage and suggested resolution under
human approval, never auto-close.

### 3.3 OnTrak Sentinel → 2.1 Hardening, 3.0 Unified risk & response

**2.0.0 — shipped baseline** `[x]`: S0–S4 — IdP (OIDC/SAML, SCIM, MFA), Guard
detection, policy-gated prevention with approvals, safe-lists, TTL rollback,
alert delivery, measured time-to-prevent, signed compliance packet, intel expiry.

**2.1 — Vendor adapters** — `[ ]` Telemetry and enforcement adapters shipped
rather than an operator's own JSON `POST`. Exit: one vendor adapter runs
detection → block end to end in CI.

**2.2 — Packet extras** — `[ ]` Retention windows, control history and CSV/PDF
packet variants (S4's declared exclusions). Exit: an auditor gets all three from
the console.

**2.3 — IdP availability** — `[ ]` HA for the IdP/data plane. Exit: a node loss
does not interrupt sign-in for the family.

**3.0 — Unified risk & response** — `[ ]` Identity-aware correlation (a new
geolocation plus anomalous flows is one incident), step-up auth and session
revocation from a detection, playbook-driven response into Tix with evidence.

**4.0 — Fleet-scale defense** — `[ ]` Multi-tenant IdP, fleet rollout, and
cross-estate detection.

### 3.4 OnTrak Sync → 2.1 Approvals, 2.2 Safe apply, 3.0 Fleet remediation

**2.0.0 — shipped baseline** `[x]`: scan → findings → apply across hosts and
containers, four honest answers per target, approval-gated single apply path,
change freeze, SSO + break-glass, digest cache, in-process timer.

**2.1 — Approval workflows** — `[ ]` Change windows and maintenance calendars on
top of the freeze; approvals with a named approver and an expiry. Exit: an apply
outside its window is refused with the reason, and a test pins it.

**2.2 — Safe apply** — `[ ]` Canary then wave; rollback of a bad apply;
per-host blast-radius caps. Exit: a failed canary stops the wave and leaves the
remainder untouched.

**2.3 — Inventory depth** — `[ ]` Hardware, virtualisation and licence posture,
not only packages. Exit: one estate report names all four.

**2.4 — Per-team scope** — `[ ]` Multi-tenant estates and team-scoped visibility
matching the family roles. Exit: two teams see only their own hosts.

**3.0 — Fleet-wide remediation** — `[ ]` Dependency-aware waves, convergence
verification, and an estate-wide "patched" statement backed by evidence.

**4.0 — Continuous compliance** — `[ ]` Patch SLAs, attestation exports and
cross-estate reporting.

### 3.5 OnTrak Genie → 2.1 CLI parity, 3.0 Team CodeOps

**2.0.0 — shipped baseline** `[x]`: v0.1–v1.0 — console, tenancy, gateway model
chain, previews/approvals, terminal client, remote workspaces, BYO project,
skills/memory, propose-then-commit, repository-aware workspaces (clone, branch,
PR), account ceiling, threat model + runbook.

**2.1 — CLI parity** — `[ ]` Propose-then-commit, sharing commands and web
research from the terminal. Exit: a CLI user reviews a change set, shares a chat
and researches the web without opening the console.

**2.2 — Per-account change sets** — `[ ]` One pending set per account instead of
one per process. Exit: two operators review their own proposals concurrently.

**2.3 — Fleet operations** — `[ ]` Many workspaces from one console without the
operator becoming the bottleneck.

**3.0 — Team-scale CodeOps** — `[ ]` Shared review queue, per-team policy, and
the L2 rung (signed policy for unattended policy-bounded runs).

**4.0 — Continuous code operations** — `[ ]` Scheduled/event-driven runs under a
signed policy, with the L3 refusal still standing for host changes outside the
sandbox.

### 3.6 OnTrak Engineer → 2.1 Evidence export, 2.2 Build diff, 3.0 Multi-binary

**2.0.0 — shipped baseline** `[x]`: a metered add-on that points an agent at a
build and returns how it works, with one credit per project and the credit spent
in the control plane.

**2.1 — Evidence export** — `[ ]` Export an analysis as a signed assurance packet
(report + hashes + transcript). Exit: a packet verifies without the console.

**2.2 — Build diff** — `[ ]` Compare two builds of the same application and
report what changed. Exit: an injected change is named by symbol and by offset.

**2.3 — Analysis depth** — `[ ]` A defensible static-analysis chain (disassembly,
strings, imports, call graph) recorded as evidence.

**3.0 — Multi-binary project workspace** — `[ ]` One project spanning an
application and its libraries/installers.

**4.0 — Continuous release analysis** — `[ ]` Watch upstream builds and deliver a
diff report per release.

### 3.7 Uncensored Godmode → 2.1 Run history, 2.2 Replay, 3.0 Workspace

**2.0.0 — shipped baseline** `[x]`: metered front door to Genie (one credit per
run, refunded if nothing was produced), SSO, per-user gateway key, quota and
usage reporting, model catalog from the gateway, studio/race/judge modes.

**2.1 — Run history** — `[ ]` A durable list of a person's runs with their
artifacts and cost. Exit: a run from last week is inspectable.

**2.2 — Replay & diff** — `[ ]` Re-run a past prompt against a chosen model and
diff the files/answer. Exit: a replay never double-charges.

**2.3 — Team credits** — `[ ]` Pools and per-team quotas on the existing ledger.

**3.0 — Snapshot/rollback workspace** — `[ ]` Every run snapshots its workspace;
a person can roll back to any run.

**4.0 — Delegated autonomous runs** — `[ ]` Time-boxed runs under signed
consent, still metered and still attributed.

### 3.8 OnTrak Class → 2.1 Completion handoff, 3.0 Academy

**2.0.0 — shipped baseline** `[x]`: the OpenMAIC classroom host
(`classroom.innotel.us`) — generated multi-agent lessons, checks, learner
progress, served behind the family sign-in and linked from ITS by
`Course.classroomUrl` / `Cohort.classroomUrl`.

**2.1 — Completion handoff** — `[ ]` A classroom completion becomes an ITS
training record/certificate (the classroom's own progress is not the record of
record). Exit: finishing a lesson produces a verifiable ITS record.

**2.2 — Instructor authoring** — `[ ]` An instructor can edit checks and lesson
structure without regenerating from a prompt.

**2.3 — Progress analytics** — `[ ]` Per-learner and per-cohort progress for the
instructor.

**2.4 — Classroom packs** — `[ ]` Versioned, portable classroom bundles.

**3.0 — Multi-course academy** — `[ ]` Cohorts, prerequisites and a catalog
spanning courses.

**4.0 — Adaptive classroom** — `[ ]` The lesson adjusts to demonstrated gaps,
with the record still explainable.

### 3.9 OnTrak Lab → 2.1 Microsoft depth, 3.0 Multi-host range

**2.0.0 — shipped baseline** `[x]`: Python control plane, catalog/scenarios,
sessions, scoring, scheduler, generator, student/admin portals, CLI; Linux and
Windows templates; golden-image pipeline; Guacamole console; ticket rubric;
container stack; one-command install; published image.

**2.1 — Microsoft products beyond Office** — `[ ]` Exchange, SQL Server,
SharePoint, Microsoft 365 Apps. Exit: each has a build recipe and one graded
scenario.

**2.2 — Cloud identity sandbox** — `[ ]` Entra ID/M365 sign-in, MFA reset and
conditional-access scenarios against a tenant sandbox.

**2.3 — Recording & review** — `[ ]` `guac.recording` on for security scenarios
with instructor-only playback (retention decided with ONYX).

**2.4 — Role-based portals** — `[ ]` Cohorts (teacher, TA, marker) and
per-cohort scenario sets.

**2.5 — Metrics** — `[ ]` Session latency, pool depth and pass rate per
objective, exported.

**2.6 — Signed scenario packs** — `[ ]` Versioned, signed bundles a course can
pin and ship.

**3.0 — Multi-host range** — `[ ]` Orchestrate several lab hosts as one range
with capacity-aware placement.

**4.0 — Federated ranges** — `[ ]` Share a range between institutions with
per-range isolation and a common result format.

### 3.10 OnTrak Portal (supporting) → 3.0 Operating surface

**2.0.0 — shipped baseline** `[x]`: SSO-only front door, role-scoped tiles,
product health lights, fleet roll-up, group answer-back.

- `[ ]` 2.1 Self-service requests and access reviews initiated from Unity.
- `[ ]` 2.2 Per-organisation branding (the hosted multi-tenant case).
- `[ ]` 3.0 The family's operating surface: per-product insight, not only a
  launchpad.

## 4. Sequencing

1. **Tix 2.1** — the two named scale fixes; the only product with a measured
   failure in a stated target.
2. **ITS 2.1** — authoring at scale; the largest untapped catalog growth lever.
3. **Genie 2.1 / Engineer 2.1** — CLI parity, then evidence export.
4. **Sync 2.1–2.2, Sentinel 2.1** — approvals and safe apply; vendor adapters.
5. **Class 2.1, Lab 2.1** — close the training loop and deepen Microsoft content.
6. **3.0 lines** — Sentinel's unified risk, ITS multi-tenancy, Tix assurance,
   Genie team CodeOps.

## 5. Working agreement

- Every checklist item ships with a test that fails without it.
- A version bump touches: the version file, the changelog, the per-product
  roadmap, and this table.
- Documentation of a capability is not the capability. Items are `[x]` only when
  the behaviour is exercised the way a user will use it.
- The family keeps one identity, one theme and one evidence standard; a new
  surface adopts all three before it ships.
