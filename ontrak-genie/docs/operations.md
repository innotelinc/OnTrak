# Coding Agent

A self-hosted coding agent web app: chat in the browser, and the agent reads,
edits and runs code inside a sandboxed workspace. Model access goes through
[self-hosted OmniRoute](https://github.com/diegosouzapw/OmniRoute), an
OpenAI-compatible gateway that multiplexes many providers behind one endpoint.

```
browser  ──SSE──▶  agent server (Node)  ──OpenAI API──▶  OmniRoute  ──▶  providers
                        │
                        └── tools: read / edit / write / list / search / run
                                    confined to ./workspace
```

## Quick start

```bash
npm install
cp .env.example .env

# 1. start the gateway (pick one)
npm run gateway                       # npx -y omniroute
npm run gateway:docker                # docker run -p 20128:20128 diegosouzapw/omniroute

# 2. connect a provider, or replies will be empty (see the next section)
npm run provider:add -- --name OpenRouter \
  --base-url https://openrouter.ai/api/v1 --api-key sk-or-... --prefix openrouter

# 3. build the locked-down image that run_command executes in (recommended)
npm run sandbox:build

# 4. start the agent
npm run build && npm start            # http://127.0.0.1:3400
```

Before committing anything, `npm run check` runs the typecheck, the build, the
unit suite and the browser smoke test in one command.

### Running it in a container

`docker compose up -d` runs the agent with no Node and no npm on the host. Set
`OMNIROUTE_API_KEY` in `.env` first — compose reads `.env` itself, so there is
nothing to copy around.

Compose passes `.env` in wholesale (`env_file`) and overrides only what must
differ inside a container: the workspace and data paths, and `AGENT_SANDBOX=host`,
because the container is already the boundary and there is no Docker socket in it
to nest into. A hand-maintained list of variables is a list that falls out of
date: this one came up with `AGENT_APPROVAL` at the code's default of `off` while
`.env` said `risky`, silently dropping the approval gate.

- `./workspace` is bind-mounted at `/workspace`, so edits land on the host.
- Sessions live in the named volume `agent-data` at `/data`, so a rebuild does not
  throw away the chats. `docker compose down` keeps it; `down -v` does not.
- The `healthcheck` polls the static shell, which is public by design, so it works
  whether or not `WEB_TOKEN` is set and never makes a restart depend on the LAN
  gateway. `docker compose ps` shows the result.
- `.dockerignore` keeps `.env`, `.git`, `node_modules`, `dist`, `.agent` and
  `workspace` out of the build context, so the image carries no secrets and no
  state.

The gateway is a separate service on purpose: this app only speaks the OpenAI
wire format, so `OMNIROUTE_URL` can point at OmniRoute, another gateway, or a
direct provider with no code changes.

## Model access (read this before wondering why replies are empty)

Out of the box OmniRoute starts with **zero providers connected** — you can check
with `curl -s localhost:20128/api/providers`, which reports
`{"connections":[],"total":0}`. Its `auto` router then falls back to keyless
web providers, and those do not work on every host. On the machine this was
built on, all of them failed:

| Provider                | Failure                                        |
| ----------------------- | ---------------------------------------------- |
| `opencode` (free tier)  | 403 — only usable from inside OpenCode          |
| `cloudflare-playground` | Playwright Chromium not installed               |
| `theoldllm`             | 403 — Vercel blocks this server's egress IP     |
| `duckduckgo-web`        | 418 — anti-abuse rate limit                     |
| `uncloseai`             | 502                                             |
| `auggie`, `zcode`       | 502 — CLI not installed                         |

So expect to connect something. `npm run provider:add` is the short path; two
working examples follow, and the hosted free tier is the one this host runs on.

### Local model via Ollama (verified end-to-end)

No signup, no third party. Install Ollama, pull a tool-capable model, then
register it as a custom OpenAI-compatible provider node:

```bash
ollama serve &
ollama pull qwen2.5-coder:7b

# Point OmniRoute at it. Validate first, then create the node and a connection.
curl -s -X POST localhost:20128/api/provider-nodes/validate \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://127.0.0.1:11434/v1","apiKey":"ollama"}'

NODE=$(curl -s -X POST localhost:20128/api/provider-nodes \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ollama Local","prefix":"local","apiType":"chat","baseUrl":"http://127.0.0.1:11434/v1","apiKey":"ollama"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["node"]["id"])')

curl -s -X POST localhost:20128/api/providers \
  -H 'Content-Type: application/json' \
  -d "{\"provider\":\"$NODE\",\"name\":\"Ollama Local\",\"apiKey\":\"ollama\"}"
```

The model then appears as `local/qwen2.5-coder:7b` in the app's model selector.
Note that provider *nodes* and provider *connections* are separate records —
creating the node alone does not make the models routable.

Small local models usually emit tool calls as **raw JSON text** instead of using
the structured channel. The agent detects and executes those anyway (see
*Text-mode tool calls* below), so they work. Expect sloppy edits from a 7B model
though: on CPU at roughly 5 tok/s it is usable but slow, and it may rewrite more
than you asked.

### A hosted free tier (what this host uses)

Any of **Groq**, **Cerebras**, **Google AI Studio** or **OpenRouter** has a real
free tier and a two-minute signup. `npm run provider:add` wires one up for you:
it validates the key, creates whatever OmniRoute needs, and prints the model ids
that became routable.

```bash
# OpenRouter owns the "openrouter" prefix, so the script detects the built-in
# provider and connects it with just the key.
npm run provider:add -- --name OpenRouter \
  --base-url https://openrouter.ai/api/v1 \
  --api-key sk-or-v1-... --prefix openrouter

# Anything else OpenAI-compatible becomes a custom node + connection.
npm run provider:add -- --name Groq \
  --base-url https://api.groq.com/openai/v1 --api-key gsk_... --prefix groq
```

The same thing by hand is in the OmniRoute dashboard at
<http://127.0.0.1:20128> (Settings → Providers).

Connected to a free OpenRouter key, these four `:free` models all answered with a
structured `tool_call`, which is the only hard requirement:

| Model id                                            | First call |
| --------------------------------------------------- | ---------- |
| `openrouter/cohere/north-mini-code:free`            | 2.4 s      |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | 4.1 s      |
| `openrouter/poolside/laguna-s-2.1:free`             | 6.6 s      |
| `openrouter/qwen/qwen3.8-27b:free`                  | 20.5 s     |

### Picking a model: a big catalog is not a usable catalog

Measured 2026-09-29 against the gateway on this network, which advertises **578
models**. Every row below comes from a real request, not a model card:

| Model id | Structured `tool_call`? | Notes |
| -------- | ----------------------- | ----- |
| `gemini/gemini-3.1-flash-lite` | yes, fast, and always up | **Current default** — the only explicit id that survived the full sweep |
| `gemini/gemini-3-flash-preview` | yes when its credentials are free | Stronger, but cooling down much of the time |
| `gemini/gemini-2.5-flash` | yes when its credentials are free | Second fallback |
| `auto/best-coding` | lottery | Served `gemini-2.5-flash`, `gemini-3-flash-preview` *and* `gemini-3.1-flash-lite` on separate calls |
| the other 37 `auto/*` combos | no | Empty reply, or `400 No target in combo ... supports tool calling` |
| `agentrouter/claude-opus-5`, `claude-opus-4-8`, `gpt-5.6-sol` | no | `credits exhausted` (402) — the one strong explicit provider has no credit left |
| `gemini/gemini-3.7-flash`, `gemini/gemini-2.5-pro`, `gemini/gemini-3.1-pro-preview` | no | Advertised, then `400 not available in the active live catalog` |

**Why the default is pinned instead of a combo.** The same task — write a module,
write its tests, run them, report — was given to each:

| Model | Result |
| ----- | ------ |
| `gemini/gemini-3.1-flash-lite` | **finished**: 6 steps, 21.3 s, no fallback needed, 4 tests pass (re-run independently) |
| `gemini/gemini-3-flash-preview` | finished, but 4 steps in 47.6 s, most of it spent thrashing on 429s |
| `auto/best-coding` | **failed**: 1 step, 12.8 s, zero tool calls, two empty replies, then a hard 400 |

A combo name describes intent, not capability, and OmniRoute will happily accept
one it cannot satisfy. Reliability comes first, because a model that is cooling
down cannot answer however strong it is. That is why the *weaker* model leads
here, with the stronger ones behind it in the chain.

#### Checking instead of guessing

`npm run model:health` asks each candidate to make one real tool call and reports
what came back, because a structured `tool_calls` response is the only hard
requirement the agent loop has:

```bash
npm run model:health                            # 24 models, spread across providers
npm run model:health -- --all --json sweep.json # everything, writing as it goes
npm run model:health -- --model gemini/gemini-3.1-flash-lite --runs 3
```

The default sample is taken round-robin **across providers**, not from the top of
the list: a plain slice is all `auto/*` combos, which is the least informative
sample available. The full sweep of this gateway:

```
Catalog   579 models, 374 claiming tool calling
Probing   374 model(s) across 14 provider(s), 1 run(s) each
...
29/374 can drive the agent (structured tool call).
```

**Twenty-nine of 374 — and 28 of those are `auto/*` combos that all resolve to the
same model.** Excluding the combos, exactly one explicit id works. Per provider:

| Provider | Working / probed |
| -------- | ---------------- |
| `auto` | 28 / 38 (all serving `gemini-3.1-flash-lite`) |
| `gemini` | 1 / 7 |
| `dva`, `openrouter`, `aug`, `tllm`, `cxa`, `cfp`, `no-think`, `agentrouter`, `oc`, `unc`, `pepper`, `gemini-web` | **0 / 340** |

Twelve of fourteen providers answer nothing, for concrete reasons the report
groups and shows: `DEVIN_AGENTIC_HOME must be an absolute path inside the bridge
sandbox` (113 models), `Auggie CLI not found` (28), `The Old LLM is blocked by
Vercel for this server egress IP` (26), `Codex app-server transport is not
configured` (26), `Cloudflare Playground browser session failed: Playwright is not
available` (20). None of those are model problems — they are unconfigured or
unreachable providers, which is why "connect more providers" is not the same as
"get more working models".

**Read a sweep with care.** Probing 374 models is itself a burst, and it cools
down the very credentials it is measuring — two models that work perfectly well on
their own came back as timeouts and 429s during it. That is why the report
separates *broken* from *throttled* and *no answer in time*, and why the models you
actually deploy should be re-checked on their own:

```bash
npm run model:health -- --model gemini/gemini-3.1-flash-lite --runs 3
```

The script exits non-zero when nothing it probed worked, so it is usable as a check.

#### Running a sweep from the UI

The same question can be asked from the browser: the sidebar's `sweep` button
opens a panel with **run sample** (24 models spread across providers — the
informative default) and **run full sweep** (every id claiming tool calling:
slower, and it will rate-limit the providers it measures). It shows live progress
— `probing 11 of 24...` — by polling once a second while a sweep is in flight, and
then reports:

```
2 of 24 can drive the agent (sample sweep, swept 3 h ago).

Usable (2), fastest first — use one without hunting for it in the picker
  [use]  4837 ms  agentrouter/claude-opus-4-8   <- in your chain
  [use]  4983 ms  no-think/agentrouter/claude-opus-4-8

Broken (19) — fix these in the gateway's provider settings
  6 x OmniRoute returned HTTP 400 for /chat/completions: {"error":...
      aihorde/2DN   <- in your chain
      ...and 3 more

Throttled (1) — credentials cooling down - often caused by the sweep itself
```

Working models come first, and the failures are grouped by **reason** with the
affected ids beneath each, because the actionable unit is the provider rather than
the model. Rows already in this chat's chain are marked. `POST /api/models/sweep`
takes `{"all": true|false}` and answers `202` with the initial state, or **`409`**
if a sweep is already running — the slot is claimed before the first `await`, so
impatiently clicking twice cannot start two of them. Nothing runs on its own: an
open panel costs one request when it opens, and polls only while a sweep is in
flight.

The last finished report is written to `AGENT_DATA_DIR/sweep.json` and read back
when the server starts, so a restart — or a container being rebuilt — does not make
the catalog look unexplored again, and a sweep that took minutes is not thrown away
by a `docker compose up -d`. A missing or half-written file is treated as "no
report yet" rather than an error, and a run is never restored as *running*:
nothing is probing after a restart.

Persisting the report created a new way to be misled — an old file that reads as
this morning's — so the status line says when it was taken (`swept 3 h ago`) and
`GET /api/models/sweep` adds a derived `stale` flag, which turns that line amber
past a day. The ids in a catalog rarely change; which of them a rate-limited free
tier will answer for changes constantly, and only the second one matters here. The
flag is computed on the way out rather than stored, so the file on disk keeps its
own shape.

Easier still: every usable row carries a **use** button that points this chat at
that model, and the picker marks each model the last report got a tool call out of
with `✓`. Finding one of 580 ids by hand was the part of a sweep that was still
manual.

#### Checking the chain on a timer

A catalog sweep is an occasional, manual thing. The other question — *is the chain
I actually use still working?* — is asked automatically. `AGENT_HEALTH_INTERVAL_MS`
(default 15 minutes) has the server ask every entry in the chain to make one tool
call, and reports it in the sidebar as `models 3/4 ready`, with a per-model
breakdown in the tooltip:

```
models 2/4 ready
  ok   gemini/gemini-3.1-flash-lite - 6213 ms
  FAIL gemini/gemini-3-flash-preview - OmniRoute returned HTTP 429 ...
  ok   qwen2.5-coder:7b (offline) - 2867 ms
```

Three deliberate limits: only the *chain* is probed, never the catalog (a 374-model
sweep takes minutes and rate-limits the providers it measures); the probes run one
at a time, for the same reason; and the timers are `unref`'d, so a health check can
never keep the process alive. `AGENT_HEALTH_INTERVAL_MS=0` switches it off, and the
row then says so rather than looking like a failure.

The wording is precise on purpose: a model is "ready" only if it actually asks for
the tool, accepted **either** through the structured channel **or** as salvaged JSON
text, because that is how the agent itself judges it. Checking only the structured
channel reported the local Ollama model as broken while it was happily driving
tools — exactly the kind of false alarm that teaches people to ignore a status row.

The last check is also read *before* a turn: if it could not get a tool call out of
anything this chat would use, the turn opens with a notice saying so —
`Heads up: the last model check could not get a tool call out of anything in the
chain (...)` — and points at the sidebar. It **warns rather than refuses**, because
the check is on a timer and its last word can be minutes old, and a refusal based
on a stale reading would be worse than the failed turn. A chat that has opted out of
the offline gateway is told about its own chain, not about a local model it will
never call.

### Falling back when a provider gives up

Free tiers throttle constantly, and the failure is not always an error: OmniRoute
often returns **HTTP 200 with an empty message** when every credential for a model
is cooling down. Either way a turn used to die mid-task.

`AGENT_FALLBACK_MODELS` is an ordered, comma-separated list tried when the chosen
model throttles, errors, or answers with nothing:

```ini
AGENT_MODEL=gemini/gemini-3.1-flash-lite
AGENT_FALLBACK_MODELS=gemini/gemini-3-flash-preview,gemini/gemini-2.5-flash
```

A retry is only attempted while **nothing has reached the browser**, so a reply is
never duplicated mid-stream; once text is on screen the error is reported instead.
Cancelling the request (the Stop button) is never treated as retryable. A gateway
that cannot be reached **is** — otherwise a dead network would stop the chain at
its first link and the offline fallback would never be tried. Each substitution is
announced as a notice, and hovering the model selector lists the chain in order. Verified live: a request to a cooling-down model logged
`gemini/gemini-3-flash-preview returned an empty response; retrying with
auto/coding` and completed on the fallback.

The chain is also **per chat**. The `chain` box in the toolbar overrides it for
one conversation, is saved with the session, and comes back when you reopen it.
Clearing the box means "this model and nothing else" — it is sent as an empty
chain rather than falling back to `AGENT_FALLBACK_MODELS`, and the box only
becomes meaningful once it has been seeded or edited, so a chat opened before
`/api/health` answers cannot silently lose its fallbacks.

There is a second layer, for the case the chain itself cannot solve: when *every*
entry comes back throttled **and** the turn has produced nothing at all (no text,
no tool call), the loop waits and then walks the whole chain again instead of
giving up. `AGENT_RETRY_ATTEMPTS` (default `2`) bounds the re-walks and
`AGENT_RETRY_DELAY_MS` (default `20000`) is the first wait, doubling per attempt up
to a minute — a cooling-down credential is worth outlasting. It is guarded on both
"nothing emitted" and "no tool has run", so a re-walk can never duplicate output or
repeat work, and a cancelled request never triggers one.

### Offline fallback

The chain above still assumes the gateway is up and the internet is reachable.
Neither is guaranteed, and a gateway on your own LAN is no help at all if the
*network* is down, because every provider it aggregates is remote.

`AGENT_OFFLINE_URL` adds a second, fully independent gateway that is tried only
after every model in the list above has failed:

```ini
AGENT_OFFLINE_URL=http://127.0.0.1:11434/v1
AGENT_OFFLINE_MODELS=qwen2.5-coder:7b
```

That is Ollama's OpenAI-compatible endpoint - on this machine, so it needs no
network, no key and no gateway at all:

```bash
ollama pull qwen2.5-coder:7b
```

Two details worth knowing:

- The offline entry is keyed by **URL and model**, so the same model id can appear
  on both gateways without one shadowing the other, and the switch is announced
  (`retrying with qwen2.5-coder:7b on the offline gateway`) rather than silent.
- A 7B model prints its tool calls as **JSON text** instead of using the
  structured channel. That is fine - the agent salvages it (see *Text-mode tool
  calls*), which is why a plain Ollama model can drive tools at all.

When the local model takes over, the UI says so: a red `offline: qwen2.5-coder:7b`
badge appears in the toolbar and stays up, so a silent downgrade to a 7B model
cannot be mistaken for the main model having answered. It is driven by a `gateway`
event the agent emits once per turn and again whenever the gateway changes —
separate from the notice, which scrolls away. The sidebar carries a permanent
`offline:` row too, so you can see whether a fallback exists without opening
`.env`. Verified in a real browser against a deliberately dead main gateway.

The toolbar's `local` checkbox is the escape hatch. Unchecked, this chat will not
use the offline gateway at all, so work where a small model's answer would be worse
than an error fails loudly instead of being quietly answered by a 7B. The choice is
saved on the session (`useOffline`), overridable per turn, and disabled when no
offline gateway is configured.

The fallback is **not** exempt from the approval gate: a local model asks for a
click exactly like a remote one. Leave `AGENT_OFFLINE_URL` empty to disable it.
`GET /api/health` reports the configured offline gateway as `offline`.

### Known dead end: `cloudflare-playground`

Installing Chromium (`playwright install chromium`) gets the browser to launch,
but `page.goto("https://playground.ai.cloudflare.com")` then hangs until timeout
while `curl` fetches the same URL in 0.16s — including with DNS bypassed via
`--host-resolver-rules`, so it is bot management stalling headless automation,
not a resolvable networking fault. Treat this provider as unusable for unattended
agents.

### Text-mode tool calls

OmniRoute multiplexes many providers, and weaker or free models frequently print
`{"name": "read_file", "arguments": {...}}` into the message content rather than
using the structured `tool_calls` field. The agent recognises that shape, only
after checking the name against its real tool list, and executes it as a genuine
tool call. While a reply looks like such a call it is held back rather than
streamed, so raw JSON never flashes into the conversation; if it turns out to be
prose after all, it is released. A small notice marks each salvaged call.

### Choosing a model

Any model that supports **tool calling** will work; without it the agent can chat
but cannot touch files. A probe is the only thing that tells you which of the
advertised ids really do it — **`npm run model:health`** (see *Checking instead of
guessing* above). Advertising the capability is not the same as having it, and
`auto` / `auto/*` describe an intent rather than a guarantee, so they are not a
way around checking.

To filter the catalog by claimed capability yourself:

```bash
curl -s localhost:20128/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    if (m.get('capabilities') or {}).get('tool_calling') and 'text' in (m.get('output_modalities') or []):
        print(m['id'])"
```

If the agent replies "The model returned an empty response", that means the
gateway answered but no provider produced anything — connect one and retry.

## Safety model

The agent is deliberately constrained, because it runs with your privileges:

- **Workspace jail.** Every path is resolved against `AGENT_WORKSPACE` and any
  path that escapes it (via `..` or an absolute path) is rejected, so it cannot
  read or write elsewhere on the host.
- **No privilege escalation.** `sudo`, `doas` and `su -` are refused, along with
  `mkfs`, block-device writes, `shutdown`/`reboot`, recursive forced `rm` of
  paths outside the workspace, `userdel`/`passwd`, `crontab`/`systemctl`, and
  piping a download straight into a shell. Blocked commands come back to the
  model as a refusal, not a crash.
- **Command timeouts.** Every command is killed after `AGENT_COMMAND_TIMEOUT_MS`
  and its whole process group is torn down.
- **Stuck-loop guard.** If the same tool call fails identically three times the
  agent stops with an explanation rather than spending the whole step budget on a
  loop. Weak models wedge like this often; alternating a failing call with a
  harmless read does not reset the counter.
- **Prompt-injection aware.** The system prompt tells the agent not to go hunting
  for credentials or keys outside the workspace, and to say so rather than work
  around a missing permission. That is a mitigation, not a guarantee.
- **UI auth.** Two ways in, and either can be the only one. Set `WEB_TOKEN` and
  every `/api/*` call needs `Authorization: Bearer <token>` (or `?token=`); a
  non-loopback bind without one logs a loud warning on startup. Or configure
  sign-in — `ONTRAK_OIDC_ISSUER`, `ONTRAK_OIDC_CLIENT_ID` and
  `ONTRAK_OIDC_SESSION_SECRET` — and the console sends the browser to Authentik,
  verifies the returned `id_token` against the provider's published keys, and
  keeps the result in a signed cookie. **Configuring sign-in refuses
  unauthenticated calls even when `WEB_TOKEN` is empty**, so switching it on
  cannot leave a published port open by accident.

  **Sign-in on more than one name.** The provider matches the redirect URI byte
  for byte, and the URI is the address the *browser* reaches — so a deployment
  reachable at two names (the family's `genie.ontrak.innotel.us` and the
  platform's `genie.innotel.us`) registers both and lists them in
  `ONTRAK_OIDC_REDIRECT_URL`, comma-separated. The entry whose host matches the
  browser's `Host` header is the one a sign-in starts with, and that choice is
  carried with the state so the token exchange repeats it rather than re-deriving
  it. A name that is not listed falls back to the first entry; a caller that is
  not on a listed name signs in and lands on the first, which is the honest
  answer to "which of this deployment's names was this registered for".

  **Proving it, rather than assuming it.** `scripts/verify-sso.py` drives the whole
  thing against a live deployment: it creates a throwaway Authentik identity,
  completes a real authorization-code flow, and asserts that the API is closed
  without a session, that the authorize URL names this name's callback and this
  client, that the session resolves to a subject, and that signing out ends it. No
  admin token, or a deployment it cannot reach, is a SKIP (exit 2) rather than a
  failure — which is what lets the estate's posture runner call it from any host
  (`ips/scripts/check-sign-in-posture.sh`). The token is read from the environment,
  then this repo's `.env`, then the estate's `cerulean/.env`, so the check never
  needs a credential a deployment of this console would hold.
- **Whose key pays.** With `CONTROL_PLANE_INTERNAL_URL` and
  `CONTROL_INTERNAL_TOKEN` set, a turn is attributed to the signed-in person and
  spends *their* gateway key — and is refused when that account may not spend.
  Without them every turn spends the one `OMNIROUTE_API_KEY` in `.env`, which is
  the single-operator shape this ships as. See *Tenancy* below.
- **Commands run in a container.** See the next section.

Once you expose this beyond localhost, put it behind a reverse proxy with TLS as
well as one of the two gates above. The agent is an autonomous process with shell
access; treat the port accordingly.

## Command sandbox

`run_command` is the tool that can do real damage, so it does not run on the
host by default. `AGENT_SANDBOX=auto` (the default) runs every command inside a
throwaway container:

```
docker run --rm --name agent-cmd-...        \
  --network none                            \   # no network at all
  --read-only --tmpfs /tmp:rw,exec,size=512m \  # immutable root filesystem
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory 2g --memory-swap 2g --cpus 2 \
  -v <workspace>:/workspace -w /workspace   \
  coding-agent-sandbox:latest bash -lc <command>
```

Only the workspace is mounted, so a build script or a model that has been talked
into something unwise cannot reach the rest of the host. Verified on this host:
`curl` to the internet fails with `000` (no network), `touch /nope` fails with
`Read-only file system`, while `python3`, `node`, `git` and `ripgrep` all work.

| `AGENT_SANDBOX` | Behaviour                                                        |
| --------------- | ---------------------------------------------------------------- |
| `auto` *(default)* | Use the container when Docker and the image are available, otherwise run on the host and say so in `/api/health` |
| `docker`        | Refuse to run anything unless it can be containerised             |
| `host`          | Run directly in the agent process — fastest, no isolation         |

Build the image once with `npm run sandbox:build` (Debian slim + Node 22, plus
git, ripgrep, python3, make and a C toolchain; ~450 MB). The UI shows which
backend is active in the sidebar, and a command that outlives its timeout is
force-removed by name rather than left running.

Inside `docker compose` the agent is already containerised, so set
`AGENT_SANDBOX=host` there rather than nesting Docker.

### Networking: why nothing here uses a Docker address

The sandbox runs with `--network none`, so a command inside it has **no network
at all** — no DNS, no `pip install`, no `npm install`. That is deliberate: it is
the difference between a build step and a build step that can also phone home.
If you need package installs inside the sandbox, that is a deliberate trade to
make, not a bug to work around.

The compose service publishes the UI on the host's own address and reaches the
model gateway by its LAN address, because a container on a Compose bridge is only
reachable at `172.17.x.x`. That address is meaningless to every other host on the
network, so anything addressed by service name breaks the moment it leaves the
Compose network.

## Approval gate

Sandboxing stops a command from reaching the host. Approval stops it from running
at all until a human agrees, which is the difference between "contained" and
"intended".

```ini
AGENT_APPROVAL=risky         # off | risky | all
AGENT_APPROVAL_MAX_LINES=120
AGENT_APPROVAL_TIMEOUT_MS=300000
```

| Mode | Asks before |
| ---- | ----------- |
| `off` *(code default)* | nothing — right for scripts driving the API directly |
| `risky` | every `run_command`, plus writes that change more than `AGENT_APPROVAL_MAX_LINES` lines |
| `all` | every tool that changes or executes anything |

Reading tools (`read_file`, `list_dir`, `search_code`) never interrupt, in any
mode. The prompt is computed by `previewTool` **without touching the workspace**,
and `run` recomputes the same plan when it executes, so what you approve and what
runs cannot drift apart. The browser shows a card with the summary and, for a
write, the full diff; **Approve** runs it, **Deny** hands the model a refusal it is
told not to repeat.

The decision comes back through `POST /api/approvals/:id` on a second connection
while the chat stream is parked, so nothing is blocked. A prompt is bound to its
stream's abort signal: closing the tab or pressing Stop releases it immediately
instead of leaving the turn hanging, and unanswered prompts time out on their own.

Verified live: an approved `python3 approval_demo.py` ran in the container and
returned `ok`; a denied `echo should-not-run` never executed, and the model was
told the user refused rather than being left to retry.

## The UI

A single-page app with no build step (`public/`), served by the agent itself.

- **Diff view.** `write_file` and `edit_file` return a structured line diff
  alongside the tool result, so each change is rendered as before/after hunks
  with per-line numbers and `+`/`−` counts, and the raw tool output is one
  disclosure away. The diff is computed server-side (`src/diff.ts`, a small LCS
  implementation) and stored with the transcript, so reopening a chat shows the
  same diffs. It is stripped before the transcript is sent to the model.
- **Approval cards.** When a command or a large write needs a click, the card
  appears inline in the conversation with the diff attached and active
  Approve / Deny buttons.
- **Viewer diffs.** Opening a file the agent has written shows its change against
  the version that existed before the agent last touched it, with a
  `show file` / `show diff` toggle, and files the agent has modified get a dot in
  the workspace tree. The previous contents are snapshotted per path on every
  write, so this also reveals any change made outside the agent since. The viewer
  also has a `delete` button: the first click arms it (`confirm delete`, in the
  colour reserved for irreversible things) and a second one within a few seconds
  removes the file through `DELETE /api/file` — not a native `confirm()`, which
  blocks the page and cannot be answered in a headless browser. The file's
  snapshot is dropped with it, so a later file of the same name does not read as a
  change against a stranger. Directories are refused by the API, so one click can
  never take out a subtree.
- **Per-chat model, chain and step budget.** The model selector, the `chain` box
  and the `steps` box in the toolbar are saved on the session
  (`PATCH /api/sessions/:id`), restored when you reopen the chat, and sent with
  each message. `steps` caps how many assistant turns one message may take, so
  you can bound a cheap model's runaway loop without editing `.env`.
- **Offline badge.** When the local fallback model answers, a red badge appears
  in the toolbar naming it, and the sidebar shows whether an offline gateway is
  configured at all. See *Offline fallback*.
- **Chain health.** The sidebar's `models n/m ready` row is the result of the
  server's periodic tool-call check on the configured chain, refreshed in the page
  every minute, with the per-model detail in its tooltip. See *Checking the chain
  on a timer*.
- **Catalog sweep.** The sidebar's `sweep` button opens a dialog that asks the
  gateway which of its advertised models can actually make a tool call, with live
  progress, the age of the report, and a report grouped by what you can do about
  it. See *Running a sweep from the UI*.
- **Preview pane.** While the agent writes a file, the pane above the composer
  shows the file *being written* rather than reporting it afterwards: the tool
  call's arguments are forwarded as they arrive (`draft` events), rendered live
  with a caret and a size readout, and followed to the end unless you scroll away.
  When the write lands it says what changed, and `show change` / `show code`
  switches between the body and its diff. It opens by itself on the first draft,
  closes if you close it, and stays up afterwards, because the code the agent just
  wrote is usually what you want to read next.

  While the file is still arriving the pane splits and shows the change *beside*
  the code: the file so far on the right, and on the left a diff of it against the
  file as it stands on disk, recomputed as the body grows (spaced out, never
  overlapping, so a long file does not spend the whole write diffing bodies that
  are about to be replaced). The baseline is the file on disk rather than a
  snapshot, because a second write to the same file in one turn is replacing the
  first one. It uses the server's own diff engine through `POST /api/file/diff`,
  so the pane and the viewer can never disagree about what changed. Only
  `write_file` gets this: an `edit_file`'s content is the replacement snippet, not
  the file that snippet goes into.

  What "live" means depends on the provider, which is worth stating plainly rather
  than implying: the LAN gateway's Gemini path hands a whole tool call over in one
  SSE frame — measured, one frame of 161 argument characters — so there is nothing
  to stream and the file simply appears complete. A small local model that prints
  its call as JSON *prose* is the opposite case: that text arrives token by token,
  so the file really is watchable being written (12 drafts growing 48 → 629
  characters on the local 7B, for one 600-character file). Both paths are the same
  event; only the second one has anything to show before it is finished.
  `npm run draft:check` measures which of the two you have, so a gateway that stops
  streaming a call is noticed rather than silently degrading the pane.

  The pane is syntax-highlighted while it is written — a ~200-line highlighter of
  its own in `public/highlight.js`, because this project has no runtime
  dependencies and because the input is usually *not valid code yet*: every rule is
  allowed to run to the end of the text, so an unclosed string or half a keyword is
  coloured instead of throwing. It handles Python, JavaScript/TypeScript, JSON and
  shell, tells JSON keys from values, and leaves anything else as plain text rather
  than guessing. The workspace viewer uses it too.
  Drafts exist only during a turn, so the pane is also restorable: reopening a chat
  puts its newest file-writing call back on screen, marked as coming from the
  transcript. A reload therefore does not leave an empty pane beside a conversation
  that plainly wrote a file, and the pane's open/closed state is remembered for the
  tab.
- **Choosing the working directory.** A deployment names one sandbox (`AGENT_WORKSPACE`),
  and the workspace panel picks a folder inside it — the agent then reads, writes and
  runs there. The panel also makes folders, so a new project does not have to exist
  before it can be named. The choice is stored at `<AGENT_DATA_DIR>/workspace.json`
  and is deployment-wide: the next person to open the console lands where the
  operator left off rather than back at the sandbox root. What it can never be is
  *outside* the sandbox — the picker resolves through the same fence the tools do,
  so `..` and absolute paths are refused before anything is written, and the
  browser cannot be talked into handing the agent the host. With tenancy on the
  sandbox is the account's own directory, so the choice is scoped to that account.
- **Accessibility.** Landmarks and labelled controls, a skip link, visible focus
  rings, `aria-expanded` on the panel toggle, a dialog role with focus handling
  for the file viewer, and a polite live region that announces tool results,
  notices and errors without narrating every streamed token.

### Reaching it from another machine

Binding beyond loopback puts a shell on your network, so it always needs a
token:

```bash
# .env
HOST=0.0.0.0
WEB_TOKEN=$(openssl rand -hex 24)
```

Then open `http://<host>:3400/?token=<WEB_TOKEN>` once. The token is stored in
`sessionStorage` for that tab and removed from the address bar, so it is not left
in history or shared by copy-paste. Without it, `/api/*` returns 401 and the UI
says so. The safest option remains not binding at all and forwarding a port
instead: `ssh -N -L 3400:127.0.0.1:3400 user@host`.

## Tenancy

By default this console is single-operator: one `.env`, one `OMNIROUTE_API_KEY`,
and every turn spends it. Turn on Distro's control plane and each turn is instead
attributed to the person who asked for it, and gated on that account's quota.

```bash
# .env — both are required; an empty or placeholder token means "off"
CONTROL_PLANE_INTERNAL_URL=https://distro.example.com
CONTROL_INTERNAL_TOKEN=<the plane's service token>
```

The token is a credential, so it can be a `vault://` reference like everything
else in `.env`; the entrypoint resolves it before the server boots, so the
deployment never holds the value itself. The family deployment carries it as
`CONTROL_INTERNAL_TOKEN=vault://cerulean/ontrak#CONTROL_INTERNAL_TOKEN`.

The URL is the plane's **origin**: this console calls `/api/internal/identity`,
`/api/internal/quota-check`, `/api/internal/usage-report` and
`/api/internal/audit` under it. The contract is Distro's — the same endpoints and
payloads Studio speaks — so one control plane serves both surfaces.

What the gate does, in order, before anything is spent:

1. **Resolve** the signed-in subject to an account, and to that account's own
   gateway key (`POST /api/internal/identity`, with the service token).
2. **Check the quota** for that key (`GET /api/internal/quota-check`, bearing the
   key itself — that is how the plane identifies the account).
3. **Spend it**: the turn's model calls carry the account's key, never the shared one.
4. **Record** what it cost (`POST /api/internal/usage-report`), after the answer has
   been sent. An export also writes an audit row (`POST /api/internal/audit`),
   because it leaves this system and becomes another one's input.

Three deliberate asymmetries, each with a reason:

| | Behaviour | Why |
| --- | --- | --- |
| The key | **Strict.** No resolved account, no turn — never a fallback to the shared key. | A fallback moves one person's spend onto the operator's key, which is the problem this replaces. |
| The quota check | **Fail-open.** A plane that cannot answer does not stop the turn. | The gateway key's own hard caps remain the backstop; a read-only hiccup must not be an outage. |
| The ledger and the audit | **Best-effort**, and written after the response. | The turn is already paid for, and a record that could not be written must not fail an answer somebody already has. |

Two consequences worth knowing before switching it on:

- **Sign-in becomes required.** The plane keys accounts on the OIDC subject, and a
  shared bearer carries no subject to key on: with tenancy on and `ONTRAK_OIDC_*`
  unset, every turn is refused with *"Genie cannot tell which account this turn
  belongs to"*. Configure `ONTRAK_OIDC_*` in the same change.
- **No gateway key reaches the browser.** Accounts and quotas are resolved
  server-side in the request handler; a refused turn is a `401` or a `429`
  carrying the plane's own reasons and nothing else.

### Two accounts, two workspaces

Tenancy decides *whose key pays*, and the disk follows it. With a plane
configured, an account's files, chats and file history are its own:

```
<AGENT_WORKSPACE>/accounts/<account>/             what that account may read and write
<AGENT_DATA_DIR>/accounts/<account>/sessions/     its chats
<AGENT_DATA_DIR>/accounts/<account>/snapshots/    its file history
```

`<account>` is the control-plane user id, sanitized to a single path segment and
suffixed with eight hex digits of that id's own digest. That pair is the point: an
id that looks like a path (`../..`, `/etc/passwd`) cannot become one, and two ids
that sanitize alike (`a/b` and `a-b`) still get different directories rather than
silently sharing one.

Everything that touches disk resolves through `src/scope.ts`, which is the single
answer to "where is the workspace": the path jail (`resolveInWorkspace`), the
session store, the snapshot store, the ripgrep root, the container mount for
`run_command`, and the sandbox mount. A request enters its account's scope once,
in the server, before routing — so the tree, a file read, a diff and a delete all
agree, and none of them can be talked back into the shared root.

Two details that are deliberate:

- **A file read is not quota-gated.** Someone at their daily cap can still read
  what they already wrote; refusing that turns a spend limit into a lockout from
  one's own work, and the thing that costs money stays gated a route later.
- **The refusal is a `401`.** With a plane configured and no session, the API
  answers *"Genie cannot tell which account this belongs to"* rather than serving
  the shared workspace — the same posture as the turn gate, and the reason
  three sign-in variables are not optional once tenancy is on.

With no plane configured there is no account to key on, and every path resolves to
the single configured workspace exactly as it did before: `AGENT_WORKSPACE` and
`AGENT_DATA_DIR` are the whole layout, as in `## Layout` below.

`GET /api/health` reports `tenancy: true` when a plane is configured, which is the
quickest way to confirm a deployment picked the settings up.

## Secrets (Cerulean Vault)

The platform's secret store is **Cerulean Vault** (HashiCorp Vault, KV v2), and
`.env` is a reference file rather than the store itself. Any value may be a
`vault://<mount>/<path>#<key>` reference — the same grammar Cerulean, Onyx, Atlas,
Zeus and Distro resolve — and the image's entrypoint resolves every one of them
**before the server boots**, so nothing in `src/` knows a reference was there.

```bash
# .env — the secret lives in Vault; this file only points at it
VAULT_ADDR=http://192.168.1.71:8200
VAULT_TOKEN_FILE=/vault/token/ontrak.token
VAULT_PREFIX=cerulean
OMNIROUTE_API_KEY=vault://cerulean/ontrak#OMNIROUTE_API_KEY
CONTROL_INTERNAL_TOKEN=vault://cerulean/ontrak#CONTROL_INTERNAL_TOKEN
ONTRAK_OIDC_CLIENT_SECRET=vault://cerulean/ontrak#ONTRAK_OIDC_CLIENT_SECRET
ONTRAK_OIDC_SESSION_SECRET=vault://cerulean/ontrak#ONTRAK_OIDC_SESSION_SECRET
```

The resolver (`scripts/vault-env.mjs`, run by `docker-entrypoint.sh`) is
**fail-fast**: no `VAULT_ADDR` with a reference present, an unreachable store, a
missing path or a missing key each stop the container, so a deployment can never
boot holding a literal `vault://` string or a stale credential. With no references
it is a silent no-op, which is why it always runs. A leftover `infisical://` value
is refused outright — Infisical is retired, and a stale reference is not a
fallback.

**One token per product, narrowed to its own path.** Cerulean mints a periodic
token for each name in its `VAULT_PRODUCT_TOKENS` and writes it to
`./data/vault/token/<product>.token`. Genie's is `ontrak`, scoped to
`cerulean/data/ontrak` (and its metadata) and nothing else, so a leaked copy
cannot read a sibling's secrets. It never gets the mount-wide `cerulean.token`.
The family stack mounts that file read-only at `/vault/token/ontrak.token`; the
`docker-compose.yml` here documents the same mount for a standalone deployment.

**Move the values with the platform tool**, which reads the secret, unions it with
what is already in Vault and never prints a value:

```bash
VAULT_ADDR=http://192.168.1.71:8200 VAULT_TOKEN_FILE=./data/vault/token/ontrak.token \
VAULT_PREFIX=cerulean VAULT_PATH=ontrak \
python3 scripts/vault-migrate.py --from-env-file .env \
  --keys OMNIROUTE_API_KEY,CONTROL_INTERNAL_TOKEN,ONTRAK_OIDC_CLIENT_SECRET,ONTRAK_OIDC_SESSION_SECRET
```

It prints the `vault://` lines to put back in `.env`. Then restart the container:
the entrypoint resolves them before `node dist/server.js` runs. Rotating a secret
is a write to Vault (or a re-run of the command above) plus a restart — `.env`
never holds the value again.

## Configuration

All optional — see `.env.example`.

| Variable                                    | Default                  | Purpose                                  |
| ------------------------------------------- | ------------------------ | ---------------------------------------- |
| `PORT` / `HOST`                             | `3400` / `127.0.0.1`     | Web server bind address (the compose stack sets `PORT` from `ONTRAK_GENIE_PORT`, 3410 by default) |
| `OMNIROUTE_URL`                             | `http://127.0.0.1:20128/v1` | Gateway base URL — use a LAN address, never a Docker service name |
| `OMNIROUTE_API_KEY`                         | *(empty)*                | Sent as a bearer token if set. May be a `vault://` reference — see *Secrets (Cerulean Vault)* |
| `AGENT_MODEL`                               | `auto/coding`            | Default model; overridable per request. Pin an explicit id — see *Picking a model* |
| `AGENT_WORKSPACE`                           | `./workspace`            | The only directory the agent can touch   |
| `AGENT_DATA_DIR`                            | `./.agent`               | Sessions and the last sweep report (`sweep.json`) |
| `AGENT_MAX_STEPS`                           | `30`                     | Assistant turns per message (overridable per chat/per request) |
| `AGENT_FALLBACK_MODELS`                     | *(empty)*                | Ordered models to try when one throttles or returns nothing |
| `AGENT_OFFLINE_URL`                         | *(empty)*                | Second gateway tried last, e.g. Ollama on `127.0.0.1:11434` |
| `AGENT_OFFLINE_KEY`                         | *(empty)*                | Key for that gateway, if it wants one   |
| `AGENT_OFFLINE_MODELS`                      | *(empty)*                | Models to try on the offline gateway     |
| `AGENT_HEALTH_INTERVAL_MS`                  | `900000`                 | How often to check the chain can still call tools; `0` disables |
| `AGENT_RETRY_ATTEMPTS`                      | `2`                      | Re-walks of the chain when everything throttled and nothing was produced; `0` disables |
| `AGENT_RETRY_DELAY_MS`                      | `20000`                  | First wait before a re-walk; doubles per attempt, capped at 60s |
| `AGENT_APPROVAL`                            | `off`                    | `off` / `risky` / `all` — see the approval gate |
| `AGENT_APPROVAL_MAX_LINES`                  | `200`                    | Changed-line threshold for `risky`        |
| `AGENT_APPROVAL_TIMEOUT_MS`                 | `300000`                 | How long an unanswered prompt waits        |
| `AGENT_SANDBOX`                             | `auto`                   | `auto`, `docker` or `host` for `run_command` |
| `AGENT_SANDBOX_IMAGE`                       | `coding-agent-sandbox:latest` | Image the sandbox container runs   |
| `AGENT_SANDBOX_MEMORY` / `_CPUS` / `_PIDS`  | `2g` / `2` / `512`       | Sandbox resource ceilings                |
| `AGENT_COMMAND_TIMEOUT_MS`                  | `120000`                 | Per-command timeout                      |
| `AGENT_REQUEST_TIMEOUT_MS`                  | `300000`                 | Per-model-request timeout                |
| `AGENT_STREAM`                              | `true`                   | Set `false` if a provider mishandles SSE |
| `AGENT_TOOL_RESULT_LIMIT`                   | `60000`                  | Cap on a single tool result              |
| `WEB_TOKEN`                                 | *(empty)*                | Require this bearer token on `/api/*`    |
| `CONTROL_PLANE_INTERNAL_URL`                | *(empty)*                | Distro control-plane origin. With the token below, every turn is attributed and quota-gated — see *Tenancy* |
| `CONTROL_INTERNAL_TOKEN`                    | *(empty)*                | Control-plane service token (`x-control-internal-token`); empty or a placeholder means tenancy is off. May be a `vault://` reference — see *Secrets (Cerulean Vault)* |
| `ONTRAK_OIDC_ISSUER`                        | *(empty)*                | Authentik issuer. With the two below, require sign-in on `/api/*` |
| `ONTRAK_OIDC_CLIENT_ID`                     | *(empty)*                | OIDC client id registered with the provider |
| `ONTRAK_OIDC_CLIENT_SECRET`                 | *(empty)*                | Only for a confidential client; omit it with PKCE. May be a `vault://` reference |
| `ONTRAK_OIDC_REDIRECT_URL`                  | `http://127.0.0.1:<PORT>/api/auth/callback` | Must match a URI registered with the provider byte for byte. Comma-separate one per name; the entry matching the browser's `Host` is used (see *Sign-in on more than one name*) |
| `ONTRAK_OIDC_SESSION_SECRET`                | *(empty)*                | Signs the session cookie. Required for sign-in. May be a `vault://` reference |
| `ONTRAK_OIDC_SESSION_HOURS`                 | `12`                     | How long a sign-in lasts before the person is sent back to the provider |
| `VAULT_ADDR`                                | *(empty)*                | Cerulean Vault base URL. Empty = no references are resolved (*Secrets (Cerulean Vault)*) |
| `VAULT_TOKEN_FILE`                          | *(empty)*                | File holding this stack's path-scoped token (or `VAULT_TOKEN`, the direct value) |
| `VAULT_PREFIX`                              | `cerulean`               | KV v2 mount point; only change it for an external Vault mounted elsewhere |
| `VAULT_NAMESPACE` / `VAULT_SKIP_VERIFY` / `VAULT_CACERT` | *(empty)*    | Enterprise namespace and TLS knobs; all unused on the platform's OSS Vault |

## Agent tools

| Tool          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `read_file`   | Read a file with numbered lines; `offset`/`limit` for paging    |
| `list_dir`    | List a directory, directories first                             |
| `write_file`  | Create or fully replace a file (creates parent directories)     |
| `edit_file`   | Exact-substring replace; refuses missing or ambiguous matches    |
| `search_code` | Regex content search; uses `ripgrep` with a Node fallback        |
| `run_command` | Shell command in the workspace, with the guard above             |

## API

| Method   | Path                  | Purpose                              |
| -------- | --------------------- | ------------------------------------ |
| `POST`   | `/api/chat`           | Run a turn; SSE stream of `AgentEvent`. Accepts `model`, `fallbackModels`, `maxSteps` |
| `GET`    | `/api/health`         | Server + gateway reachability, sandbox, approval, offline fallback, `tenancy` |
| `GET`    | `/api/models`         | Model ids from the gateway           |
| `GET`    | `/api/models/sweep`   | Last catalog sweep: running, progress, per-model verdicts, `stale` |
| `POST`   | `/api/models/sweep`   | Start one (`{ all }`); `202`, or `409` if one is already running |
| `GET`    | `/api/sessions`       | List sessions                        |
| `POST`   | `/api/sessions`       | Create a session                     |
| `GET`    | `/api/sessions/:id`   | Full transcript                      |
| `PATCH`  | `/api/sessions/:id`   | Save the session's model / chain / step budget |
| `DELETE` | `/api/sessions/:id`   | Delete a session                     |
| `POST`   | `/api/approvals/:id`  | Answer a pending approval (`approve`/`deny`) |
| `GET`    | `/api/files?path=`    | List a directory, with `changed` flags |
| `GET`    | `/api/file?path=`     | Read a workspace file                |
| `DELETE` | `/api/file?path=`     | Delete a workspace file (`404` if it is not there, `400` for a directory) |
| `GET`    | `/api/file/diff?path=`| Current file vs. the last version the agent changed |
| `POST`   | `/api/file/diff`      | Diff a body still being written (`{ path, content }`) against the file on disk |
| `GET`    | `/api/workspace`      | The directory the agent works in, the sandbox around it, and every folder inside it that can be chosen |
| `POST`   | `/api/workspace`      | Choose the working directory (`{ path }`, sandbox-relative; `400` if it escapes the sandbox) |
| `POST`   | `/api/workspace/mkdir`| Create a folder in the working directory (`{ name }`; `400` for a name that is a path, `409` if it is taken) |

`POST /api/chat` takes `{ message, sessionId?, model?, maxSteps? }` and streams
`AgentEvent`s: `session`, `step`, `draft` (a file being generated, with the content
so far), `text`, `tool_call`, `tool_result` (with an optional `diff`), `notice`,
`error`, then `done` and `[DONE]`.

## Development

```bash
npm run dev           # tsx watch (reload on change)
npm run typecheck     # tsc --noEmit
npm test              # node:test — 302 tests, no browser needed
npm run ui:smoke      # drives the real UI in a headless Chromium
npm run model:health  # which advertised models really do tool calling
npm run offline:check # proves the offline fallback, with the gateway dead
npm run draft:check   # how the configured gateway streams a file being written
npm run live:check    # offline:check and draft:check, one after the other
npm run sandbox:build # rebuild the run_command container image
```

`npm run check` runs the whole gate in the order that makes sense: `typecheck`,
`build`, `test`, `ui:smoke`. The build comes before the tests because the suite
runs the compiled `dist/test/*.test.js`, not the TypeScript, and `ui:smoke` comes
last because it needs a server to drive — start one first (or use the compose
container, which is already on `ONTRAK_GENIE_PORT` — 3410 by default, since the
family stack owns :3400).

`npm run offline:check` is the one check that cannot be a unit test, because the
fallback it covers only happens when every main model has already failed. It starts
a real server with `OMNIROUTE_URL` pointed at a closed port, sends one turn
through `/api/chat`, and requires the turn to finish on the local model anyway:
reporting the failure, switching gateway, writing a file, running it with
`python3`, and printing what it printed. With no `AGENT_OFFLINE_URL` configured, or
one that is not answering, it skips and exits 0 rather than blaming this project
for a missing Ollama. It is deliberately *not* part of `npm run check` — it needs a
local model, and a 7B one on CPU spends a minute or two thinking.

`npm run draft:check` covers the one part of the preview pane that depends on
someone else's behaviour. Drafts exist because a model writes a file through a tool
call whose arguments stream in, and that is a property of the gateway, not of this
code — one that can go away silently: a gateway that buffers the whole call into
the final JSON leaves the pane showing nothing until the write is already finished,
with no error anywhere. The script runs one real turn, checks that the drafts grew,
that they named one file, that exactly one attempt was drafted and that the drafted
body is what landed on disk, and then reports the shape of it. A single draft means
the pane cannot stream for that provider; `--require-fragmented` turns that into a
failure, for pinning a provider to the behaviour you want. The container's Gemini
path is currently the single-frame case, so the default run passes with a NOTE.

`npm run live:check` is the two live checks in one command: the offline fallback
(`offline:check`) and the shape of the configured gateway's streaming
(`draft:check`). Both need the same things — a running agent and a reachable local
model — so running the pair is the usual way to answer "is the live path still
working?" after a gateway or `.env` change. Neither belongs in `npm run check`,
which stays fast and needs no model of its own; either one skips and exits 0 when
the thing it needs is not configured.

`npm run ui:smoke` exists because there is no build step and no DOM test runner,
which leaves a gap: `node --check` proves the client parses but not that it runs.
It opens the UI in Chromium over the DevTools Protocol, clicks what a person
would click, and fails on a console exception — covering the file tree, the
changed markers, the viewer's diff/file toggle, the model picker, the sandbox,
approval and chain-health rows, the sweep panel, whether the sweep's usable models
are marked in the picker, the preview pane (including a real write, its
highlighting, that the pane comes back after a page reload, and a report of
whether a live diff was actually streamed — a whole call can arrive in one frame,
in which case there is no window in which to stream one), the viewer's change
rendering and its two-click delete, the accessibility landmarks, and
(when `AGENT_APPROVAL` is on) two full prompts, one answered **Deny** and one
**Approve** with a harmless `echo`, so it proves both paths and still executes
nothing that changes anything. It also cross-checks what the panel renders against
the API it mirrors, and the pre-turn warning against the chain health. It uses
Node's built-in `WebSocket`, so there is nothing to install, and it exits 0 with a
message if no browser is present. The server must be running:

```bash
npm start & npm run ui:smoke
```

It found a real bug on its first run: a denied approval emits a `tool_result`
with no matching `tool_call`, so the client had no card to attach it to and the
refusal vanished from the conversation.

Because the pane it checks only exists when a file is really written, the suite
writes one small file (`ui_smoke_preview.py`) into the workspace it is pointed at —
the same way the approval checks run a real `echo`. It then deletes that file
through the viewer, which both cleans up after the run and covers the delete path
end to end.

The suite covers the path jail, the tool layer, the command guard, the diff
engine, the sandbox's Docker arguments, text-mode call salvage, step-budget
clamping, the approval policy and its pending-request broker, tool previews, file
snapshots, retry classification, the highlighter, and the reader behind the preview pane — reading
a tool call out of JSON that has not finished arriving, which is the sort of thing
that only fails in production if it is never tested on a fragment. Two bugs came
out of that reader meeting a real model: a text-mode reply that printed two calls
in one block gave them the same id (both were built from the same millisecond), so
the second call's output was rendered under the first call's name; and the draft
kept re-announcing "complete" once per token after the call was written. The first
now has a regression test. None of it needs a model to verify. The tests force `AGENT_SANDBOX=host` and
`AGENT_APPROVAL=off` so they behave identically whether or not Docker and the
sandbox image are present.

## Host notes

Setup on this machine needed three things outside the project directory. All are
reversible; none touch application data.

- **Ollama** installed to `/usr/local/bin` from the official GitHub release
  tarball (1.4 GB, `ollama-linux-amd64.tar.zst`). Model weights live under
  `~/.ollama`. Remove with `rm -rf /usr/local/bin/ollama /usr/local/lib/ollama ~/.ollama`.
- **Chromium** for Playwright at `~/.cache/ms-playwright` (184 MB + 115 MB), for
  the `cloudflare-playground` provider. It turned out not to help — see the dead
  end above — so it can be deleted: `rm -rf ~/.cache/ms-playwright`.
- **IPv4 address preference** appended to `/etc/gai.conf`
  (`precedence ::ffff:0:0/96 100`). This host advertises AAAA records but has no
  working IPv6 route, so IPv6-preferring clients hang. The change is a general
  fix for that; the original is at `/etc/gai.conf.bak.pre-ipv4-pref`. Revert with
  `cp /etc/gai.conf.bak.pre-ipv4-pref /etc/gai.conf`.

The gateway is bound to loopback (`OMNIROUTE_SERVER_HOST=127.0.0.1`) because its
default is `0.0.0.0` with no API key, which it warns about on startup.

## Layout

```
src/config.ts      env + .env loading
src/scope.ts       whose slice of disk a request runs in (per-account, or shared)
src/workspace.ts   path jail and filesystem helpers
src/diff.ts        line diff / hunks for the UI
src/omniroute.ts   OpenAI-compatible client (streaming, retry classification)
src/modelHealth.ts periodic tool-call check on the chain, for the health row
src/sweep.ts       on-demand catalog sweep, shared by the UI and the script
src/draft.ts       reading a tool call that is still arriving, for the preview
src/sandbox.ts     run_command backend: docker flags, probing, fallback
src/approval.ts    approval policy + the pending-request broker
src/snapshots.ts   previous contents of agent-written files
src/tools.ts       tool definitions, previews, execution, command guard
src/agent.ts       the multi-step loop: model chain, approval, tool calls
src/store.ts       JSON session persistence
src/server.ts      HTTP server, SSE, static assets
public/            single-page UI (no build step)
public/highlight.js  the preview pane's highlighter (tested on its own)
Dockerfile         the agent image (runtime only - no .env baked in)
docker-compose.yml service, env passthrough, workspace + data volumes
.dockerignore      keeps secrets and host state out of the build context
sandbox/Dockerfile  image that run_command executes in
scripts/           add-provider.mjs (connect a provider), ui-smoke.mjs (browser test),
                   model-health.mjs (CLI sweep), offline-check.mjs (offline proof),
                   draft-check.mjs (how the gateway streams a write),
                   live-check is offline-check + draft-check via package.json
src/test/          node:test suite
```
