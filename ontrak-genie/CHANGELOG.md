# Changelog

## 0.3.0 — 2026-10-19

### Added

- **OnTrak Engineer, as a metered add-on.** `src/engineer.ts` plus
  `GET /api/engineer` and `POST /api/engineer/charge`: one credit per project at
  $5 a credit, priced by Magnate and spent against the balance the Distro control
  plane holds. The project id is the idempotency key, so a retry, a reload or a
  second tab charges once; a refusal is a 402 the page can act on, an unreachable
  plane is a 503 it can retry, and a deployment with no control plane keeps
  working unmetered (`gated: false`). 10 tests.
- **A service may act for a person** (`TRUSTED_ACTOR_HEADER`, off by default).
  `src/actor.ts` resolves `x-genie-actor` against the control plane, so a request
  holding the shared bearer runs the turn under the *named* account's own subject,
  workspace, quota and gateway key — never an invented identity, and never an
  account that does not exist. See `G0DM0D3`, the page in front of it. 12 tests.
- The API scope and the chat turn now resolve the caller through one
  `callerFor()`. They had begun to disagree: the scope asked `sessionFrom`, so an
  actor request was refused with "sign in" before the chat route — which does
  understand actor callers — was reached at all.

### Notes

- The edge now serves this console at `re.ontrak.innotel.us` as well, which is
  where the Engineer add-on is reached from. That name is a Network change
  (`ontrak-provision.py`), not a change to this program.

## 0.2.0

The console as it stood before the metered add-on: projects, snapshots, previews,
approvals, the shared tenancy gate and the model chain.

