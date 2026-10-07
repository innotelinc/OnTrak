# OnTrak — v1.0 status and v2.0 roadmap (all products)

> One document, every product. It records where each OnTrak product is against its
> own roadmap, confirms the family reached its v1.0 line, and lays out **v2.0** for
> each. The per-product roadmaps (`ROADMAP.md`, `ontrak-tix/ROADMAP.md`,
> `ontrak-sentinel/ROADMAP.md`, `ontrak-genie/docs/roadmap.md`) remain the
> single source of truth for detail; this is the portfolio view.
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned.

---

## 1. Where every product is (2026-10)

| Product | Roadmap line | State | What remains for 1.0 |
| --- | --- | --- | --- |
| **OnTrak ITS** (TrainingOps) | `v1.0` milestone | `[x]` complete | Nothing — v1.0, v1.1, v1.2 and v1.6 all `[x]`. v1.3's exit is met; v1.4/v1.5 are post-1.0 depth, not blockers. |
| **OnTrak Tix** (ServiceOps) | `M0–M6` | `[x]` complete | Nothing — M0–M6 all `[x]`. M7 (intelligence & scale) is `[~]`: assist and analytics shipped, only non-functional hardening remains. |
| **OnTrak Sentinel** (IdP + Guard) | `S0–S4` | `[~]` **effectively done** | Every S4 enforcement item is `[x]` (policy gate, approvals, safe-lists, TTL rollback, enforcement plane, alert delivery, mute, measured time-to-prevent, compliance packet). Only compliance *extras* remain (retention windows, control history, CSV/PDF). |
| **OnTrak Sync** | shipped console | `[x]` | Nothing — the estate updater runs end to end (Scan → Findings → Apply), with SSO and break-glass. |
| **OnTrak Portal** (Unity) | shipped front door | `[x]` | Nothing — one sign-in, role-scoped tiles, product health, group answer-back. |
| **OnTrak Genie** (CodeOps) | `v1.0` milestone | `[x]` complete | Nothing — v1.0 is `[x]`. v0.4's three `[ ]` items (repo-aware workspaces, propose-then-commit review, ONYX hand-off) are pre-1.0 *breadth*, not blockers. |

**Conclusion:** the family is at its **v1.0 line**. The `[~]` markers that remain are
honest "last mile" notes — non-functional hardening (Tix M7), compliance extras
(Sentinel S4), and optional breadth (Genie v0.4) — not missing capability. No
product is blocked from being called 1.0.

---

## 2. Unity sign-in & one identity (shipped this pass)

The family's front doors are now **one screen wearing one theme**.

- **Single sign-on only, everywhere.** Every browser sign-in screen draws exactly
  one control — the hand-off to **Cerulean** (Authentik). There is no
  email-and-password form on any product's primary screen; the local account is a
  break-glass door at an unlinked path (`/sign-in/break-glass`, `/login/break-glass`,
  `/console/sign-in/upstream`) because using it is a decision, not a convenience.
- **Including Sentinel.** Sentinel is the family's IdP, so its console is the one
  login it owns outright — but it now federates to Cerulean too
  (`SENTINEL_UPSTREAM_*`, the standard authorization-code + PKCE flow), and its
  sign-in page presents the provider as the primary control with the console's own
  password demoted below a rule as the fallback.
- **One shape, one theme.** Tix, ITS, Sync and Genie now render the same gate as
  OnTrak Unity: a centred card, the product mark (`OnTrak <Product>`), and the one
  SSO button — no pitch copy, no family taglines. The palette is the shared
  [Unity theme](../theme/README.md); the copy-check guards
  (`ontrak-genie/scripts/copy-check.mjs`, `ontrak-tix` `copy:check`,
  `ontrak-sync/web` `copy:check`) keep taglines and sales copy off the door.
- **Verified:** ITS typecheck + 370 tests; Tix typecheck + 844 tests; Sentinel
  typecheck + 520 tests (including the full upstream SSO handshake); Sync typecheck
  + copy-check; Genie copy-check; the 17-file theme-copy guard.

---

## 3. v2.0 — the enterprise line

Each product's own roadmap already sketches its "after 1.0" direction; this turns
those sketches into one v2.0 portfolio.

### 3.1 OnTrak ITS → v2.0 "Enterprise training platform"
*(drawn from `ROADMAP.md` §4 "v2.0")*
- Multi-tenant organisations with isolated catalogs, branding and reporting.
- BI/warehouse export and scheduled reporting.
- Opt-in AI tutor — hints, misconception detection, scenario suggestions — always
  assistive, never auto-grading.
- Hardening: deeper audit trail, retention controls, SSO/SCIM at org scale.
- **Exit:** two organisations run isolated catalogs and reports under one deployment
  with audited, retained training records.

### 3.2 OnTrak Tix → v2.0 "Evidence-grade ITSM at scale"
- Finish M7 hardening: scale targets under load, backup/DR runbooks, SOC 2-ready
  controls.
- Multi-region / HA for ticket writes; p95 read < 300 ms, write < 500 ms at load.
- Scheduled CSV/PDF exports and a warehouse connector (reporting backlog).
- Config-as-code export/import and environment promotion (admin backlog).
- Deeper assurance: evidence-request portal for auditors, tamper alarms on the
  audit chain, third-party timestamping.

### 3.3 OnTrak Sentinel → v2.0 "Unified risk & response"
*(its own `S5` and `S6`, promoted to v2.0)*
- Identity-aware detection: a login from a new geolocation plus anomalous flows is
  one incident, not two alerts.
- Step-up authentication and session revocation triggered by a detection.
- Playbook-driven response, exporting incidents into Tix with full evidence.
- Enterprise hardening (S6): HA for the data plane and IdP, fleet-scale rollout.
- Vendor adapters for telemetry and enforcement, shipped rather than documented as
  an operator's own JSON `POST`.

### 3.4 OnTrak Sync → v2.0 "Fleet-wide remediation"
- Approval workflows for change windows and maintenance calendars.
- Rollback / canary for a bad apply, with per-host blast-radius caps.
- Deeper inventory: hardware, virtualisation and licence posture, not only packages.
- Multi-tenant estates and per-team scope, matching the family's role model.

### 3.5 OnTrak Portal → v2.0 "The family's operating surface"
- Deeper per-product insight on the tiles, so the front door is a status board, not
  only a launchpad.
- Self-service: requests, entitlements and access reviews initiated from Unity.
- Branding per organisation, for the hosted multi-tenant case.

### 3.6 OnTrak Genie → v2.0 "CodeOps at team scale"
- Repository-aware workspaces (Gitea/Atlas): clone, branch, open a PR from the
  console, under the same jail and gate.
- Propose-then-commit review: a change set a reviewer approves, not one write at a
  time.
- ONYX as the shared artifact store — Genie owns no storage.
- Fleet operations across many workspaces without the operator becoming the
  bottleneck.

### 3.7 Cross-cutting v2.0
- **One identity at scale** — Cerulean SSO + SCIM everywhere, org-scale group
  mapping, enforced MFA visible per product.
- **One evidence standard** — the shared assurance-packet format (already agreed
  between Tix and Sentinel) extended to every product's exports.
- **One theme** — Unity stays the single palette; new surfaces adopt it before
  they ship.

---

## 4. Suggested sequencing

1. **Close the last-mile 1.0 notes** — Tix M7 hardening, Sentinel S4 compliance
   extras. These are documentation and controls, not new capability.
2. **Cross-cutting first** — identity-at-scale and the state board on Unity, because
   every product's v2.0 leans on them.
3. **Per-product v2.0** — Sentinel S5/S6 and Tix scale are the heaviest; ITS
   multi-tenancy and Genie's repo workspaces are the most self-contained.
