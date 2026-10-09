# Porting OnTrak Lab into OnTrak's own stack

The decision this document executes: **the lab becomes TypeScript inside OnTrak**, so
there is one language, one repository and one application rather than two products a
deployment has to run side by side. The alternative the consolidation audit had
recommended — keep the lab as a separately deployed Python peer behind
`ONTRAK_LAB_URL` (audit §6/C1) — has been set aside by the product decision that
prompted this work, and this file exists so the port is governed rather than
improvised.

It is a rewrite of a working platform. It is written down as stages, each with an
entry condition and an exit check, because the failure mode of a port this size is a
half-migrated tree where neither stack works.

**OnTrak-dev is not modified.** It stays the behavioural reference: every ported module
is read against `OnTrak-dev/ontrak/<module>.py` and proven against that module's own
Python tests, which are ported with it.

## 1. What is actually being ported

`OnTrak-dev/ontrak/` is **12,910 lines** of Python, with **8,889 lines** of Python tests
beside it. Module by module, with its disposition:

| Python module | Lines | Ported to | Stage | Status |
| --- | --- | --- | --- | --- |
| `models.py` | 341 | `src/lib/lab/models.ts` | 1 | **done** |
| `scoring.py` | 200 | `src/lib/lab/scoring.ts` | 1 | **done** |
| `guac.py` | 321 | `src/lib/lab/guac.ts` | 1 | **done** |
| `guest.py` | 567 | `src/lib/lab/guest.ts` | 1 | **done** (except WinRM — see §3) |
| `incus.py` | 469 | `src/lib/lab/incus.ts` | 1 | **done** |
| `qemu.py` | 402 | `src/lib/lab/qemu.ts` | 1 | **done** |
| `selection.py` | 188 | `src/lib/lab/selection.ts` | 1 | **done** |
| `scheduler.py` | 281 | `src/lib/lab/scheduler.ts` | 1 | **done** |
| `config.py` | 510 | `src/lib/lab/config.ts` | 2a | **done** |
| `scenarios.py` | 534 | `src/lib/lab/scenarios.ts` | 2a | **done** |
| `media.py` | 203 | `src/lib/lab/media.ts` | 2a | **done** |
| `memory.py` | 203 | `src/lib/lab/memory.ts` | 2a | **done** |
| `catalog.py` | 741 | `src/lib/lab/catalog.ts` | 2b | **done** (its 4 manifests converted to `data/catalog.json`) |
| `lessons.py` | 348 | `src/lib/lab/lessons.ts` | 2b | **done** (its 7 lessons converted to `data/lessons.json`) |
| `primitives.py` | 536 | `src/lib/lab/primitives.ts` | 2d | landed — all nine primitives, compared against the Python field for field |
| `generator.py` | 306 | `src/lib/lab/generator.ts` | 2d | landed — generates and validates against the shipped tree |
| `sessions.py` | 1638 | `src/lib/lab/sessions.ts` | 2d | landed — 18 lifecycle tests, the four disagreements diagnosed and resolved, see §2d |
| `store.py` | 709 | `src/lib/lab/store.ts` (contract + in-memory), `store-prisma.ts` + `prisma/` models | 2c/2d | landed — the contract and the in-memory store in 2c, the Postgres/Prisma one and its reversible migration in 2d |
| `tickets.py` | 534 | `src/lib/lab/tickets.ts` | 3a | landed — the rubric, the grader and the blend; checked against the Python form for form |
| `auth.py` + `oidc.py` | 73 + 325 | *not ported* — superseded | 3 | see §3 |
| `demo.py` | 474 | `src/lib/lab/demo.ts` | 2d | landed — a whole class runs with no hypervisor; see §2d |
| `portal/app.py` | 1101 | `src/app/(app)/lab/**` + `src/app/api/v1/lab/**` | 3 | not started |
| `portal/admin.py` | 511 | `src/app/(app)/lab/admin/**` | 3 | not started |
| `cli.py` | 1373 | `scripts/lab-*.ts` (`tsx`) | 4 | not started |

The non-Python surface, which the port inherits rather than rewrites where it is data
or shell:

| Surface | What it is | Disposition |
| --- | --- | --- |
| `scenarios/**` (14 scenarios) | the task definitions themselves | **kept**; the family already imports them by tag |
| `catalog/*.yaml` (795 lines) | OS/Office/product manifests | stage 2 — see the YAML decision in §3 |
| `lessons/*.yaml` (672 lines) | guided lessons | stage 2, same decision |
| `infra/**` (25 shell scripts) | host bootstrap, golden image, templates, publish/pull | stage 4 — **shell stays shell**: these build a Windows image with `incus`, `qemu-img` and `oras`, and a Node rewrite would be a worse version of the same script |
| `Dockerfile`, `docker-compose*.yml` | the lab's own container stack | stage 4, folded into the family's compose files |
| `deploy/guacamole`, `deploy/authentik`, `deploy/gateway` | console gateway, IdP provisioning, nginx | **kept** — third-party services, not lab code |
| `web/landing/index.html` | the project landing page | **kept**; the family already publishes a landing page |

## 2. Stage 1 — what is in the tree now

Stage 1 is the pure core: the modules that decide things, with no I/O and no database.
They are the ones everything above them depends on, and the ones whose behaviour is
worth pinning before a session manager is built on top.

| Module | What it now decides in TypeScript |
| --- | --- |
| `models.ts` | the session state machine (`requested → allocating → provisioning → ready → in_use → checking → passed/failed → recycling → destroyed`, plus `error`), which states are live/usable/terminal/need an instance, the category vocabulary, objectives, check outcomes, the score report, the session record with its expiry and extension arithmetic |
| `scoring.ts` | the guest grading contract: read the JSON between the markers, weigh it against the scenario, refuse to call a crash a pass |
| `guac.ts` | the Guacamole console link: sign, encrypt and base64 exactly as `guacamole-auth-json` verifies, and probe whether the gateway accepts what we sign |
| `guest.ts` | how a script reaches a guest: UTF-16LE `-EncodedCommand` PowerShell, shell heredocs, chunked uploads, the readiness waits, and which transport a platform gets |
| `incus.ts` | every hypervisor operation, through the `incus` CLI, with the error mapping that turns an exit code into a `NotFound` a caller can handle |
| `qemu.ts` | whether a Windows guest gets KVM or the software fallback, and the instance config to merge when it cannot |
| `selection.ts` | which scenario a student is asked to do, and why — the explanation is part of the output, not a log line |
| `scheduler.ts` | the prewarm/drain windows, the deficit rule and the pool ceiling |

**Verified by measurement, not assertion** (all re-run after the last edit):

- `npx tsc --noEmit` → **exit 0**.
- The seven ported suites: **176 tests, 0 failures** (`npx tsx --tsconfig tests/tsconfig.json --test tests/lab-*.test.ts`).
- The whole application suite: `npm test` → **642 tests, 637 pass, 0 fail, 5 skipped** — the 5 skipped are the opt-in live lab-boundary tests, which need a running server. The 466 pre-existing tests still pass, including the guards that police the architecture (§3).
- The Guacamole payload is pinned against an **independent implementation**: one test decrypts the payload with the cipher primitives directly and asserts the plaintext is exactly `HMAC-SHA256(key, json) || json`, and another cross-checks the whole encoding against the `openssl` CLI, which is the same trick the Python module used to prove its format.

**Single-responsibility note, now settled.** `JSON_BEGIN`/`JSON_END` stay in
`models.ts`, and `scenarios.ts` imports them. An earlier draft of this file said they
should move to `scenarios.ts` once it existed; on landing them the opposite is right —
the marker pair is the **guest grading contract**, and the grader is what reads it, so
it belongs where the grader's types live. A loader importing it is the normal
direction. Recorded because the earlier sentence was an instruction, and an instruction
that turned out wrong is worth correcting rather than quietly ignoring.

### Stage 2a — the settings, the scenario loader, the media store, the fake hypervisor

Stage 2's first slice, landed and verified the same way:

| Module | What it adds |
| --- | --- |
| `config.ts` (1,259 lines) | the settings tree, the `ONTRAK_<SECTION>__<KEY>` override rule, the coercion and refusal rules, `requireSecrets`, and the name helpers. Its output is **structurally assignable to every consumer already in the tree** — `new IncusClient(settings.incus)`, `buildDriver(settings)`, the console's settings — so no adapter sits between them |
| `scenarios.ts` (838) | the scenario loader and validator, on the JSON record shape this repository already defines (`lab-scenario-import.ts`), with the grading contract enforced at load time |
| `media.ts` (632) | the media store: licensed media refused, a checksum re-verified after download, and a mismatch failing rather than warning |
| `memory.ts` (438) | `InMemoryIncus` — the in-memory hypervisor, async to match the ported client, that makes stage 2b and the demo flow verifiable with no hypervisor at all |

**Verified:** `tsc --noEmit` clean; the four suites **76/76**; the whole app suite
**718 tests / 713 pass / 0 fail / 5 skipped**; `npm run build` exit 0. The scenario
suite validates **all 14 real lab scenarios** — the lab's own data, so a rejection there
would have meant the port was wrong, not the data. (At this point the records lived under
`tests/fixtures/lab-scenarios/`; stage 2d moved them to the `scenarios/` tree a host
actually reads, see below.)

### Stage 2b — the catalogue, the lessons, and the data they read (including the conversion)

`catalog.ts` and `lessons.ts`, with **52 tests**, and the one-off data conversion
§3/C6 called for. The lab's YAML is read once, with the lab's own parser, and written as
JSON into `src/lib/lab/data/`:

| Converted | From | Shape |
| --- | --- | --- |
| `catalog.json` (4 manifests) | `catalog/*.yaml` | keyed by file name, each holding that manifest's group, defaults and entries |
| `lessons.json` (7 lessons) | `lessons/*.yaml` | keyed by file name, one lesson each |
| `config.json` | `config/ontrak.yaml` | the config record `config.ts` takes as its file half |

The conversion is lossless (`yaml.safe_load` → `json.dumps`) and was run against
`OnTrak-dev` read-only — nothing in that repository is written, which is why the YAML
stays its source of truth and a change there has to be re-converted.

**Verified:** `tsc --noEmit` clean; the two suites **52/52**; the whole app suite
**770 tests / 765 pass / 0 fail / 5 skipped**; `npm run build` exit 0. The catalogue and
lesson suites run against the **lab's real data** — 4 manifests, 7 lessons — so the
loader is proven on the actual range rather than on fixtures written to suit it, and the
planner is proven pure by testing every ranked strategy with host facts as arguments.
Two behaviours were found by reading the Python rather than assuming: the planner
accepts `poolReady`/`templateReady` and **never reads them**, so `warm-pool` and
`clone-template` are unreachable in the lab today (kept as-is and documented rather than
quietly "fixed" in a port), and `Media.from_dict` lowercases the checksum, which the
catalogue keeps doing because `media.ts` compares it exactly.

### Stage 2c — the store's contract, and two real defects the composition exposed

Two things landed, and one of them is worth more than the module it came with.

**`store.ts`** is the lab's persistence as an interface plus `InMemoryLabStore`, the
reference implementation the tests and the demo use (the Postgres/Prisma one is 2d, per
§3/C3). Writing the tests for it found two defects in the store, both fixed at the cause
rather than asserted around:

- the event readers returned **insertion order** where the lab reads `ORDER BY id DESC` —
  an audit trail shown backwards, and the lab's own suite asserts the direction;
- `slice(-0)` is `slice(0)`, which returns the **whole array**, so a caller asking for
  zero events was handed every event ever logged. `LIMIT 0` returned nothing.

**The guest transport had never composed.** Three modules landed in stage 1 that were each
internally consistent and wrong together: `guest.ts` defines the transport contract every
driver reads (`returncode`, mirroring the Python's `CompletedProcess`), while `incus.ts`
and `memory.ts` handed back a result carrying `code`. A driver reading `returncode` from it
gets `undefined` — which is **falsy** — so a failing check would have read as a passing
one and no readiness probe could ever succeed. The second half of the same seam: the
driver interface named its timeout `timeoutSeconds` while the real client takes `timeout`,
so every scenario timeout was silently replaced by the client's default. Both are fixed,
with `GuestExecOutput` as the guest-exec shape and the reason stated on it, and the two
`sessions.ts` declarations that had grown the invented shapes are gone with the file.

**The session manager is ported but not landed yet** at this point in the work: the file
and its 18-test suite were written and reviewed but four lifecycle behaviours disagreed
with the lab's, so they were parked rather than committed. Each is diagnosed in §2d and all
four are now resolved.

Two things stage 2a confirmed by measurement rather than by reading:

- **The JSON decision is not a loss.** The lab's `scenario.yaml` was already converted
to JSON in this repository, field for field, when the family's importer was written, so
the loader ports onto data that is already here rather than onto a new format. That
settles §3/C6 for scenarios; `catalog`/`lessons` are 1,467 lines of YAML that still need
the same one-off conversion, which is why they are 2b and not 2a.
- **`guest.driver` defaults to `incus-exec`, not the Python's `winrm`** — required by
§3/C1, and asserted by a test, since keeping the lab's default would make a default
deployment throw on its first Windows session.

### Stage 2d — the session manager, and the four disagreements resolved

`src/lib/lab/sessions.ts` — the largest module in the lab, and the one every other moving
part goes through — lands with `tests/lab-sessions.test.ts`, 18 tests that drive the whole
lifecycle (request, claim or clone, wait for the transport, grade, reset, complete, sweep)
against `InMemoryIncus`, `InMemoryLabStore` and a driver that records rather than pretends.
The clock and the sleep are injected, so a 90-minute TTL and a 20-minute idle sweep happen
in milliseconds, and the scenarios and catalogue are the ported real ones.

Four behaviours disagreed when the suite first ran. None was a test-only problem and none
was fixed by loosening an assertion — each was traced to the lab:

- **The event sequence.** The port wrote `allocating` into the log and the test read the
trail oldest-first. The lab's reader is `ORDER BY id DESC` (newest first) and the lab logs
`requested`, `cloned`, `ready` — **there is no `allocating` event**; the intermediate states
are what the session *row* says. The test was wrong on both counts, and is now written the
way the lab reads its own audit trail.
- **A Linux scenario landed in `error`.** The manager resolved the scenario's *first
declared workload* (`ubuntu-24.04`) and refused the bare golden-image template by name,
with the command to fix it — exactly the lab's `_resolve_workload` rule, where an unset
workload means `platform_workloads[0]`. The fixture had built the wrong template. Behind
that sat a second, worse defect: the fake handed in as the **shell** transport inherited
`BaseDriver.runScriptFile`, which composes PowerShell — so a test that believed it was
watching the Linux path was watching the Windows path and passing. `RecordingDriver` now
takes the transport it stands in for, and the Linux assertion is made against `check.sh`
arriving over the shell transport with no PowerShell run at the guest.
- **A second `complete` was not refused.** The lab refuses on `is_terminal`, which is only
`destroyed`/`error` — `passed` is deliberately *not* terminal there, because a check that
resolves leaves the machine in the student's hands. So "passed a check" and "handed the
work in" are two different facts, and the port had only the first. `LabSession` now carries
`completedAt`, set at completion, and `complete` refuses a session that already has one:
the portal's Complete button is a POST, and a double submit would otherwise grade a VM that
no longer exists and **store a 0 % attempt over a pass**. This is a divergence from the lab
(the Python only appends `[completed]` to the notes), and it is recorded as one.
- **The idle sweep recycled nothing.** It measured idle with `secondsSince`, which read the
**real** clock, against stamps written by the **injected** one — with a fixture clock a day
away from wall-clock time the window came out negative and every session was skipped. Fixed
at the root: `secondsSince(value, now)` takes the clock and `reap` passes the injected one,
which is what the lab does by comparing against the clock its sessions were stamped with.

Two of the four are therefore port defects and two were the suite's — which is the useful
split, because the suite was written against the lab rather than against the port, and it is
what caught the fake that was not shaped like the transport it stood in for.

**The store on Postgres, and a migration that reverses.** The Python's `store.py` *is* a
SQLite file it creates and migrates by hand. The port keeps the contract and moves the engine
to the database this deployment already runs (§3/C3): four models in `prisma/schema.prisma`
(`LabSession`, `LabResult`, `LabEvent`, `LabMeta`), a migration that only *adds*, and
`store-prisma.ts` implementing the same interface as the in-memory store — so nothing above
the store knows which one it is holding, and a test asserts exactly that by running one
script against both.

Three things are worth stating because each is where an adapter like this goes wrong. The
Prisma client is described **structurally** (`LabPrismaClient`), so the conversions can be
unit-tested with no database and the one call site that owns a real client does the cast.
Timestamps cross the boundary in named functions, because `""` means *no such moment* for
`readyAt`/`expiresAt`/`completedAt` and has to become NULL rather than 1970. And a stored
report is read back through the lab's own `to_dict`/`from_dict` coercions, so a JSONB column
written by an older version degrades one field at a time instead of throwing inside a results
page — and a report this port writes stays readable by the lab's own tools.

**The migration reverses, and that was checked rather than asserted.** `migrate dev` is
forward-only; the brief asks for reversible migrations, so
`prisma/migrations/20261109000000_add_lab_runtime/down.sql` is hand-written and *applied* in a
throwaway database after the up migration: the four tables, the enum and the migration's own
row in `_prisma_migrations` are removed, the app's other fifteen tables are untouched, and
re-running the up migration restores everything. The migrations directory also shipped
without a `migration_lock.toml`, which is why `migrate diff` could not tell which connector
the history was built for; that file is now committed.

The up migration was verified two ways rather than one: `prisma migrate diff` between the
migration history and `schema.prisma` reports an empty migration (so the SQL and the models
agree), and the schema was applied to a real Postgres 16 — which is also where the integration
test runs, skipped rather than failed when no database is reachable. That test is the only
place the things a fake cannot express are checked: the sequence behind the id, the state
enum, `timestamp(3)` keeping milliseconds through the ISO round-trip, the JSONB report, and
the two `ON DELETE` clauses (a deleted session takes its results and leaves its events behind
naming no session — the events an operator needs after a botched teardown).

**A whole class, with no hypervisor — and a data gap found by trying it.** `demo.ts` is the
lab's demo mode: an in-memory hypervisor, a simulated guest that answers with plausible
grading, and a flow that assigns, provisions, checks, submits and tears down a class in
seconds. It is the only end-to-end proof of the port available here, for the reason §4
gives — and its two suites (16 tests, ported from `test_demo.py`) run it against the real
manager, the real scoring and the real store.

Trying to run it surfaced the most consequential gap of the whole port: **the lab's scenario
data and scripts had never been shipped.** The 14 records existed only as flat JSON test
fixtures, with no `setup.ps1`/`check.ps1`/`setup.sh`/`check.sh` anywhere — so a deployment
had nothing to inject a fault with and nothing to grade against, which is a fact only an
end-to-end run can reveal. The fix is `scenarios/`: the lab's own tree, one directory per
scenario, the scripts copied from `OnTrak-dev` unchanged beside the `scenario.json` converted
from its YAML, plus the shared `_lib` libraries. `src/lib/lab/dataset.ts` is the one module
in the port that reads a disk (which is the other half of the pure modules' injected-file
contract), and `tests/lab-dataset.test.ts` asserts the tree is *complete* — all 14 records,
the script each platform runs, and the other platform's script absent — because a missing
`check.sh` is otherwise discovered by a student whose work cannot be graded.

The conversion was checked rather than trusted: every regenerated record equals the record
the previous fixtures held, field for field, so the fixtures and the shipped tree were the
same data all along and the change was about *where* it lives.

Four divergences in the demo are named in the module and worth repeating here, because each
is the port's own decision showing through: the store is in-memory by default (the port has
no SQLite), there is no lab user table to seed (§3/C2 — `demoAccounts` returns the roster and
creating accounts is the app's business), the simulated guest's dice are deterministic but
explicitly **not** the Python's (`random.Random` seeded with a string cannot be reproduced, so
the port's own small PRNG is seeded with the same facts), and — since stage 3a — the write-up
*is* synthesised, from the same rubric a student's is marked with (stage 3a, below;
`writeUps: false` turns it off, which is how the unsubmitted case is demonstrated).

**`primitives` and `generator`, and 2d is done.** The nine fault primitives are the reviewed
building blocks a generated scenario composes, and they were checked rather than eyeballed: the
lab's own module was imported and its fields dumped, and the port's output compared against
them field for field — **identical**, scripts included, character for character. That matters
more than it sounds: a primitive's check decides whether a student's fix counts, so paraphrasing
one would change what a student is graded on. `tests/lab-primitives.test.ts` then holds the
contract the generator depends on — a check must report *exactly* the objectives the primitive
declares, no more and no fewer, because an unreported objective scores zero for ever and an
invented one grades work the ticket never asked for.

The generator writes a scenario record plus its two scripts and then **validates what it
wrote**, which is the lab's own rule ("a generated scenario that would always score zero fails
generation instead of failing a student"). Two adaptations were needed and both are named in
the module: the record is JSON and the target tree is a parameter (the port's repository is pure
and has no root), and validation re-reads the tree with `scenarioEntriesFrom` and hands the
validator each new scenario's `ScenarioFiles` — so the *script* contract is checked, not just
the record's. The whole matrix (one scenario per primitive) validates cleanly, and the
refusals are all covered: an empty list, an unknown primitive, an id that is not
lowercase-dashed, clobbering without `--force`, and the same objective id twice (which the
lab's own self-pair combination is the real case of).

### Stage 3a — the in-house ticket, and the write-up in the grade

`src/lib/lab/tickets.ts` is `tickets.py` field for field: the form a student fills in, the
rubric that marks it, and the blend that mixes it with the machine grade. Landing it turned the
two placeholders stage 2d left behind into the real thing — `DEFAULT_TICKET_RULES` in
`scenarios.ts` is no longer "finds the form and validates none of it", and `complete` no longer
says the write-up was left out.

**The rubric was checked, not eyeballed.** The Python module was imported, all 14 shipped
forms were dumped with every field's attributes, and the port's own loader was run over the
same records and compared: **identical**, every form and every field, attribute for attribute.
The *grader* was then checked the same way, on 125 submissions across those 14 rubrics — the
synthesised write-up, an empty submission, a one-word answer per field, an answer built from the
terms a rubric rejects, and each single field left blank in turn — comparing the score, the submitted flag, the
notes and every field's `passed` **and** its `detail` line against the Python's. All identical.
That matters more than it sounds: the `detail` is the feedback a student reads, and a port that
scored the same while telling them something different would have silently rewritten the course.

**What the port adds is the policy, and the policy is the Python's.** `complete` marks the
machine and the ticket and blends them (`ticket.weight` is capped at 60, so the machine state is
always the larger part); an unsubmitted write-up scores zero **and the attempt cannot resolve**,
because "the fix nobody recorded" is not a finished job; and the one case where blending would
lie is spelled out instead — if the machine could not be graded at all, the write-up is marked,
stored and logged but left out of the number, so a good write-up cannot manufacture a pass for
an unverified machine. The draft the student was typing is forgotten once the write-up is handed
in, and `ticket_graded` joins `completed` in the audit trail.

**The ticket verdict goes through the app's own rule.** `scoring.ts` already asked
`clearedPassMark` for the machine half (§3/C5); the write-up's own rubric mark now does too,
which is C5's convergence applied one level down and carries C5's cost: the verdict is taken at
the whole-percent boundary, so a 59.6% write-up clears a 60% rubric where the Python called it
short.

**The store's ticket half, in both implementations.** `LabTicket` is a table of its own rather
than a column on `LabResult` — the write-up is read on its own (the session page shows the
student what they wrote) and the admin view lists tickets without unpacking a report — and the
migration that adds it (`20261110000000_add_lab_ticket`) is additive, with a hand-written
`down.sql` in the directory. A **draft is not a grade**: an unsubmitted write-up lives in
`LabMeta` under `ticket_draft:<sessionId>`, the lab's own key, so a half-written answer cannot
appear in a marking record. `tests/lab-store-prisma.test.ts` runs the ticket half of the
contract against both the in-memory store and the Prisma one, and against a real Postgres when
one is reachable — including the two facts a fake cannot prove, the foreign key and the
`ON DELETE CASCADE` that takes a session's tickets with it while its events stay behind.

**One consequence worth stating, because it changed existing tests rather than being hidden:**
all 14 shipped scenarios declare a `ticket.form`, so a *completed* session now requires a
write-up. The session suite hands one in (built from the rubric by the demo's own synthesiser,
so there is one definition of what a passing write-up looks like), and the demo hands one in for
every student — which is also what makes the blended grade visible in a run of the demo.

**Verified:** `tsc --noEmit` clean; the lab suites **451 tests / 449 pass / 0 fail / 2 skipped**
(the skips are the opt-in live-boundary tests); the whole app suite **887 / 879 pass / 5
skipped / 3 fail**, the three being the pre-existing `family-*` failures caused by an
uncommitted local edit to `docker-compose.all.yml` (binding the published ports to
`192.168.104.129`), which are green with that edit stashed; `npm run build` exit 0. The
differential checks above (14 forms, 125 graded submissions) were run against `OnTrak-dev`
read-only.

The migration was verified the way the lab's runtime one was, and with the same three
checks: `prisma migrate diff` between the migrated database and `schema.prisma` reports an
**empty migration** (so the SQL and the models agree); the store's integration test runs
against a **real Postgres** and now covers the write-up as well — the JSONB grade and the
answers beside it, the drafts in `LabMeta`, and the `ON DELETE CASCADE` that takes a
deleted session's tickets with it; and `down.sql` was **applied** in a throwaway database,
after which `LabTicket` is gone while `LabSession`, `LabResult` and the app's own `User`
table are untouched and the migration is forgotten in `_prisma_migrations`, and re-running
`migrate deploy` restores it. The development database on this machine was then left
migrated, which is the state `npm run db:deploy` is expected to produce.

### Stage 3 — the surfaces, and stage 4 — the CLI and the deployment

Stages 1–3a produced a control plane nothing could reach: no route in the app imported
`src/lib/lab/`. Stage 3 connected it, and stage 4 gave an operator a way to work the
range without a browser. Six decisions are worth stating out loud.

**A third fact about the lab: it can be *here*.** `ONTRAK_LAB_ENABLED` plus `ONTRAK_LAB_URL`
meant "somebody else's lab"; the port means a deployment can serve the lab itself, and
that is a different question, so it is a different variable (`ONTRAK_LAB_IN_APP`).
`labDoor()` combines all three into one answer a page can draw — off, a peer's link, this
app's `/lab`, or a refusal that names the variable to fix — and the in-app answer wins over
a stated address, because a stated address would be handed a `/dashboard`, which is the
*peer* lab's landing page and not a page this app has. A deployment migrating off
OnTrak-dev therefore adds one variable and does not have to remember to delete another. A
deployment that wants the family's portal tile to point at the in-app lab sets
`ONTRAK_LAB_URL` to this app's origin; that keeps the portal's own light working, which is
what `/healthz` is for.

**One runtime, opened once.** `src/lib/lab/service.ts` is the only place that reads the
environment, opens the store and loads the data: demo mode (the ported in-memory range, no
hypervisor and no secrets) or a host (Prisma and `incus`). A lab that will not open is a
*value* with a sentence naming what to fix, never a 500 from whichever page loaded first,
and a host with no `incus` still opens and reports `hypervisor: false`, which is what the
ported availability checks are for.

**The app's identity, the lab's names.** §3/C2 said the lab's own sign-in is not ported;
the port is therefore concrete about it — the lab's "student" *is* the family's email,
lowercased, because that is the unique key the completions door files results against. A
session a student starts and the attempt they are credited with cannot disagree about who
they are.

**The grade is filed once, by whichever half graded it.** The write moved out of the HTTP
route into `src/lib/lab-completion-record.ts`, and the in-app flow calls it too, so the
attempt, its check results, its certificate, its evidence and its audit entry are identical
whether a peer lab reported over `POST /api/v1/lab/completions` or this app graded the
session itself. The session key is prefixed `in-app:` for one reason: a deployment running
both would otherwise let one lab's session id be answered as a duplicate of the other's.

**A check is a preview, and a preview is not a result.** `runChecks(session, false)` for
"check my work", and a write-up can be marked before it is handed in; both are held in
process memory (`src/lib/lab/preview.ts`) with a lifetime and a cap, and neither reaches a
table. This is the Python's own `preview_reports`/`preview_tickets` ("shown, never stored"),
and it is what makes the lab results-only rather than "results plus whatever was clicked".
The cost is stated: an action's redirect and the page render that follows are not guaranteed
to be the same process, so a deployment with several instances shows the grade summary from
the action's own message and may not have the per-field detail until the session is handed
in. What is *stored* is unaffected.

**Stage 4 retires two kinds of command rather than losing them.** `serve` was uvicorn and
this app is the server; `user` was the lab's own account table, which §3/C2 supersedes. Both
refuse with the reason and the replacement (`npm start` with `ONTRAK_LAB_IN_APP=1`; the
family's own user administration). The three host commands — `image build`, `media fetch`,
`catalog refresh` — are refused the same way, because they need a hypervisor, gigabytes of
media or an Incus remote, and a command that half-runs on the wrong machine is worse than
one that says where it belongs.

**A container is not a lab host, and the wiring says so.** `docker-compose.all.yml` passes
the lab's switches through to the training app and deliberately does **not** mount an Incus
socket: the image has neither `incus` nor `/dev/kvm`, so a mounted socket would produce a
worker that fails later and more confusingly than one that never started. The two honest
deployments are a container in demo mode (`ONTRAK_DEMO__ENABLED=1`) and the app started
where a hypervisor lives; `.env.example` documents both, with the lab's own settings tree.

**Verified:** `tsc --noEmit` clean. `npm run build` exit 0, with `/lab`,
`/lab/sessions/[id]`, its console route, `/api/v1/lab/sessions/[id]/status` and `/healthz`
in the route table. The whole app suite **924 tests / 919 pass / 0 fail / 5 skipped** (the
skips are the opt-in live-boundary tests), including the ported read models, the completion
mapper, the runtime seam — which drives a whole session through a demo runtime — the CLI run
as an operator runs it (`session start` must allocate a machine, the write-up must have the
five actions the Python had, and the transports a manager builds for itself must be given the
hypervisor), and three new a11y audits: the write-up form and the console panel are
presentational precisely so an axe sweep can reach them with no server, database or machine
behind them. The CLI was exercised on this host: `doctor` reports the three missing
secrets and exits 1, `scenario validate` clears all 14 scenarios, and `demo run --students 3`
provisions, checks, writes up, hands in and tears down a class with no hypervisor and exits 0.
`npm run lab -- help` lists the surface a Python operator already knows.

**And then it was run on a real lab host, which is the check this document had been
waiting for.** A machine with `incus` 7.5.1, `/dev/kvm`, a prepared `ontrak` project and the
21 built templates was pointed at with the settings tree above, and the whole student flow
went through the ported control plane rather than the Python's:

| Step | What came back |
| --- | --- |
| `doctor` | `ok` on all eight lines and exit 0 — settings, secrets, `incus`, 14 scenarios, 63 catalogue entries, 7 lessons, the gateway, and "served here at /lab" |
| `pool status` | 21 rows, every one with its template present |
| `session start --scenario linux-sudo-delegation` | **4.4 seconds** to a `ready` session on a real container, `10.20.0.168` |
| the guest itself | `visudo -c` exit 1, `/etc/sudoers.d/50-helpdesk` at mode 0644, `dana.ops` in `ops` — the fault injected by `setup.sh` is really there |
| `session check` | **0%**, four objectives failed, with the guest's own words for each — the `^` under the invalid line, the 0644 drop-in, the blanket rule |
| the repair | a fresh 0440 drop-in; `visudo -c` parses; `sudo -l -U dana.ops` shows `(root) NOPASSWD: /usr/bin/systemctl restart nginx` |
| `session check` again | **80%, resolved** |
| `ticket grade` | 100%, 5/5 fields, and "nothing stored" |
| `ticket complete` | `machine 80% x 65% + ticket 100% x 35% = 87%`, resolved, exit 0 |
| `results` | one attempt, best 87, resolved — the attempt really is in the ledger, and the machine was destroyed on submission |

**That run found two real defects in this port, and both are fixed.** `session start` called
`createSession` where the Python called `allocate`: it filed a row at `requested` and returned,
so the `check` an operator would type next had nothing to grade and no amount of waiting would
have changed that. And the write-up answered `form`, `show` and `grade` while its own error
message advertised `save` and `complete` — two of the Python's five actions absent, and the
message listing them as if they were there. `allocate` also brings the range's own selector
with it (`selection.choose` over the whole range's history), which is what makes
`--scenario` optional when `selection.auto_assign` is on, as it was in the Python.
`tests/lab-cli.test.ts` now pins both seams against a demo runtime, so they are checked on a
laptop as well as a host.

**One finding that is not this port's, and should be said plainly.** `no-blanket-rule` fails on
a machine nobody has touched: the template's stock `/etc/sudoers` carries `%admin ALL=(ALL) ALL`
on line 50, and the check's own regex matches `(ALL) ALL`. So that objective costs 20 points
whatever the student does, and the scenario is only resolvable with a perfect score on the
two criticals and `dropin-hygiene` — which is exactly what happened above. `check.sh` is
byte-for-byte the Python lab's (verified with `diff`), so this is inherited with the scenario
rather than introduced by the port; it is a bug in the scenario's grading, and fixing it
belongs with the scenario, not here.

**The Windows half needed two things, and only one of them was the image.** A Windows session
(`net-dns-failure`) cloned, booted and took an address, but its Incus agent never came up — an
hour of polling, with the VM at ~74% CPU the whole time. The cause was in the host's own build
scripts: `build-golden-image.sh` and `import-golden-image.sh` **clear**
`requirements.cdrom_agent` on `ontrak-win-base` (they say so, for WinRM), so no `agent:config`
disk is attached to the instance or to the templates — and that disk is where an Incus agent in
a Windows guest reads the host configuration it needs. Attaching it to the running instance and
restarting brought the agent up in **about ninety seconds** (`incus exec … cmd /c echo`
answered), and the guest's fault was then visible from the outside: a static DNS entry on the
adapter, and `Resolve-DnsName fileserver.ontrak.lab` reporting "DNS name does not exist". So the
diagnosis is proven rather than guessed, and the repair is host work: re-publish the image with
the requirement intact, or attach the disk **before** the `clean` snapshot is taken, because
this port clones `template/clean` and a device added to the instance afterwards is not in it.

**With the agent up, the graded Windows session failed — and that was this port's fault.**
`session check` against the live guest returned `cannot prepare C:\ProgramData\OnTrak\lib: the
incus-exec driver has no Incus client`. The manager gave its **shell** transport the hypervisor
but built its **Windows** transport with settings alone, and `incus-exec` is the agent on the
other end of the Incus socket: with no client, every command the driver runs comes back as a
failure, so no Windows guest could ever have been graded. Every unit test passed because every
one of them injects its drivers — the default construction was the untested path, which is
exactly the kind of hole a host run exists to find. It is fixed (`the driver now gets the
client, as the shell transport already did`) and pinned by a test that fails on the old
construction with the live error's own words.

**The fixed path has not been re-run against a live Windows guest, and the reason is disk.**
The first attempt filled the host's filesystem — the 6 GiB golden image, a 3.4 GiB clone and
its boot writes on a volume that was already at 92% — and took the deployment's Postgres down
with it. Space was recovered and the database restarted, and the Windows VM was deleted to
give the space back rather than booted again: a second attempt on a full volume would have been
the same outage twice. So the honest state of the Windows half is: **the agent comes up once
the config disk is attached, and the driver defect it exposed is fixed and unit-tested, but a
graded Windows session is still owed a host run** on a machine with the headroom for it. The
host's volume should be sized for the images and snapshots the lab keeps — this document
records the limit it has, which is the finding an operator most needs.

**Not verified here, and unchanged from §4:** a real *Windows* guest booting, being
fault-injected and **graded** (the three paragraphs above are where that stands: the agent is
the image's job, the driver defect is fixed, and the graded run is owed a host with disk); the
console websocket tunnel; and the browser suite (`npm run test:a11y`, Playwright) against these
pages, which needs a running app and a database. The page-level walkthroughs the Python
asserted through rendered HTML are covered here at the layer below — `tests/lab-portal.test.ts`
asserts the address, the status body, the catalogue groups and both CSVs directly — and the
browser pass remains the honest last step before a class uses it.

## 3. Architectural conflicts, and how each is resolved

The brief says to identify and resolve conflicts rather than ignore them. These are the
seven that a port of this size creates, with the resolution taken and the honest cost
of each.

**C1 — Windows guest transport: `pywinrm` has no Node equivalent.**
`guest.py` drives Windows over WinRM through `pywinrm`. There is no maintained WinRM
client for Node, and hand-writing WSMan with NTLM message signing is a large, untestable
here component. **Resolved:** Windows guests are driven through `incus-exec` — the Incus
agent over virtio-vsock — which the lab's own documentation calls the better transport
(it has no network dependency, so a scenario that breaks the NIC still grades). The
driver-name list stays complete, so an operator configuration that names `winrm` fails
loudly with a message naming the gap and the transport to use, rather than silently
using something else. **Cost:** a deployment that depends on WinRM specifically (a
Windows image with no virtio agent) is not served by this stack until a WSMan client
exists. That is a real capability regression and it is named, not hidden.

**C2 — Identity: two sign-in systems cannot both exist.**
The lab ships `auth.py` (scrypt password hashes, HMAC-signed cookies, CSRF) and
`oidc.py` (Authentik). The family already has identity, and audit §6/C5 decided the lab
is a relying party whose two roles map onto the family's vocabulary at sign-in. **Resolved:**
`auth.py` is **not ported**. The ported lab authenticates with the app's own
`requireSession` and reuses the app's roles; a second login and a second user table
would be the "boundary with nothing inside it" the audit refuses. **Cost:** the lab's
standalone deployments lose their local sign-in — which is already the lab's documented
position (there is no local account; sign-in is Authentik's).

**C3 — Database: SQLite becomes the app's Postgres.**
`store.py` is 709 lines of self-migrating SQLite (`users`, `sessions`, `results`,
`events`, `tickets`, `meta`). **Resolved:** Prisma models in the app's existing Postgres,
with a reversible migration, in stage 2. The `users` table is not migrated — it is
superseded by C2. **Cost:** the lab's "one file to copy" deployment story is gone; a lab
host now needs the database the family already requires.

**C4 — Blocking subprocess calls.**
`incus.py` shells out synchronously, which is right for a CLI and wrong inside Next's
request handling, where a 120-second `incus list` would stall every other request.
**Resolved:** the ported client is **async** and takes an injectable runner, so a test
needs neither `incus` nor a real process. **Cost:** callers `await`; that is reflected
in the ported signatures.

**C5 — One pass rule.**
`tests/one-pass-rule.test.ts` refuses any comparison of a score against a pass mark
outside `src/lib/score-rules.ts`. The ported grader contains one. **Resolved:** the
grader now calls `clearedPassMark({ score: earned, maxScore: total, passScore })` and
adds only the condition that rule does not contain (every critical objective passed).
**Cost, stated because it is a real behaviour change:** the verdict is taken at the
app's whole-percent boundary, so a 79.6% weighted score clears an 80% mark where the
Python's one-decimal comparison called it short. That convergence is the point — a lab
result and a simulated result quoting the same percentage must agree about what a pass
is — but it is a divergence from `scoring.py` and it is recorded as one. Stage 3a applies
the same rule to the write-up's own rubric mark, and carries the same cost with it: a
59.6% ticket clears a 60% rubric here where the Python called it short.

**C6 — YAML: the app has no YAML parser, and the lab's data is YAML.**
`config.py` reads `config/ontrak.yaml`; `catalog.py` and `lessons.py` read 1,467 lines
of YAML. OnTrak has no YAML dependency. **Resolved — the data becomes JSON.** The lab's
scenario YAML was already converted to JSON in this repository when the family's importer
was written (all 14 scenarios, field for field), so the
scenario loader ports onto data that is already here; `config.ts` takes an
already-parsed record and does not choose a parser; and `catalog`/`lessons` get the same
one-off conversion, with a checked script rather than by hand. **Cost:** the lab's YAML
files stay the source of truth in `OnTrak-dev`, so a change there has to be re-converted —
which is true of every ported data file and is stated rather than hidden. The alternative
(a `yaml` dependency) was not taken because this repository's conventions discourage a new
dependency that its own precedent makes unnecessary.

**C7 — The portal's HTTP surface.**
`portal/app.py` and `portal/admin.py` are ~1,600 lines exposing ~45 FastAPI routes,
many rendering Jinja HTML. **Resolved:** they become Next route handlers and React
pages in stage 3, not a FastAPI app embedded in the tree. Where a route is a
convention (`/healthz`, the console iframe, `results.csv`) it keeps its contract, since
operators and the family's portal probe those paths.

## 4. What cannot be verified here, and how it will be

This was written when the machine doing the port had **no hypervisor, no `/dev/kvm`, no
Windows media and no browser** — which is not a new problem: it is exactly why the lab itself
ships `memory.py` (an in-memory hypervisor) and `demo.py` (a whole class run with no hypervisor
at all), and why its own roadmap marks the Windows paths "built, but not proven on real
hardware". The port inherits that structure, and stage 2 ports both — so the port's behaviour
is verifiable the same way the Python's is.

**Half of that paragraph stopped being true, and the row changed with it.** The host this work
finished on *is* a lab host — `incus` 7.5.1, `/dev/kvm`, a prepared project and 21 built
templates — so the Linux guest row below is no longer "not verifiable here": it was run, on a
real machine, end to end (§5, with the numbers). What is left is narrower and stated exactly:

| Claim | How it is verified in this repository |
| --- | --- |
| grading, weighting, criticals, refusals | unit tests, ported from `test_scoring.py` |
| the write-up rubric, the feedback and the blend | unit tests ported from `test_tickets.py`, run over all 14 shipped rubrics; the demo's write-up makes the blended grade visible end to end |
| the console payload is one Guacamole accepts | fixed vectors + `openssl` cross-check |
| hypervisor command construction and error mapping | a scripted runner; no `incus` needed |
| the whole class flow (assign → provision → grade → destroy) | stage 2, against the ported in-memory hypervisor |
| a real Linux guest boots, is fault-injected and is graded | **verified on a lab host** — clone → boot → 0% → repair → 80% resolved → a write-up blended to 87% → a `results` row and the machine destroyed (§5) |
| a real Windows guest is driven through the Incus agent (`incus-exec`) | **half verified, and it found a port defect**: no `agent:config` disk exists on `ontrak-win-base` (the host's build scripts clear `requirements.cdrom_agent`), so the agent never starts until one is attached — proven, it comes up in ~90s once it is. With the agent up, `check.ps1` grading failed on a real bug: the manager built the Windows driver with no Incus client. Fixed, and pinned by a test that fails on the old construction; **the graded re-run is owed a host with disk** (§5) |
| the console websocket tunnel | **not verifiable here** — no browser |

## 5. Staging, and what "done" means

| Stage | Scope | Exit check |
| --- | --- | --- |
| **1** (this commit) | the pure core: 8 modules, 176 ported tests | typecheck clean, ported suites green, full app suite unchanged and green |
| **2a** (landed) | `config`, `scenarios`, `media`, `memory` — 76 tests | typecheck clean, suites green, the 14 real lab scenarios validate, full suite and build unchanged and green |
| **2b** (landed) | `catalog`, `lessons` — 52 tests — plus the lab's data converted to JSON (`src/lib/lab/data/`) | the real catalogue and lesson library load and validate with no YAML parser; the grader takes the catalogue's own object; suite and build green |
| **2c** (landed) | `store`'s **contract** + the in-memory implementation, and the guest-transport repairs below | typecheck clean; the store, memory, incus and guest suites green; the whole app suite and the build unchanged and green |
| **2d** (landed) | `sessions`'s four behaviours resolved, the Prisma store + reversible migration, the `scenarios/` tree, `demo`, `primitives`, `generator` (§2d) | the ported demo flow runs a full class with no hypervisor, as `demo.py` does (`tests/lab-demo.test.ts`), and the store round-trips a session and a report (against a real database) |
| **3a** (landed) | `tickets` — the form, the rubric, the grader and the blend — plus the ticket half of the store (`LabTicket` + migration) and the demo's write-up synthesis (stage 3a) | every shipped rubric validates and is satisfiable; a completed session blends the two halves and an unsubmitted one cannot resolve; the ticket half of the store contract holds against both implementations, and against a real Postgres |
| **3** (landed) | the student surface (`/lab`, the session page, the console route, the pollable status), the instructor fleet and both CSVs, the in-app door and the lab's `/healthz` | a student starts, checks and hands in; an instructor reads the class; `results.csv` keeps its path, name and header row; three new a11y audits pass |
| **3 (rest)** | the admin panel's pages (users, platforms, tickets, schedule, audit) and a lessons browse page | named work, and pages over modules that stage 2 already ported — the read models and the CLI are in place, so this is presentation |
| **4** (landed) | the CLI as `scripts/lab/cli.ts` (`npm run lab`), the settings documentation, and the deployment wiring in `.env.example` / `docker-compose.all.yml` | `doctor` names what a host is missing; `scenario`, `catalog`, `lesson` and `generate` read the shipped data with no host at all; `demo run` drives a whole class with none; the Python commands that a *server* or an account table used to provide refuse, in words, with the code that replaced them |
| **4 (rest)** | the `infra/**` host shell (not in this repository; OnTrak-dev's) and the three host commands — `image build`, `media fetch` and `catalog refresh` | they run where the hypervisor and the media live, and each says so rather than half-running |

Stages 1, 2a, 2b, 2c, 2d, 3a, 3 and 4 are complete and verified — the control plane, its data,
its store, its demo, its write-up, its surfaces and its CLI. What remains is the *rest of* the
portal surface (an admin panel and a lessons browse page, both over modules already ported) and
the host-side commands, and neither is a prerequisite for a class: `/lab` serves one today, from
a host or from demo mode.
