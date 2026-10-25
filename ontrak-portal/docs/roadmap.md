# OnTrak Portal — roadmap

> **Re-baselined at 2.0 (2026-10-24).** The shipped front door is **2.0.0**; the
> next minor milestones are 2.1 and 2.2, and the next major is 3.0. The portfolio
> view is [../../docs/portfolio-roadmap-v2.md](../../docs/portfolio-roadmap-v2.md).
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned.

## 1. Vision

One sign-in, then the products a person's role belongs in — and, at 3.0, one page
that says what needs attention across them. The portal decides **where to send
somebody**, never **what they may do there**. Every product authorises the caller
from its own credential; a second authorisation system here would be the more
dangerous of the two.

## 2. 2.0.0 — shipped baseline `[x]`

- `[x]` **SSO-only front door.** Cerulean (Authentik) authorization-code + PKCE,
  the ID token verified against the published JWKS, and issuer, audience, nonce,
  expiry and email verification checked before anything in it is believed. A
  break-glass account exists, is disabled unless configured, and is logged.
- `[x]` **Role-scoped tiles.** `src/lib/portal-rules.ts` is the catalogue and the
  routing rule; a person is never shown a product their role has no business in,
  and a group that matches nothing falls back to `STUDENT` and says so.
- `[x]` **Product health lights.** Each tile probes the product's own
  unauthenticated health endpoint and reports *answering*, *not answering* or
  *not checked* — the third drawn in the same grey as "we could not look", because
  a page of green lights from a broken prober is the failure the family exists to
  avoid.
- `[x]` **Fleet roll-up and group answer-back.** The dashboard groups products by
  role and answers the directory's group claim rather than keeping a second copy
  of who somebody is.
- `[x]` **Password sign-in delegated to OnTrak Sync.** The portal keeps no
  accounts; the form consumes Sync's account table rather than inventing a
  second login.

**2.0 exit:** a person signs in once, sees exactly the products their role
belongs in, and each tile says whether the product is answering.

## 3. Next

### 2.1 — Self-service requests and access reviews `[ ]`

**Goal:** the portal is where an access question starts, not only where a
session starts.

- `[ ]` A person asks for a product or a role from the tile that declined them,
  and the request carries the role and the reason rather than an email to an
  administrator.
- `[ ]` Access reviews initiated from Unity: an administrator sees who holds
  which role and confirms or withdraws it, with the decision audited in the
  product that owns the role.
- `[ ]` **Exit:** a declined request and a completed review both leave an audit
  row naming the actor, and no role is changed by the portal itself.

### 2.2 — Per-organisation branding `[ ]`

**Goal:** the hosted multi-tenant case wears the tenant's face.

- `[ ]` The tenancy's name, mark and accent are applied to the sign-in page and
  the dashboard, resolved from the session after sign-in rather than from the
  hostname or a path segment.
- `[ ]` A tenant's tiles are its products; one deployment can carry more than one
  organisation without a second portal.
- `[ ]` **Exit:** two organisations see their own branding and their own tiles on
  one deployment, and neither can reach the other's.

### 3.0 — The family's operating surface `[ ]`

**Goal:** per-product insight, not only a launchpad.

- `[ ]` **Per-product summaries** read from each product's existing read API —
  open and at-risk tickets, unpatched or Unknown hosts, failed sign-ins, class
  progress — each number carrying the time it was read. A summary is a read; the
  portal still authorises nothing and mutates nothing.
- `[ ]` **Delegated read only.** The viewer's own credential is used where the
  product supports it; otherwise an aggregate-only service credential may read
  counts and never rows. A product that cannot answer is **Unknown**, never zero.
- `[ ]` **A daily needs-attention digest and product status history**, not only a
  live probe: what changed since yesterday, what has been down for longer than a
  probe window, and what nobody has looked at.
- `[ ]` **Exit:** a sysadmin opens one page and sees the three things that need
  attention across products, each linked to the product and timestamped, with a
  silent product shown as unknown.

## 4. What it will never do

- Authorise a product action. The product refuses; the portal only routes.
- Hold accounts, passwords or a second directory.
- Keep a copy of a role that can drift from the group claim.
- Show a number it did not read, or a green light it did not receive.
