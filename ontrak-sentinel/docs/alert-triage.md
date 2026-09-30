# Working the queue

How an operator reads what detection raised, why it is loud, and what it is part of — and
what the deployment must have configured before any of it is true.

Detection (`detection-service.ts`, `detection-rules.ts`) answers *is this an incident* and
*who is it about*. Everything on this page is the second half: what a person does next.
The judgement itself lives in `alert-triage-rules.ts` as pure functions, so what the page
shows is testable without a database, a browser or a session — the same split the rest of
the console uses.

## What has to be configured

| Setting | What it does | Default |
| --- | --- | --- |
| Anything that ingests telemetry | There is no queue to work until an alert exists. `POST /guard/v1/events` is mounted only when `SENTINEL_GUARD_TOKEN` is set. | off |
| `SENTINEL_ADMIN_PASSWORD` | A console login, so a browser can hold a session at all. Without it the console is reached with a session minted by the OIDC flow. | unset |

`SENTINEL_GUARD_ORGANIZATION` names the organization a token ingests for; without it the
token's organization is looked up rather than trusted.

## The queue — `GET /console/alerts`

Open work is the default. `state=OPEN` means `NEW` and `ACKNOWLEDGED`; `CLOSED` is
available but never the default, because a resolved printer ticket beside a live intrusion
is a queue nobody reads to the bottom.

| Parameter | Values | Meaning |
| --- | --- | --- |
| `state` | `OPEN` (default), `ALL`, `NEW`, `ACKNOWLEDGED`, `CLOSED` | Which states to show |
| `severity` | `ALL` (default), `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` | Exact severity, not "at least" |
| `assignee` | `ANY` (default), `MINE`, `NONE`, an identity id | Who owns it. `MINE` is the reader's own, resolved where the comparison happens rather than when the filter is read, so the select reads back as the word that was chosen |
| `identityId` | an identity id | Everything open about one person |
| `address` | an address | Everything open from one address |
| `search` | free text | Rule name, rule id, identity, address, asset, device, note, indicator |
| `alert` | an alert id | Opens that alert's investigation (see below) |

The filter is a **`GET`**, unlike every other form in the console. Narrowing a list changes
nothing, so it belongs in the address bar where it can be bookmarked, shared and reached
with the browser's back button. Acknowledge and close stay `POST`s, which is what makes a
`GET` safe here.

Anything unrecognised falls back to the default rather than erroring: a bookmark that
outlives a deployment which renames a state should show the queue, not a page about a bad
parameter. No value is ever passed through to the store — each is checked against the list
it came from.

The header and the table answer **two different questions**. The header describes
everything the organization has (open, new, acknowledged, closed, per severity, how many a
feed raised, the oldest open sighting, the newest activity, and how many open alerts have
an owner); the table is what the filter selected. A single number would have to pick one,
and the one that gets reported upward is usually the header's.

The owner count is stated separately because it is the number the field exists for: an open
alert nobody owns is one nobody is working, and the header says so in as many words
(`0 open alert(s) have an owner; 1 are waiting for one`) rather than leaving it to be
inferred from a column.

Ordering is part of the rule, not of the store query: **loudest first, then most recent,
then by rule name and id**. Two alerts that share a millisecond still come back in a
stable order, because a list that reshuffles between two page loads makes an operator
re-read rows they have already dismissed.

Age is measured from the **last** sighting, never the first. A burst that is still arriving
is not an ignored alert, and a queue that aged it as though it were would send somebody to
yesterday's incident instead of today's.

## One alert — `GET /console/alerts?alert=<id>`

A link, not a second page, so it can be pasted into a chat. The alert is looked up in the
**unfiltered** list, so it opens for whoever follows the link whatever their queue is
narrowed to. The queue's own filter travels in the URL beside `alert=`, so closing the
panel returns to the list somebody was reading.

It answers three questions:

**What else is this.** `relatedAlerts` finds the open alerts that share the subject's
identity, address, asset, device or dedupe group, tightest relation first, each one naming
the value that relates it — "same address `203.0.113.7`" rather than "a related alert". An
alert that relates on several axes is reported once, on its tightest one, so the list does
not pad itself. A **closed** alert is never a neighbour: an investigation is about what is
open.

**Why is it this loud.** When threat intelligence raised the severity above what the rule
fires at, `escalationSummary` says so in one sentence, naming the indicator, its feed and
its confidence — read from the alert's own record. That is the point: the feed may have
been withdrawn a month ago, and "why is this CRITICAL?" in a review has to be answered by
what the alert was judged on rather than by a live lookup that now returns nothing.
Indicators that matched below `CONFIDENCE_FLOOR` are reported separately, as annotations
that did not change the judgement.

**What happened.** One timeline, oldest first: first seen, each observation kept as
evidence, a repeat, the indicator matches, and the operator's note. Evidence and indicators
share the list on purpose — two tables side by side make a person line the timestamps up
by hand.

## Acting on it

All four actions are `POST`s that answer `303`, so a refresh re-fetches a page rather than
repeating the change. All four require `canReadDirectory` on the actor, which is `ADMIN`,
`AGENT` or `AUDITOR`; a `SERVICE` identity is refused, which is the same rule
`DetectionService` applies to reading the queue.

### `POST /console/alerts/acknowledge`

| Field | Required | Notes |
| --- | --- | --- |
| `alertId` | yes | The alert to acknowledge |
| `note` | no | Free text, recorded on the alert |

Acknowledging says *somebody has seen it*. It does not say it is finished, and it does not
stop a repeat from refreshing the alert underneath it. The page offers it only on a `NEW`
alert; `POST`ing it against an acknowledged one is accepted, because the state change is
the service's rule and re-asking for a state something already has is not a change the
product needs to refuse.

```sh
curl -sS -i -X POST http://127.0.0.1:8787/console/alerts/acknowledge \
  -H "X-Sentinel-Session: $SESSION" \
  --data-urlencode "alertId=$ALERT_ID" \
  --data-urlencode "note=Looking at this now"
```

### `POST /console/alerts/close`

| Field | Required | Notes |
| --- | --- | --- |
| `alertId` | yes | The alert to close |
| `note` | yes | At least three characters, trimmed |

A reason is required because an incident review asks this question and a blank answer is
not one. A shorter note is refused by the service, by name, with `400` — the minimum is a
rule about an incident record and lives with the record rather than in the HTTP layer.

```sh
curl -sS -i -X POST http://127.0.0.1:8787/console/alerts/close \
  -H "X-Sentinel-Session: $SESSION" \
  --data-urlencode "alertId=$ALERT_ID" \
  --data-urlencode "note=Blocked at the edge; the host is being rebuilt"
```

### `POST /console/alerts/assign`

| Field | Required | Notes |
| --- | --- | --- |
| `alertId` | yes | The alert to hand over |
| `assigneeId` | yes | An **active human** identity in this organization |

Handing an alert to one person is the difference between an incident with an owner and two
people acknowledging the same thing. Two of the rules are about people rather than about
permissions, and both are refused by name: a **service identity** cannot own an incident,
and a **deactivated** identity cannot be given one — an alert showing a name that will never
pick it up is invisible to the `unassigned` queue, which is worse than one that says nobody
has it. Offboarding already ends that person's sessions and revokes their tokens; this is
the same fact one level out.

The rule lives in `alert-assignment-rules.ts` and is used by **both** the service and the
picker the page renders (`assignableIdentities` filters through `assignmentRefusal`), so the
list can never offer a name the service would refuse — a refusal an operator met after
choosing a name from a list would read as a bug in triage rather than as a rule.

Both the identity id and its display name at that moment are written to the alert, so a
later rename or offboarding does not rewrite who was asked. An empty `assigneeId` is refused
with `400`. A **closed** alert is refused by name: the row is the record of who worked it and
there is no work left to hand on.

```sh
curl -sS -i -X POST http://127.0.0.1:8787/console/alerts/assign \
  -H "X-Sentinel-Session: $SESSION" \
  --data-urlencode "alertId=$ALERT_ID" \
  --data-urlencode "assigneeId=$IDENTITY_ID"
```

### `POST /console/alerts/unassign`

| Field | Required | Notes |
| --- | --- | --- |
| `alertId` | yes | The alert to give back to the queue |

Unowned is a state, not a gap in the record, so it has its own path rather than being
"assign to nobody": the two read differently on the chain. Clearing the owner clears all
three columns together, so a row can never say `unassigned` while still naming somebody.

```sh
curl -sS -i -X POST http://127.0.0.1:8787/console/alerts/unassign \
  -H "X-Sentinel-Session: $SESSION" \
  --data-urlencode "alertId=$ALERT_ID"
```

All four land on the organization's evidence chain as `guard.alert.acknowledged`,
`guard.alert.closed`, `guard.alert.assigned` and `guard.alert.unassigned`, against the actor
who acted, with the note or the new owner. The alert's own escalation is recorded when it is
*raised* (`guard.alert.raised`, `guard.alert.repeated`), including the indicators that moved
its severity and the identity, device and asset it was correlated to.

A repeat is *not* one of these actions. When more of the same telemetry arrives the alert is
refreshed in place and **keeps its owner**: somebody is already working it, and more of the
same is not a reason to hand it back to the queue.

## The posture summary — `GET /console/compliance`

Read-only, and deliberately: a report that could also change one of the controls it
describes would be the report and the thing reported in the same request. It is meant to
be printed, pasted into a ticket and signed, which is why it carries the instant it was
generated.

It reports six controls, each computed from the same rows the product enforces:

| Control | Reads |
| --- | --- |
| A second factor is required before a session is granted | The effective policy of every scope, through the same `policyForRole` a sign-in uses. `WARN` names the scope that does not require one |
| Every active identity has a second factor enrolled | The directory. The count is separate from the policy on purpose: a policy that requires one is not the same as a population that has one |
| An active administrator exists | The directory. `FAIL` when nobody could administer the organization or restore access after a mistake |
| The session policy is stored rather than left at the built-in default | The policy table. `WARN` when no baseline row has ever been written, because the number the login path uses is then the code's default rather than a recorded decision |
| Nothing at `HIGH` or above is waiting in the Guard queue | The alert store, through `triageSummary`. `WARN` when there is a detection pipeline and it is behind; the row says so in words when there is **no** pipeline, which is an absence rather than a clean queue |
| The evidence chain verifies end to end | `IdentityService.auditTrail`, per organization |

An absence is reported as an absence throughout. A deployment with no second factor
enrolled anywhere, no stored baseline, or no detection pipeline gets a `WARN` or a `FAIL`
naming what is missing, because a green tick with a footnote is exactly what a review is
for catching. A role that may not read the trail gets a report that says it cannot assert
anything about the chain, rather than a `null` rendered as success.

Below the controls the page lists every policy scope — the population it governs, how many
of that population have a factor, whether one is required and what the session lifetime and
idle timeout resolve to — and marks each scope that has no row of its own as *inherited*,
so a role that is looser than the baseline is visible rather than accidental. Changing any
of it is on `/console/policies`; the posture page never writes.

## Not here yet, and named rather than implied

- **No suppression or bulk action.** One alert is acknowledged or closed at a time. There
  is no "close everything at this address" and no maintenance window, because both are how
  an alert gets closed without anybody deciding anything.
- **No notification.** Nothing is sent anywhere when a `CRITICAL` alert is raised; the
  queue is a page somebody has to open. Assignment gives an alert an owner, not a way of
  reaching them.
- **No shift view.** The queue can be narrowed to *mine* and to *unassigned*, which is what
  the owner field makes sayable, but there is no roster, no rota and no handover between
  shifts — an alert someone holds overnight stays theirs until they hand it on or close it.

The detection-coverage map, which answers *which rules and sources are silent*, is a page of
its own at `/console/coverage` rather than part of the queue.
