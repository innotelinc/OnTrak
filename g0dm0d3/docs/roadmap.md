# Uncensored Godmode (G0DM0D3) — roadmap

> **Re-baselined at 2.0 (2026-10-24).** The shipped front door is **2.0.0**; the
> next minor milestones are 2.1, 2.2, 2.3, and the next majors are 3.0 and 4.0.
> The portfolio view is [../../docs/portfolio-roadmap-v2.md](../../docs/portfolio-roadmap-v2.md).
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned.

## 1. Vision

The agent with the guardrails off, priced honestly: a small page at
`uc.genie.innotel.us` that takes a prompt, spends one credit, and streams Genie's
answer — plus a studio, a preview and a ship button, with the money and the
identity handled by the services that already own them.

```
browser ──▶ oauth2-proxy ──▶ g0dm0d3 ──▶ Genie     /api/chat          (SSE relayed)
                                 ├──────▶ OmniRoute /v1/chat/completions (studio, per-user key)
                                 └──────▶ Distro    /api/internal/...   (credits, identity, quota)
```

## 2. 2.0.0 — shipped baseline `[x]`

- `[x]` **One credit per run**, charged in the Distro control plane before
  anything happens; a run that never produced a byte is refunded under
  `refund-<run id>`, idempotently.
- `[x]` **The run id is the idempotency key** — a double submit, a retry or a
  reloaded tab charges once.
- `[x]` **Sign-in is the family's SSO**, and only when the deployment says the
  proxy is in front: with `G0DM0D3_TRUST_PROXY_HEADERS` unset every request is
  refused.
- `[x]` **Per-user gateway key** — the studio calls `/api/gateway/v1/…` on this
  origin; this app attaches the key Distro issued to the address, checks quota and
  records usage. The browser never holds a key.
- `[x]` **The model lists are the gateway's catalog** — race tiers and judge chain
  fill from `/api/gateway/v1/models`, so a retired model disappears without a
  deploy.
- `[x]` **Preview and ship** — the project's dev server proxied on this origin,
  and a ship path that adopts the workspace as a project and pushes it.
- `[x]` **Plan gate on both the page and the route** — a non-subscriber is offered
  the plans; an unaskable billing service gets a reload, never a paywall.
- `[x]` Refusals are specific: 400/401/402/403/502/503 with the body a page can
  act on.

**2.0 exit:** a signed-in person with a plan runs a prompt, sees it stream, and
the ledger shows exactly one credit spent against their own key — and a run that
never started shows a refund.

## 3. Next

### 2.1 — Run history `[ ]`

**Goal:** a run is a thing you can find again.

- `[ ]` A durable list of a person's runs with prompt, model, cost, duration and
  the artifacts they produced.
- `[ ]` Exit: a run from last week is inspectable without the browser tab.

### 2.2 — Replay & diff `[ ]`

- `[ ]` Re-run a past prompt against a chosen model and diff the files/answer.
- `[ ]` Exit: a replay never double-charges and the diff is stored beside the
  original.

### 2.3 — Team credits `[ ]`

- `[ ]` Pools and per-team quotas on the existing ledger (no second ledger).
- `[ ]` Exit: a team's spend is attributable per person and capped per pool.

### 3.0 — Snapshot/rollback workspace `[ ]`

- `[ ]` Every run snapshots its workspace; a person can roll back to any run.

### 4.0 — Delegated autonomous runs `[ ]`

- `[ ]` Time-boxed runs under signed consent, still metered and still attributed.

## 4. Boundaries

- The money lives in the control plane; this app holds no ledger and no model key
  of its own.
- A header anyone can set is not a login; the proxy is trusted only when the
  deployment says so.
- Once bytes have streamed, a run is not refunded: "stop" must not be a way to get
  free runs.
