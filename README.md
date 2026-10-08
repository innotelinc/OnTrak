<div align="center">

# OnTrak

**TrainingOps platform — self-hosted IT support training, ticketing and incident evidence.**

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/blob/main/standards/unity/README.md)

</div>

> **OnTrak** is the **TrainingOps** platform of the [Innotel Labs](INNOTEL-LABS.md)
> family and a member of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack):
> one repository for the IT support operation. This app — **OnTrak IT Support
> Training** — is an open source, browser-based training platform where students
> fix deliberately broken machines and are graded from the resulting state,
> while [**OnTrak Tix**](ontrak-tix/README.md) runs the real desk beside it, with
> clients, SLAs, billing and insurance-grade incident evidence;
> [**OnTrak Sentinel**](ontrak-sentinel/README.md) is the directory and the
> intrusion console; and [**OnTrak Sync**](ontrak-sync/README.md) keeps the
> Network's packages and containers current and owns the family's local accounts.
> [**OnTrak Portal**](ontrak-portal/README.md) is the front door: one sign-in,
> then the products a role belongs in. Every product works on its own — it always
> has — and they consume Cerulean for identity and trust and share one audit
> chain; no virtual machines and no terminal servers are required for any of them.
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

**Requirements:** Node.js >= 20.11 and a PostgreSQL database — or just Docker,
which brings its own. Both paths below give the same app; pick either.

### Run it in containers

```bash
git clone https://github.com/innotelinc/OnTrak.git
cd OnTrak

cp .env.example .env          # then edit AUTH_SECRET
docker compose up -d --build  # build the image, apply migrations, serve on :3000

docker compose --profile demo run --rm seed   # optional: the demo accounts below
```

The app waits for its migrations to finish before it starts, so it never serves
against a schema it has not been given. The database and uploaded packages each
live on a named volume, so neither a rebuild nor a `down` discards them. Build
the image without starting anything with `docker build --target runner .` (or
`make images`, which builds OnTrak Tix's too).

### Run the whole family at once

Each product keeps its own stack because each is independently deployable, and
there is also `docker-compose.all.yml` — all five in one project on one network,
with the wiring between them already in place (each app's own database and public
address, a registered OIDC client per product, the desk's outbound provisioning
pointed at the provider, and the portal's password sign-in pointed at OnTrak
Sync's account table):

```bash
make all-up     # :3300 portal, :3000 training, :3001 desk, :8787 provider, :8420/:8421 Sync
make all-demo   # optional: the demo data for both demo-able apps
make all-down
```

The one thing it cannot decide for you is the provider's address, because it has
to be one that **both** the browser and the app containers resolve — see the
header of that file. [docs/family-operations.md](docs/family-operations.md) is the
same stack written down as it is actually deployed: the five names, the role
groups in Authentik, and which of the two sign-in paths to check when one fails.

### Deploy it

`docker-compose.prod.yml` is the deployment overlay, used on top of the file
above rather than instead of it:

```bash
cp .env.production.example .env.production   # then fill in the two REQUIRED values
make prod-up
```

Three things change, and each is the reason the overlay exists: the database
stops being published on a host port, the secrets become required instead of
defaulted, and the containers restart by themselves. It refuses to start while
`AUTH_SECRET` or `POSTGRES_PASSWORD` is unset, because the development
placeholders in `.env` are public knowledge — a deployment that quietly accepted
them would be worse than one that stopped.

Give it a fresh volume. Postgres applies `POSTGRES_PASSWORD` only when it
creates the role, so pointing this at an existing development database will not
change that database's password and the app will fail to authenticate.

### Run it from source

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

Every product in the family draws from **one vocabulary of six roles** — `ADMIN`,
`SYSADMIN`, `ANALYST`, `TECHNICIAN`, `INSTRUCTOR`, `STUDENT` — and one set of
capability names, so a group in Cerulean means the same thing to the training
app, the desk, Sentinel, OnTrak Sync and the [portal](ontrak-portal/README.md).
The table above is this app's slice of it. The portal is what decides *where* to
send somebody; each product still authorises the caller itself, from its own
credential, which is why a role change at the directory takes effect everywhere
at once and nothing has to be copied anywhere.

---

## Single sign-on

The training app is a **relying party**, not a directory: OnTrak Sentinel (or any
OpenID Connect provider — Authentik, Entra, Okta) is the authority on who somebody
is, and this app asks. Nothing about the ordinary email-and-password sign-in
changes for a deployment that names no provider — it simply shows no SSO button,
because a button that cannot complete a handshake is worse than none.

```bash
# .env — the four variables that turn it on
ONTRAK_OIDC_ISSUER="https://idp.example.test"     # the provider's issuer identifier
ONTRAK_OIDC_CLIENT_ID="ontrak-training"          # registered there
ONTRAK_OIDC_DEFAULT_ROLE="STUDENT"               # when no mapping matches
ONTRAK_OIDC_ROLE_MAPPINGS="instructors=INSTRUCTOR
it-ops=ADMIN"                                    # one rule per line
```

Register the redirect URI **exactly** as this deployment serves it —
`<ONTRAK_TRAINING_BASE_URL>/api/sso/callback`. A URI built from the container's
internal address can never match, because the provider compares it byte for byte;
that is what `ONTRAK_TRAINING_BASE_URL` is for. A client secret is optional: a
public client proves itself with PKCE, which is always used.

The handshake is an authorization-code flow with PKCE. `state`, the replay
`nonce` and the PKCE verifier travel in one short-lived signed cookie; the ID
token's signature is verified against the provider's published JWKS, and its
issuer, audience and nonce are checked before anything is trusted. Then the claims
decide three things:

- **Which account.** By the provider's stable subject first (`User.externalId`),
  then by email — so an account that predates SSO is adopted rather than
duplicated, and a rename in the directory *moves* the account instead of creating a
second one with the first one's attempts and certificates left behind.
- **Which role**, from the group claims, falling back to the default. Two things
  are deliberately not allowed: an assertion never **reactivates** an account an
  administrator switched off here, and a sign-in never strips the role from the
  last active administrator, because either would leave a deployment somebody has
to repair by hand.
- **Whether at all.** An unverified email is refused, `ONTRAK_OIDC_ALLOWED_DOMAINS`
  narrows who may sign in, and `ONTRAK_OIDC_REQUIRE_MFA` demands second-factor
  evidence in the assertion rather than assuming it.

A first sign-in **provisions** the account with no local password at all, and the
email-and-password form refuses it with the same message it gives for a wrong one —
so the form cannot be used to discover which accounts are SSO-only. Every
successful sign-in is audited as `auth.sso_sign_in` and every refusal as
`auth.sso_sign_in_denied` (with the reason, and never the address).

SAML and IdP-initiated sign-on are not here yet; the flow is SP-initiated OIDC
only. The decisions are covered by `tests/oidc.test.ts`, which drives a real
OpenID provider on a loopback port — real keys, a published JWKS, single-use codes
and S256 PKCE — and proves the refusals as well as the success: a forged
signature, a replayed code, a wrong verifier, a missing client secret, a foreign
issuer, a stale nonce and an unverified email.

The app's **own routes** have a live test, which is the honest answer to "does
single sign-on work?" — it starts the app with a provider it starts itself, walks
`/api/sso/start` → the provider → `/api/sso/callback` with a cookie jar exactly as
a browser would, and fetches a protected page with the session the callback issued:

```bash
ONTRAK_SSO_LIVE=1 DATABASE_URL=postgresql://… \
  npx tsx --tsconfig tests/tsconfig.json --test tests/sso-live.test.ts
```

It is opt-in twice over — the flag says "start a server for this", and a reachable
Postgres is required because a sign-in provisions an account — and it cleans up the
account it provisions, so a local run leaves no trace. `npm test` skips it.

### One front door for the family

Signing in to each product separately is the part
[**OnTrak Portal**](ontrak-portal/README.md) removes. It is a relying party to the
same provider and the same group claims, so the role that decides which tiles it
draws is the role this app already checks — and the portal deliberately
re-implements none of it, because a second authorisation system would be a second
thing to be wrong, and the more dangerous of the two would be the one people
trusted.

The portal keeps **no accounts of its own**. Its password form delegates to
[OnTrak Sync](ontrak-sync/README.md), which owns the family's local account table:
the path a LAN with no route to the provider signs in through. That is the split
worth remembering operationally — **the portal's two sign-in paths fail
independently.** Cerulean signing in does not depend on Sync answering, and Sync's
account table does not depend on Cerulean.
---

## Real shells in a sandbox

A scenario is authored for one of two machines, and says which:

| `fidelity` | What runs your commands | Where |
| --- | --- | --- |
| `simulated` (default) | The built-in simulated engine | In the browser, instantly, everywhere |
| `container` | A real `bash` in a disposable container | On the server, one container per attempt |

A container-fidelity scenario gets real exit codes, real error messages and a real
filesystem. After every command the sandbox's tree is harvested back into the
attempt's machine state — type, permissions, owner, group, mtime, size and content —
so grading is unchanged: `file_mode`, `file_contains`, `dir_exists` and
`command_matched` check a real filesystem with no grader changes at all.

```bash
# .env — a sandbox for real bash. Without this, nothing changes: every
# scenario runs simulated, and a container-fidelity scenario is not offered.
ONTRAK_SANDBOX_BACKEND="docker"              # docker | process
ONTRAK_SANDBOX_IMAGE="debian:bookworm-slim"  # bake the tools a scenario needs into this
```

The **docker** backend is the real one: no network, no capabilities,
`no-new-privileges`, and memory, CPU and process ceilings. Tools are baked into the
image rather than installed by the student, which is what makes it a sandbox, and
the image must have `bash` — a sandbox image without one is named as the problem at
container start rather than discovered as a strange `exec` failure later. The
**process** backend runs real bash in a scratch directory on the app server with no
isolation at all — useful in development and in CI, and refused unless both
`ONTRAK_SANDBOX_BACKEND=process` and `ONTRAK_SANDBOX_ALLOW_PROCESS=1` are set.

Two things are deliberately honest about the limits. `cd`, `pwd` and `cd -` are the
driver's own, so they are exact; a command that prints an absolute path *itself* (a
`readlink -f`, say) prints the sandbox's own root, because quietly rewriting what a
real shell really said is the one thing a fidelity backend must never do. And
machine state that is not the filesystem — services, packages, the registry — comes
from the scenario's boot state, exactly as it does for a simulated attempt.

Nothing is a hard dependency on a sandbox. Fidelity is resolved when the attempt
page renders: a container-fidelity scenario on a deployment with no sandbox runs
simulated and says so on screen, a sandbox that stops answering mid-attempt falls
back once and says so, and the availability rule keeps a sandbox-only scenario out
of the catalogue where there is no sandbox to run it in. The exit criterion is
covered by `tests/sim-container.test.ts`, which grades one scenario twice — once
simulated, once under real bash — and asserts the two reports agree check for check.

PowerShell in a sandbox is not here yet. The honest version of it is a Windows base
image, and shipping a `pwsh` process on Linux under a scenario that promises Windows
would be fidelity theatre — so the validator refuses container fidelity for any
engine but `bash` rather than quietly substituting something else.

### Upstream, the other direction

OnTrak Sentinel **provisions** into Tix over SCIM 2.0, and Tix **pushes** its own
people back out to the provider so a person is added once. Both directions are
documented in [ontrak-tix/docs/identity.md](ontrak-tix/docs/identity.md).

### Downstream: results, and the people who own them

Training evidence is only worth collecting if it can leave. Set
`ONTRAK_API_TOKEN` and a deployment exposes a read API over the same rows the UI
shows — `GET /api/v1/results` (paged by cursor, filtered by `since`, scenario,
cohort, status or grading mode), `GET /api/v1/roster`, and CSV exports of both.
A lab reports a finished session to `POST /api/v1/lab/completions`. Set
`ONTRAK_WEBHOOK_URL` and `ONTRAK_WEBHOOK_SECRET` as well and every new grading is
posted to a consumer as it happens, HMAC-signed over a canonical body with the
timestamp inside the signature.

The design decisions are all about the fact that the consumer is *not here*.
An event's id is derived from the grading rather than the delivery, so a retry is
recognisably the same fact and cannot be applied twice; the body is canonical, so
the bytes signed are the bytes sent; a refusal is an outcome rather than an
exception, so a consumer that is down can never fail a grading; and every
delivery — refusals included — is a row an operator can list and resend instead
of a log line nobody read. A re-grade is a *second* event, not a correction.

The same door opens inward: `POST /api/v1/roster` imports a class spreadsheet,
reading columns by name, refusing rows line by line while importing the rest,
and creating accounts with **no** local password — a roster says who exists, not
what their secret is. [`docs/integrations.md`](docs/integrations.md) is the
consumer's document: routes, signature verification, and what each refusal means.

The third way in is somebody else's product. Set `ONTRAK_LTI_ISSUER` and the
learner never opens this app at all: their LMS launches a scenario here over
**LTI 1.3** (`/api/lti/login` then `/api/lti/launch`), this app is the tool and
the LMS is the platform, and when the attempt is graded the score goes back to the
line item the launch named — a per-write `client_credentials` token signed with
the deployment's key (`make lti-key` mints one), and a score body with both
progress fields set, because a platform holds a score without them as provisional
and it never reaches a gradebook. The matching public half is served from this
deployment at `/api/lti/jwks.json`, so a platform that offers a **Keyset URL**
registers the URL and holds no copy of the key — and an LMS with a pasted-key field
takes the same key as a PEM instead. A passback that cannot happen never fails a
grading; it says which of its three reasons applies. `docs/moodle-lti.md` is the
operator's runbook for standing this up in a real Moodle site, from the keypair to
the role mapping.
Deep linking is refused by name rather than half-supported: this is a tool, not a
gradebook or a course shell.

The last way in is a **directory**, and it is a push rather than a sign-in. Set
`ONTRAK_SCIM_TOKEN` and the app exposes a SCIM 2.0 service provider at
`/api/scim/v2` — `Users` (list, create, get, replace, patch, delete),
`Groups` (list, get, patch) and `ServiceProviderConfig` — so an Entra or Okta
connector can provision, rename, deactivate and class-assign the roster without a
human or a spreadsheet. The design is the same as everywhere else here: the
surface is a *port* onto accounts this app already owns, a provisioned person has
no local password at all, and deleting a user **deactivates** them rather than
erasing the attempts and certificates behind them. It will not invent a class or
reassign one — a cohort is an instructor's, so `Groups` creation, rename and
delete are refused with SCIM's own `mutability` rather than half-honoured. Every
accepted push is audited (`scim.user.provision`, `scim.user.update`,
`scim.user.deprovision`, `scim.group.members`). `docs/integrations.md` is the
connector's document. With no token set the whole surface answers 503 with a
reason, so a deployment that never uses it is untouched.

None of this is hidden from the operator either. The control room at `/admin`
shows single sign-on, LTI and directory sync as off, configured or **misconfigured
with the reason**, and reports each shared secret as the name of the variable that
holds it rather than its value — and a half-wired `ONTRAK_OIDC_*` or `ONTRAK_LTI_*`
block is said out loud in the app log at boot, because a deployment that quietly
fell back to local passwords is the failure nobody notices.

Beside those three, a **Sentinel** tile links out to the family's IDS/IPS product.
Sentinel is a separate deployment with its own console, so this app cannot report on
its internals and does not try: the tile says where its **control center** is, from
`SENTINEL_CONSOLE_URL` (or the `SENTINEL_ISSUER` origin), and is `off` when the
deployment has named no console, `incomplete` when it named one the deployment
cannot open. That control center is the one page that shows what Guard detected and
what it blocked, together.

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
| `npm run docker:db` | Start just the Postgres container, for running the app from source. |

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
    oidc-rules.ts             single sign-on decisions (discovery, claims, roles)
    oidc-client.ts            the two network calls, and PKCE — plus a fixture client
    oidc-service.ts           what a verified assertion does to a local account
    scim-rules.ts             directory-sync (SCIM 2.0) decisions, pure
    scim-service.ts           what a pushed user or group does to a local account
    scim-store-prisma.ts      the SCIM port against the account tables
    templates.ts              starter definitions for the scenario editor
prisma/
  schema.prisma               data model
  migrations/                 the versioned schema history every environment applies
  seed.ts                     idempotent demo school + one finished pass to demo a certificate
tests/
  sim.test.ts                 engine + grading + validator + desktop tests
  desktop-render.test.ts      the desktop surface still server-renders
  oidc.test.ts                single sign-on, including a real provider on loopback
  sso-live.test.ts            opt-in: the app's own SSO routes against a running app
  scim.test.ts                the directory-sync service provider
  scim-live.test.ts           opt-in: the SCIM routes a real connector drives
  lti.test.ts                 LTI launch decisions, the published key set, the client seam
  lti-live.test.ts            opt-in: a scenario launched through the app's own LTI routes
  lti-passback.test.ts        grade passback against a real AGS token endpoint
  integration-status.test.ts  what the control room reports about the three integrations
  support/local-idp.ts        a real, minimal OpenID provider for the tests above
  support/local-lti-platform.ts  a real, minimal LTI 1.3 platform for the passback test
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
| [docs/integrations.md](docs/integrations.md) | The public API, webhooks, LTI 1.3 and SCIM 2.0 directory sync: routes, signature verification, roster import, launching from an LMS with grade passback, and letting a directory push people in |
| [docs/moodle-lti.md](docs/moodle-lti.md) | Registering the training app in a real Moodle LTI 1.3 site, end to end: the keypair, the tool form, the identifiers back into `.env`, and the role mapping |
| [INNOTEL-LABS.md](INNOTEL-LABS.md) | The Innotel Labs product family and how the five products fit together |
| [docs/family-operations.md](docs/family-operations.md) | The family as deployed: the five hostnames, the Authentik role groups, and how to repair each sign-in path |
| [ontrak-portal/README.md](ontrak-portal/README.md) | The centralized dashboard — one sign-in, then the products a role belongs in |
| [ontrak-sync/README.md](ontrak-sync/README.md) | The Network's package and container update view, and the family's local accounts |
| [ontrak-tix/docs/](ontrak-tix/docs/) | The service desk: tickets, SLAs, clients, billing, incidents, assurance |
| [ROADMAP.md](ROADMAP.md) · [ontrak-tix/ROADMAP.md](ontrak-tix/ROADMAP.md) | What is shipped, what is next, and the honest gaps |

---

## Sibling project

Five [**Innotel Labs**](INNOTEL-LABS.md) products share a stack, a design
language and one identity layer:

- [**OnTrak Tix**](ontrak-tix/ROADMAP.md) — enterprise ticketing and
  service management for IT desks and MSPs, with incident response and
  insurance-grade, tamper-evident documentation.
- [**OnTrak Sentinel**](ontrak-sentinel/ROADMAP.md) — identity (IdP) and
  intrusion prevention (IDS/IPS).
- [**OnTrak Sync**](ontrak-sync/README.md) — Network package and container update
  monitoring and, on approval, updating; also the family's local account table.
- [**OnTrak Portal**](ontrak-portal/README.md) — the centralized dashboard: one
  sign-in, then the products a role belongs in.

OnTrak IT Support Training **trains** the technicians; OnTrak Tix is the tool
they **work in**; OnTrak Sentinel protects both; OnTrak Sync keeps the machines
underneath them current; and OnTrak Portal is where a person starts. They link via
a ticket ↔ scenario bridge, a shared role vocabulary and a single identity
provider.

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
