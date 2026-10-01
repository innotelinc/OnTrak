# Operator runbook — OnTrak Genie

The work an operator actually does: bring it up, keep it standing, notice when it
is not, and take one account out without taking the console down. Written to be
followed, not read — each section says what to run and what the answer means.

Companion documents: [operations.md](operations.md) is the full developer
reference, [threat-model.md](threat-model.md) is what the controls are defending,
[roadmap.md](roadmap.md) is what is built and what is not.

Everything here assumes the family deployment: the OnTrak stack on
`192.168.1.21`, the image from `ghcr.io/innotelinc/ontrak-genie`, the control
plane on Distro (`192.168.1.61:20140`), Authentik at
`https://auth.cerulean.innotel.us`, and OmniRoute at `192.168.1.71:20128`.

## 1. The one-line health check

```bash
curl -fsS http://192.168.1.21:3400/api/health
# {"error":"unauthorized"} means WEB_TOKEN is set — send it, do not assume the console is down:
curl -fsS -H "Authorization: Bearer $WEB_TOKEN" http://192.168.1.21:3400/api/health
```

Read four fields before anything else:

| Field | What a wrong value means |
| --- | --- |
| `ok` / the gateway block | OmniRoute is unreachable from the console. Turns will fail; nothing else will. |
| `authRequired` + `tenancy` | `webToken` set, or an account gate on. Tenancy with no sign-in configured refuses every turn — see §5. |
| `workspaceBase` | **`/workspace` is the single-operator root.** On a tenanted deployment this means the account scope did not resolve. |
| `approval.mode` | `off` at a public name is the posture to change, not to note. |

## 2. Deploy, and deploy again

```bash
# pull-only, the path a deploy takes
cd <stack>/ontrak-genie && make genie-prod-up

# the family stack's entry, if that is how this host is composed
cd <stack> && docker compose -f docker-compose.all.yml up -d --no-deps genie-app
```

The image is `ghcr.io/innotelinc/ontrak-genie:<tag>`, one image and no `-migrate`
twin — there is no database to migrate. `ONTRAK_GENIE_IMAGE_TAG` picks the tag;
the group compose names the same version, so a deploy is a pull rather than a
build.

**A deploy that stops instead of starting is the Vault resolver working.** The
entrypoint resolves every `vault://` reference before the server runs, and a
missing secret, a missing key or an unreachable store is fatal by design
(`scripts/vault-env.mjs`). Read the last line of `docker logs` — it names the
reference, not the value — and fix the reference rather than making the resolver
lenient.

### Deploy from the repository, not from a copy

A host that builds its own image has to build it from the tree the repository
actually holds. A directory that has drifted — an older copy with its own
history, or a checkout nobody has pulled — is a deploy that succeeds and ships
the wrong code, and nothing in the console says so, because the console cannot
tell the difference between "the feature is off" and "the feature is not in
this build". Before `up`, `git rev-parse --short HEAD` in that directory should
be a commit you can find in the repository.

### Rolling back

Two shapes, and the difference is whether the host builds or pulls.

**Built on the host** — `docker compose` in the source directory that owns the
compose file:

```bash
cd <stack>/ontrak-genie        # the directory that owns docker-compose.yml
git log --oneline -5           # pick the commit to return to
git checkout <commit>
docker compose up -d --build   # rebuilds the image from *that* tree
```

`--build` is not optional. The running service is an image, and `up -d` alone
would recreate the container from the image the *previous* commit built — the
rollback would look like it worked while the newer code stayed live. Confirm it
took by reading a field the rollback introduces or removes in `/api/health`
(`modelSelection`, say, which only the free-plan build reports), rather than
trusting the exit code.

**Pulled** — the family stack, which takes a tag:

```bash
ONTRAK_GENIE_IMAGE_TAG=<previous-tag> make genie-prod-up
```

A rollback does **not** touch three things, and each of them is a reason not to
reach for one:

- **The data volume** (`<AGENT_DATA_DIR>`, the `agent-data` volume). Transcripts,
snapshots, `approvals.jsonl` and the workspace survive it. Rolling back is not a
way to clear state; §9 covers what to back up if that is what you want.
- **`.env`.** A setting added by the newer code stays behind, and one that only
the *newer* code knows about is ignored rather than rejected — so if the reason
you are rolling back is a setting, change the setting. Rolling the code back
instead leaves the two out of step in the opposite direction.
- **The port.** `ONTRAK_GENIE_PORT` in `.env` is what keeps the console where it
is (the compose default is 3410). If `docker compose config | grep PORT` shows a
different number than the one you expect, fix that before `up -d` — "the console
is gone" and "the console moved" look identical from a browser.

## 3. Sign-in

Both names — `genie.ontrak.innotel.us` and `genie.innotel.us` — are registered in
Cerulean and on NPM Edge, and each completes its own code flow: the redirect
resolution reads the browser's `Host` and picks the matching registered URI, so
one name never bounces its session onto the other. That means **a new name needs
an Authentik redirect URI, not only a DNS record and a proxy host.**

Symptom → cause:

| Symptom | Cause |
| --- | --- |
| `redirect_uri` mismatch at the provider | The name reached Authentik was not registered as its own URI. Add it to the `OnTrak` provider. |
| Sign-in completes, then loops straight back to sign-in | `ONTRAK_OIDC_SESSION_SECRET` differs between two replicas, or is empty (sign-in is off entirely then). |
| The console is reachable with no sign-in at all | `ONTRAK_OIDC_ISSUER` / `_CLIENT_ID` / `_SESSION_SECRET` not all set, or set to a placeholder — a `change-me…` value counts as unset on purpose. |

## 4. When a turn is refused

The refusal text says which gate refused, and the four are different problems:

| Refusal | Meaning | Do |
| --- | --- | --- |
| *"Sign in, so the model pool is spent on your own key"* | Tenancy is on and there is no subject. | Turn sign-in on, or turn tenancy off. Do not add a shared key. |
| *"The tenancy service could not identify this account"* | The control plane did not answer. | §5. |
| *"Your account cannot start another turn right now — …"* | The plane's own quota. The reasons are the plane's. | Check the account's plan in Distro. |
| *"This account has started N turns today, and this deployment's ceiling is N per day"* | **Genie's own ceiling**, not the plane's. | §6. |

## 5. The control plane is unreachable

Two alerts exist, and they mean different things:

- **`controlplane.unreachable`** — this console could not reach Distro while
  somebody was using it. The console cannot tell the plane about the plane's own
  outage *while it is happening*, so it records the window and reports it on the
  next call that succeeds, or on
  `CONTROL_PLANE_OUTAGE_REPORT_INTERVAL_MS` (default 60s) for a console nobody is
  using. **If you saw this alert, the call that carried it succeeded** — so the
  plane is up now, and what you are looking at is history.
- **`sync.stale`** — a usage sync has not run inside its window. That is the
  plane's own watchdog and it means the *ledger* went quiet, which is a billing
  and attribution problem rather than a console one.

While it is down, turns are refused (`503`) rather than falling back to the
operator's shared key. That is deliberate: a fallback would move one person's
spend onto the operator's key, which is the exact problem tenancy exists to fix.
Design the outage to be short, not to be invisible.

```bash
curl -fsS http://192.168.1.61:20140/health                # is the plane up
docker logs --tail 50 distro-control-plane                # what it says
```

## 6. A runaway loop hit the ceiling

`AGENT_ACCOUNT_CEILING_REQUESTS` bounds how many turns one account may start per
day, and it is the only bound the family's unlimited-usage plan cannot provide.
Read where the account stands:

```bash
curl -fsS http://192.168.1.21:3400/api/account/usage | jq .ceiling
# { "limit": 200, "used": 200, "remaining": 0, "allowed": false }
```

It clears at **midnight UTC**, and a restart of the console clears it too — the
count is held in the process on purpose, because a durable counter is a billing
mechanism and this is a safety stop. If an account hits it daily, that is a
finding about the workload, not about the limit: raise the number only after you
know which loop is doing it. `0` disables it, which is the shipped default.

## 7. The model chain is dead

A big catalog is not a usable catalog: an id that cannot call a tool fails the
turn however strong the model is. Symptoms are a spinner that ends in nothing, or
an empty reply.

```bash
curl -fsS http://192.168.1.21:3400/api/models/sweep | jq '.sweep.stale, (.sweep.results[] | {model, verdict})'
npm run model:health          # the same question from a shell
```

Run a fresh sweep from the console's status row (**not** `all` first — it is a
burst against someone else's gateway). `throttled` on every entry usually means a
free tier has exhausted its daily quota, which is why the chain leads with
OpenRouter's free router and keeps Gemini last: a reset quota is still reachable.
A report older than a day is marked `stale` rather than shown as current.

## 8. Take an account out

Off-boarding is three steps and none of them is deleting a chat:

1. Remove the subject at the provider (Authentik group membership, or the account
   itself). The next request resolves no identity and is refused; the 5-minute
   caller cache is the outside edge of that.
2. Revoke the account's gateway key in Distro. That is the credential a turn
   spends, and it is the one that stops spend if the provider side is missed.
3. Leave the disk. `<AGENT_WORKSPACE>/accounts/<account>/` and
   `<AGENT_DATA_DIR>/accounts/<account>/` hold their work, and a departure is not
   a reason to destroy somebody's evidence; remove them on a schedule you can
   defend, in writing.

## 9. Backup, and what to back up

| Path | Why |
| --- | --- |
| `<AGENT_DATA_DIR>/sessions/` and `accounts/*/sessions/` | The transcripts. Losing these loses the work. |
| `<AGENT_DATA_DIR>/snapshots/` and `accounts/*/snapshots/` | The file history the diff viewer reads. |
| `<AGENT_DATA_DIR>/approvals.jsonl` | Who let what run. Append-only, and the only record of an approval. |
| `<AGENT_WORKSPACE>/accounts/*/` | The code itself, if this deployment is its home. |
| `<AGENT_DATA_DIR>/workspace.json` | The chosen working directory, per account. Cheap, and its loss changes where tools land. |

`sweep.json` is a cache and is not worth restoring.

## 10. Incident: the agent is at a public name and something is wrong

1. **Stop the bleeding before diagnosing.** Set `AGENT_APPROVAL=all` and recreate
   the container: every mutating tool call now waits for a click, which ends an
   unattended run without destroying the evidence.
2. **Read what it did**, in this order: `approvals.jsonl` (who approved what),
   the transcript (`/api/sessions`), the account's `snapshots/` (what changed and
   when), then Distro's audit rows for the account.
3. **Close the network if the workspace matters more than the convenience.**
   Unset `AGENT_SANDBOX_NETWORK` (back to `none`) and stop publishing a preview
   (`AGENT_PREVIEW_PUBLISH=false`) — a command that cannot reach out cannot
   exfiltrate, and a preview nobody can dial is not an unauthenticated app.
4. **Rotate what was reachable**: the account's gateway key in Distro, and any
   credential that was inside the workspace the agent could read.
5. **Write down the loop that made it possible.** If the answer is "the gate was
   off", the fix is the gate, not the prompt.

## 11. Housekeeping that is safe to automate

- `GET /api/health` on a probe; alert on `ok: false`.
- `GET /api/account/usage` per account for the ceiling row; alert on
  `ceiling.allowed: false` (a loop) rather than on `used` alone.
- A weekly sweep, so a model that stopped calling tools is found by you rather
  than by a user.
- Prune `approvals.jsonl` on a retention schedule you can defend — never by
  dropping the file a deployment is currently appending to.
