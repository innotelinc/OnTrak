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
| **2** | The builder API: Genie's UI over Olympus's plan → build → preview path; control-plane tenancy | Phase 1 |
| **3** | Studio's interface retires; the front-door count reaches one | Phase 2 |
| **4** | Docs converge: the stack doc's §3 updated from *chosen A* to *A′ — A's engine, B's client*, Olympus's README and `docs/stack.md`, and the family table | Phase 3 |

Nothing in the stack doc's §4–§6 (one OmniRoute, one identity, one secrets store)
changes. The front-door retirement in its §4.3 moves from Studio to the bolt.diy
forks alone.

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
- **Who owns the builder API contract.** Genie and Olympus end up coupled by an API
  that neither currently publishes. That contract needs an owner before Phase 2.

## 7. Open questions

1. Does the builder API become a documented interface of Olympus, or a service in
   front of it?
2. Does Genie stay in the OnTrak family (CodeOps) or move beside Olympus once it is
   the family's builder surface? Phase 0 assumes it stays.
3. Is the TUI's role affected? The doc defines it as *"queues and watches"*; Genie
   watching means the TUI's reason to exist narrows, which is a question for the
   TUI's owner rather than an assumption here.
