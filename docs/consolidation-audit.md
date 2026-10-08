# OnTrak ⇄ OnTrak-dev — repository comparison and architecture audit

> **Purpose.** OnTrak (this repository) and OnTrak-dev are two applications that
> build the *same kind of thing* — an IT-support training range with graded
> scenarios — from opposite ends: OnTrak grades **simulations** in the browser,
> OnTrak-dev grades **real virtual machines** it stands up on demand. This document
> is the pre-integration audit: what each repository is, where they overlap, which
> of those overlaps are genuine targets for consolidation, which are architectural
> conflicts that must be *decided* rather than merged, and an incremental,
> reversible plan for getting from here to one product.
>
> It is a plan and a record, not a claim of completion. Read §8 before believing the
> integration is finished.

Status legend used below: **done** · **planned** · **open** (a decision, not a task).

---

## 1. Scope and method

Two repositories were compared, both cloned locally from `innotelinc`:

| Repository | Path in this audit | Role |
| --- | --- | --- |
| `innotelinc/OnTrak` | `OnTrak/` (this repo) | The primary repository, application identity and deployment destination. |
| `innotelinc/OnTrak-dev` | `OnTrak-dev/` (sibling checkout) | The source repository to be integrated. Must remain unchanged. |

Method:

- **Tree and file inventory** of both repositories, excluding `node_modules` and
  `.git`.
- **Entry points**: `package.json` scripts, `pyproject.toml`, `Makefile` targets,
  the `Dockerfile`/`docker-compose*.yml` of each, and the mount points an HTTP
  router is reached through.
- **Documents read for intent**: `OnTrak/README.md`, `OnTrak/ROADMAP.md`,
  `OnTrak/INNOTEL-LABS.md`, `OnTrak/docs/{stack,family-v2-roadmap,family-operations}.md`,
  and every product `README.md`; `OnTrak-dev/README.md`, `OnTrak-dev/pyproject.toml`,
  `OnTrak-dev/requirements.txt` and `OnTrak-dev/docs/stack.md`.
- **Source read for structure**, not for exhaustive behaviour: the Prisma schema
  and route tree of the OnTrak training app, and OnTrak-dev's `ontrak/` package,
  `ontrak/portal/`, `scenarios/`, `catalog/`, `infra/` and `tests/`.

What this audit does **not** do: it does not run either application, does not
verify OnTrak-dev's Windows/Incus/ZFS/Guacamole paths (OnTrak-dev's own README
reports those as "reviewed but not proven in this repository" without a real
host), and does not claim to have measured runtime behaviour of anything.

---

## 2. Repository inventory

### 2.1 OnTrak (primary) — a Next.js/Prisma monorepo of separately-deployable products

| Module | What it is | Stack | Entry point | Deployable | Tests |
| --- | --- | --- | --- | --- | --- |
| `src/` + `prisma/` (root) | **OnTrak IT Support Training (ITS)** — browser simulations, graded attempts, certificates | Next.js 15, React 19, TS, Prisma 6, PostgreSQL, Tailwind 4, xterm.js | `npm run dev`/`build`/`start`; `prisma/seed.ts` | App | `tests/*.test.ts` (tsx, ~379); Playwright a11y + Tix e2e |
| `ontrak-sentinel/` | **Sentinel** — IdP (OIDC/SAML/SCIM/MFA) **+ Guard IDS/IPS** | Node/TS + Prisma + PostgreSQL; framework-free server-rendered console | `npm run serve` (`scripts/serve.ts`) | App | `tests/*.test.ts` (~538) |
| `ontrak-tix/` | **Tix** — service desk, SLAs, billing, incident assurance | Next.js 15, React 19, TS, Prisma, PostgreSQL | `npm run dev`/`build` | App | ~844 tests |
| `ontrak-sync/` | **Sync** — fleet package/container update view; owns the family's **local account table** | Python 3.12 + FastAPI + SQLite (API); Next.js 16 dashboard | `make up`; `web/` | App (two processes) | 406 (plain `unittest`) |
| `ontrak-genie/` | **Genie** — browser/CLI coding-agent console | Node/TS, SSE, sandboxed workspace | `npm run build && npm start` | App | `src/test/**` (`node --test`) |
| `ontrak-portal/` | **Portal (Unity)** — the family front door; routes by role, holds no data | Next.js 15, React 19, TS, **no database** | `npm run dev` (port 3300) | App | 4 test files |
| `theme/` | **Unity** shared palette + copy checks | CSS + TS (and Python copy guard) | — | Shared library | `theme/tests/test_theme_copies.py` |
| `docker-compose.all.yml`, root `Makefile` | The **family stack** (`make all-up`) and per-product targets | Docker Compose | — | Deployment | Compose validation in CI |

ITS's own data model is 14 Prisma models: `User`, `Cohort`, `CohortMember`,
`SoftwarePackage`, `Scenario`, `ScenarioDraft`, `ScenarioSoftware`, `Assignment`,
`Attempt`, `CheckResult`, `PlatformToggle`, `Setting`, `AuditLog`,
`WebhookDelivery`. Its browser routes are `/`, `/login` (+ `/login/break-glass`),
`/register`, `/verify`, `/certificate/[id]`, `/health`, and the signed-in areas
`/admin` (the "control room"), `/instructor`, `/student`, `/api/lti`,
`/api/scim`, `/api/sso`.

### 2.2 OnTrak-dev (source) — a Python platform that runs a real lab

| Module | What it is | Stack | Entry point | Deployable | Tests |
| --- | --- | --- | --- | --- | --- |
| `ontrak/` | The platform: catalog, scenarios, sessions, scoring, selection, store, CLI | Python ≥3.10, PyYAML, cryptography, pywinrm | `ontrak.cli:main` (`ontrak` CLI) | Library + CLI | pytest |
| `ontrak/portal/` | Student/instructor/admin web surface | FastAPI + Jinja2 + python-multipart | `ontrak.portal.app:create_app` (uvicorn) | App | pytest |
| `catalog/` | Workload manifests: `windows-desktop.yaml`, `windows-server.yaml`, `office.yaml`, `linux.yaml` | YAML (manifests, never binaries) | — | Data | `test_catalog.py`, `test_workloads.py` |
| `scenarios/` | 14 scenario directories + `_lib/`; each `scenario.yaml` + `setup.ps1`/`check.sh` | YAML + PowerShell/bash | — | Data + guest scripts | `test_scenarios.py`, `test_generator.py` |
| `lessons/` | 7 walkthrough lessons (YAML) | YAML | — | Data | `test_lessons.py` |
| `infra/` | Host bootstrap, golden image, template builds, installer ISO, QEMU/Incus helpers | Bash + PowerShell | `infra/bootstrap-host.sh` | Operator scripts | `test_golden_image.py` |
| `deploy/` | Edge gateway (nginx), Guacamole + guacd, Authentik wiring | Docker + nginx | compose | Deployment | `test_guac.py` |
| `tests/` | pytest suite | pytest, httpx2 | `make test` | — | 280 tests, 1 skipped |
| Root | `docker-compose.yml` (lab-setup, gateway, portal, guacamole, guacd) + `.remote.yml`; `Dockerfile`; `Makefile` | Docker Compose | `docker compose up -d --build` | Deployment | `test_config.py`, `test_secrets_script.py` |

OnTrak-dev's platform modules, by job: `config.py` (settings),
`catalog.py`, `scenarios.py`, `primitives.py`, `generator.py` (scenario
generation from fault primitives), `sessions.py` (the request→clone→boot→grade→
destroy lifecycle), `scheduler.py` (scheduled prewarm/drain), `scoring.py`,
`selection.py`, `store.py` (SQLite), `models.py`, `incus.py`/`qemu.py`/`guest.py`
(hypervisor + guest transports), `guac.py` (signed HTML5 console links),
`memory.py` (in-memory hypervisor for demo), `demo.py`, `oidc.py` + `auth.py`
(Authentik sign-in + HMAC cookie), `tickets.py`, `lessons.py`, `cli.py`,
`media.py`.

---

## 3. Architecture comparison

### 3.1 Frontend

| | OnTrak | OnTrak-dev |
| --- | --- | --- |
| Framework | Next.js 15 App Router, React 19, Server Components | FastAPI + Jinja2 server-rendered HTML |
| Styling | Tailwind 4 + the Unity theme tokens; a shared `AppShell` nav | Hand-written CSS (`static/app.css`) + `base.html` chrome |
| Client state | React client components where needed (`AppShell`, `Terminal`) | None to speak of; forms POST and redirect |
| Live console | `xterm.js` driving a **simulator** in the browser | An `<iframe>` to **Guacamole** (real RDP/SSH to a VM) |
| Nav model | Role-scoped sidebar from `navForRole(role)` | Per-page links; `instructor`/`student` split |
| i18n | A small cookie-driven layer (`src/lib/i18n.ts`, `locales/{en,es}.ts`) | English only |

### 3.2 Backend and services

| | OnTrak | OnTrak-dev |
| --- | --- | --- |
| Language / runtime | TypeScript on Node ≥20.11 | Python ≥3.10 |
| Web layer | Next.js route handlers + Server Actions | FastAPI + uvicorn |
| Hypervisor | None — everything is simulated in-process | **Incus** (QEMU/KVM) on the host, reached over its socket |
| Guest automation | None | WinRM (default), `incus exec`, SSH, `null` |
| Console protocol | In-browser terminal emulator | Guacamole + guacd (RDP/SSH) |
| Background work | Webhook delivery, seeds | Warm pools, scheduled prewarm/drain, provisioning threads |

### 3.3 Data stores

| | OnTrak | OnTrak-dev |
| --- | --- | --- |
| Primary | PostgreSQL via Prisma (each product its own schema and database) | **SQLite** (`state/`), one file |
| Migrations | Prisma migrations (`prisma/migrations/`) | None found — the schema is created on first use by `store.py` |
| Other state | Object/`storage/` for evidence; per-product DBs (Sentinel 5434, Tix 5433, training 5432) | `state/`, `media/`, YAML config, Incus images/snapshots on the host |
| Identity of rows | CUID/uuid strings | SQLite integer row ids |

### 3.4 Authentication and authorisation

| | OnTrak | OnTrak-dev |
| --- | --- | --- |
| Provider | Cerulean (Authentik) via each product's own OIDC client; **Sentinel** is the family's own IdP (OIDC/SAML/SCIM/MFA) and also federates to Cerulean | Authentik only (`oidc.py`); no local password |
| Local credential | Per-product break-glass paths; the family's local **account table** is OnTrak Sync's | A `users` row per Authentik identity, with a **sentinel value** (`sso:authentik`) in a `password_hash` column that nothing verifies |
| Session | Per-product signed session cookie / NextAuth-style `jose` tokens | One HMAC-SHA256 cookie (`ontrak_session`) signed with `portal.secret` |
| Roles | Six, family-wide: `ADMIN`, `SYSADMIN`, `ANALYST`, `TECHNICIAN`, `INSTRUCTOR`, `STUDENT` | Two: `instructor`, `student` |
| Authorisation | Re-checked server-side per action; Sentinel adds policy/ABAC and MFA enforcement | `require_user` / `require_instructor` dependencies; ownership check in one `load_session` helper |

### 3.5 Routing, configuration and deployment

| | OnTrak | OnTrak-dev |
| --- | --- | --- |
| Public entrance | One app per subdomain (`its.`, `tix.`, `sentinel.`, …); Portal (Unity) is the front door | One nginx **gateway** publishing one port: `/` → portal, `/guacamole/` → console; the range also answers on three names (`ontrak.`, `student.`, `admin.`) |
| Config convention | `ONTRAK_*` flat env vars, `.env` + `.env.example`, per product | `ONTRAK_<SECTION>__<KEY>` env overriding `config/ontrak.yaml` (YAML-parsed values) |
| Secrets | `.env`, with Cerulean Vault `vault://` references resolved at boot | Same Vault convention; `scripts/secrets.sh` fills generated local secrets idempotently |
| Local secrets generation | `.env.example` copy | A first-run `lab-setup` service writes `.env` and shared portal/console keys |
| CI | `.github/workflows/ci.yml` incl. a **Family stack** job (`make all-up`) | `.github/workflows/` incl. an attribution guard; ISO smoke test |
| Deploy targets | `docker-compose.all.yml`, `docker-compose.prod.yml`, per-product compose | `docker-compose.yml` + `docker-compose.remote.yml`, `infra/build-installer-iso.sh` |

### 3.6 Shared conventions the two already agree on

Both use the same **platform services** vocabulary (Cerulean/Authentik for
identity, Vault for secrets, DNS/TLS from Cerulean, NPM Edge), both separate pure
logic from adapters and test the pure half, and both treat "results only, never
progress" as a deliberate policy (OnTrak-dev says it in `docs/architecture.md`;
OnTrak persists only submitted attempts). That agreement is the seam the
integration plan in §7 leans on.

---

## 4. Feature-by-feature overlap

### 4.1 Overlapping capabilities

| Capability | OnTrak | OnTrak-dev |
| --- | --- | --- |
| A student signs in and starts a task | `/student`, simulated scenario in the browser | `/dashboard`, real VM provisioned on demand |
| An instructor watches a class | `/instructor` (cohorts, attempts, analytics) | `/instructor` (sessions, warm pool, templates, CSV) |
| Results are recorded | `Attempt` + `CheckResult` + certificates | `results` table + SQLite + CSV export |
| Scenarios are authored | `Scenario` rows + `ScenarioDraft` + `ScenarioEditor` | `scenario.yaml` + `setup.ps1`/`check.sh` |
| Objectives are declared and checked | Grading rules over simulator state | `check.ps1`/`check.sh` over live machine state |
| Hints | Scenario hints in DB/i18n | Progressive hints per scenario |
| Self-service reset | Restart the simulated machine | Destroy and re-clone the clean snapshot |
| A dashboard | `/admin` control room, `/student`, `/instructor` | FastAPI portal dashboard + `/admin` panel |
| Lessons/walkthroughs | i18n scenario text; no separate lesson library | A dedicated `lessons/` YAML library + pages |
| Theming | Unity theme tokens | Its own CSS |

### 4.2 Unique to OnTrak (nothing to port in)

- **Tix** — an MSP-grade service desk with SLAs, queues, billing, incident
  response and the signed assurance packet.
- **Sentinel** — a real IdP (OIDC/SAML/SCIM/MFA/access reviews) **and** an
  IDS/IPS (syslog + NetFlow/IPFIX listeners, detection rules, triage,
  threat-intel, policy-gated enforcement with approvals, safe-lists and rollback),
  on one hash-chained evidence log.
- **Sync** — fleet-wide package/container update state with an approval-gated
  applier, and the family's local account table.
- **Genie** — a sandboxed coding-agent console with an approval gate.
- **Portal (Unity)** — the role-scoped front door with product health and the
  fleet roll-up.
- **Simulated scenarios** — Linux, Windows and Office machines that need no
  hypervisor, no Windows image and no licence, so they run anywhere Docker runs.
- **LTI 1.3, OIDC SSO and SCIM 2.0** in the training app, with the
  `integration-status` panel reporting exactly how each is wired.
- **Certificates and proof-of-training packets** in the family's shared signed
  format.

### 4.3 Unique to OnTrak-dev (the reason to integrate)

- **Real machines.** Incus VMs that boot a real Windows/Linux kernel; a scenario
  that must hold a driver fault or survive a malware scenario needs a VM, not a
  simulation. OnTrak-dev says this out loud: "a container cannot be Windows 95".
- **A workload catalog** of media/device profiles from Windows 95 → Server 2025,
  Office 97 → 2024, and published Linux images, with the legacy profiles (IDE,
  emulated NIC, no Secure Boot) already worked out.
- **A scenario generator** — fault primitives compose into new scenarios
  (`ontrak generate`), each validated against the grading contract before it can
  reach a student.
- **Warm pools and scheduled prewarm/drain** — memory is spent only while a class
  runs, and 30 students at 09:00 do not fall the host over.
- **An HTML5 console via Guacamole** with signed, encrypted, short-lived,
  single-VM payloads — the RDP password is never shown to the student.
- **A bootable installer ISO** that provisions a range host first-boot.
- **Process-level grading of a real fix**: any correct fix passes because the
  check reads live state, not a scripted log.

---

## 5. Redundancy and consolidation targets

These are the places where keeping both is duplicate product, not duplicate code:

| # | Redundancy | Recommendation |
| --- | --- | --- |
| R1 | **Two scenario models** — Prisma `Scenario`/`ScenarioDraft`/`ScenarioSoftware` (simulation, DB-backed) vs `scenarios/*/scenario.yaml` (`_lib/`, generated, file-backed) | Keep both *representations*, converge the *authoring*: one validated schema, a documented mapping, and one import direction. Do not delete either — §6/C3. |
| R2 | **Two instructor surfaces** (`/instructor` in Next.js vs `/instructor` + `/admin` in Jinja) | One instructor surface (Next.js); OnTrak-dev's lab ops become a section of it. |
| R3 | **Two student dashboards** | One (`/student`), with "start a real machine" as a task type. |
| R4 | **Two sign-in paths and two user tables** (family Identity/Sync accounts + 6 roles vs Authentik-only + SQLite `users` + 2 roles) | One identity: OnTrak-dev's portal points at the family IdP; its `users` row becomes a role/display cache keyed by the IdP subject, as it already is. |
| R5 | **Two portals/front doors** (Unity vs the FastAPI portal) | Unity stays the family front door; the FastAPI portal becomes the **lab console** (sessions + console), not a second door. |
| R6 | **Two evidence trails** (family append-only hash-chained audit vs OnTrak-dev's `log_event`/`results`) | OnTrak-dev's events feed the family evidence model; do not build a third. |
| R7 | **Two deployment stacks and two edge models** (one host port + nginx gateway vs per-product subdomains) | Adopt the family's subdomain + wildcard-cert model; retire the gateway once the portal is served by the family edge. |
| R8 | **Two config conventions** (`ONTRAK_*` vs `ONTRAK_<SECTION>__<KEY>` + YAML) | Document OnTrak-dev's as the lab's own; do not rewrite it for the merge — bridge it at the boundary. |
| R9 | **Two theming systems** | OnTrak-dev's Jinja surfaces adopt the Unity tokens before they ship as family screens. |
| R10 | **Overlapping "lessons"** (OnTrak-dev's lesson library vs ITS's scenario text) | Keep OnTrak-dev's `lessons/` as data; surface it in the ITS UI rather than re-authoring it. |

---

## 6. Architectural conflicts (decisions, not merges)

**C1 — Two languages, one product.** OnTrak is TypeScript; OnTrak-dev is Python.
Porting the lab to TypeScript would mean re-implementing WinRM, Guacamole signing,
PowerShell generation and the Incus client — a rewrite, not an integration.
*The decision:* OnTrak-dev's Python control plane **stays a separate service** and
is integrated as a deployable peer (a "Lab" product), reached by the family UI. The
family already accepts this shape — OnTrak Sync is deliberately Python for exactly
this reason.

**C2 — Simulation vs real VM.** The two graders disagree about what "resolved"
means: OnTrak grades simulator state in-process; OnTrak-dev runs `check.ps1` against
a live guest. They are complementary, not alternatives, but they cannot both own the
`Attempt` record without a decision.
*The decision:* the **task** carries the mode (`simulated` | `lab`); the simulation
stays the default and needs no host, the lab is opt-in per scenario and per
deployment. Grading evidence records which mode produced it, because "passed" means
something different in each.

**C3 — Two scenario schemas cannot be one without losing something.** ITS scenarios
are rows with software inventory and i18n; OnTrak-dev's are files with guest scripts
and a generated-from-primitives provenance. A single table that held both would be a
row where half the columns are `NULL` and no reader can tell which kind it is.
*The decision:* a **mapping plus a validated interchange**, not a merged table. One
direction first (lab scenario → family scenario), with a round-trip test.

**C4 — Evidence models differ in kind.** The family's audit log is append-only and
hash-chained *by construction*; OnTrak-dev's `log_event`/`results` are ordinary
rows. Silently presenting the latter as if it were the former would weaken the claim
the whole family makes in its assurance packets.
*The decision:* lab events that matter to a review are **written to the family
evidence chain** at the boundary; OnTrak-dev's SQLite row stays its operational
record, and is labelled as such.

**C5 — Two identity sources.** OnTrak-dev's SQLite users are derived from Authentik;
the family's local account table is Sync's. Running both as writable sources of
truth is how an offboarding silently fails.
*The decision:* the IdP (Sentinel or Cerulean) is the source; OnTrak-dev's row is a
cache, and the family's roles replace `instructor`/`student` at the same boundary.

**C6 — Two role vocabularies.** `instructor`/`student` must be mapped to the family's
six. The mapping is not a rename: OnTrak-dev's `instructor` covers what the family
splits into `INSTRUCTOR`, `TECHNICIAN` and `ADMIN`.
*The decision:* map at the boundary with an explicit table, and let the IdP's groups
decide — never infer.

**C7 — Reversibility.** The consolidation must not require a destructive migration
of training data. OnTrak-dev keeps only *results* (never progress), which is what
makes a one-way import feasible and reversible by dropping the imported rows.

---

## 7. Integration plan

**Baseline.** An integration branch `integration/unified-ontrak` **already exists**
in OnTrak, and the Sentinel work has already landed on it: a NetFlow/IPFIX flow
listener (`ontrak-sentinel/src/lib/guard-netflow.ts`), a Sentinel **control center**
(`/console/control-center`), and a **Sentinel tile** in the training app's `/admin`
control room (`src/lib/sentinel-status.ts`). `OnTrak-dev` is untouched. The plan
below starts from that state.

Each step is independently revertable: a config change, an env flag, or a commit
that can be reverted without touching the other steps.

**Step 1 — Freeze the audit (this document).** *Artefacts:* this file.
*Verify:* it is reviewed and referenced from the roadmap; no code changes.

**Step 2 — Recognise the lab as a capability, in the UI only.** *Artefacts:* the
Portal product catalogue (`ontrak-portal/src/lib/portal-rules.ts`) gains a `lab`
entry; the training app's `/admin` gains a capabilities panel listing every family
capability with its state and link, driven by env (`ONTRAK_LAB_URL`, base-domain
derivation). *Verify:* unit tests for the catalogue/panel; no lab code runs.
*Revert:* drop the entry; nothing else changed.

**Step 3 — One identity for the lab.** *Artefacts:* OnTrak-dev's
`ONTRAK_PORTAL__OIDC_*` pointed at the family IdP; a documented
`instructor`/`student` → family-role mapping; the SQLite `users` row kept as a
cache. *Verify:* sign in to the lab through the family provider; confirm a group
change takes effect on the next sign-in (OnTrak-dev already re-reads the IdP per
sign-in). *Revert:* point the OIDC vars back at Authentik directly.

**Step 4 — Surface a lab session from the family UI.** *Artefacts:* a
"start a real machine" action for scenarios tagged `lab`, behind
`ONTRAK_LAB_ENABLED` (default **off**), which deep-links into the lab portal's
session flow with the signed-in identity. *Verify:* an integration test asserts the
action is absent when the flag is off and links correctly when it is on; the
simulation path is unchanged. *Revert:* clear the flag.

**Step 5 — Converge the scenario model, one direction.** *Artefacts:* a mapping
spec plus a one-way importer (lab `scenario.yaml` → family `Scenario`), a migration
for whatever columns it needs, and a round-trip test over the 14 lab scenarios.
*Verify:* imported scenarios grade identically in the simulation where the simulator
supports them, and are refused (not silently accepted) where it does not.
*Revert:* delete the imported rows; the source files were never touched.

**Step 6 — Evidence at the boundary.** *Artefacts:* lab session completion (and
enforcement-relevant events) appended to the family evidence chain with the mode
recorded. *Verify:* a completed lab session appears in the chain and in a signed
assurance packet. *Revert:* stop the append; existing rows remain (append-only).

**Step 7 — Reporting and instructor convergence.** *Artefacts:* the lab's results
and CSV surface folded into the Next.js instructor view; OnTrak-dev's own portal
reduced to the session + console surface. *Verify:* the instructor view shows both
modes from one query; the lab portal no longer offers a competing dashboard.
*Revert:* the lab portal is unchanged until this step, so reverting restores it.

**Not in this plan, deliberately:** porting OnTrak-dev to TypeScript; merging the
two databases; deleting either scenario representation; retiring the lab's
hypervisor tooling. See §6.

---

## 8. What remains

Stated plainly, because the integration is **not** complete:

- **No OnTrak-dev code has been ported or merged.** Not one Python module has been
  re-implemented in TypeScript, and no lab route is served by the family stack.
- **No database migration has been written for OnTrak-dev.** Step 5's migration is
  planned, not authored; OnTrak-dev keeps its results in SQLite and no schema change
  exists in either repository to reconcile them.
- **Only Step 1 and the pre-existing Sentinel work are real.** Steps 2–7 are
  planned. Nothing in §7 beyond Step 1 has been implemented.
- **OnTrak-dev has not been modified**, as required. Its `README.md` still describes
  a standalone range; its portal still signs in only through Authentik and only as
  `instructor`/`student`.
- **The lab's host-half has never been verified in this environment** (no
  hypervisor), and this audit did not run either application.
- **Terminology is unresolved.** Two products are called "OnTrak"; the merged
  product's name, and the name of the lab capability, are open (§9).

---

## 9. Risks and open questions

| # | Risk / question | Why it matters |
| --- | --- | --- |
| Q1 | **What is the merged product called, and what is the lab called?** | Two repositories, one name. Until this is decided, docs and links will keep colliding. |
| Q2 | **Does the lab become a product or a mode of ITS?** | It changes the Portal catalogue, the role model and the URL scheme. §6/C2 assumes "mode"; §7/Step 2 assumes "capability". |
| Q3 | **Who owns the real-VM grading record?** | If a `lab` attempt is graded by OnTrak-dev but stored by ITS, the write path crosses two languages and two stores. §6/C2 proposes ITS owns `Attempt` and records the mode. |
| Q4 | **Can the family edge serve the lab?** | The lab's Guacamole console, its three names and its signed single-VM payloads all assume its own nginx gateway; moving to the family's subdomain + wildcard-cert model is unproven. |
| Q5 | **Hypervisor capacity under the family's tenancy** | The lab is single-tenant and RAM-bound (warm pools, `max_total`). Multi-tenant hosting is out of scope today and must stay out until measured. |
| Q6 | **Licensing** | OnTrak-dev uses Microsoft evaluation media (expires in 90–180 days) and never redistributes retail media; a merged product inherits that operator responsibility and must keep saying so. |
| Q7 | **Two ways to grade, one definition of "passed"** | Analytics and certificates that mix modes will be misleading unless every figure states its mode. |
| Q8 | **CI** | The family's "Family stack" job brings up six containers; adding the lab means a hypervisor in CI, which is why Step 4's automation is gated and Steps 5–7 must be verifiable without a VM. |
| Q9 | **Review cost** | The integration touches identity, evidence and deployment at once. §7's sequencing exists to keep each step independently revertable; skipping ahead trades that away. |
