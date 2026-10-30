# Changelog — Ontrak ITS / the training range

## Unreleased — OnTrak Bolt is published

`bolt.ontrak.technology` is the family's eighth name and its seventh product: the app
builder, running from `docker-compose.all.yml` (`bolt-app`) beside Genie. It is not
reachable directly. `bolt-app` publishes no port and `bolt-sso` — an oauth2-proxy against
the same `ontrak` OIDC client as the portal, gated to `ontrak-sysadmins` and
`ontrak-admins` — holds the port the edge forwards to, because the builder has no
account model of its own and spends the deployment's gateway key on every turn. Its
gateway key is `cerulean/ontrak/bolt#OMNIROUTE_API_KEY` in Cerulean Vault, resolved by
the image's entrypoint; the proxy's three credentials are `cerulean/ontrak/bolt-sso`,
resolved by `scripts/deploy.sh`. `docs/family-operations.md` carries the row, the name,
and the callback (`https://bolt.ontrak.technology/oauth2/callback`).

## 2.0.0 — 2026-10-24

The family re-baseline. Everything shipped to date — the simulators and grading,
real bash drivers, the ported lab, SSO/SCIM/LTI, the public API and webhooks,
certificates and the cohort packet, the learning loop and the localization
mechanism — is now **2.0.0**, and the roadmap versions the next work as 2.1
(authoring at scale), 2.2 (assessment depth), 2.3 (content/locales), 3.0
(enterprise) and 4.0 (open credentials). No code changed in this release; the
version and the roadmap move so all nine products share one comparable line. See
[ROADMAP.md](ROADMAP.md) and [docs/portfolio-roadmap-v2.md](docs/portfolio-roadmap-v2.md).

## 0.2.0 — 2026-10-19

A family release-train bump: this product's code is unchanged in this release, and
the version moves so the seven names carry one comparable line. The work behind it
is in the shared surfaces these products sit on — the Engineer add-on and its
credit ledger, G0DM0D3, Genie's trusted-actor path, and the Network names that
front them (`re.ontrak.innotel.us`, `uc.genie.innotel.us`).

the training range: scenarios, sessions, the range console

## 0.1.0

The product as it first shipped.
