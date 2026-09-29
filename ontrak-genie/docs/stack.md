# OnTrak Genie — Platform Stack Role

**Classification: CodeOps**

**Role: the browser console for a coding agent — an agent's work made visible and
gated, in one workspace, on the operator's own machine.**

Genie drives a coding agent over a sandboxed workspace and shows what it does while
it does it: the tool calls as they are decided, the file being written while it is
still being written, and a diff of the change against what is on disk before the
write lands. It declares its role here so the ecosystem definition lives in one
place — the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
owns the stack; this page says what Genie owns, provides, consumes, and explicitly
does not.

## Owns

- The agent loop — request, tool call, result, streamed to the browser over SSE, including the partial tool call rendered as it arrives.
- The workspace jail — one directory is reachable, escapes and absolute paths are refused, and generated/third-party trees are skipped.
- The tool set — `read`, `edit`, `write`, `list`, `search`, `run`.
- The approval gate — a browser decision for commands and writes over a line threshold, with deny that ends the turn rather than stalling it.
- Live visibility — the file being written, highlighted, beside a live diff against the on-disk baseline; a changed-marker tree; a diff view for any file with snapshot history.
- Persistence — sessions, transcripts and per-file snapshots under one data directory, restored across restarts.
- Model resilience — the fallback chain, the chain-health probe, the catalog sweep, and an optional second gateway tried only after the chain is exhausted.
- **Per-turn attribution and quota** — whose account a turn belongs to, whether it may spend, and what it cost (`src/tenancy.ts`). The account's gateway key is resolved and spent server-side; the browser never sees it. The **disk follows the same account**: its workspace, chats and file history live under `accounts/<account>/` (`src/scope.ts`), so two people on one deployment are not just billed separately, they cannot read each other's files.

## Provides

- The one browser surface that shows an agent's *work* rather than its output — the counterpart, in a browser, of a terminal agent session.
- The browser face of the model-health checks the stack otherwise runs as CLI scripts: whether a configured model can still call a tool, and which catalog ids actually can, are questions this answers with a panel instead of a command someone has to know to run.
- A human-in-the-loop gate for command execution, complementary to the server-side protected-path enforcement the factory applies.
- The browser half of the factory handoff: a workspace becomes an Olympus build request (`build-requests/<slug>.md`), assembled deterministically from the file set with no second model call, so the spec can be read and edited before anything is manufactured.

## Consumes

- **OmniRoute** — model gateway. Genie holds no provider credentials and speaks only the OpenAI-compatible API; the gateway's address arrives from the deployment environment. *Wired:* with Distro's control plane configured, a turn spends the **account's own** gateway key rather than the one in `.env`, which is what makes per-account quota and usage real.
- **Distro** (BuilderOps) — the control plane, consumed as Studio consumes it: the same `/api/internal/identity`, `/quota-check`, `/usage-report` and `/audit` contract, so one plane serves both surfaces. *Wired, and off until a URL and a service token are set.* The key posture is deliberate — strict (no account, no turn), fail-open on the quota read, and best-effort on the ledger — and the account's key never reaches the browser.
- **Authentik** (Cerulean) — identity, SSO. Wired: the authorization code flow with PKCE, RS256 `id_token` verification against the provider's JWKS, and a signed session cookie. Off until the issuer, the client id and the session secret are configured; the shared bearer remains for API clients that drive the endpoint directly.
- **Cerulean Vault** — secrets. *Planned:* a `vault://` reference resolved at deploy time, in place of a `.env` value.
- **Cerulean** — trust (DNS/TLS) and **NPM Edge** — public routing, for the operator surface where it is exposed. *Planned.*
- **Olympus** (FactoryOps) — the builder engine. See [convergence-olympus.md](convergence-olympus.md): the target is Genie's interface over Olympus's plan → runner → package → runtime path. Wired at the *handoff* today: Genie writes a build request in the shape `factory/APP_SPEC_TEMPLATE.md` defines, and Olympus manufactures it. The export is deliberately one-directional — Genie learns whether a spec was written, never how a build is going, because a console that polls the factory quickly becomes a second factory.

## Explicitly does NOT own

- Identity (Authentik), secrets (Cerulean Vault), trust/DNS/TLS (Cerulean), storage (ONYX), or revenue (Magnate) — Genie integrates with these instead of re-implementing them.
- Application packaging, publication and runtime — that is Olympus's builder, and Genie does not grow a second one. It produces the *request*; Olympus produces the build.
- Model routing policy — the gateway decides which provider answers; Genie only chooses which model id to ask for and reports what came back.

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| `src/agent.ts` | TypeScript | The turn loop: chain selection, retry re-walk, tool dispatch, event emission |
| `src/tools.ts` | TypeScript | `read`, `edit`, `write`, `list`, `search`, `run` — each jailed to the workspace |
| `src/workspace.ts` | TypeScript | Path resolution and the jail; refuses absolute paths and escapes |
| `src/approval.ts` | TypeScript | The gate: blocks a call until the browser answers, times out closed |
| `src/diff.ts` | TypeScript (LCS) | The diff engine behind both the history view and the live change column |
| `src/server.ts` | Node HTTP | UI + JSON API + SSE stream; static assets served from `public/` |
| `src/snapshots.ts` | TypeScript | Per-file snapshots, so a change can be shown against what it replaced |
| `src/builder.ts` | TypeScript | Assembles an Olympus build request from a workspace; the only place this console hands work to another system |
| `src/controlplane.ts` | TypeScript | Distro's control-plane contract: identity, quota, usage, audit. The same endpoints Studio calls |
| `src/tenancy.ts` | TypeScript | The per-turn gate: which account pays, whether it may spend, and what gets recorded |
| `src/scope.ts` | TypeScript | The account's slice of disk: the one answer to "where is the workspace", read by the path jail, the stores, the sandbox mount and the export |
| `public/` | Vanilla JS + CSS | The console: transcript, tool cards, preview pane, live diff, sweep panel |
| `web/landing/` | Static HTML + vendored Unity theme | This product's landing page — published at `/ontrak-genie/` under the family's GitHub Pages site, alongside the root landing |
| `scripts/` | Node ESM | The check commands — UI smoke, draft, offline, model sweep |
| `sandbox/` | Dockerfile | The image `run_command` executes in when sandboxing is available |

## In the family

OnTrak Genie is the **CodeOps** member of the [OnTrak](../README.md) family's
[Innotel Labs](../INNOTEL-LABS.md) line, alongside Training (TrainingOps), Tix
(the service desk), Sentinel (identity and intrusion) and Sync (Network updates).
It shares the family's license posture and its identity layer, and it is the one
member whose subject is the toolchain rather than the desk.
