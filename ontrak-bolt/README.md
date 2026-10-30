<div align="center">

# OnTrak Bolt

**The app builder beside Genie: describe an app, watch it build, run it in the tab.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/blob/main/standards/unity/README.md)

</div>

> **Part of the [OnTrak platform](../README.md) — the Innotel Labs ecosystem**

---

**OnTrak Bolt** is the family's **builder**. [Genie](../ontrak-genie/README.md) is the
agent that edits a repository on a server, inside a workspace it cannot leave, with
every command gated behind an approval. Bolt is the other half of that offer: a
prompt, a project, and the running app in the same window — built and executed in a
**WebContainer** in the browser, not in a sandbox on the host.

It is a **vendored product**, not a dependency. The application is
[`innotelinc/bolt.diy`](https://github.com/innotelinc/bolt.diy) at commit
`45b423d`, MIT, checked in here so that a deployment builds a tree this repository
reviewed. What the fork changes is listed below, and it is deliberately short.

---

## Why Bolt, when Genie is right there

| Question | Genie answers | Bolt answers |
| --- | --- | --- |
| *"I have a repository and a task."* | Clone it with your token, edit in place, preview it, open the pull request. | Not its job. |
| *"I have an idea and no repository."* | You would scaffold one first. | Describe it, and the project, its files and its dev server exist in the tab. |
| *"Where does the code run?"* | A container on your server, jailed to a workspace, commands approved one by one. | A WebContainer in the browser: no host, no workspace, no port to publish, nothing to approve because there is no host to damage. |
| *"What does it cost to add a model?"* | A gateway change. | A gateway change — both speak to the same OmniRoute endpoint. |

They are complementary on purpose, and they share the estate's model gateway, so
adding Bolt does not add a second provider account to look after.

## What it is

- **A chat that edits a project** — the model answers with artifacts (files, shell
  commands, diffs) rather than prose, and the project tree on the left is the real
  one.
- **A running app, in the tab** — the project is installed and served inside a
  **WebContainer**, with a preview pane, a terminal and an editor over the same
  files. Nothing is executed on the server, which is why the deployment needs no
  sandbox, no bind mount and no published preview port.
- **Projects that move** — export a project as a zip, import one, or push it to
  GitHub/GitLab; the git routes and the data tab are upstream's and are left wired.
- **A model picker over what the deployment actually has** — every provider Bolt
  knows is still available, and the estate configures exactly one: the OpenAILike
  provider pointed at the family gateway (`OPENAI_LIKE_API_BASE_URL`), whose model
  list is discovered from the gateway rather than hard-coded here.
- **MCP servers**, skills-style connectors and per-provider settings, as upstream
  ships them.

## Provenance, and what this fork changes

| | |
| --- | --- |
| Upstream | [`innotelinc/bolt.diy`](https://github.com/innotelinc/bolt.diy) — a fork of `stackblitz-labs/bolt.diy` |
| Pinned at | `45b423d` (2026-10-30) |
| Licence | MIT — [`LICENSE`](LICENSE), unmodified |
| How it is carried | The tree is copied in, with no submodule and no package dependency: a deployment builds what this repository reviewed, and a re-vendor is a copy plus the notes below |

The changes, and nothing else:

1. **The name and the marks.** `package.json`, the page title/description
   (`app/routes/_index.tsx`), the header wordmark (`public/ontrak-bolt-light.svg`,
   `public/ontrak-bolt-dark.svg`) and the favicon.
2. **The palette.** `app/theme/unity-theme.css` is the family theme, byte-identical
   to `../theme/unity-theme.css` and checked by
   `../theme/tests/test_theme_copies.py`; `app/styles/unity-bridge.scss` re-points
   every `--bolt-elements-*` token at a Unity token. Upstream's own
   `app/styles/variables.scss` is untouched — the bridge is later in the cascade —
   which is what keeps a re-vendor to a copy.
3. **The switch.** `public/unity-theme.js` and `app/components/ThemeToggle.tsx` are
   the family's copies, so the switch in the header is the same control every other
   product has. `app/theme/unity-sync.ts` keeps Bolt's `data-theme` (which its
   `dark:` utilities compile against) and its theme store in step with Unity's mode.
4. **The palette list.** Upstream ships thirty palettes; this ships Unity's six
   states (`desk` · `operations` · `soc` × light · dark) in `app/types/theme.ts`,
   because the bridge means the other twenty-four would be swatches that change
   nothing.
5. **One model source.** `OPENAI_LIKE_API_*` in `.env.example` points at the estate
   gateway. Upstream's sixty-odd vendor keys are not enumerated: a placeholder key
   is a provider that appears configured and fails at the first token.
6. **The container — three defects fixed, not restyled.** Upstream's image does not
   run as shipped, and every fault is silent rather than loud:
   * `pnpm prune --prod` removes `vite`, and `dockerstart` *is* `vite preview` — so
     the container starts, exits with `sh: 1: vite not found`, and restarts. The
     prune stage is gone; the image keeps the full dependency tree.
   * Bolt is a **Cloudflare Worker** build (`workers/app.ts`, `wrangler.jsonc`), and
     `vite preview` runs it in workerd, an isolate that cannot see the container's
     environment. The symptom is a deployment that `printenv`s its gateway key
     correctly and answers `/api/check-env-key` with `{"isSet":false}`: no models,
     no error. `docker-entrypoint.sh` + `scripts/render-worker-vars.mjs` copy the
     three `OPENAI_LIKE_*` values into the `vars` block of `wrangler.jsonc`, which
     the Cloudflare plugin publishes to the worker.
   * A `vault://` reference is resolved before the app starts
     (`scripts/vault-env.mjs`, copied from Genie), so the deployment's key lives in
     Cerulean Vault under the same grammar as the rest of the family instead of as
     plaintext in a `.env`. Never resolved upstream — an unresolved reference arrives
     as that literal string and every turn fails to authenticate.
7. **A curated model list.** `OPENAI_LIKE_API_MODELS` was declared by upstream and
   never read outside its error path. It is now the deployment's allowlist: the
   gateway's `/models` answer is narrowed to the ids named there (1,249 → the four
   routes this estate uses), keeping the gateway's own label and context length, and
   still offering a curated id the catalogue has not caught up with
   (`app/lib/modules/llm/providers/openai-like.ts`, `openai-like.spec.ts`).

   `docker-compose.yml` / `docker-compose.prod.yml` are the family's shape, and
   `electron/`, `e2e-tests/` and `.github/` are not carried — the desktop shell and
   upstream's CI are not this product.

### Every file, so a re-vendor is a comparison and not a memory

Upstream files this fork **edits**:

| path | the change |
| --- | --- |
| `.env.example` | one model source (`OPENAI_LIKE_API_*` at the estate gateway); upstream's vendor-key catalogue is not enumerated |
| `Dockerfile` | Node 24; no `pnpm prune --prod` (it removes `vite`, which `dockerstart` needs); entrypoint and worker-vars copy baked in |
| `README.md` | this file |
| `app/components/@settings/tabs/settings/SettingsTab.tsx` | the palette picker offers Unity's six states, and resolves a `dark` stored before them |
| `app/components/chat/BaseChat.tsx` | takes the deployment's default provider from the models response |
| `app/components/header/Header.tsx` | the family's wordmark instead of upstream's PNG |
| `app/lib/modules/llm/manager.ts` | the gateway is the default provider when it is configured and OpenRouter is not |
| `app/lib/modules/llm/providers/openai-like.ts` | `OPENAI_LIKE_API_MODELS` read as the deployment's allowlist |
| `app/lib/stores/theme.ts` | Unity's mode and Bolt's `dark:` class kept in step |
| `app/lib/stores/workbench-lifecycle.spec.ts` | the `FilesStore` double answers `getFile`/`createFile`, which `_runAction` calls |
| `app/root.tsx` | `unity-theme.css` linked ahead of the bridge; the head script asks Unity for the mode |
| `app/routes/_index.tsx` | title and description |
| `app/styles/index.scss` | `@use 'unity-bridge.scss'` after `variables.scss`, so the bridge wins on source order |
| `app/types/theme.ts` | six Unity states in place of thirty palettes |
| `docs/docs/index.md` | the Node major this tree asks for |
| `package.json` | `name`, `description`, `engines.node` |
| `public/favicon.svg` | the family's mark |
| `vite.config.ts` | preview host allowlist, trusted-IP header, the port, the COOP/COEP headers |

Files this fork **adds**: `.env.production.example`, `docker-compose.yml`,
`docker-compose.prod.yml`, `docker-entrypoint.sh`, `scripts/vault-env.mjs`,
`scripts/render-worker-vars.mjs`, `app/theme/` (`unity-theme.css`, `unity-sync.ts`),
`app/components/ThemeToggle.tsx`, `app/styles/unity-bridge.scss`,
`app/lib/modules/llm/providers/openai-like.spec.ts`, `public/unity-theme.js`,
`public/ontrak-bolt-light.svg`, `public/ontrak-bolt-dark.svg`.

Upstream files **not carried**: `.github/`, `.husky/`, `electron/`,
`electron-builder.yml`, `electron-update.yml`, `notarize.cjs`,
`vite-electron.config.ts`, `e2e-tests/`, `playwright.config.e2e.ts`,
`run-e2e-tests.sh`, `run-e2e-tests.ps1`, `test-workflows.sh`, `.env.production`.
That list is the whole of it: anything else that differs is one of the two lists
above, and a re-vendor that finds a new one has found a decision, not a chore.

### Bumping the pin

The pin lives in the table above (`Pinned at <sha> (<date>)`), and nowhere else — not
in a submodule, not in a lockfile, not in a workflow. Bumping it is the same act as
re-vendoring, and the two are done together:

1. `git clone --filter=blob:none https://github.com/innotelinc/bolt.diy /tmp/bolt-upstream`
   and `git -C /tmp/bolt-upstream checkout <new-sha>`.
2. Copy upstream's changed files in, leaving the two lists above alone.
3. Re-apply the edits from the first table to any file upstream touched, and update
   `README.md`'s *Pinned at* row to the new sha and date **in the same commit**.
4. Run the checklist below before committing; the pin and the tree ship together or
   neither does.

### The re-vendor checklist

Copy-and-reapply, in this order. Each step is a command that either passes or names
the file to look at.

1. **See the diff, and expect exactly it.** From `ontrak-work/`:

   ```bash
   diff -rq --exclude=.git --exclude=node_modules --exclude=dist \
     --exclude=build --exclude=.vitest /tmp/bolt-upstream ontrak-bolt
   ```

   The answer is the tables above: edited files *differ*, added files are *only in
   ontrak-bolt*, the not-carried list is *only in* upstream. A file outside those
   lists is the review.
2. **Copy**, then re-apply the edits. Do not copy `package.json`'s `name`,
   `description` or `engines.node` back to upstream's values, and do not bring back
   `pnpm prune --prod`.
3. **The theme copies are still byte-identical** — `python3 theme/tests/test_theme_copies.py`
   (run from `ontrak-work/`).
4. **Install and typecheck** — `cd ontrak-bolt && pnpm install --frozen-lockfile`
   (commit `pnpm-lock.yaml` if it moved), then `pnpm run typecheck`.
5. **The suite** — `pnpm test -- --no-file-parallelism`, serially because the frame
   budgets in `tests/performance/` measure wall clock.
6. **The image still runs, not just builds** — `docker build --target bolt-ai-production -t ontrak-bolt:revendor .`,
   then run it and ask the two questions that fail silently upstream:

   ```bash
   docker run -d --name bolt-revendor -e PORT=5173 -e HOST=0.0.0.0 \
     -e NODE_ENV=production -e RUNNING_IN_DOCKER=true ontrak-bolt:revendor
   docker exec bolt-revendor node -v                 # the family's major
   docker exec bolt-revendor curl -fsS localhost:5173/api/health
   docker rm -f bolt-revendor
   ```
7. **The family still agrees** — from `ontrak-work/`, `npx tsx --test tests/*.test.ts`,
   which holds `family-stack` (Bolt's row, port and health path), `family-ops` (its
   role table) and `ci-coverage` (the job that runs this suite).

## Running it

```bash
cd ontrak-bolt
cp .env.example .env          # fill in OPENAI_LIKE_API_KEY
docker compose up -d          # http://127.0.0.1:3500/
```

The family stack runs it too (`../docker-compose.all.yml`, service `bolt-app`) beside
Genie, and there it takes its key from `ontrak-bolt/.env` as a `vault://` reference
rather than from a plaintext value in the compose file. In that stack **`bolt-app`
publishes no port**: `bolt-sso` — an oauth2-proxy against the family's `ontrak` OIDC
client, the same one in front of the engineer portal — holds `${ONTRAK_BOLT_PORT:-3500}`, gated to
`ontrak-sysadmins`/`ontrak-admins`. The app answers only on the compose network.

A deployment uses the overlay, which pulls the published image instead of building:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Before you expose it

**It has to be served over HTTPS.** Bolt runs the app it builds in a WebContainer,
which needs `SharedArrayBuffer`, which needs a **cross-origin isolated** page, which
only exists in a **secure context**. Over plain HTTP to a LAN address the console
loads and looks right, and then every WebContainer call fails with
`DataCloneError: … requires self.crossOriginIsolated` — the page is painted and the
builder does not work. Two ways in:

* put it behind TLS (the family edge, a proxy with a certificate), or
* reach it over a tunnel that terminates on your own machine, where `localhost` is
  itself a secure context:
  `ssh -L 3500:192.168.1.21:3500 root@i1`, then open `http://localhost:3500/`.

The compose file and the image already send `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (upstream's own
middleware); the missing piece is the secure context, not the headers.

**Bolt has no sign-in of its own.** Upstream is a local-first builder and ships no
account model; Genie's `WEB_TOKEN` and OIDC tenancy have no equivalent here. Anyone
who reaches it can spend the deployment's gateway key, which is why the family stack
puts its published port on the **proxy** and not on the app: `bolt-sso` is the only
door, `bolt-app` is reachable from nowhere else, and `bolt.ontrak.technology` forwards
to the proxy (see `../scripts/deploy.sh`, which resolves the proxy's three credentials
from Cerulean Vault before compose starts). A bare `docker compose up` here is a
laptop deployment — that one publishes the port with no proxy in front, and it should
stay on `127.0.0.1`.

**The deployment's model list is the deployment's picker.** Upstream opens on
OpenRouter with `claude-3-5-sonnet-latest`; this stack qualifies for neither (it has a
gateway and no OpenRouter key), so `LLMManager.getDefaultProvider()` and
`DEFAULT_MODEL` take the first entry of `OPENAI_LIKE_API_MODELS` instead. Without that
the console opened on a provider that could only answer
`Invalid or missing API key` while the five models it does serve sat one dropdown away.

## Where things are

| path | whose |
| --- | --- |
| `app/`, `public/` (except the two wordmarks and `favicon.svg`), `tests/`, `scripts/`, `workers/`, `docs/`, `types/` | upstream |
| `app/theme/`, `app/components/ThemeToggle.tsx`, `app/components/header/Header.tsx`, `app/styles/unity-bridge.scss`, `app/types/theme.ts`, `app/routes/_index.tsx` | this fork (files 2 and 3 above) |
| `public/unity-theme.js`, `public/ontrak-bolt-*.svg` | this fork |
| `Dockerfile`, `docker-entrypoint.sh`, `scripts/render-worker-vars.mjs`, `scripts/vault-env.mjs`, `docker-compose*.yml`, `.env.example`, `.env.production.example`, `README.md` | this fork |

Upstream's own notes are kept as they shipped: [`FAQ.md`](FAQ.md),
[`CHANGES.md`](CHANGES.md), [`PROJECT.md`](PROJECT.md), and `docs/`.
