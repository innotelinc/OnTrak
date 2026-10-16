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
genie projects              # saved projects: list, save, open, export, import
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
| `/projects [list\|new\|open\|rename\|remove\|export\|import]` | Saved projects — see §4. Names, `--out` and `--files` are read from the line |
| `/remote [list\|ssh\|disconnect\|atlas\|new\|clone\|run\|push\|pr]` | A folder on another machine, GitHub, or Atlas — see §5. The flags are read from the line |
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

## 4. Projects

A **project** is a named directory in the deployment's sandbox: the thing you come
back to. A **bundle** is one project as a single portable file — its name, its
note and every file inside it, text kept as text and anything binary carried as
base64, so it is a document you can read, diff and keep in version control rather
than an archive you have to unpack to inspect.

Both are the console's, and this is the same pair over the same routes. What the
CLI adds is the case a browser cannot serve: exporting from the shell, and moving
a project between two deployments.

```bash
genie projects                            # list them, and which one is open
genie projects new "Checkout refactor"    # save one, and work in it
genie projects open 2                     # make row 2 the working directory
genie projects export --out keep.json     # the open project, as one file
genie projects import keep.json           # load it back as a new project
genie projects rename 1 "Checkout v2"     # rename one
genie projects remove 3                   # forget it (its folder stays)
genie projects remove 3 --files           # …and delete the folder too
```

**A project is named by its row, its name, or its id.** The row numbers are the
ones `genie projects` just printed — the same bargain `/resume` makes with a chat
— and the name is matched case-insensitively, because the name is the thing you
remember. Used with no name at all, `genie projects export` means *the open
project*, which is the case you are in when you think "let me keep this".

**Opening a project is a saved choice, not a second mechanism.** It sets the
account's working directory, exactly as the console's folder picker does, so the
agent, the file tree, the preview and the publish flow all follow it without
knowing the command exists. `new` and `import` open what they make, as the
console's do.

**The entry and the folder are separate decisions**, which is why they are
separate spellings: `remove` unlists and leaves the work exactly where it is,
and `remove --files` deletes the directory as well. The reading `remove` gets by
default is the one that cannot lose anything.

**A bundle streams when you want it to.** `--out -` puts the bundle itself on
stdout and the sentence about it on stderr, so a redirect writes the file and
nothing else; `import -` reads a bundle from stdin. One deployment can be piped
into another with no temporary file:

```bash
genie projects export -o - | ssh other-host genie projects import -
```

**A bundle is checked where it lands.** Every path in it is re-validated against
the sandbox file by file, a name already in use gets a count rather than
overwriting anything, and a file that is not a bundle is refused with what was
wrong with it — `400` with the reason, which the CLI prints and exits `1` on. The
heavy directories the console already ignores (`.git`, `node_modules`, build
output) are left out by the same rule, and an export that leaves anything behind
**says so** (`skipped`) rather than quietly shipping less than you asked for.

The verbs and their flags, in full:

| Command | What it does |
| --- | --- |
| `genie projects` | List them, newest-opened first, with the open one marked |
| `genie projects new "<name>"` | Save a new project and work in it |
| `genie projects open <which>` | Make one the account's working directory |
| `genie projects export [which] [--out <file>]` | Write it as one portable file |
| `genie projects import <file>` | Load a bundle as a new project (`-` is stdin) |
| `genie projects rename <which> "<name>"` | Rename one |
| `genie projects remove <which> [--files]` | Forget one; `--files` deletes its folder too |

`--json` prints the server's own payload instead of a sentence, where it applies —
including the project the server made, which is how a script learns the directory.

## 5. Remote workspaces

A **remote folder** is a directory on another machine, mounted over SSH and made
the working directory — so every tool, the diff, the preview and the publish flow
reach it without knowing it is remote. A **GitHub repository** is cloned with your
own token into the working directory and edited in place. **Atlas** is the
ecosystem's Gitea forge, offered as an add-on.

All three are the console's, over the same routes, and the credentials are the
same ones: held by the server for your session, never written into the workspace,
and never taken from a command line here.

```bash
genie remote                              # what is connected, and where Atlas is
genie remote ssh deploy@git.example.com:/srv/app --key-file ~/.ssh/id_ed25519
printf '%s' "$PASS" | genie remote ssh root@192.168.1.90:/srv/app --password-stdin
genie remote disconnect 1                 # a row number, a label, or an id
genie remote atlas                        # this deployment's own Atlas credential
genie remote new "my-project"             # create it on the forge, clone it, work in it
genie remote clone innotelinc/atlas       # --github for GitHub, --token-stdin for a token
genie remote run                          # run the project here (--command to say it yourself)
genie remote push genie/fix-the-thing
genie remote pr genie/fix-the-thing "Fix the thing" --branch main
```

**A secret is never an argument here.** `--key-file` names a file, and
`--password-stdin` / `--token-stdin` read a pipe, so neither lands in a shell
history or in `ps` — on a shared machine that is the difference between a tool
and a habit. `--password <value>` exists for a throwaway host and is the spelling
to avoid. A key is a *file* because that is what it is everywhere else.

**The target is spelled the way ssh spells it** — `user@host:/absolute/path` — and
the port is `--port`, never folded into the target: `host:2222:/path` is a shape
ssh accepts and a person does not mean. The halves are checked by the server
exactly as the console's fields are, so nothing here is a second, weaker parser.

**`genie remote atlas` needs no secret at all.** It connects with the credential
the deployment already holds for its own forge, which is the system path and is not
gated on a plan; anyone else's credential is checked against the Atlas plan first,
so a refusal reads as an add-on with somewhere to subscribe rather than as a
failure to sign in.

**`genie remote run` is the half that makes the rest usable.** It starts the
project in the working directory — which is where a repository created or cloned
from the forge was just put — through the same route the console's preview pane
uses, so what runs here is what the pane would show. No command means the server
works one out (`npm run dev`, `manage.py`, a static site); `--command` says it
yourself; `--json` prints the status the pane reads. The server owns the process
and the port, so this returns rather than holding the terminal.

Anything Gitea works here, not only Atlas: `genie remote` talks to whatever
`http(s)` address it is given, and the API calls follow that address.

## 6. Skills

A skill is a markdown playbook with a name and a description, loaded from

- `~/.config/ontrak-genie/skills/`,
- `$ONTRAK_GENIE_SKILLS` (or `skillsDir` in the config),
- `./.genie/skills/` — project-local, and it shadows a personal skill of the
  same name,
- `<AGENT_DATA_DIR>/skills/` — the deployment's own, read when this process is a
  deployment's (it is the directory the console reads, so a skill added inside
  the container is one every chat there is offered).

```markdown
---
name: release-check
description: Verify a release before tagging it
---
Run the test suite, then the typecheck, then check the changelog …
```

With no front matter the file name is the name and the first non-empty line is
the description, so a directory of plain markdown still works.

**A skill may also be a directory**: `<skills>/impeccable/SKILL.md` plus whatever
it refers to — `reference/*.md`, templates, scripts. The playbook's body is what
is used; the rest is on disk for the agent to read, and the composed message says
where that directory is. A skill written as `description: >` (a YAML block scalar)
is read as its text, not as `>`.

`/skill release-check check v0.3` composes the playbook and the task into **one
message**, fenced so the model can tell the instruction from the request, with
the task last. There is no hidden system prompt: what was sent is what `/last`
shows.

### Installing one

```bash
genie skills add pbakaus/impeccable              # a github.com repository, or owner/repo
genie skills add awesome-skills/code-review-skill --name review
genie skills add acme/skills --path audit        # a repository that holds several
genie skills add acme/skills --ref v2 --project  # a tag, and install into ./.genie/skills
genie skills remove audit
```

The repository's own layout is worked out rather than required: `SKILL.md` at the
root, `skills/<name>/SKILL.md`, or one markdown playbook on its own — and a
repository that publishes the same skill for a dozen providers installs **once**,
from the canonical copy. A repository that holds several *different* skills is
refused until `--path` says which, and the other names are printed.

`GITHUB_TOKEN` is read from the environment (or `--token`, or the deployment's
`AGENT_GIT_TOKEN`) — a private repository needs one, and GitHub's hourly limit for
anonymous callers is low enough that installing a handful of skills runs into it.

What is installed is what the **console** sees too: the same directories are read
by the server, per account (`§5` of [operations.md](operations.md)). In a
deployment (`AGENT_DATA_DIR` set) `add` writes into the deployment's own skills
directory rather than into a home directory the console never reads; on a laptop it
writes into the person's own, which is the first directory the CLI reads back.
`genie skills list` prints the directories it looked in, so where a skill landed is
never a guess. Nothing is executed by an install — a skill is text this program
reads.

## 7. Scripting

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

## 8. Flags

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
| `--out <file>` | Where `genie projects export` writes its bundle. `-` is stdout |
| `--files` | With `genie projects remove`: delete the project's folder as well |
| `--json` | Machine-readable output where it applies |
| `--no-color` | Plain output. `NO_COLOR` and a non-TTY pipe do the same |

`--out` and `--files` are also read from the words of a `/projects …` line, since
a REPL command has no separate argv to take them from.

Resolution order for the address and the credential is **flag → environment →
config → default** (`http://127.0.0.1:3400`). The environment names are
`ONTRAK_GENIE_URL`, `ONTRAK_GENIE_TOKEN`, `ONTRAK_GENIE_COOKIE`,
`ONTRAK_GENIE_CONFIG` and `ONTRAK_GENIE_SKILLS`.

## 9. What the CLI consumes

| Endpoint | Used for |
| --- | --- |
| `GET /api/auth/status` | Whether sign-in is on, and verifying a credential |
| `GET /api/auth/cli?port=` | The loopback handoff (see §2) |
| `GET /api/health`, `/api/models`, `/api/account/usage` | The banner, `whoami`, `usage` |
| `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id` | Listing, resuming, naming, archiving, deleting |
| `POST /api/chat` | The turn, as SSE |
| `GET /api/approvals`, `POST /api/approvals/:id` | The gate |
| `GET /api/shares`, `POST /api/sessions/:id/share` | Sharing (the API is available to the CLI; no command wraps it yet) |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `POST /api/projects/:id/open` | Projects: listing, saving, renaming, forgetting, opening |
| `GET /api/projects/:id/export`, `POST /api/projects/import` | A project as one portable file, and back |

## 10. Building and running from source

```bash
npm install
npm run build          # tsc → dist/, including dist/cli/main.js
npm run cli -- --help  # or: node dist/cli/main.js
```

The package declares `bin: { "genie": "dist/cli/main.js" }`, so installing it
puts `genie` on the path. There are **no runtime dependencies** — the same rule
the console follows — which is why the SSE parser, the argument parser and the
renderer are all in this repository rather than in a package.
