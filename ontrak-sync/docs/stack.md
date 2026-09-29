# 🛠️ Ontrak Sync — Platform Stack Role

**Classification: CodeOps**

**Role: CodeOps** — the Network's package and container update *view*, and the only
thing allowed to apply one: it walks every host and every incus container on it,
records what is behind, and installs only what an operator approved.

This page declares Ontrak Sync's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in exactly one
place; this page links this product to it and states what it owns, consumes, provides,
and explicitly does not own.

## Boundaries

**Owns**

- The Network's **package state**: which apt/snap/docker updates each host and container
  is behind on, where that reading came from, and whether the host is waiting for a reboot —
  the one fact about a patch no manager reports, because every manager reports an unpacked
  kernel as current.
- The **apply decision**: what gets installed, in what window, within what scope.
- The **finding lifecycle**: what "approved", "skipped", "expired" and "unknown" mean,
  and the rule that none of them may erase a finding that was not re-inspected.
- The one credential that reaches every Network host (an SSH key, read-only in the
  container).
- The family's **local account table** — the accounts, the password break-glass path, and
  the capability each role holds. The portal's password form delegates here rather than
  inventing a second login, and every product consults it. Cerulean's Authentik remains the
  directory; this is the table that works when the provider cannot be reached.

**Consumes**

- **Cerulean** — public DNS names, TLS certificates, and the NPM Edge proxy host, when
  the dashboard is fronted off the LAN.
- **Cerulean Vault** — the secrets posture for this repo: production secrets come from
  Vault (KV v2), referenced as `vault://<mount>/<path>#<key>`. See `.env.example`.
- **SSH (key only, `BatchMode=yes`)** and `incus exec` on the Network hosts — the only
  way in; nothing is installed on them to make this work.

**Explicitly does NOT own**

- Identity **as a directory** — Cerulean runs Authentik, one OIDC client serves the whole
  family, and group membership decides a role. Sync verifies that provider's tokens and
  owns the *local* account table above; it does not manage groups, and a role granted at
  the directory takes effect on the next sign-in with no write here.
- Package repositories — it reads what `apt`, `snap` and the registries already publish;
  it never mirrors, signs, or re-hosts a package.
- Configuration management — it upgrades packages and recreates compose projects. It does
  not write host configuration, manage users, or converge a machine to a desired state.
- Billing (Magnate), storage (ONYX), media, or telephony — it has nothing to bill, store,
  or stream.

## Service map — what Ontrak Sync is made of

| Component | Technology | Job |
|---|---|---|
| `ontrak-api` | Python 3.12, FastAPI, SQLite | The scan, the finding lifecycle, the cron policy, and the only code that writes to a host |
| `ontrak-web` | Next.js 16, React 19, hand-written CSS | The dashboard: hosts, findings, runs, settings, accounts |
| `ontrak/remote.py` | OpenSSH, `incus exec` | Every command that reaches another machine, in one file |
| `ontrak/applier.py` | apt / snap / docker | The only module that changes a machine |
| `ontrak/scheduler.py` | in-process cron | The timer — a setting in the database, not a system crontab |

## In the ecosystem

- **Trust → this repo.** Cerulean issues the public name and its certificate and creates
  the NPM proxy host when the dashboard leaves the LAN; nothing here calls the NPM API.
- **Secrets → this repo.** Cerulean Vault is the only secrets posture. This repo has no
  resolver of its own, so `.env` must hold the resolved value — a `vault://` reference
  left in place would reach the container as a literal string, which is a deployment
  error, never a fallback.
- **Identity → the family's directory, and a local table.** Sign-in is Cerulean SSO, with
  no password field on the primary screen; the local account table is reached through a
  break-glass path at an unlinked URL, because using it is a decision rather than a
  convenience. A deployment that names no provider falls back to a bearer token the
  operator pastes. Either way `docs/placement.md` is explicit that this surface belongs
  behind the edge like every other admin surface
  (`1-primary/npm/docs/stack.md`), rather than exposed on the LAN indefinitely.
- **The Network → this repo → the Network.** It is the one service that reaches every
  other machine, which is why it runs in its own container (`docs/placement.md`) and
  why the SSH key is mounted read-only: it may install packages through the key, it may
  not rewrite the key.
- **This repo → the platforms.** A stack that reads "0 pending" while three hosts have
  been unreachable for a month is the failure this exists to remove, so the dashboard
  counts *Unknown* next to *Pending* rather than underneath it.

---

*Ontrak Sync · CodeOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
