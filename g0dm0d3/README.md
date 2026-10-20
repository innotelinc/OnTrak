# G0DM0D3

A metered front door to **OnTrak Genie**. One credit per run, charged in the Distro
control plane before anything happens, refunded if the run never produced a byte.

It exists so somebody can use the agent without the console: a small page at
`uc.genie.innotel.us`, behind the family's SSO, that takes a prompt, spends a credit,
and streams Genie's answer back.

```
browser ──▶ oauth2-proxy ──▶ g0dm0d3 ──▶ Genie     /api/chat          (SSE relayed)
                                 ├──────▶ OmniRoute /v1/chat/completions (studio, per-user key)
                                 └──────▶ Distro    /api/internal/...   (credits, identity, quota, usage)
```

## Why it is built this way

* **The work lives in Genie, the money lives in the plane.** This app holds no
  ledger and no model key: it asks Distro for a balance, asks Distro to spend, and
  hands the prompt to Genie. A second ledger here would eventually disagree with the
  first, and the second one is always the one that is wrong.
* **Identity comes from the proxy, and only when the deployment says so.** The
  signed-in address arrives as `x-forwarded-email` from oauth2-proxy (it accepts
  `x-auth-request-email` too, which is what an nginx `auth_request` deployment gets). With
  `G0DM0D3_TRUST_PROXY_HEADERS` unset every request is refused — a header anyone can
  set is not a login.
* **The studio's models are the family's gateway, and its key is the caller's
  own.** Genie's console has spent a per-person OmniRoute key since `tenancy.ts`;
  the studio used to be the exception, asking every visitor for a personal
  OpenRouter key so the spend landed on their card and the accounting nowhere. It
  now calls `/api/gateway/v1/…` on this origin, and this app attaches the key
  Distro issued to that address, checks their quota, and records what the
  completion cost. The browser never holds a key, and the same three calls Genie
  makes (`identity`, `quota-check`, `usage-report`) are the whole contract — see
  `src/gateway.js`.
* **The model lists are the gateway's catalog.** The page asks this origin for
  `/api/gateway/v1/models` and fills its pickers, its race tiers and its judge
  chain from the ids that come back — there is no vendored provider list to drift
  from what the gateway serves. A model the gateway retires disappears from the
  page; one it adds is offered without a deploy. A local OpenAI-compatible server
  is the only other provider, and only when a person enables it.
* **Sign-in is Genie's.** The API-keys panel has no key to paste: its button
  renews the SSO session in place (`/oauth2/sign_in?rd=…`), and the account it
  returns as is the one the gateway bills.
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
| `GET /` | proxy | 302 to `/index.html`, carrying the query |
| `GET /index.html` | proxy + plan | the product's own page (403 without a subscription, 503 when billing cannot answer) |
| `GET /metered` | proxy | the credit-facing console, which is where a non-subscriber is offered the plans |
| `GET /api/session` | proxy | identity, balance, credits per run, price per credit |
| `POST /api/gateway/v1/chat/completions` | proxy + plan | the studio's completions, through OmniRoute on the caller's own key |
| `GET /api/gateway/v1/models` | proxy | the gateway's catalog, for the same key |
| `POST /api/run` | proxy + plan | `{message, runId, sessionId?}` → SSE, after one charge |
| `POST /api/approve` | proxy | `{id, decision}` → Genie's approval route, with the service bearer |
| `GET /api/preview` | proxy | Genie's preview status for the caller's workspace |
| `POST /api/preview/start` | proxy | run the project's dev server (the command is Genie's to choose) |
| `POST /api/preview/stop` | proxy | stop it |
| `GET /preview/…` | proxy | the running app, byte for byte, on this origin |
| `GET /api/ship` | proxy | where a ship can go, and the project this workspace already is |
| `POST /api/ship` | proxy | `{name, target, message?}` → Genie adopts the workspace as a project, commits and pushes it |

The preview is proxied rather than iframed from Genie: the app's own fetch, cookies
and asset URLs then behave exactly as they will when it is deployed, and the pane
needs no second host, port or certificate. A dev server's absolute runtime URLs
(`/@vite/client`, `/_next/…`) are forwarded too, and its hot-reload socket with
them. `GET /api/ship` and `POST /api/ship` are Genie's project and git work, not
this app's: the terminal has files but no project noun, so the route adopts the
workspace as a project and then uses the console's own publish path.

`POST /api/run` answers, before any stream: `400` for a missing run id or message,
`401` without an identity, `402` with `{balance}` when there are no credits, `403`
with `{subscribeUrl}` when the account has no plan, `502` with `{refunded}` when
Genie refused or was unreachable, `503` when the plane is.

The page is gated like the run, and the gateway route behind it is gated again:
the studio is the product, and a request that came around the page must not reach
the models just because it knows the path. A signed-in account without a plan
gets the plans; an unaskable billing service gets a reload, never a paywall — see
`src/entitlement.js`. The gateway answers `400` without a model, `401` without an
identity, `403` with `{code:"no_account"}` when the plane has never seen the
address, `403` with `{subscribeUrl}` without a plan, `429` with the plane's own
`reasons` when quota refuses, and `503` when the plane or the gateway is
unreachable.

The studio is told where its models are at serve time: with `OMNIROUTE_URL` set,
`/index.html` carries a `window.G0DM0D3_GATEWAY` line naming `/api/gateway/v1`,
and the page fills its model lists from `/api/gateway/v1/models` on load. With it
unset the document is served unchanged and only a local model can be used — there
is no key prompt and no third-party origin.

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
| `OMNIROUTE_URL` | for the studio | the family's gateway, as an OpenAI-compatible base (`https://gateway.innotel.us/v1`) |
| `OMNIROUTE_API_KEY` | no | shared key for a deployment with no plane; empty when Distro issues every key |
| `OMNIROUTE_MODEL` | no | the model a completion asks for when the page names none, default `auto/chat` |
| `PORT` | no | default `8080` |

## Tests

```sh
npm test          # 43 tests, no network: a fake plane, a fake Genie and a fake gateway
```

They pin the parts that are money: no identity means no run, no run id means no
charge, a duplicate run id costs one credit, an empty balance is a 402 that never
reaches Genie, a non-subscriber is offered the plans on the page and on the run,
and a refused or unreachable Genie is refunded exactly once. On the gateway side:
a completion spends the caller's own key, a streamed one has its usage frame
recorded, an address the plane has never seen is a 403 rather than the shared key,
a quota refusal never reaches the gateway, and a deployment with no gateway serves
the page it always did.
