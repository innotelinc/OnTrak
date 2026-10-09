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
| `config.py` | 510 | `src/lib/lab/config.ts` | 2 | not started |
| `scenarios.py` | 534 | `src/lib/lab/scenarios.ts` | 2 | not started |
| `catalog.py` | 741 | `src/lib/lab/catalog.ts` | 2 | not started |
| `lessons.py` | 348 | `src/lib/lab/lessons.ts` | 2 | not started |
| `media.py` | 203 | `src/lib/lab/media.ts` | 2 | not started |
| `primitives.py` | 536 | `src/lib/lab/primitives.ts` | 2 | not started |
| `generator.py` | 306 | `src/lib/lab/generator.ts` | 2 | not started |
| `memory.py` | 203 | `src/lib/lab/memory.ts` | 2 | not started |
| `sessions.py` | 1638 | `src/lib/lab/sessions.ts` | 2 | not started |
| `store.py` | 709 | Prisma models + `src/lib/lab/store.ts` | 2 | not started |
| `tickets.py` | 534 | `src/lib/lab/tickets.ts` | 3 | not started |
| `auth.py` + `oidc.py` | 73 + 325 | *not ported* — superseded | 3 | see §3 |
| `demo.py` | 474 | `src/lib/lab/demo.ts` | 2 | not started |
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

**Single-responsibility note.** `JSON_BEGIN`/`JSON_END` live in `models.ts` rather than
a `scenarios.ts` that does not exist yet. When `scenarios.ts` lands in stage 2 the
markers should move there and `models.ts` should re-export nothing; the current
placement is a footprint, and it is recorded here so it is not mistaken for a design.

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
is — but it is a divergence from `scoring.py` and it is recorded as one.

**C6 — YAML: the app has no YAML parser, and the lab's data is YAML.**
`config.py` reads `config/ontrak.yaml`; `catalog.py` and `lessons.py` read 1,467 lines
of YAML. OnTrak has no YAML dependency and its own precedent is to convert lab data to
JSON (the 14 lab scenarios were converted once into `tests/fixtures/lab-scenarios/`).
**Open — a decision, not a deferral:** either add the `yaml` package (a new dependency,
which the repository's conventions say not to take on unverified) or convert the lab's
YAML data files to JSON with a porting script and keep them as data. Stage 2 cannot
start without this being chosen; nothing in stage 1 touches YAML, which is why stage 1
could proceed. **Recommendation:** convert to JSON, because the app already reads the
lab's scenario data that way and a second YAML dialect in one tree is the kind of drift
`tests/lab-rules.test.ts` exists to prevent.

**C7 — The portal's HTTP surface.**
`portal/app.py` and `portal/admin.py` are ~1,600 lines exposing ~45 FastAPI routes,
many rendering Jinja HTML. **Resolved:** they become Next route handlers and React
pages in stage 3, not a FastAPI app embedded in the tree. Where a route is a
convention (`/healthz`, the console iframe, `results.csv`) it keeps its contract, since
operators and the family's portal probe those paths.

## 4. What cannot be verified here, and how it will be

This environment has **no hypervisor, no `/dev/kvm`, no Windows media and no browser**.
That is not a new problem: it is exactly why the lab itself ships `memory.py` (an
in-memory hypervisor) and `demo.py` (a whole class run with no hypervisor at all), and
why its own roadmap marks the Windows paths "built, but not proven on real hardware".
The port inherits that structure, and stage 2 ports both — so the port's behaviour is
verifiable the same way the Python's is, and the same residue stays honestly unproven:

| Claim | How it is verified in this repository |
| --- | --- |
| grading, weighting, criticals, refusals | unit tests, ported from `test_scoring.py` |
| the console payload is one Guacamole accepts | fixed vectors + `openssl` cross-check |
| hypervisor command construction and error mapping | a scripted runner; no `incus` needed |
| the whole class flow (assign → provision → grade → destroy) | stage 2, against the ported in-memory hypervisor |
| a real Windows VM boots, is fault-injected and is graded | **not verifiable here** — a lab host's job, as before |
| the console websocket tunnel | **not verifiable here** — no browser |

## 5. Staging, and what "done" means

| Stage | Scope | Exit check |
| --- | --- | --- |
| **1** (this commit) | the pure core: 8 modules, 176 ported tests | typecheck clean, ported suites green, full app suite unchanged and green |
| **2** | `config`, `scenarios`, `catalog`, `lessons`, `media`, `primitives`, `generator`, `memory`, `sessions`, `store` + Prisma models and a reversible migration + the C6 decision | the ported demo flow runs a full class with no hypervisor, as `demo.py` does, and the store round-trips a session and a report |
| **3** | the portal surface (`app` + `admin`) on the app's identity, `tickets`, the lab scenario/lesson pages, the console iframe | a student starts, checks, completes; an instructor reads the results; the routes keep their contracts; a11y sweep passes |
| **4** | the CLI as `tsx` scripts, compose/Docker deployment, and the `infra/**` shell kept as shell with its entry points documented | the stack builds and reports healthy with no Incus socket mounted; the boundary tests still pass |

Stage 1 is complete and verified. Stages 2–4 are named work with a stated order; none of
them is started, and nothing in this document should be read as claiming they are.
