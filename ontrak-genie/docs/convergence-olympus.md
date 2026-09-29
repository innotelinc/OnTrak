# Genie-first convergence: one web surface, one builder

**Status: proposed** · supersedes the *Studio-first* reading of
[convergence-onyx-olympus-distro-atlas.md](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-onyx-olympus-distro-atlas.md)
for the web surface only.

> **What this is.** The stack's build-plane convergence doc chose **Studio as the one
> web UI** because it was the only surface that ended with a running, named
> application. That conclusion still holds for the *engine* and is not in question
> here. What changed is the front end: this console is a better browser surface than
> Studio, and the doc's own fallback option — *"one engine, three thin clients"* —
> becomes the correct shape once the other clients retire. This document is the plan
> for replacing Studio's interface with Genie's, without touching the engine.

---

## 1. What the convergence doc decided, and what it deferred

| Option | Shape | Verdict in the doc |
| --- | --- | --- |
| **A — Studio-first** | Studio is the one web UI; Olympus's engine the one builder; Distro's control plane absorbed; Chef retires | **Chosen** — the only shape where all four "one"s hold *and* output is a running app |
| **B — One engine, three thin clients** | Extract the builder into a service; Studio, the TUI and the bolt.diy shell all call it | **Deferred** — *"one" holds at the engine layer only; three web surfaces remain* |
| **C — Distro-first** | Distro is the web UI *and* the builder | Rejected — WebContainer cannot produce a host process |

**Option B was deferred for one reason: it left three web surfaces.** That reason
disappears when Studio and the bolt.diy forks retire and one client remains. So
Option B is not a competing idea — it is the same engine decision with a different
front end, and it is the shape this document adopts.

## 2. Why Genie's interface and not Studio's

The engine question (**can it run a server-side app, can it publish a real name, can
it pick a stack**) is settled in Olympus's favour and stays there. The interface
question is different: it is about what the person operating the agent can see.

| Property | Genie | Studio |
| --- | --- | --- |
| Grain | Watch an agent work in a workspace | Describe an app, receive one |
| Partial work | The file being written, rendered and diffed **while writing**; the tool call as it is still arriving | A streaming log |
| Gating | A browser approval per command, with deny that ends the turn | Server-side gates, protected paths |
| Model truth | Chain health (`models n/m ready`) and a catalog sweep, in a panel | Model list |
| Resilience | Fallback chain plus a second gateway tried only after the chain fails | Single gateway, local Ollama bypassed by design |
| Frontier | Dependency-free front end (`public/app.js`), SSE | Next.js App Router, React |

Two of those are arguments the portfolio already accepts: Olympus's `/admin` exists
because *"every failure already had a script that diagnosed it … and not one was
reachable from a browser, so the person who noticed the symptom was never the person
who could run the script."* Genie's chain-health badge and sweep panel are that
argument applied to models, which is what Studio's model list is not.

## 3. Target architecture

```
                    ┌────────────────────────────────────────────┐
                    │  GENIE — the one web UI                     │
                    │  agent console · approval gate · live diff  │
                    │  chain health · sweep · export to factory   │
                    └───────────────┬────────────────────────────┘
                                    │ plan / build / preview / publish
                                    ▼
   ┌───────────────────────────────────────────────────────────┐
   │  OLYMPUS — the one engine  (unchanged)                     │
   │  project_plan.py → Archon greenfield → Codex →             │
   │  package-app.py / package-website.py → app-runtime.py      │
   └───────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────┬───────────┴────────┬──────────────────┐
        ▼               ▼                    ▼                  ▼
   Authentik       Cerulean Vault      Distro control plane   OmniRoute
   (identity)      (secrets)           (keys, quotas)         (models)
```

Retired by this shape: Studio's interface (`web/studio/`), and the bolt.diy forks
as builder front doors. **Not** retired: Olympus's engine, its runner, its packaging,
its publishing path through Cerulean and NPM Edge, or its TUI.

## 4. What Genie has to gain

1. **Identity.** Replace the static bearer with Authentik OIDC (PKCE, id_token
   verification) as `ontrak-tix` and `ontrak-portal` already do. Keep the bearer as
   an API path for clients that drive the endpoint directly.
2. **Tenancy.** Consume Distro's control plane the way Studio does: resolve the
   identity, gate quota *before* dispatch, record usage *after*, key the session
   library on the control-plane user id.
3. **Secrets.** A Cerulean Vault `vault://` reference in place of the gateway key in
   `.env`.
4. **The builder API.** The surfaces Studio exposes today — plan, generate, project
   build queue, build log, preview, export — re-expressed as the client half of
   Olympus's engine. This is the largest piece and the one to scope first.
5. **Export to factory.** Genie already writes files into a workspace; the export
   step writes a `build-requests/` spec, so a session that produced something worth
   building becomes factory input instead of stopping at the preview.

## 5. Phases

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| **0** | Genie conformed and landed in OnTrak as `ontrak-genie/` — license, stack doc, guard, port, no internal addresses | — |
| **1** | Stack citizenship: Authentik OIDC, Vault references, the shared gateway's address from the environment | Phase 0 |
| **2** | The builder API: Genie's UI over Olympus's plan → build → preview path; control-plane tenancy — **started**: the *handoff* is wired and measured end to end — a real checkout, a real plan, and a manufactured application whose own tests pass (§5.1–§5.3) — and *tenancy* is wired (Distro's control plane: resolve the caller, gate quota before dispatch, spend the account's own key, record after); plan/build/preview/publish, and partitioning, remain | Phase 1 |
| **3** | Studio's interface retires; the front-door count reaches one | Phase 2 |
| **4** | Docs converge: the stack doc's §3 updated from *chosen A* to *A′ — A's engine, B's client*, Olympus's README and `docs/stack.md`, and the family table | Phase 3 |

### 5.1 What the handoff was measured to do (29 Sep 2026)

Run against a real Olympus checkout, from a Genie in this repository, with a
six-file static app in the workspace:

| Step | Result |
| --- | --- |
| `export` from the console | `build-requests/pomodoro-timer.md` written into the checkout — 12,921 bytes, the template's four `##` headings, entry point `index.html`, stack inferred from the file set, and verification criteria (`npm install`, `npm test`) taken from the app's own `package.json` |
| Olympus's planner reads it (`scripts/project_plan.py --spec`) | `builds/pomodoro-timer/plan.json` — a real plan in the factory's own format: `runtime.language=node`, `run.install=npm install`, `run.start=python3 -m http.server 8080`, `run.port=8080`, six files |
| `make app SPEC=build-requests/pomodoro-timer.md` (host) | **stops at the vendor gate**: *"no working archon CLI found"*. `core-modules/archon` is populated by `./setup.sh`, which also needs `uv`, and the build's coding step is Codex. `python3 factory/doctor.py` reports the same: *not cloned: omniroute, archon, ai-software-factory* |
| `make docker-app` (inside Olympus's own image) | **manufactures the app**: five gates cleared by hand and one model choice made on the gateway — see §5.2 — after which the DAG runs `[load]` → `[plan]` → `[build]` → `[verify]` → `[record]` and writes an eight-file application whose own tests pass (§5.3) |

So the handoff is verified end to end: Genie's export, the factory's plan, and —
inside the container — the built application, tests and all. Three notes for
whoever closes it:

- **`AGENT_FACTORY_DIR` is the `build-requests/` directory *inside* the checkout,
  not the checkout itself.** Pointed at the root, the export writes
  `<checkout>/<slug>.md` — and the spec's own next steps then tell the operator it
  belongs in `build-requests/`, which is the right hint but not the right outcome.
- **An application spec needs the model step.** `package-app.py` and
  `package-website.py` own the scaffold and the packaging, but the app-specific
  files (`server/schema.sql`, `src/App.tsx`) are written by the builder — Archon +
  Codex today. Nothing in Genie can stand in for that, which is exactly the §6 rule
  about not growing a second builder.
- ~~**Tenancy attributes and gates; it does not partition.**~~ **Closed.** The disk
  is keyed on the same account now: a request enters its account's scope once
  (`src/scope.ts`, entered in `server.ts` before routing) and the path jail, the
  session store, the snapshot store, the ripgrep root, the container mount and the
  factory export all resolve inside it. §4.2's *"key the session library on the
  control-plane user id"* is done; the layout and the id sanitizing are in
  `docs/operations.md` under *Two accounts, two workspaces*.

### 5.2 The container, `make docker-app` (29 Sep 2026)

`docker compose up -d olympus`, the Archon CLI installed, and then
`make docker-app SPEC=build-requests/pomodoro-timer.md REPLACE=1`, watching each
refusal rather than guessing at it. Five gates stand between the documented
workflow and a run, and four of them are runtime state the image does not carry:

| Gate | What it says | What clears it |
| --- | --- | --- |
| Nested-container user namespaces | The build node: `bwrap: No permissions to create a new namespace`; Codex then exits 0 having written nothing, three times, and the node reports *"all agent attempts produced no project files"* | `security_opt: [seccomp=unconfined]` on the service. Docker's default profile refuses `clone(CLONE_NEWUSER)` — `unshare -U true` fails with `Operation not permitted` in a plain container and succeeds with the profile off. Olympus's own `scripts/install-build-runner.sh` describes this class of host, and it is right that the answer is not "run the agent unsandboxed" |
| The `archon` CLI | *"no working archon CLI found. Tried: /app/core-modules/archon/bin/archon"*. `core-modules/` is deliberately empty in git, and the image does not populate it | Clone the mirror into the build context (or into `/app/core-modules/archon`). Note `bin/archon` does not exist anywhere in the upstream tree at the pinned SHA `0add058` — what the workflow actually runs here is the released binary from `https://archon.diy/install` (`archon-linux-x64`, v0.11.1) |
| `uv` | *"the 'uv' runtime is missing, and every archon-greenfield node needs it"* | `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh` |
| A git repository | *"Error: Not in a git repository. The Archon CLI must be run from within a git repository."* `.dockerignore` excludes `.git`, so `/app` is not one | `git init` in `/app` plus one baseline commit |
| `.archon/config.yaml` | *"Invalid assistants config in '/app/.archon/config.yaml': 'assistants.codex.apiBaseUrl': unknown provider setting"* | **A finding about Olympus, not about the container.** The committed config writes `apiBaseUrl` and `defaultModel` for both assistants, and the engine's codex run-config schema (`packages/providers/src/codex/config.ts` at the pinned SHA) accepts `model`, `modelReasoningEffort`, `webSearchMode`, `additionalDirectories`, `codexBinaryPath` — nothing else. Removing `apiBaseUrl` and renaming `defaultModel` → `model` lets the source capture and the DAG start, and costs the gateway nothing: `build-app.py` writes the run's own `CODEX_HOME` config from `OMNIROUTE_BASE_URL`/`OMNIROUTE_API_KEY`. As committed, a checkout cannot run its own workflow on the engine it pins |
| The gateway's tool-capable pool | `[plan] Failed` — *"the gateway refused the planning turn"*, `HTTP 429` then `HTTP 502`, over two attempts | **Nothing in either repository**, and cleared on 29 Sep 2026 by choosing a model rather than by waiting. This was upstream, on the shared gateway. The workflow needs a model that both answers and tool-calls, and probing the catalog at the time of writing found none: `auto/coding` → `503 Maximum combo retry limit reached`; `auto/coding:free` → `400 No target in combo auto/coding:free supports tool calling; request carried 1 tools`; `auto/coding:reliable` → `429 Rate limit exceeded: free-models-per-day`; the pool's own diagnostics name an expired stealth model (`404`) and an exhausted budget pool (`402`). `OMNIROUTE_MODEL` pins the choice, and the *choice* is what matters more than *when*: `scripts/build-model-check.py --model <m>` is the repo's own gate for it — it asks the model to call a tool and then to carry the same conversation to a second turn. `gemini/gemini-3.1-flash-lite` passes it (`turn 1 {"command":"echo \"ok\" > probe.txt"}; turn 2 {"command":"ls -la probe.txt"}`) and carries a build; `auto/coding` was still refusing at the time, and the flash-preview pair sat on a 60-second credential cooldown (`429 model_cooldown`) rather than being unusable |

One further line, seen and harmless: Archon's title generator logs *"Claude Code
SDK does not support bypassPermissions when running as root (UID 0)"*, then falls
back — the conversation title is cosmetic and the workflow proceeds. `IS_SANDBOX=1`
silences it.

So the container is proven end to end, and the application it produced is real:
see §5.3. The sixth gate was never something a change in either repository could
close — but it was not the transient outage it looked like either, and the part of
it that *is* addressable is the same part as always: which model the gateway will
serve, checked rather than assumed.

Nothing in the stack doc's §4–§6 (one OmniRoute, one identity, one secrets store)
changes. The front-door retirement in its §4.3 moves from Studio to the bolt.diy
forks alone.

### 5.3 What came out (29 Sep 2026)

`OMNIROUTE_MODEL=gemini/gemini-3.1-flash-lite make docker-app
SPEC=build-requests/pomodoro-timer.md REPLACE=1` — with the spec Genie exported in
§5.1 as the input, which is what makes this the end of the line rather than a
second experiment:

| Node | Result |
| --- | --- |
| `[load]` | `Completed (100ms)` — the spec resolves to `builds/pomodoro-timer` |
| `[plan]` | `Completed (1m22s)` |
| `[build]` | `Completed (3m7s)`, after two retries. Codex exits `1` on the pinned model and on the fallback (`429 Too Many Requests`), then the third attempt exits `0`. Nothing was written on the two that failed — the box the workflow draws around the model step, working |
| `[verify]` | `Completed (122ms)` — `structural`: no declared command was runnable *there* |
| `[record]` | `Completed (92ms)` — `8 files, 10143 bytes`, entry `index.html` |

Eight files, no dependencies: `index.html` (accessible markup; the clock carries
`role="timer"`), `app.js` (DOM wiring, `localStorage`), `timer.js` (the pure logic —
presets, `advance`, `nextPreset`, `summarise`), `test/timer.test.js`, `package.json`
(`test: node --test`), a `README.md`, and a `MANIFEST.json` recording the **spec's
SHA-256** beside the workflow, the model and the agent's exit code — so the
provenance of a build is a file it carries, not a log.

Its declared criteria — the `npm install` / `npm test` pair Genie's export took from
the app's own `package.json` — hold where the app actually lives: `node --test`
inside the container is **5/5 passing**.

**Two facts about the paths, both worth knowing before packaging.**

- **`builds/` is a named volume, not a bind mount** (`olympus-builds:/app/builds`).
  The manufactured application therefore lives in the container's volume, while the
  host's `./builds` still holds only the `plan.json` the host-side
  `scripts/project_plan.py` wrote. Anything that reads `./builds` on the host —
  `make app-package` among them — sees the plan and not the app. This is also why
  §5.1's `plan.json` and §5.3's application look like two builds of one spec: they
  are the same build, in two filesystems.
- **The model choice is a deployment fact, not a constant.** The spec is portable
  and the plan is portable; the one input that is not is which model the gateway
  will serve at build time. `scripts/build-model-check.py` exists for exactly that
  question — run it before a build rather than reading a code out of a failed one.

### 5.4 The artifact, packaged and running (29 Sep 2026)

The manufactured application then went through Olympus's *other* half — the
packaging and runtime path — which answers a different question from the builder's:
not "did the model write an app" but "is it running".

| Step | Result |
| --- | --- |
| `builds/<slug>` read from the checkout | **Not there.** The run had just reported `8 files, 10143 bytes`, and `app-package` answered *"no build at builds/pomodoro-timer"*: `builds/` is a named volume (`olympus-builds:/app/builds`) and every packaging target reads `./builds/<slug>` on the host |
| `docker compose cp` the tree out of the volume | The app, its `MANIFEST.json` and its `plan.json` in the checkout — and `node --test` in it is **5/5 passing**, so the verification travels with the artifact |
| `package-app.py pomodoro-timer --check` | Refused: *"src/App.tsx is missing or empty"*. That is Studio's React packager; a plan-bearing build does not use it |
| `make app-up SLUG=pomodoro-timer` | Picked `package-project.py` (the plan-bearing packager), wrote the Dockerfile **from `plan.json`**, built `olympus-app-pomodoro-timer:latest`, wrote `project.manifest.json` and `project.zip`, started the container — and then **died six times on its health check**: `sh: python3: not found` |
| The same artifact, with the plan corrected to `static` | **Packaged and running**: healthy, loopback-only on `127.0.0.1:21400`, serving the app (`<title>Pomodoro Timer</title>`, `role="timer"`), and listed by `make apps-list` at `https://pomodoro-timer.studio.olympus.innotel.us` |

Four findings, all in Olympus, all reached from this handoff — written up with the
patch in `docs/olympus-upstream.md`:

1. **A plan can name a `run.start` its own runtime image cannot execute.** The plan
   said `runtime.language: node` with `install: npm install`, so the packager built
   `node:24-alpine` — an image where `python3` exists in the *build* stage (installed
   for native modules) and the published stage is a fresh base plus `COPY
   --from=build`. The model's own `npm start` shells out to `python3`. Nothing in
   packaging reads the project (deliberately), and nothing runs the start command
   until a person asks for the app, so the failure arrives as six health-check
   attempts and one line that names neither the plan nor the image. With the plan
   corrected — `static`, which is nginx serving files, `start` deliberately not run —
   the same artifact packaged and ran. Note that `static` is refused *together with*
   an install or build command, so the plan has to be consistent, not relabelled.
2. **`builds/` is a named volume and every reader of it is on the host**, which is
   the whole of finding 1's setup step: a run that reports success looks like it
   produced nothing one command later.
3. **`REPLACE=1` is destructive before the risky step.** A rebuild deletes the
   previous `builds/<slug>` before the plan node runs, so a plan turn the gateway
   refuses costs the last artifact — measured, at cost: the working app was gone
   after one failed re-plan, and it left an empty directory that still *looks* like a
   build to anything that only checks for the directory.
4. **A built image cannot stand in for the build directory.** The packager's
   generated `.dockerignore` excludes `plan.json` and `project.manifest.json`, so
   recovering the app from its own image gets the files and not the plan — which is
   what `app-runtime.py` reads to decide how to run it.

## 6. Risks, stated rather than worked around

- **A second builder appearing by accident.** The failure mode of this plan is Genie
  growing its own packaging step because one was convenient. The rule to hold: Genie
  never learns to build an image, and Olympus never grows a console.
- **The gateway address is not settled.** The convergence doc names the one gateway
  at one address; Olympus's own README names another, and this repository's template
  named a third. "One OmniRoute" is the doc's core thesis, so this is a prerequisite
  for Phase 1, not a detail — and whatever the answer is, the address belongs in a
  deployment's environment, never in a repo file.
- **Auth is a breaking change for direct API clients.** A deployment that drives the
  endpoint with a bearer and `AGENT_APPROVAL=off` is the case that notices.
- **Studio has behaviour worth keeping** — entitlements, the build queue, the
  archive, the admin panel. The plan retires the *interface*, not those behaviours;
  each is either re-exposed through Genie's UI or kept server-side in Olympus.
- **Who owns the builder API contract.** *Settled during Phase 2, and it was
  already settled in the code.* Olympus publishes the contract and always has: a
  build request is a Markdown file whose headings mirror
  `factory/APP_SPEC_TEMPLATE.md`, consumed by `make app SPEC=…` and by
  `.github/workflows/olympus-app-builder.yml`. Studio's
  `web/studio/lib/factory-spec.ts` was already the client half of it. So no new
  API is needed and no owner has to be negotiated — Genie implements the same
  contract, which is also why the handoff can be deterministic: it is writing a
  document to a published shape, not calling an unpublished service.

## 7. Open questions

1. ~~Does the builder API become a documented interface of Olympus, or a service in
   front of it?~~ **Answered by Olympus's own layout: the interface is the
   `build-requests/` spec, it is documented, and it needs no service in front of
   it.** What is still open is the rest of Phase 2 — preview and publish — where an
   API that does not exist yet would be needed, and which therefore still needs an
   owner.
2. Does Genie stay in the OnTrak family (CodeOps) or move beside Olympus once it is
   the family's builder surface? Phase 0 assumes it stays.
3. Is the TUI's role affected? The doc defines it as *"queues and watches"*; Genie
   watching means the TUI's reason to exist narrows, which is a question for the
   TUI's owner rather than an assumption here.
