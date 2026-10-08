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
| R7 | **Two deployment stacks and two edge models** (one host port + nginx gateway vs per-product subdomains) | Adopt the family's subdomain + wildcard-cert model for the lab's **public names**; the gateway itself stays. §9/Q4 answers what the edge can take over and what it cannot: one family name in front, the lab's own nginx still routing `/` and `/guacamole/` behind it. |
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

*How it is recorded (Step 6).* The mode is a **column on the attempt**
(`Attempt.gradingMode`), written when the attempt is graded and read back by every
surface that reports a score — never re-derived from the scenario's tags at read
time, so a scenario retagged later cannot rewrite what past evidence says (the same
reason a certificate is stored rather than recomputed). The task's own marker is the
`lab` tag Steps 4–5 already use (`src/lib/grading-mode.ts`); a task without it is the
simulator's. An absent or unrecognised value reads back as `simulated`, which is the
weaker claim and therefore the safe default for an assurance record. This is what
answers **Q2** and **Q3** in §9.

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
listener (`ontrak-sentinel/src/lib/guard-netflow.ts`), an OTLP receiver
(`ontrak-sentinel/src/lib/telemetry-otel.ts`, `POST /guard/v1/otel`), a Sentinel
**control center** (`/console/control-center`), and a **capabilities panel** in the
training app's `/admin` control room (`src/lib/capabilities.ts`, which superseded the
single Sentinel tile). `OnTrak-dev` is untouched. The plan below starts from that
state.

Each step is independently revertable: a config change, an env flag, or a commit
that can be reverted without touching the other steps.

**Step 1 — Freeze the audit (this document).** **(done)** *Artefacts:* this file.
*Verify:* it is reviewed and referenced from the roadmap; no code changes.

**Step 2 — Recognise the lab as a capability, in the UI only.** **(done)**
*Artefacts:* the Portal product catalogue (`ontrak-portal/src/lib/portal-rules.ts`)
has a `lab` entry (host `lab`, roles STUDENT/INSTRUCTOR/ADMIN, its own `/healthz`);
the training app's `/admin` has a capabilities panel listing every family capability
with its state and link, driven by env (`ONTRAK_LAB_URL`, base-domain derivation)
(`src/lib/capabilities.ts`). *Verify:* unit tests for the catalogue
(`ontrak-portal/tests/portal-rules.test.ts`, `product-health.test.ts`) and the panel
(`tests/capabilities.test.ts`); no lab code runs. *Revert:* drop the entry; nothing
else changed.

**Step 3 — One identity for the lab.** **(done — as documentation; operator-run)**
*Artefacts:* `docs/lab-identity.md` — the operator steps to point the lab's OIDC at
the family's provider (the exact `ONTRAK_PORTAL__<SECTION>__<KEY>` variables and the
redirect-URI rule), the explicit `instructor`/`student` → family-role mapping, and that
the lab's SQLite `users` row is a role/display **cache keyed by the IdP subject**, not a
source of truth. OnTrak-dev is unchanged. *Verify:* an operator signs in to the lab
through the family provider and confirms a group change takes effect on the next sign-in
(OnTrak-dev re-reads the IdP per sign-in, `ontrak/oidc.py`); **not executed here — no lab
host exists in this environment.** *Revert:* point the OIDC vars back at Authentik.

**Step 4 — Surface a lab session from the family UI.** **(done)** *Artefacts:*
`src/lib/lab-rules.ts` (a pure, tested reader of `ONTRAK_LAB_ENABLED` and
`ONTRAK_LAB_URL`, default **off**, plus the exact `lab` scenario-tag match), and a
"start a real machine" link on the student page's scenario card, drawn only when the
deployment enabled the lab *and* the scenario is tagged `lab`. It deep-links to the
lab's own dashboard (`<ONTRAK_LAB_URL>/dashboard`), which signs the student in against
the same provider — the link carries **no identity**, because a subject in a query
string would be a second, weaker identity path (§6/C5). *Verify:* `tests/lab-rules.test.ts`
asserts off-with-no-link, enabled-with-the-right-link, and a half-configured lab that
is reported rather than drawn as a dead link; the simulated start is unchanged for a
scenario that does not claim the lab. *Revert:* unset `ONTRAK_LAB_ENABLED`.

  *Caveat, stated plainly:* no scenario is tagged `lab` yet (that is Step 5), so in
today's data the link renders nowhere. The reader and the gate are the deliverable;
the affordance becomes visible when a lab scenario exists and a lab is deployed.

  **One door, not two (added after the importer gained a caller).** A lab scenario
  carries **no simulated checks** — that is Step 5's design, not an oversight — so a
  simulated attempt at one grades nothing while `gradingModeForTags` labels the record
  `lab`, because the mode is read from the same tag. The evidence would say a real
  machine decided something no machine touched, which is the single failure §9/Q7
  exists to prevent. So `simulatedStartRefusal` (`src/lib/lab-rules.ts`) is asked at
  **both** seams: the card draws the lab door *instead of* the start button, and
  `startAttempt` refuses the POST before creating anything, because a rule only the page
  checks is a rule a POST walks past. *Verify:* `tests/lab-import.test.ts` holds the
  rule and holds each seam to asking it — deleting the check from either file fails,
  naming that file — and `tests/lab-rules.test.ts` keeps the substring rule (`cyber-lab`
  is not `lab`). *Revert:* one identifier in two files; the tag stays the only marker.

**Step 5 — Converge the scenario model, one direction.** **(done)** *Artefacts:*
`src/lib/lab-scenario-import.ts` — a pure, one-way importer from a parsed lab
`scenario.yaml` to the family's row shape (platform, engine, difficulty, time limit,
pass mark, tags incl. `lab`, the briefing as `description`/`brief`, and the objectives
as the task list), with `exportLabScenario` for the return trip; one nullable column,
`Scenario.labMeta` (+ `prisma/migrations/20261106000000_add_scenario_lab_meta`), for the
facts the family's model has no column for (objective ids/weights/critical flags,
category, workloads, lessons); and the 14 lab scenarios as JSON fixtures under
`tests/fixtures/lab-scenarios/`. *Verify:* `tests/lab-scenario-import.test.ts` holds all
14 to a field-for-field round trip, and asserts that the **simulator refuses every one**
— the imported definition carries no checks (the lab grades against a live machine, and
nothing in the YAML says which live condition an objective tests), so
`validateDefinition` declines it rather than letting it pass as simulated. *Revert:*
delete the imported rows; the source files were never touched.

  **And it can be written now.** The step's own caveat was that nothing put the mapping
  into a database, so no deployment held a `lab`-tagged scenario and the door above was
  drawn nowhere. `src/lib/lab-import.ts` is the plan — pure, tested, all-or-nothing, and
  a duplicate slug is refused rather than silently overwritten — and
  `npm run lab:import` (`scripts/import-lab-scenarios.ts`) is the operator's script that
  applies it, idempotent by slug, publishing the rows because a scenario a student cannot
  reach is a door drawn nowhere. *Verify:* `tests/lab-import.test.ts`; and it has been run
  against a booted family stack, where the 14 rows landed tagged `lab`, published, with no
  checks, and a lab completion then filed an attempt against one of them.

**Step 6 — Evidence at the boundary.** **(done)** *Artefacts:* `src/lib/grading-mode.ts`
(the two modes, the task's `lab`-tag rule, and the default-to-`simulated` coercion);
the mode is written to `Attempt.gradingMode` (+ migration
`20261107000000_add_attempt_grading_mode`: one nullable TEXT column) at grading time,
carried on the `attempt.submit` and `attempt.regrade` entries in the family's
append-only audit chain (§6/C4), added to the graded-event payload (`GradedEventInput.mode`
— an additive field, which on its own would not move the version; the version is **2**
because `passed` was recomputed, see §9/Q7 and `src/lib/score-rules.ts`), and stated on
the results API JSON and CSV (`mode`). *Verify:*
`tests/grading-mode.test.ts` pins the tag rule and the default;
the webhook suite asserts every payload carries a mode and that an unstated or
unrecognised one is `simulated`; the CSV suite asserts the column is appended.
*Revert:* the column is nullable and every reader defaults to `simulated`, so
dropping it restores the previous behaviour with no backfill.

  The **inbound boundary** that accepts a lab's completion and writes that row is
also here: `POST /api/v1/lab/completions`, its pure rulebook
(`src/lib/lab-completion-rules.ts`), and the idempotency key it relies on
(`Attempt.labSessionId`, unique, + migration `20261108000000_add_attempt_lab_session`).
It authenticates with the deployment's API token, refuses a completion filed against a
scenario that is not tagged `lab`, and writes the attempt, its check results and a
`mode: "lab"` certificate in one transaction. The contract is in
[lab-completion.md](lab-completion.md); `tests/lab-completion.test.ts` pins the rules.

  *Caveat, stated plainly:* **no lab is deployed in this environment**, so no
completion has been posted end-to-end and no row carries `gradingMode = 'lab'` yet.
What is delivered — and tested — is the field, its derivation from the task's own tag,
every reader that states it, and the door a lab would report through. **Making the
call is OnTrak-dev's half and is not implemented**, because OnTrak-dev must stay
unchanged.

**Step 7 — Reporting and instructor convergence.** **(done on this side; the lab's own
portal is untouched)** *Artefacts:* `summariseByMode` in `src/lib/analytics-rules.ts`
splits the same attempts by grader, and `/instructor/analytics` renders a "By grading
mode" panel where each figure names the mode that produced it (audit Q7) instead of
blending a simulator's pass with a live machine's; `/instructor/attempts` and the
attempt review show a mode badge on every row; `mode` is on `/api/v1/results` and its
CSV export. *Verify:* `tests/lib.test.ts` holds two simulated attempts and one lab
attempt to *not* blend (the aggregate would read 70% while the split reads
simulator-100%/lab-0%); the CSV suite holds the appended column. *Revert:* drop the
panel and the column; the aggregate cards are unchanged.

  *Caveat, stated plainly:* reducing OnTrak-dev's own portal to a session + console
surface is a change **inside OnTrak-dev**, which this work must not make, so the lab
portal still offers its own dashboard. The convergence here is one-directional: the
family's instructor view is ready to show lab results the moment a lab reports them.

**Not in this plan, deliberately:** porting OnTrak-dev to TypeScript; merging the
two databases; deleting either scenario representation; retiring the lab's
hypervisor tooling. See §6.

---

## 8. What remains

Stated plainly, because the integration is **not** complete:

- **No OnTrak-dev code has been ported or merged.** Not one Python module has been
  re-implemented in TypeScript, and no lab route is served by the family stack.
- **Nothing has been migrated in OnTrak-dev.** Its schema is created on first use and
  this work adds no change there. Steps 5–6 add two nullable columns on *this* side
  (`Scenario.labMeta` and `Attempt.gradingMode`, each with its migration), and no attempt
  is made to reconcile the two databases: the family's Postgres and the lab's SQLite stay
  separate stores (§6/C4).
- **Steps 1–7 are real; the lab itself is not deployed.** The lab is a catalogue entry, a
  tile, a gated "start a real machine" link on a `lab`-tagged scenario, a documented
  identity mapping, an importer that reads the lab's 14 scenarios into the family's shape,
  a recorded grading mode on every attempt's evidence, an instructor view that states
  that mode, and a boundary that accepts a lab's completion and records it as a graded  attempt. **No lab is deployed, and nothing has been graded on a real machine.** OnTrak
  Lab's half — signing in through the family IdP, and calling the completion route after a
  session — is drafted out of tree in this repository
  (`integrations/lab-completion-client/`, a dependency-free Python client with its own
  tests) **and has not been installed on a lab host.** No lab identity has been exercised
  here, and no scenario has been run on a hypervisor.

  What is no longer true is the older form of that sentence, and the change is worth
  recording precisely. **The catalogue is now in a database, and a completion has been
  posted end to end — against a booted family stack, not against a lab.** `npm run
  lab:import` wrote the lab's 14 scenarios into a running deployment (tagged `lab`,
  published, no simulated checks, `labMeta` intact, idempotent on a second run), and
  `POST /api/v1/lab/completions` — authenticated with the deployment's token — filed
  `sess-2026-10-08-0001` against `net-dns-failure`: **201** on the first delivery and
  **200** with the same `attemptId` on the retry, the attempt `GRADED` with
  `gradingMode = 'lab'` and three check rows, a certificate issued whose signed content
  carries `mode: "lab"` and the `lab` skill tag, an `attempt.lab_completion` entry in the
  audit chain, and the same `mode` in `GET /api/v1/results` and its CSV. A completion
  filed against a simulated scenario was refused `422`. What that proves is the *boundary*
  and the *catalogue*; it does not prove a real session, because no lab host exists here
  and the session id in that test was typed by hand rather than by a machine. The lab's
  side of the wire is still unwalked.
- **OnTrak-dev has not been modified**, as required. Its `README.md` still describes
  a standalone range; its portal still signs in only through Authentik and only as
  `instructor`/`student`.
- **The lab's host-half has never been verified in this environment** (no
  hypervisor), and this audit did not run either application.
- **The family landing page still lists six products, without OnTrak Lab.** It lists
  what the family site links to and serves, and OnTrak Lab is a peer product with its
  own repository, its own host and no deployment in this family running one — Q4 below
  says the family edge *may* serve a lab, and a page is not a deployment, so the count
  is the same before and after that answer; `docs/stack.md` carries the lab's row
  instead, where being part of the architecture is the question being asked.
- **The family's service map now describes the family that exists.** It had listed
  `ontrak-sentinel` as "(planned)"/"(unbuilt)" and carried no row for `ontrak-genie`,
  while `docker-compose.all.yml` starts both of them and [INNOTEL-LABS.md](../INNOTEL-LABS.md)
  records Sentinel's S0–S3 as shipped — so a reader of the architecture document was told
  the family's own IdP and IDS/IPS did not exist yet, in the repository that ships them.
  The rows are corrected, and the claim cannot come back silently: a service-map row that
  names a directory present here may no longer call it planned or built elsewhere, which
  `tests/service-map.test.ts` fails on. The lab's row keeps its marker, because there the
  claim is true.
- **A shipped listener is a port the guide has to name.** The same sweep found two more
  documents that had fallen behind the code in the same way: [INNOTEL-LABS.md](../INNOTEL-LABS.md)
  still said "when Sentinel's IdP is built" although S1 is closed and the same page names
  Sentinel as the layer the other products sign in through, and the operations guide's list
  of Sentinel's shared host ports stopped at the syslog listener, omitting the NetFlow/IPFIX
  collector `docker-compose.all.yml` has published since the flow listener landed. The
  guide's "What runs where" table is checked against the compose file now, by
  `tests/family-ops.test.ts`: a port it names that no family stack publishes is a failure
  rather than a reader's dead end at 3am.
- **A registered client is a list the guide has to have.** The same sweep found the
  operations guide one callback short of the client it describes: its "redirect URIs
  registered on the `ontrak` client" stopped at five and closed by saying
  "`--print-redirect-uris` prints the same list, so the script and the registered client
  cannot drift apart unnoticed" — while `scripts/cerulean-ontrak.py` registers six. The
  one missing was Genie's (`https://genie.ontrak.innotel.us/api/auth/callback`, which
  `ontrak-genie/src/server.ts` answers), so an operator who registered the client from
  that page left Genie's sign-in failing at the provider with the guide's own
  `redirect_uri mismatch` row as the only clue. The page is that list rather than a second
  copy of it now, and the claim is mechanical: `tests/family-ops.test.ts` holds the
  guide's block against the script's `REDIRECT_URIS` in both directions, and refuses a
  callback at a name the script publishes no proxy host for.
- **A role table is a list of what each role can reach, and Genie was not in it.** The
  catalogue gives `SYSADMIN` the agent console (`ontrak-portal/src/lib/portal-rules.ts`),
  and both documents that answer "which group do I put this person in" stopped short of
  it: the operations guide's `ontrak-sysadmins` row read "Tix, Sentinel, Sync" — four
  pages above its own sentence saying sysadmins reach *everything* — and the portal's
  README said the desk, Sentinel and Sync as well. Both name Genie now, and both tables
  are held to the catalogue: `tests/family-ops.test.ts` for the guide, which describes
  this deployment and so leaves the optional lab out, and
  `ontrak-portal/tests/portal-rules.test.ts` for the README, which documents the catalogue
  itself and so includes it. The guide's table now says which of the two it is, so a
  reader comparing them does not have to guess why one lists a product the other does not.
- **The boundary is what CI tests, and it cannot stop being tested.** The two live tests
  that drive the lab's completion route — this repository's half of the boundary, and the
  only pair a lab host depends on — run in the `training` job on every change with no VM
  (§9/Q8). That was true before and asserted only in a comment beside the steps, so
  `tests/ci-coverage.test.ts` holds the three clauses that make it a rule rather than a
  habit: no workflow step may name a hypervisor, every root live test must be off unless
  its own flag is set, and the lab's two boundary tests must keep being run by a job.
  Where the lab is *hosted* is a different question with a different answer (§9/Q5): one
  lab host per deployment, single-tenant, because its VMs share one bridge, one pool and
  one store and nothing in the lab names a tenant.
- **A suite that is not an npm package can be missed the same way.** The genie job ran
  `npm test`, which is that package's TypeScript suite, and
  `ontrak-genie/scripts/tests/test_verify_sso.py` — twelve offline tests of Genie's sign-in
  posture check, deciding config precedence, the callback that has to be *this* name's, a
  redirect handed back rather than followed, and an unset admin token as a skip rather than
  a failure — was run by no job and named by no Makefile target, so it had only ever run on
  the machine of whoever wrote it. That is the failure the portal's own job was added for,
  one artifact class over, which is why the rule is general now rather than npm-shaped:
  every directory in the tree that holds a `test_*.py` must be run by a job, derived by
  walking the tree rather than listed, with a job's `working-directory` and a step's own
  `cd` both counted as a job saying where it works. What "run by a job" means is the
  narrow part, and two plants moved it: a comment that names a test directory has not run
  it, so the job text is comment-stripped first, and Python's discovery reaches a suite one
  level down rather than through an ancestor, so `cd scripts && … discover -s tests` counts
  and discovering from the package root finds nothing. Seven plants fail it — a planted
  directory, and each of the four suites losing the step or the `cd` that runs it — and the
  first defect, the genie suite with no job at all, fails it by name.
- **The first-sign-in table is held to the seeds now.** Which address, which account,
  which password, which join code — that table is the one page an operator reads on the
  first morning, and it was the last table in the guide held to nothing, in a document
  whose every other list is compared against the file that decides it. It matters more
  than the rest: a stale row here is a room that cannot sign in, and nobody reading it
  can tell a wrong password from a wrong server. `tests/family-ops.test.ts` reads the
  demo accounts, the default password and the join code out of `prisma/seed.ts` and
  `src/lib/seed-rules.ts`, the desk's accounts and password out of
  `ontrak-tix/prisma/seed.ts`, and refuses an account the seed does not create; it also
  refuses Sync's row unless the phrase it tells an operator to grep for is one
  `ontrak-sync/backend/ontrak/api.py` actually prints. A guide may name fewer accounts
  than a seed creates — it may not name one that does not exist.
- **The family-stack job now waits for the family stack, and the portal's lights are
  pointed at the products that answer them.** The one CI job that boots six products
  together waited for three — training, tix and Sentinel — and printed "all three
  products are up" while `docker-compose.all.yml` starts seven services, so the portal,
  Genie and both halves of Sync were booted and never asked: a product that never came
  up left the job green, which is the same empty green as a status light nobody asked.
  All seven are waited for now, the four that had no check at all have one, and
  `tests/family-stack.test.ts` refuses a service the family stack publishes a port for
  that the job never waits for. Waiting for the whole stack also found what the
  three-product wait had been hiding: **Sync's API has never started in CI.** It refuses
  to boot without `ONTRAK_API_TOKEN` — deliberately, because it can install packages
  across the Network — and the job supplied no placeholder, so the container
  crash-looped from the first run while the dashboard beside it answered and the job
  watched three other products. The job now supplies a placeholder token beside the
  other two, and a product that fails to come up has its own logs printed at the point
  of failure instead of only in the whole-stack dump. The same sweep found the way a
  light can lie *inside* the stack: the portal asks
  `<ONTRAK_<KEY>_INTERNAL_URL><health>` from inside its own
  container, and the family stack aimed Sync's at its API (`sync-api:8420/health`, a
  404 — the API answers only under `/api`) and never set Genie's at all, so a healthy
  Sync and a healthy Genie were drawn as outages on the page whose whole job is to say
  which products are up. Each light is now pointed at the product's own address (Sync's
  dashboard answers `/health`; its API keeps `ONTRAK_SYNC_API_URL`), the job asks the
  portal container the same question on every push, and the same test refuses a light
  aimed at a service that does not answer the path the portal asks.
- **The portal's own suite runs in CI now.** It was the one product with no job:
  `training`, `tix`, `sentinel`, `sync` and `genie` each have one, and the family's front
  door had none — its 45 unit tests, its typecheck and its copy check only ever ran on
  the machine of whoever was editing it, and its TypeScript was compiled only as a side
  effect of the `Image (portal)` build, which can say the code compiles but not that the
  rules hold. `OnTrak Portal` installs it, typechecks it, runs `copy:check` — the one
  that keeps the family's taglines off the sign-in gate, which no build fails and no
  type breaks on — and runs the suite, on Node 22, which is what its image is built on.
  `tests/ci-coverage.test.ts` holds the general claim, derived from the packages rather
  than from a list of products: every `package.json` in this repository that declares a
  `test` script must have a job running from its directory that runs that suite and its
  typecheck.
- **The family's liveness question is asked in one place.** The dashboard and
  `npm run health:check` answer the same question about the same deployment, and they
  did it with two copies of the rule: the page asked through `probeProduct` and honoured
  `ONTRAK_<KEY>_INTERNAL_URL` (the addresses a deployment sets when the public names are
  not reachable from where the question is asked), while the check had its own `fetch`,
  its own list of statuses and its own idea of which address to ask. The two disagree
  exactly where the overrides matter, and in the direction that costs most: an operator
  reading "DOWN" for every product while the dashboard two feet away draws every light
  green believes neither again. Both now go through `probeFleet` — the page for the
  tiles a person can see, the check for the whole catalogue — so the statuses that count
  as an answer, the address asked and the path appended to it are decided once. A
  product with nothing to ask stays `unknown` and is never reported up, and the check
  exits 1 on it, because "we did not look" is not a yes. The rule cannot come back in a
  second copy silently: `ontrak-portal/tests/product-health.test.ts` refuses a file
  outside `src/lib/sync-client.ts` that counts both a 401 and a 403 as an answer, and
  `ontrak-portal/tests/fleet-probe.test.ts` drives the shared answer against a real
  server — the override is a base the declared path is appended to, and a family that
  answers 404 everywhere reads down, nowhere up.
- **The lab is a link a deployment may draw, not a light the family must watch.** The
  dashboard gave every training-audience role a tile for OnTrak Lab and probed
  `<ONTRAK_LAB_INTERNAL_URL, else lab.<base domain>>/healthz`, so a deployment that does
  not run the lab — today, every deployment, since the lab is a peer Python host that
  `docker-compose.all.yml` does not start — opened on a red "not answering" for a product
  nobody was running, and `npm run health:check` exited 1 for the same reason. It was the
  same class of defect as Sync's light aimed at the wrong half of Sync, and the one light
  in the family that could never turn green. The lab is now the catalogue's only
  **optional** product: it stays in `PRODUCTS`, because what it is for, who belongs in it
  and the `/healthz` it answers do not change with a deployment, but `tilesFor` draws a
  tile for it only once the deployment has supplied the same two facts the training app
  already reads (`ONTRAK_LAB_ENABLED`, `ONTRAK_LAB_URL`; `labAddress()` in
  `ontrak-portal/src/lib/config.ts`). Until then there is no tile, no probe and no light
  to misread, a person who came for the lab still lands on the training range rather than
  on a tile that is not there, and the family table on the same page says "not in this
  deployment" instead of printing a name nothing resolves. `npm run health:check` skips
  the lab with a line saying so rather than failing a deployment for a product it does not
  run. `ontrak-portal/tests/lab-address.test.ts` and the catalogue cases in
  `portal-rules.test.ts` hold the three states — off, on-but-nowhere, on-and-located — and
  `tests/family-stack.test.ts` keeps the lab out of the stack's light list, now because
  the stack never draws it. The training app's control room panel
  (`src/lib/capabilities.ts`) carried the same defect more quietly: it read
  `ONTRAK_LAB_URL` itself and offered `lab.<base domain>` as the lab's "family address"
  in any deployment that had not set one — the second reader of a variable
  `src/lib/lab-rules.ts` already owns, which is the drift that file explicitly refuses
  for Sentinel, and the exact "invents a link that does not resolve" its own test names.
  The row is built from the lab's reader now, so a deployment with no lab shows it as
  `off` — marked with the reason, in a state of its own rather than the red of an address
  that was refused — and links nowhere; the row itself stays, because a product missing
  from a list of what a deployment can reach is a product nobody can reach from here.
  Two files reading one product's variables is how that happened, so
  `tests/lab-rules.test.ts` now holds *who* may read them: a list of the readers — one
  per package, because the portal is independently deployable and cannot import the
  training app's — checked against the tree, with a marker for a file that genuinely
  must name them. A planted second reader fails it, naming the file and the line. Where
  the two facts go is stated too, because the deployment paths differ: the root `.env`
  for the family stack, `.env.production` for the training app's production overlay
  (`docs/family-operations.md` §7). A real intermittent failure in the genie job turned
  up on the way through, and it was worth measuring rather than guessing at.
  `preview-hosting.test.ts` gave a spawned `node` two seconds of fixed polling to reach
  `listen()`, and the failing run gave up 53ms past that mark on an address that was
  about to answer — the assertion was never wrong, its patience was. It is bounded by a
  deadline now: a child that takes three seconds to listen fails the old budget and
  passes this one, and a port that never answers still fails. Asking *how* it asked turned
  up a second hazard, and an honest one to record because the measurement did not support
  the first explanation it suggested: the wait asked "is anything listening?" by
  **binding** the port, so it held the port for the instant between `listen()` and
  `close()`, and a process that binds in that instant dies of `EADDRINUSE` — reproducible
  on demand, but it did not turn up in forty amplified trials of this loop, so it is not
  what this failure was. The wait asks by **connecting** now: a probe that cannot take the
  port from the process it is waiting for, and the same question a user asks. `waitFree`
  still asks with a bind, because *free* means bindable and nothing is racing for the port
  there.
- **Terminology is resolved** (§9/Q1). *OnTrak* names this repository and the family
  inside it, never one product; the product in `src/` is **OnTrak IT Support Training**,
  and the lab is **OnTrak Lab**.

---

## 9. Risks and open questions

| # | Risk / question | Why it matters |
| --- | --- | --- |
| Q1 | **What is the merged product called, and what is the lab called?** | **Resolved.** *OnTrak* is this repository and the family of products inside it, never one product on its own. The product in `src/` keeps the name it already serves and issues certificates under, **OnTrak IT Support Training** (capability id `training`, host label `its`), and what was called "the lab" is **OnTrak Lab** (capability id and host label `lab`). Keeping the training product's name is the decision that costs nothing: it is already in `NEXT_PUBLIC_APP_NAME`, in the default certificate issuer and in every host label, and the collision was never between those two names, it was between a *family* and a *product* that were both called OnTrak. The source repository keeps its own name, `OnTrak-dev`. |
| Q2 | **Does the lab become a product or a mode of ITS?** | **Resolved — both, at different layers.** The lab stays a **product** in the family catalogue (its own origin, roles, health and deployment, Step 2), because that is *where the service lives*; and a training task carries a **mode** (`simulated` \| `lab`, Step 6), because that is *how one attempt was graded*. "Where is it" and "who graded this" are different questions, and treating them as one is what made this look open. Removing the mode would not remove the product; removing the catalogue entry would not change a grade. |
| Q3 | **Who owns the real-VM grading record?** | **Resolved — the family owns the graded `Attempt`; the lab owns only its operational session.** One ledger means one certificate path, one analytics query and one assurance packet; the lab's SQLite row is operational, like Sentinel's raw events, and stays labelled as such (§6/C4). The cross-language write is accepted and made **one-directional and idempotent**: `POST /api/v1/lab/completions` writes one family attempt per lab session id (unique `Attempt.labSessionId`), with `mode = lab`, its check results and a `mode`-carrying certificate ([lab-completion.md](lab-completion.md)). The family's half is built and unit-tested; **OnTrak Lab's half — calling it after a session, with the deployment token — is drafted out of tree** in `integrations/lab-completion-client/`, because OnTrak-dev must stay unchanged, and has not been installed on a lab host. |
| Q4 | **Can the family edge serve the lab?** | **Resolved on paper — yes, as one name instead of three, with the lab's own gateway kept.** The edge forwards one *host* to one *port* and passes the path through unchanged, which is exactly the shape the lab publishes: a single port on which its own nginx serves the portal at `/` and the console at `/guacamole/` (`OnTrak-dev/deploy/gateway/nginx.conf`). So a deployment that runs a lab gives it one family name — `lab.<base domain>` → the lab host's published port — with the websocket upgrade the console tunnel needs, which the family's host map sets per product (`scripts/cerulean-ontrak.py`, `allow_websocket_upgrade`) and the lab's own provisioner never mentions. DNS and TLS need nothing new either: the name is one label under the Network's `*.ontrak` wildcard, put there by the same Cerulean/NPM that already provisions the six. **What does not carry over is the lab's three names, and that is where the two models genuinely collide:** the lab publishes `ontrak.`, `student.` and `admin.` (`OnTrak-dev/scripts/cerulean-provision.py`) and the family publishes `ontrak.` for the **portal**, so the two provisioners claim one name for two different apps. NPM refuses the second claim ("already in use"), which is the loud failure — the quiet one would have repointed the family's front door at the lab. The lab's other two names go with it, and what is lost with them is per-name edge treatment (the student name on the internet, the staff name behind a VPN), because the family's edge authorizes nobody: identity comes from the provider and each product decides who the caller is. Role-gating does not disappear — the lab's own portal still decides from the group claim at sign-in. R7's "retire the gateway" is answered in the same breath: the lab's *public* names retire, its inner router stays, because the console is served at `/guacamole/` inside its container and generates base-relative URLs from that path, so giving the console a name of its own means changing OnTrak-dev — which is frozen. Sign-in costs one line rather than saving one: the lab picks its callback by the origin the browser started on and falls back to the canonical (first) entry for anything unregistered, so it registers `https://lab.<base domain>/oidc/callback` on the provider **and lists it first**. **The residue is this work's usual one: none of it has been run here** (no lab, no hypervisor), and the thing an edge change can break is the console tunnel — a websocket through NPM into the lab's inner nginx into guacd is the first measurement a real host owes. |
| Q5 | **Hypervisor capacity under the family's tenancy** | **Resolved on paper — the lab stays single-tenant, one host per deployment, and the family's tenancy is not extended to it.** The family is multi-tenant in its *database*: Tix carries `tenantId` on every domain row and Sentinel keeps one evidence chain per organization, both "single-tenant self-hosted and hosted multi-tenant from one image". The lab's isolation is a different thing wearing the same word: one Incus project (`ontrak`), one `ontrak0` bridge, one SQLite store, one warm pool, and a portal container that is a hypervisor administrator by design — `OnTrak-dev/docs/operations.md` says in as many words never to put the portal on that bridge. Nothing in the lab names a tenant, so two tenants sharing a hypervisor would share a bridge (their VMs mutually reachable), one pool and one results store: a boundary with nothing inside it. What sharing would cost comes from the lab's own sizing — 2 vCPU and 4 GiB per student VM (`infra/incus/profile.yaml`), a 16 vCPU / 64 GiB host sized at **8–12 students** with 4–6 prewarmed, pool targets defaulting to 0 with scheduled windows filling only a genuine deficit, and `pool.max_total` (60) bounding the *pool* rather than concurrent sessions — so the ceiling that decides anything is RAM at the peak of a class window, and two tenants whose windows overlap share it invisibly. **The decision, stated rather than assumed:** a deployment that runs a lab runs one lab host; the lab is advertised as single-tenant; multi-tenant hosting stays out of scope until it is measured — and "measured" is specific, namely peak RAM at a real class's prewarm-plus-session peak on the target host, whether two tenants' class windows can overlap at all, and, if they can, a per-tenant isolation design (its own project, bridge, pool and store) that the lab does not have today. **The residue is this work's usual one: none of it is a measurement.** No hypervisor exists in the environment this audit was written in, so every figure above is the lab's own published guidance read out of its repository, not a number anybody took here. It is also why the family side needs no new guard: its half of the claim is a single address (`ONTRAK_LAB_URL`), which `src/lib/lab-rules.ts` already holds to one reader per package. |
| Q6 | **Licensing** | **Kept where a reader will meet it.** OnTrak-dev uses Microsoft evaluation media (90 days for desktop, 180 for Server) and never redistributes retail media; the family's own documentation now says so in `docs/stack.md` (Licences), naming the lab's repository as the source, so the responsibility is inherited as a statement rather than as a surprise. It stays the operator's either way, which is the point: a product that quietly stopped saying it would be the one that broke it. |
| Q7 | **Two ways to grade, one definition of "passed"** | **Addressed.** Analytics: `summariseByMode` and the "By grading mode" panel state each figure's mode, and the attempts list and review badge every row, so a simulator's pass is never averaged into a live machine's (Step 7). Evidence: a completion record now carries `mode` **inside its signed content**, so the same numbers graded two ways are two different records with two different codes, and a lab certificate cannot be read as a simulated one (the record is only byte-unchanged for a record that predates the field — see [training-evidence.md](training-evidence.md)). The results feed and CSV report the mode too. The half of Q7 that was still open — whether a lab attempt and a simulated one could disagree about *passed* — is closed as well: one rule decides a pass (`src/lib/score-rules.ts`) and the simulator's report, the certificate, the payload, the feed, the CSV and the screens all apply it, so a scenario worth zero points is a failure on every one of them instead of full marks on four. |
| Q8 | **CI** | **Resolved — and it was already true, so the job is to keep it true.** CI never needs a hypervisor, and the lab's own repository answers the same question the same way: a host with no usable `/dev/kvm` "stops at the KVM check and says so" rather than emulating (`OnTrak-dev/docs/roadmap.md`), demo mode runs an entire class against an in-memory hypervisor, and the emulated path is behind `ONTRAK_INSTALL_TEST_ALLOW_TCG=1` because it takes hours. So what belongs in CI is the **boundary**, and this repository already runs it on every change: the `training` job applies the migrations and then runs `tests/lab-live.test.ts` and `tests/lab-client-live.test.ts` with their own flags — the completion route driven through the app's own door, and the Python client's real request against it — with no VM anywhere in the job, which is the only pair a lab host depends on. The host half (booting a real machine, Guacamole, the console) stays an operator's deployment, and both live tests are off unless their flag is set, so nothing boots a server or needs a database by accident on a laptop either. **The rule is mechanical now** rather than a comment: `tests/ci-coverage.test.ts` refuses a workflow step that names a hypervisor, refuses a root live test that is not opt-in, and refuses to let the lab's two boundary tests stop being run by a job — so the honest green of "the boundary is covered without a VM" cannot quietly become a green that means nothing. |
| Q9 | **Review cost** | The integration touches identity, evidence and deployment at once. §7's sequencing exists to keep each step independently revertable; skipping ahead trades that away. |
