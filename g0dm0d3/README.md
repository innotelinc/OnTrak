# G0DM0D3

A metered front door to **OnTrak Genie**. One credit per run, charged in the Distro
control plane before anything happens, refunded if the run never produced a byte.

It exists so somebody can use the agent without the console: a small page at
`uc.genie.innotel.us`, behind the family's SSO, that takes a prompt, spends a credit,
and streams Genie's answer back.

```
browser ──▶ oauth2-proxy ──▶ g0dm0d3 ──▶ Genie  /api/chat   (SSE relayed)
                                 └──────▶ Distro /api/internal/credits  (balance, spend, grant)
```

## Why it is built this way

* **The work lives in Genie, the money lives in the plane.** This app holds no
  ledger and no model key: it asks Distro for a balance, asks Distro to spend, and
  hands the prompt to Genie. A second ledger here would eventually disagree with the
  first, and the second one is always the one that is wrong.
* **Identity comes from the proxy, and only when the deployment says so.** The
  signed-in address arrives as `x-auth-request-email` from oauth2-proxy. With
  `G0DM0D3_TRUST_PROXY_HEADERS` unset every request is refused — a header anyone can
  set is not a login.
* **The run id is the idempotency key.** A double-submit, a retried `fetch` or a
  reloaded tab charges once, because the plane deduplicates on the reference.
* **A run that never started is refunded.** Genie refusing the turn, or not
  answering at all, gives the credit back under `refund-<run id>` (itself
  idempotent). Once the stream has produced bytes it is not refunded: the work was
  done, and a refund would make "stop" a way to get free runs.

## Endpoints

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true,"product":"g0dm0d3"}` — the portal's light |
| `GET /` | none | the page (it reads the session itself) |
| `GET /api/session` | proxy | identity, balance, credits per run, price per credit |
| `POST /api/run` | proxy | `{message, runId, sessionId?}` → SSE, after one charge |

`POST /api/run` answers, before any stream: `400` for a missing run id or message,
`401` without an identity, `402` with `{balance}` when there are no credits, `502`
with `{refunded}` when Genie refused or was unreachable, `503` when the plane is.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `GENIE_URL` | yes | Genie's base URL, e.g. `http://genie-app:3400` |
| `WEB_TOKEN` | yes in this deployment | the bearer Genie accepts for a service caller |
| `CONTROL_PLANE_INTERNAL_URL` | for metering | Distro's internal origin; unset means runs are unmetered |
| `CONTROL_INTERNAL_TOKEN` | for metering | the issued service credential (`credits:read`, `credits:write`) |
| `G0DM0D3_TRUST_PROXY_HEADERS` | yes | `1` when oauth2-proxy really is in front |
| `G0DM0D3_PRODUCT` | no | ledger product key, default `g0dm0d3` |
| `G0DM0D3_CREDITS_PER_RUN` | no | default `1` |
| `PORT` | no | default `8080` |

## Tests

```sh
npm test          # 11 tests, no network: a fake plane and a fake Genie
```

They pin the parts that are money: no identity means no run, no run id means no
charge, a duplicate run id costs one credit, an empty balance is a 402 that never
reaches Genie, and a refused or unreachable Genie is refunded exactly once.
