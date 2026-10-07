# Genie CLI

**`genie` — the console, in a terminal.**

The browser console shows an agent's work while it happens. The CLI is the same
promise without the browser: it drives the **same server**, over the **same API**,
and renders what the server decides. It is a client, not a second agent — the
turn, the tool dispatch, the workspace jail and the approval gate all stay on the
server, and the CLI shows them and answers the gate when it opens.

```bash
genie login                 # sign in (browser-assisted)
genie                       # chat
genie ask "run the tests"   # one turn and exit
genie sessions              # list chats
genie --help                # everything else
```

---

## 1. Why it exists, and what it is not

The server was built to be driven by something that is not a tab — `GET
/api/approvals` says so in as many words, and `scripts/approvals.mjs` was the
first, narrow consumer of that. The CLI is the whole of it.

| Not this | Why | Instead |
| --- | --- | --- |
| A second agent | Two loops drift; the jail, the gate and the audit trail are the server's | The CLI sends `message` and renders the stream |
| A re-implementation of the tools | The tool set is versioned with the server | It renders `tool_call` / `tool_result` frames |
| A new privilege | A caller who can answer a prompt already could, from the console | It authenticates as a person (OIDC) or a bearer |

Two things are deliberately **not** in the CLI:

- **A model client.** It never holds a provider credential and never talks to a
  gateway. Genie speaks the OpenAI-compatible wire format; the server does that.
- **An offline mode.** With no server there is nothing to drive.

## 2. Signing in

`genie login` runs the deployment's own OIDC sign-in with the answer handed to the
machine that asked for it:

1. the CLI listens on an ephemeral **loopback** port;
2. it opens `<server>/api/auth/cli?port=<n>`, which starts the ordinary
   authorization-code + PKCE flow;
3. the provider returns the browser to the deployment's callback, and — because
   the sign-in was started for a CLI — the deployment redirects to
   `http://127.0.0.1:<n>/#genie_token=<session>`;
4. the CLI's page reads the fragment, posts it to its own listener, and the CLI
   **verifies it against `/api/auth/status` before storing anything**.

The credential travels in the URL **fragment**, which a browser never sends to a
server, so it cannot land in an access log or leak as a `Referer`. The port is
bounded to the loopback range, so a crafted link cannot deliver a freshly minted
session to somebody else's host. `docs/threat-model.md` carries the trust
boundary this sits on.

Two fallbacks exist for a machine where the browser dance is not possible:

```bash
genie login --cookie "<ontrak_genie_session value>"   # paste a signed-in session
genie login --token "<WEB_TOKEN>"                     # the deployment's shared bearer
```

Whatever arrives is checked before it is written to
`~/.config/ontrak-genie/config.json` (mode `0600`), so a credential that does not
work is a message rather than a file that fails on the next command.

## 3. The REPL

A line that starts with `/` is a command to the CLI; a bare number picks a
follow-up the last turn offered; anything else is a task.

| Command | What it does |
| --- | --- |
| `/help` | The list below, drawn from the same table the autocomplete uses |
| `/new` | Start a fresh chat (the current one is kept) |
| `/sessions` | List chats, most recent first, numbered for `/resume` |
| `/resume <id\|number>` | Switch chat and print its stored transcript |
| `/rename`, `/archive`, `/unarchive`, `/delete` | Housekeeping on the current chat |
| `/model [id]`, `/models [filter]` | Show or choose the model; list the catalog |
| `/steps [n]`, `/offline [on\|off]` | Per-chat step budget and offline-gateway opt-out |
| `/pending`, `/approve [id]`, `/deny [id]` | Answer a gate that opened on another turn |
| `/skills`, `/skill <name> [task]` | List and apply skills |
| `/usage`, `/whoami` | The account's usage and ceiling; the server and plan in force |
| `/last` | The message the agent was last asked |
| `/clear`, `/login`, `/logout`, `/quit` | The CLI itself |

**Tab completion** is wired to the same table `/help` is drawn from, so the
palette cannot offer something that does not exist.

### Streaming

The turn renders as it arrives: prose streams line by line, tool calls appear as
cards with their arguments summarized to the field that matters, a result shows
its first useful line and **its diff** when a file changed. Markdown is rendered
just enough to be readable — fenced blocks are framed and dimmed, inline code and
bold are styled — and degrades to plain text when there is no colour.

### The gate

An `approval_request` renders as a box with the summary and the diff, and the
turn parks while it is answered. The prompt is answered through `POST
/api/approvals/:id` — the same route the browser card uses — so the decision is on
the same record (`approvals.jsonl`, with the actor) either way.

**Non-interactively the default is deny.** `genie ask` with no terminal cannot
consent, so a destructive call is refused rather than run; `--yes` is how an
unattended run says it means it.

### Follow-ups

After a turn the CLI offers up to three next steps, derived from what the turn
actually did — a failure outranks a review; a clean change suggests review, tests
and commit. They come from the events, **not** from a second model call: a
suggestion can never invent work the turn did not do, and it costs nothing.

## 4. Skills

A skill is a markdown playbook with a name and a description, loaded from

- `~/.config/ontrak-genie/skills/`,
- `$ONTRAK_GENIE_SKILLS` (or `skillsDir` in the config),
- `./.genie/skills/` — project-local, and it shadows a personal skill of the
  same name.

```markdown
---
name: release-check
description: Verify a release before tagging it
---
Run the test suite, then the typecheck, then check the changelog …
```

With no front matter the file name is the name and the first non-empty line is
the description, so a directory of plain markdown still works.

`/skill release-check check v0.3` composes the playbook and the task into **one
message**, fenced so the model can tell the instruction from the request, with
the task last. There is no hidden system prompt: what was sent is what `/last`
shows.

## 5. Scripting

`genie ask` is the non-interactive shape, and the exit code is the answer:

```bash
genie ask "run the typecheck and fix what fails" --yes   # 0 when the turn completed
genie sessions --json | jq '.[0].id'                     # machine-readable where it applies
```

| Exit | Meaning |
| --- | --- |
| `0` | The turn ran (or the command succeeded) |
| `1` | The turn reported an error, the server refused, or it was unreachable |
| `2` | The command line was wrong — an unknown flag or subcommand |

The server's refusals arrive as the server's own message: an unreachable host, a
`401` with the sign-in hint, a `429` over quota, and a `400` for a bad port are
all distinguished rather than flattened into "failed".

## 6. Flags

| Flag | Meaning |
| --- | --- |
| `--url <origin>` | Deployment to dial. Wins over the environment and the config file |
| `--token <value>` | `WEB_TOKEN` bearer for this run |
| `--cookie <value>` | A session cookie for this run |
| `--model <id>` | Model for this run (remembered on the chat when the plan allows a choice) |
| `--session <id>` | Continue an existing chat |
| `--skill <name>` | Apply a skill to the task |
| `--max-steps <n>` | Step budget |
| `--yes` | Approve gated actions without asking |
| `--json` | Machine-readable output where it applies |
| `--no-color` | Plain output. `NO_COLOR` and a non-TTY pipe do the same |

Resolution order for the address and the credential is **flag → environment →
config → default** (`http://127.0.0.1:3400`). The environment names are
`ONTRAK_GENIE_URL`, `ONTRAK_GENIE_TOKEN`, `ONTRAK_GENIE_COOKIE`,
`ONTRAK_GENIE_CONFIG` and `ONTRAK_GENIE_SKILLS`.

## 7. What the CLI consumes

| Endpoint | Used for |
| --- | --- |
| `GET /api/auth/status` | Whether sign-in is on, and verifying a credential |
| `GET /api/auth/cli?port=` | The loopback handoff (see §2) |
| `GET /api/health`, `/api/models`, `/api/account/usage` | The banner, `whoami`, `usage` |
| `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id` | Listing, resuming, naming, archiving, deleting |
| `POST /api/chat` | The turn, as SSE |
| `GET /api/approvals`, `POST /api/approvals/:id` | The gate |
| `GET /api/shares`, `POST /api/sessions/:id/share` | Sharing (the API is available to the CLI; no command wraps it yet) |

## 8. Building and running from source

```bash
npm install
npm run build          # tsc → dist/, including dist/cli/main.js
npm run cli -- --help  # or: node dist/cli/main.js
```

The package declares `bin: { "genie": "dist/cli/main.js" }`, so installing it
puts `genie` on the path. There are **no runtime dependencies** — the same rule
the console follows — which is why the SSE parser, the argument parser and the
renderer are all in this repository rather than in a package.
