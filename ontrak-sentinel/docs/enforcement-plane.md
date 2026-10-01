# The enforcement plane: making a block reach something that can drop a packet

Sentinel decides, approves, records and audits a prevention action — and, on its own,
touches no network. The **enforcement plane** is the other half: the seam that turns an
`ACTIVE` record into a filtered packet at a firewall, an EDR agent or a proxy.

This is the operator's side of it: what the plane is told, what it must answer, how to
configure one, and the parts that are deliberately yours to write. For the design and the
reasoning, see S4 in [../ROADMAP.md](../ROADMAP.md) and `enforcement-plane.ts` beside
`enforcement-service.ts`.

## Before you start

- **Prevention is an administrator's action, and the plane does not change that.** Who may
  propose, who must approve, what the safe-list protects and how large an action may be are
  the *decision's* rules, and they are enforced before a plane is ever consulted.
- **A plane is optional.** With `SENTINEL_ENFORCEMENT_PLANE_URL` unset there is no plane,
  which is the shipped default: every action is still one an operator can take and undo from
  `/console/enforcement`, nothing claims a packet was filtered, and the startup log says so.
  Nothing else changes.
- **A plane never throws and never vetoes.** It answers with an outcome. An unreachable
  firewall, a refusing plane and a broken adapter all leave the action `ACTIVE` and write an
  `enforcement.plane.failed` row. The block is what was decided and approved; a plane that
  did not answer is a fact about the plane, and an operator is told it rather than protected
  from it.

## 1. Configure a plane

```bash
SENTINEL_ENFORCEMENT_PLANE_URL=https://firewall.innotel.us/sentinel/enforce
# Optional: sent as `Authorization: Bearer …` when set
SENTINEL_ENFORCEMENT_PLANE_TOKEN=…
# Optional: how long to wait before treating the plane as unreachable (default 5000)
SENTINEL_ENFORCEMENT_PLANE_TIMEOUT_MS=5000
```

At startup the console prints which plane this deployment has, or that it has none:

```
[sentinel] enforcement plane: http:firewall.innotel.us
[sentinel] enforcement plane: none configured — actions are recorded and reversible, but nothing filters packets
```

## 2. What the plane receives

One `POST` per operation, `Content-Type: application/json`, to that single URL.

**Apply** — an action has become `ACTIVE` (either immediately, under a policy that does not
require a second approver, or at the moment the second approver approves it):

```json
{
  "op": "apply",
  "action": {
    "id": "…", "organizationId": "…", "action": "BLOCK",
    "state": "ACTIVE", "targets": [{ "kind": "ADDRESS", "value": "203.0.113.9", "label": "the C2 host" }],
    "alertId": "…", "reason": "Beaconing to a known C2 address every 30 seconds.",
    "requestedById": "…", "approvedById": "…", "appliedAt": "…", "expiresAt": "…"
  }
}
```

**Lift** — the action was released, by hand or by its own TTL, with the plan computed when it
was decided:

```json
{ "op": "lift", "action": { "…": "the same record, now LIFTED" },
  "plan": { "kind": "LIFT", "action": "BLOCK", "targets": [ … ], "at": null, "label": "lift this block" } }
```

The whole record travels rather than a summary, on purpose: a firewall's own log is
*evidence* only if it can be joined back to the decision that put the block there — which
action, which alert, which administrator approved it.

## 3. What the plane must answer

A `2xx` with a JSON body. Anything else is the plane's refusal, and its own words are kept:

```json
{ "ok": true }
{ "ok": false, "error": "target is on our own protected list" }
```

A non-`2xx` status, a body that is not JSON, and a timeout, DNS failure or refused
connection are all one outcome — the plane did not answer — and the chain records the
reason (the first 200 characters of a `4xx` body are kept, because that is usually the only
thing that says *why* a target was rejected).

Every call lands on the organization's evidence chain as `enforcement.plane.apply`,
`enforcement.plane.lift` or `enforcement.plane.failed`, naming the plane, the operation and
what it answered. **"The block is approved" and "the block reached something that can drop a
packet" are different claims**, and the chain is where the second one is answerable.

## 4. What is deliberately yours

- **The adapter.** A JSON `POST` is small enough that an EDR, a switch ACL, a proxy or a
  firewall is a short piece of the operator's own — the same shape every telemetry source
  already uses — and the contract a plane needs is `EnforcementTarget` and nothing more. A
  vendor-specific adapter in this repository would be a filter pretending to be a seam.
- **The dry run.** `RecordingEnforcementPlane` keeps what it was told and does nothing with
  it. A deployment that wants the path exercised without a firewall — rehearsing an incident,
  or proving the seam after a change — runs that one. It answers `ok` on purpose: it did what
  it was asked, which was to record.
- **A measured time-to-prevent.** S4's exit names a defined latency; nothing in this build
  times the path from detection to an `ACTIVE` record reaching a plane. That measurement is
  the deployment's, because it is dominated by the firewall's own apply time.
