# Threat model — OnTrak Genie

**Classification: CodeOps.** Genie runs a coding agent in a browser and then puts
that agent's changes on a machine. That is the whole risk, and it is why this
document exists rather than a paragraph in the roadmap: the product's central
feature *is* an attack surface, so the useful question is not "is this safe" but
"what exactly is between the model and the host, and what happens when a
component fails".

Read this beside [operations.md](operations.md) (the developer reference, whose
"Safety model" and "Approval gate" sections are the implementation) and
[runbook.md](runbook.md) (what an operator does at 3am).

## 1. What is being protected

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| The operator's machine | The agent's changes land here; a write is not a sandbox experiment | `AGENT_WORKSPACE`, the host backend's process |
| The workspace's source and secrets | A repo often holds credentials the agent was never asked about | the account's slice under `accounts/<account>/` |
| Each account's own chats and file history | One person's work is not another's to read | `AGENT_DATA_DIR/accounts/<account>/` |
| The gateway credential | It spends a real provider quota, per account | resolved server-side from the control plane; never in a browser |
| Cerulean Vault (the estate's secrets) | A path-scoped token, not the store | `scripts/vault-env.mjs` at container start |
| The estate's network | A published preview and a published console are reachable | `AGENT_LAN_IP`, `AGENT_PREVIEW_PUBLISH`, NPM Edge |
| The audit trail | Who let what run, and what each account spent | `approvals.jsonl`, the transcripts, Distro's ledger |

## 2. Trust boundaries

Four, and each one is a place where a decision is made rather than a wall:

```
  browser ──(1)──> console ──(2)──> agent loop ──(3)──> tool: command / write ──(4)──> host
                     │                   │                    │
                     │                   │                    └── sandbox (docker, --network none)
                     │                   └── approval gate (a human click)
                     └── sign-in (Authentik OIDC) + account scope (per account)
```

1. **Browser → console.** Authentik OIDC, authorization code + PKCE, an RS256
   `id_token` verified against the provider's JWKS, and a signed session cookie.
   With `ONTRAK_OIDC_*` unset the app is the single-operator tool it has always
   been and, per `src/oidc.ts`, it closes the loopback trust instead of pretending
   to have an identity layer.
2. **Console → agent loop.** The jail, and then the account scope. `resolveInWorkspace`
   refuses absolute paths and `..`, and resolves against *the caller's* root, so a
   user who knows another account's directory name still cannot name a path into
   it. `accountDirName` sanitizes the account id and appends a digest of it, so two
   ids that would otherwise sanitize to the same directory (`a/b`, `a-b`) do not
   merge two accounts' files.
3. **Agent loop → a tool that changes something.** The approval gate
   (`AGENT_APPROVAL`: `off` / `risky` / `all`). It parks the stream on a second
   connection rather than blocking it, opens on timeout — a gate that fails open
   would be worse than no gate — and every decision, including a timeout, is
   appended to `<AGENT_DATA_DIR>/approvals.jsonl` with the actor.
4. **Tool → host.** The command sandbox: `docker run --network none` by default,
   no capabilities, no new privileges, and memory / CPU / PID ceilings. Where the
   deployment runs Genie itself in a container (`AGENT_SANDBOX=host`) the container
   *is* the boundary and the inner sandbox is deliberately not spent twice.

## 3. Adversaries, and what each one gets

**A. A model that has been talked into something.** The realistic case, and the
reason the gate and the sandbox are independent: sandboxing stops a command
reaching the host, approval stops it running at all. A prompt-injected agent — an
instruction hidden in a README, a dependency's comment, a fetched page — can ask
for anything the tool set allows, and gets:

- no path outside its own account's slice (boundary 2),
- no network from a sandboxed command unless an operator set
  `AGENT_SANDBOX_NETWORK` (boundary 4), and
- a human click for every command and for overwrites above
  `AGENT_APPROVAL_MAX_LINES` under the recommended `risky` mode (boundary 3).

**Residual:** with `AGENT_APPROVAL=off` — which is the shipped default for a
single-operator laptop — a write or a command needs no click. The agent still
cannot leave the workspace, but it *can* overwrite everything inside it. A
deployment that exposes Genie at a name must not run with the gate off; the
gate's mode is reported on `/api/health` and the console draws a badge from it
precisely so "off" is visible rather than assumed.

**B. Another signed-in person on the same deployment.** Isolated by the account
scope: their own workspace root, chat list and file history, their own gateway
key so their spend is their own, and their own sweep report. A turn without a
resolvable account is refused rather than quietly spending the operator's shared
key (`src/tenancy.ts` — the key is strict, the quota is fail-open, the ledger is
best-effort).

**Residual:** the disk is one filesystem, and both slices sit on it. Two accounts
are separated by the process's own path checks, not by a kernel boundary; a
workload that escaped to the host would see both. That is a reason not to hand a
Genie account to someone you would not give a shell on that host.

**C. Somebody who finds the name.** Both console names sit behind Authentik, and
the account is keyed on the OIDC subject — a shared `WEB_TOKEN` is a break-glass
route, not a second identity system. **Residual:** the LAN preview
(`AGENT_LAN_IP` + `AGENT_PREVIEW_PUBLISH`) publishes the *app being built* at the
deployment's address, deliberately, so a webhook or a phone can reach it. An app
started in a preview is not gated by the console's sign-in, so a preview whose app
has no auth of its own is reachable by anyone on that network. Publish an address
when the caller needs one, not by default.

**D. A compromised or hostile upstream.** The gateway, a provider, or a model
that is simply bad. Genie holds **no provider credential** — it speaks the
OpenAI-compatible wire format to OmniRoute and reports what came back — so a
leaked provider key is not Genie's to leak. A hostile gateway can answer
anything, which is a reason the tool result is data rather than instructions.

**Residual:** the code the agent reads *is* sent to whichever provider answers.
A workspace with secrets in it is a workspace whose secrets leave the machine
whenever the agent reads them. This is the largest unmitigated exposure in the
product, and it is a property of using a hosted model at all — the offline
gateway (`AGENT_OFFLINE_URL`) is the answer for a workspace that must not leave.

**E. The operator, tired.** The failure that no boundary catches. The controls:
the gate is on by default at a public name, every decision is recorded with its
actor, the sweep and the status rows make a dead model chain visible, and v1.0's
ceiling (`AGENT_ACCOUNT_CEILING_REQUESTS`) ends a runaway loop — counted where
each turn is decided, cleared at midnight UTC, and held in the process on purpose:
a durable counter is a bill wearing a safety belt, and this is a stop.

## 4. Secrets

`.env` carries `vault://cerulean/ontrak#KEY` references rather than values on the
family deployment, resolved at container start by `scripts/vault-env.mjs` under a
path-scoped KV v2 token covering only `cerulean/data/ontrak`. The resolver is
**fail-fast**: a reference that cannot be resolved, a missing key or an
unreachable store stops the container instead of booting with a literal
`vault://` string. That is the decision that makes a half-migrated deployment
impossible rather than merely unlikely — and it means a threat model that
depends on a secret being in Vault is enforced by the boot, not by review.

Per-account gateway keys never reach the browser: they are resolved per request
from Distro's control plane and used server-side to spend, then discarded with
the request.

## 5. Out of scope, deliberately

- **Unattended host changes.** The autonomy ladder
  ([roadmap](roadmap.md) §5) puts L3 out of scope: an agent that changes a host
  without a human decision is not a configuration this product ships.
- **Multi-tenant hardening against the platform operator.** Genie is a
  single-responsibility component; isolation between *organisations* is the
  estate's job (identity, the edge, ONYX), not a second tenancy system here.
- **Proctoring the model.** Genie does not try to detect a bad answer. It gates
  what a bad answer can *do*.
- **Vendoring a provider SDK, or a second execution plane.** Atlas keeps the
  ecosystem's code and CI; Genie is a console over a workspace.

## 6. Verifying the controls, not just reading them

Every claim above has a test behind it, and the ones that matter most are named
here so a change that erodes one fails loudly:

| Control | Test |
| --- | --- |
| The jail refuses `..` and absolute paths | `src/test/scope.test.ts`, `src/test/http.test.ts` |
| Account scope isolates roots, chats and history | `src/test/scope.test.ts` |
| A turn without an account is refused, not put on the shared key | `src/test/tenancy.test.ts` |
| The ceiling counts where the turn is decided and resets with the day | `src/test/ceiling.test.ts` |
| The gate times out closed, and records who decided | `src/test/approval.test.ts` |
| Sign-in is verified against the JWKS, not trusted | `src/test/oidc.test.ts`, `src/test/oidc-redirect.test.ts` |
| A control-plane outage is reported, not swallowed | `src/test/controlplane-outage.test.ts` |
