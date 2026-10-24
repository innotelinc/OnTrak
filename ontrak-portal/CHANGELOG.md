# Changelog — OnTrak Unity — the portal

## 2.0.0 — 2026-10-24

The family re-baseline. The SSO-only front door, role-scoped tiles, product health
lights and the fleet roll-up are now **2.0.0**, aligned with the nine products the
portal fronts. Next: self-service requests (2.1), per-organisation branding (2.2)
and the operating surface (3.0). No code changed in this release; the lab tile fix
below is included in 2.0.0.

## 0.4.1 — 2026-10-22

The lab tile now links to the lab, not to the front door of the range that serves
it. `ONTRAK_LAB_URL` keeps its path — the family serves the lab at
`https://its.ontrak.technology/lab` — where it used to be cut to its origin, so the
tile opened the training range's home page and a person had to find the lab from
there. A trailing slash is still dropped.

The liveness light follows: an override (`ONTRAK_<KEY>_INTERNAL_URL`) is still a
base that the health path is appended to, path and all, but a product's own
address is probed at its origin — the range's `/healthz` answers for the lab, and
`<url>/lab/healthz` is nothing.

## 0.4.0 — 2026-10-22

The family's addresses moved to `ontrak.technology`. The base domain every tile is
built from now defaults to it — in the catalogue, the config reader, the compose
defaults, the environment template and `health:check` — so a deployment that sets
nothing links at the name that resolves instead of the old `ontrak.innotel.us`.

Three addresses do not move with it and still name their own domain: Genie's two
add-ons stay under `genie.innotel.us` (`re.genie.innotel.us`, `uc.genie.innotel.us`)
and the classroom stays at `classroom.innotel.us`, because those are where the
products are served. The lab is drawn at the address the deployment gives it.

## 0.3.0 — 2026-10-19

Uncensored Godmode joins the dashboard, at `uc.genie.innotel.us` and for the same
people Genie and Engineer are for — sysadmins and builders. The tile is drawn for
`SYSADMIN` and `ADMIN`; the subscription that actually lets somebody run it is
checked by the product, which is where a refusal belongs.

Two products are now reached under Genie's own name rather than the family's base
domain, so the catalogue has a `domain` for the entries that need one. That also
fixes the Engineer tile, which was still pointing at `re.ontrak.innotel.us` after
that name was retired in favour of `re.genie.innotel.us`.

The lab's tone token was missing in both `soc` dark blocks — the tile drew its
colour rule with an undefined value there — and both now carry it.

## 0.2.0 — 2026-10-19

A family release-train bump: this product's code is unchanged in this release, and
the version moves so the seven names carry one comparable line. The work behind it
is in the shared surfaces these products sit on — the Engineer add-on and its
credit ledger, G0DM0D3, Genie's trusted-actor path, and the Network names that
front them (`re.ontrak.innotel.us`, `uc.genie.innotel.us`).

the family portal: one sign-in, then the products a role belongs in

## 0.1.0

The product as it first shipped.
