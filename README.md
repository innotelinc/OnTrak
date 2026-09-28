# OnTrak IT Support Training

> An [Innotel Labs](INNOTEL-LABS.md) product.

An open source, browser-based **IT support training platform**. Students sign in,
open a timed scenario, and fix it inside a realistic simulated environment — a
Linux shell, a Windows PowerShell session (or a clickable Windows 11 desktop),
or an Office-style spreadsheet / document / mailbox — and the attempt is graded
automatically from the resulting machine state.

No virtual machines. No terminal servers. The whole simulator runs in the browser
and on your own server, so a whole class can practice on laptops or phones.

```
        ┌────────────┐   timed, graded   ┌────────────────────────────┐
student │  browser   │ ────────────────▶ │  pure TypeScript engine    │
        │  console   │ ◀──────────────── │  (bash / PowerShell /      │
        └────────────┘   live state      │   office) + grader         │
                                          └────────────────────────────┘
```

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
git clone https://github.com/innotel-labs/ontrak-it-support-training.git
cd ontrak-it-support-training

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

| Role       | Email                        | Password       |
| ---------- | ---------------------------- | -------------- |
| Admin      | `admin@ontrak.local`     | `ontrak-demo` |
| Instructor | `instructor@ontrak.local`| `ontrak-demo` |
| Student    | `student@ontrak.local`   | `ontrak-demo` |

The demo class join code is **`NET101`**. Override the password with
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

## License

[MIT](LICENSE).
