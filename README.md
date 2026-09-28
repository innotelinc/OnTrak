<div align="center">

# OnTrak

**TrainingOps platform — self-hosted IT support training, ticketing and incident evidence.**

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **OnTrak** is the **TrainingOps** platform of the [Innotel Labs](INNOTEL-LABS.md)
> family and a member of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack):
> one repository for the IT support operation. This app — **OnTrak IT Support
> Training** — is an open source, browser-based training platform where students
> fix deliberately broken machines and are graded from the resulting state,
> while [**OnTrak Tix**](ontrak-tix/README.md) runs the real desk beside it, with
> clients, SLAs, billing and insurance-grade incident evidence. Both consume
> Cerulean for identity and trust and share one audit chain; no virtual machines
> and no terminal servers are required for either.
> **Landing page:** [https://innotelinc.github.io/OnTrak/](https://innotelinc.github.io/OnTrak/)

---

## Why OnTrak

| Problem | OnTrak answer |
| --- | --- |
| A training lab is expensive to build and every rebuild is another day of work. | Scenarios are authored once as versioned templates with checkable objectives; the simulator runs in the browser, so a class practices on laptops or phones with no hypervisor and no images. |
| Grading "did they fix it?" by hand does not scale, and two instructors grade differently. | Every submission is re-graded on the server from the submitted machine state — a forged client score cannot change a result — and any correct fix passes. |
| A one-desk helpdesk breaks the moment it serves a second client: work runs together and SLAs stop meaning anything. | [OnTrak Tix](ontrak-tix/README.md) gives every client its own promises, rate card and reporting, and shows an agent only the clients they are assigned to. |
| An incident that becomes a claim or an audit needs a record that was not assembled after the fact. | Incident evidence is written under object lock, notification wording is kept as it was actually sent, and the signed assurance packet can be verified without trusting the application. |
| Training, ticketing and security tooling each invent their own identity and evidence layer. | One identity layer and one signed, tamper-evident record format: the training record a student keeps and the packet an insurer reads share the same shape. |
| Running a support platform in-house usually means trusting a vendor with the data. | Self-hosted end to end: PostgreSQL and the app on your own host, storage behind a port you can point at your own object store, and no third-party service required to boot. |

---

## Highlights

- **Three simulated platforms** — `LINUX` (bash), `WINDOWS` (PowerShell) and
  `OFFICE` (spreadsheets, documents and mail).
- **Realistic consoles** — `xterm.js` terminal with history, tab completion,
  pipes, redirection, permissions, `sudo`, users, services, cron, firewall,
  registry, shares and more.
- **Timed and graded** — the server re-grades every submission from the
  submitted machine snapshot. Client-side scores are never trusted.
- **Hints with a cost** — optional hints deduct points and are recorded per
  attempt.
- **Role-based access** — separate experiences for `ADMIN`, `INSTRUCTOR` and
  `STUDENT`, enforced by middleware *and* on every server action.
- **Software provisioning gate** — admins enable/disable platforms and software,
  add packages by upload or download URL, and store license keys where the
  vendor requires one. Scenarios only become visible when everything they need
  is actually available.
- **PWA for phones** — installable, offline shell, mobile quick-key row on the
  virtual keyboard.

---

## Quick start

**Requirements:** Node.js >= 20.11 and a PostgreSQL database. Docker is only
needed if you want the bundled dev database.

```bash
git clone https://github.com/innotelinc/OnTrak.git
cd OnTrak

cp .env.example .env          # then edit AUTH_SECRET
npm install

npm run docker:db             # starts Postgres 16 on :5432 (or point DATABASE_URL elsewhere)
npm run setup                 # prisma generate + migrate deploy + reset + seed demo data
npm run dev                   # http://localhost:3000
```

Generate a real `AUTH_SECRET` rather than reusing the example:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Demo accounts

`npm run db:seed` provisions a small school so you can click around immediately —
including one finished, passing attempt for the demo student, so the certificate
on the report page has something real to show. (`npm run setup` clears attempts
*before* seeding, so the run it performs ends with that attempt in place; a bare
`npm run db:reset-demo` removes it again, as "start fresh" should.)

| Role       | Email                        | Password          |
| ---------- | ---------------------------- | ----------------- |
| Admin      | `admin@ontrak.local`     | `change-me-ontrak` |
| Instructor | `instructor@ontrak.local`| `change-me-ontrak` |
| Student    | `student@ontrak.local`   | `change-me-ontrak` |

The demo class join code is **`NET101`**. The password above is the shipped
placeholder — it is meant to be changed, and says so. Override it with
`SEED_PASSWORD` (at least 8 characters, matching the sign-in rule). Deactivate
these accounts (or set `NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false`) before
running a real cohort.

Handed the demo to a cohort already and need a clean slate? `npm run db:reset-demo`
clears the demo students' attempts (an assignment's attempt cap counts finished
attempts, so this is what un-blocks a student who has "used all 3 attempts") and
removes the synthetic `a11y-*` accounts left behind by browser test runs.

---

## The availability rule

This is the part that makes the platform safe to hand to students: **a scenario
is offered only when everything it depends on is genuinely usable.** Availability
is *derived* on every request, never cached, so an admin toggle takes effect
immediately.

A scenario is offered when **all** of these hold:

1. its platform (Linux / Windows / Office) is switched on globally;
2. the scenario itself is published;
3. every software package it requires exists, is enabled, and has a usable
   source — an uploaded package for `UPLOAD`, a download URL for `URL`, or
   nothing at all for `INTERNAL` simulations;
4. a time-limited licence is still valid — a `LICENSED` package has an activation key on file and has not expired, and an `EVALUATION` build's trial window has not closed.

License handling follows the vendor model:

| `LicenseType` | Needs a key? | Notes |
| ------------- | ------------ | ----- |
| `OPEN`        | No           | Free / bundled software. Never expires. |
| `EVALUATION`  | No           | Runs keyless until the trial window closes. |
| `LICENSED`    | Yes          | Hidden from students until the key is stored. |

When a scenario is blocked the admin control room explains **why**, per
dependency, so gaps are obvious — for example *"requires `postfix`, which is
disabled"* or *"requires a license key for Contoso Asset Suite"*.

---

## Roles

| Capability | Admin | Instructor | Student |
| ---------- | :---: | :--------: | :-----: |
| Toggle platforms on/off | ✅ | — | — |
| Add / enable / disable software, uploads, download URLs, license keys | ✅ | — | — |
| Manage users (roles, activation) | ✅ | — | — |
| Review audit log | ✅ | — | — |
| Author and publish scenarios | ✅ | ✅ | — |
| Create cohorts, invite by join code, set assignments & due dates | ✅ | ✅ | — |
| Observe and re-grade student attempts | ✅ | ✅ | — |
| Complete timed, graded scenarios | — | — | ✅ |

---

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Development server with hot reload. |
| `npm run build` | Production build (`prisma generate` first). |
| `npm run start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Engine, grading, validator and desktop-surface test suite. |
| `npm run setup` | Generate the client, push the schema, reset attempts, seed demo data. |
| `npm run db:migrate` | Create a versioned migration from `schema.prisma`. |
| `npm run db:deploy` | Apply the committed migrations (what a deployment runs). |
| `npm run db:push` | Push `schema.prisma` without a migration — throwaway databases only. |
| `npm run db:seed` | Re-seed demo data (idempotent). |
| `npm run db:reset-demo` | Clear demo students' attempts and synthetic test accounts. |
| `npm run db:studio` | Browse the database in Prisma Studio. |
| `npm run docker:db` | Start the bundled Postgres container. |

---

## Architecture

```
src/
  app/
    (app)/                    authenticated shell: student / instructor / admin
    actions/                  server actions (auth, student, instructor, admin)
    certificate/              the printable certificate sheet (no app shell)
    login/  register/         public auth pages
    verify/                   public certificate + packet verification
  components/
    console/                  xterm terminal, Office panel, attempt runner
    instructor/               scenario editor + validator feedback
    ui.tsx                    design-system primitives
  lib/
    sim/                      ★ the simulator — pure, dependency-free TypeScript
      shell.ts                tokenizer, pipes, redirects, operators, expansion
      paths.ts  vfs.ts        canonical paths and the virtual filesystem
      state.ts  formula.ts    initial state, spreadsheet formula engine
      drivers/                bash.ts  powershell.ts  office.ts
      grade.ts                deterministic grader (shared by client + server)
      types.ts                ScenarioDefinition, EngineState, ScenarioCheck
    availability.ts           the derived availability rule
    validate.ts               authoring validator (errors + warnings)
    scenarios.ts              attempt lifecycle, snapshots, re-grading
    auth.ts  auth-hash.ts     JWT sessions and password hashing
    templates.ts              starter definitions for the scenario editor
prisma/
  schema.prisma               data model
  migrations/                 the versioned schema history every environment applies
  seed.ts                     idempotent demo school + one finished pass to demo a certificate
tests/
  sim.test.ts                 engine + grading + validator + desktop tests
  desktop-render.test.ts      the desktop surface still server-renders
  tsconfig.json               JSX-enabled config just for the tests
```

The simulator is **pure TypeScript with no framework imports**, so the exact same
code runs in three places:

- in the browser, to interpret commands and update the console live;
- on the server, to re-grade a submission;
- in `npm test`, with no browser or database required.

### Swapping in a real backend

Every driver implements the `ShellDriver` interface (`prompt`, `banner`,
`runCommand`, optional `completions`). The current implementations are in-browser
simulations. A future container-backed driver — real bash, real PowerShell in a
sandbox — can be dropped in behind the same interface without touching the UI,
the scenario format, or the grader. That seam is deliberate and is the intended
path to higher-fidelity practice.

---

## Writing scenarios

Scenarios are JSON documents that describe the starting machine (`files`,
`state`, `docs`), the student-facing `brief` and `tasks`, and a list of `checks`
that award points. The instructor UI ships a **validator** that parses the
definition, boots it once, evaluates every check against the untouched starting
state, and warns when a check *already passes before the student does anything* —
the most common authoring mistake.

Start from the built-in templates in the scenario editor, or read the full
reference in [docs/scenario-authoring.md](docs/scenario-authoring.md).

---

## Testing

```bash
npm run typecheck
npm test
```

The suite covers the bash filesystem, pipes, redirection, permissions, `sudo`,
users, packages, firewall and cron; PowerShell services, registry, firewall,
paths and accounts; Office spreadsheets, document editing and mail; grading with
full, partial and hint-penalised scores; the scenario validator; and an
automated axe-core WCAG A/AA accessibility audit of the console surfaces
(`tests/a11y.test.ts`), which also proves the audit itself flags a planted
violation.

That jsdom audit cannot evaluate rules that need layout and paint, so a
browser-based sweep covers them:

```bash
npm run test:a11y   # Playwright + axe-core in Chromium; installs nothing new
```

It boots the app, audits the public pages plus the signed-in student dashboard
and attempt workspace, and fails on every WCAG A/AA violation — `color-contrast`
included. The accent palette was darkened to clear the AA floor, and the sweep
caught a scrollable region without keyboard access on the landing page.

---

## Security notes

- Sessions are signed HTTP-only JWTs (`jose`). Keep `AUTH_SECRET` long, random
  and private.
- Submissions are sanitised (`coerceSubmittedState`) and **re-graded on the
  server**; a forged client score cannot change a result.
- Middleware guards path prefixes, but every server action re-checks the caller's
  role and ownership before mutating anything.
- The service worker caches only static assets — never authenticated HTML.
- Uploaded packages are written under `STORAGE_DIR` and excluded from git.

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | OnTrak's role in the Innotel Platform Stack (TrainingOps) — what it owns, consumes and does not own |
| [docs/scenario-authoring.md](docs/scenario-authoring.md) | How a scenario is written and how its objectives are graded |
| [docs/training-evidence.md](docs/training-evidence.md) | Completion records, certificates and the signed export packet |
| [INNOTEL-LABS.md](INNOTEL-LABS.md) | The Innotel Labs product family and how the three products fit together |
| [ontrak-tix/docs/](ontrak-tix/docs/) | The service desk: tickets, SLAs, clients, billing, incidents, assurance |
| [ROADMAP.md](ROADMAP.md) · [ontrak-tix/ROADMAP.md](ontrak-tix/ROADMAP.md) | What is shipped, what is next, and the honest gaps |

---

## Sibling project

Three [**Innotel Labs**](INNOTEL-LABS.md) products share a stack, a design
language and one identity layer:

- [**OnTrak Tix**](ontrak-tix/ROADMAP.md) — enterprise ticketing and
  service management for IT desks and MSPs, with incident response and
  insurance-grade, tamper-evident documentation.
- [**OnTrak Sentinel**](ontrak-sentinel/ROADMAP.md) — identity (IdP) and
  intrusion prevention (IDS/IPS).

OnTrak IT Support Training **trains** the technicians; OnTrak Tix is the tool
they **work in**; OnTrak Sentinel protects both. They link via a ticket ↔
scenario bridge and a single identity provider.

## 🏛️ Platform stack

OnTrak is the ecosystem's **TrainingOps** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. OnTrak consumes identity, secrets and trust rather than
re-implementing them, and owns only what a support operation is: the training,
the desk and the evidence. See [docs/stack.md](docs/stack.md) for the full
owns/consumes boundaries.

## License

[MIT](LICENSE).

*OnTrak — TrainingOps for the Innotel platform stack. © 2026*

