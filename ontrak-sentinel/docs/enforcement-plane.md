# The enforcement plane: making a block reach something that can drop a packet

Sentinel decides, approves, records and audits a prevention action — and, on its own,
touches no network. The **enforcement plane** is the other half: the seam that turns an
`ACTIVE` record into a filtered packet at a firewall, an EDR agent or a proxy.

This is the operator's side of it: what the plane is told, what it must answer, how to
configure one, and the parts that are deliberately yours to write. Two planes ship — the
generic JSON `POST` and a Cloudflare access-rules adapter (2.1) — and the rest of the seam
is unchanged. For the design and the reasoning, see S4 in [../ROADMAP.md](../ROADMAP.md) and
`enforcement-plane.ts` beside `enforcement-service.ts`.

## Before you start

- **Prevention is an administrator's action, and the plane does not change that.** Who may
  propose, who must approve, what the safe-list protects and how large an action may be are
  the *decision's* rules, and they are enforced before a plane is ever consulted.
- **A plane is optional.** With neither `SENTINEL_ENFORCEMENT_VENDOR` nor
  `SENTINEL_ENFORCEMENT_PLANE_URL` set there is no plane, which is the shipped default: every
  action is still one an operator can take and undo from `/console/enforcement`, nothing
  claims a packet was filtered, and the startup log says so. Nothing else changes.
- **A plane never throws and never vetoes.** It answers with an outcome. An unreachable
  firewall, a refusing plane and a broken adapter all leave the action `ACTIVE` and write an
  `enforcement.plane.failed` row. The block is what was decided and approved; a plane that
  did not answer is a fact about the plane, and an operator is told it rather than protected
  from it.

## 1. Configure a plane

Two kinds of plane ship, and a deployment configures one of them.

**The generic JSON plane** — one endpoint, one `POST` per operation (section 2):

```bash
SENTINEL_ENFORCEMENT_PLANE_URL=https://firewall.innotel.us/sentinel/enforce
# Optional: sent as `Authorization: Bearer …` when set
SENTINEL_ENFORCEMENT_PLANE_TOKEN=…
# Optional: how long to wait before treating the plane as unreachable (default 5000)
SENTINEL_ENFORCEMENT_PLANE_TIMEOUT_MS=5000
```

**The Cloudflare adapter** (2.1) — the first vendor this build ships, in section 1b.

At startup the console prints which plane this deployment has, or that it has none:

```
[sentinel] enforcement plane: http:firewall.innotel.us
[sentinel] enforcement plane: none configured — actions are recorded and reversible, but nothing filters packets
```

## 1b. The Cloudflare adapter (2.1)

A deployment that runs Cloudflare does not have to write the JSON plane. IP Access Rules
block an address and lift the block again, which is exactly what a `BLOCK` enforcement
action needs:

```bash
SENTINEL_ENFORCEMENT_VENDOR=cloudflare
CLOUDFLARE_API_TOKEN=…          # scoped to edit firewall access rules on that account
CLOUDFLARE_ACCOUNT_ID=…
# Optional: `SENTINEL_ENFORCEMENT_PLANE_TIMEOUT_MS` (default 5000)
# Optional: CLOUDFLARE_API_BASE, for a proxy or a test against a stub
```

Startup prints `[sentinel] enforcement plane: cloudflare:<account id>`. Three rules hold:

- **A named vendor outranks `SENTINEL_ENFORCEMENT_PLANE_URL`**, and a vendor that is named
  but missing a variable builds a plane that *refuses with the reason* rather than falling
  back to "no plane". An operator who configured something must never see the same startup
  line as one who configured nothing; the refusal lands on the chain as
  `enforcement.plane.failed` like any other plane answer.
- **Only what an access rule can express is sent.** A `BLOCK` on `ADDRESS` targets becomes
  one rule per address (`configuration.target` is `ip`, or `ip_range` for a CIDR) with the
  note `sentinel:<action id>` — the join back to the alert, the approver and the evidence
  chain. An action that also names an `IDENTITY` or a `DEVICE` is refused **before anything
  is dialled**, naming the target: a block sent in part is not the block that was approved.
- **A lift finds what a block wrote.** The rule id is remembered for the life of the
  process; after a restart the adapter lists rules by that note and deletes the matches, so
  a TTL survives the process that applied it. A rule that is already gone answers `ok`, so
  a sweep that runs twice does its job once.

The API token is sent as `Authorization: Bearer` and never appears in an outcome, an audit
row or a log line; a vendor refusal keeps the vendor's own sentence (truncated), which is
usually the only thing that says *why* an address was rejected. `CloudflareEnforcementPlane`
is one implementation of `EnforcementPlane` — the generic plane, the dry run and the
recording plane are unchanged, and a second vendor is another implementation of the same
four methods.

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

- **The adapter for a vendor this build does not ship.** Cloudflare's access rules are
  implemented here (`enforcement-vendor-cloudflare.ts`) because they are small, public, and
  a block is the whole contract. An EDR, a switch ACL, a different proxy or another
  firewall is still a short piece of the operator's own — the same shape every telemetry
  source already uses — and the contract a plane needs is `EnforcementTarget` and nothing
  more. Shipping a second vendor adapter would be a filter pretending to be a seam; the
  generic JSON plane and this one exist so a deployment has a real path to either.
- **The dry run.** `RecordingEnforcementPlane` keeps what it was told and does nothing with
  it. A deployment that wants the path exercised without a firewall — rehearsing an incident,
  or proving the seam after a change — runs that one. It answers `ok` on purpose: it did what
  it was asked, which was to record.
- **A measured time-to-prevent.** S4's exit names a defined latency; nothing in this build
  times the path from detection to an `ACTIVE` record reaching a plane. That measurement is
  the deployment's, because it is dominated by the firewall's own apply time.
