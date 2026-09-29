<div align="center">

# OnTrak Genie

**Watch the agent work — and stop it before it matters.**

**CodeOps · self-hosted · every write is visible while it is written**

[![CI](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/ci.yml)
[![Conformity](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml/badge.svg)](https://github.com/innotelinc/OnTrak/actions/workflows/conform.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/blob/main/standards/unity/README.md)

</div>

---

> **OnTrak Genie** is the **CodeOps** product of the [Innotel Labs](../INNOTEL-LABS.md)
> family and a member of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack):
> the browser console for a coding agent. You state a task; the agent reads, edits
> and runs code inside a workspace it cannot leave; and every call it makes is on
> screen as it happens — including the file it is writing, rendered and diffed
> against what is on disk *before* the write lands. It consumes the platform
> services rather than re-implementing them, and it is deliberately the only
> surface in the family that shows an agent's work rather than its output.
> **Landing page:** [https://innotelinc.github.io/OnTrak/](https://innotelinc.github.io/OnTrak/)

---

## Why Genie

| Problem | Genie answer |
| --- | --- |
| An agent that edits your files is only trustworthy if you can watch it work — but the usual interface shows a spinner, then a finished diff you have to audit afterwards. | Tool calls stream into the transcript as they are decided, and the file being written renders live, character by character, beside a live diff of what is changing. You see the edit before the edit exists. |
| "Is this write safe?" is not a judgement to leave to the model, and not one a prompt can enforce. | An approval gate: `run_command` and any write over a line threshold stop and wait for a click. Deny ends the turn cleanly; the gate is the only thing between a plan and a changed machine. |
| A model that cannot call a tool fails the whole turn — usually after a long wait, and usually without saying why. | A chain-health probe reports `models n/m ready` in the sidebar before you type, a fallback chain absorbs a throttled provider mid-task, and a dead chain is visible rather than discovered. |
| Which model ids actually work is not something a catalog tells you, and a large advertised list is not a usable one. | Sweep the catalog from the browser: probe the ids that claim tool support and keep the ones that answer. |
| A session that cannot be resumed is a session you repeat, and a pane that forgets is a pane you reopen. | Chats, transcripts and per-file snapshots persist across restarts, and the preview pane restores what it was showing across a browser reload. |

## What it is

- **The agent loop** — request → tool call → result, streamed to the browser over Server-Sent Events, with the partial tool call rendered as it is still arriving.
- **A workspace jail** — every read and write resolves inside one directory; absolute paths and `../` escapes are refused, and `.git`, `node_modules` and build output are skipped.
- **The tool set** — `read`, `edit`, `write`, `list`, `search`, `run`, each confined to that workspace.
- **The approval gate** — a browser decision for commands and large writes, with a deny path that ends the turn instead of stalling it.
- **Live visibility** — the file being written, syntax-highlighted, with a live diff against the on-disk baseline; a changed-marker file tree; a diff view for any file with history.
- **Model resilience** — a fallback chain, a chain-health badge, a catalog sweep, and an optional second gateway (a local model, no key) tried only after the chain is exhausted.
- **Sign-in (optional)** — Authentik OIDC: authorization code with PKCE, RS256 `id_token` verification against the provider's JWKS, and a signed session cookie. The shared bearer is kept for API clients that drive the endpoint directly.
- **Persistence** — sessions, transcripts and file snapshots under one data directory.

## Quick start

From source:

```bash
cp .env.example .env          # then set OMNIROUTE_URL to a reachable gateway
npm install
npm run build && npm start    # http://127.0.0.1:3400
```

In Docker:

```bash
cp .env.example .env
docker compose up -d --build
# http://127.0.0.1:3400/?token=<WEB_TOKEN>
```

As part of the family, from the repository root:

```bash
make genie-up                 # serving on :3400
```

A gateway is required and is not shipped here: Genie speaks the OpenAI-compatible
API, so it points at the stack's shared OmniRoute. Its address comes from the
deployment's environment — no internal address is committed, and `.env` is
gitignored.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/operations.md](docs/operations.md) | The full developer reference: HTTP API, SSE events, every environment variable, the check commands, the Docker and sandbox setup. |
| [docs/stack.md](docs/stack.md) | Genie's role in the Innotel Platform Stack — what it owns, provides and consumes, and the service map. |
| [docs/convergence-olympus.md](docs/convergence-olympus.md) | The Genie-first convergence: how this console becomes the family's one web surface over Olympus's builder engine. |

## Repository layout

```
ontrak-genie/
├── src/            # agent loop, tools, workspace jail, HTTP server, diff, snapshots
│   └── test/       # unit + HTTP tests (node --test)
├── public/         # the browser UI: app.js, highlight.js, style.css, index.html
├── scripts/        # check commands: ui-smoke, draft-check, offline-check, model-health
├── sandbox/        # the image run_command executes in
└── docs/           # operations reference, stack role, convergence
```

## Status

Version 0.1.0. The console is complete and the checks pass; what is genuinely
outstanding is stack citizenship, and it is stated rather than implied:

- **Auth** is either a static `WEB_TOKEN` (the API path, and what a laptop with no
  provider uses) or sign-in through Cerulean's Authentik, which is wired and off
  until configured — set the issuer, the client id and the session secret to
  require it. Turning it on also closes the loopback trust the console otherwise
  starts with, so an empty `WEB_TOKEN` stops meaning "no gate".
- **Secrets** are read from `.env`. The platform path is a Cerulean Vault
  `vault://` reference resolved at deploy time.
- **The builder half** — plan → container → published name — is Olympus's, and
  [the convergence doc](docs/convergence-olympus.md) is how the two meet.

## License

MIT — see [../LICENSE](../LICENSE). Genie's model access is through an
OpenAI-compatible gateway; no provider SDK is vendored, and no upstream license
is redistributed here.

---

© 2026 OnTrak Genie — the family's browser agent console. An Innotel Labs product.
[github.com/innotelinc/OnTrak](https://github.com/innotelinc/OnTrak) ·
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
