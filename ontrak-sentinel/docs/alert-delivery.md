# Alert delivery: making a raised alert reach somebody

Detection raises an alert and puts it in the queue. That is the right half of the job and the
wrong half of the *product*: a queue nobody is watching is a detector that is formally
working and practically not. The **transport** is the other half — the seam that pushes an
alert to a pager, a chat channel, a ticketing intake or a mail relay, without Sentinel
owning any of them.

This is the operator's side of it: what the transport is told, what it must answer, how to
configure one, and the parts that are deliberately yours to write. For the design and the
reasoning, see S4 in [../ROADMAP.md](../ROADMAP.md) and `alert-notify.ts` beside
`detection-service.ts`.

## Before you start

- **One alert, one notification.** The transport is told when an alert is *created*, not on
  every sighting that refreshes it. A burst is one incident and one message; re-sending on
  every repeat would be the noise that delivery exists to end.
- **A transport is optional.** With `SENTINEL_ALERT_WEBHOOK_URL` unset there is no transport,
  which is the shipped default: alerts are raised into the queue exactly as before, nothing
  claims anybody was told, and the startup log says so.
- **A transport never throws and never vetoes.** It answers with an outcome. A webhook that
  refuses, an unreachable host and a broken adapter all leave the alert exactly where it is
  and write a `guard.alert.notify.failed` row. The alert is what was detected; a transport
  that could not be reached is a fact about the transport, and an operator is told it rather
  than protected from it.

## 1. Configure a transport

```bash
SENTINEL_ALERT_WEBHOOK_URL=https://hooks.innotel.us/sentinel/alerts
# Optional: sent as `Authorization: Bearer …` when set
SENTINEL_ALERT_WEBHOOK_TOKEN=…
# Optional: how long to wait before treating the transport as unreachable (default 5000)
SENTINEL_ALERT_WEBHOOK_TIMEOUT_MS=5000
```

At startup the console prints which transport this deployment has, or that it has none:

```
[sentinel] alert delivery: http:hooks.innotel.us
[sentinel] alert delivery: no transport configured — alerts are raised into the queue only
```

## 2. What the transport receives

One `POST`, `Content-Type: application/json`, to that single URL, of the alert's own summary:

```json
{
  "alertId": "…",
  "organizationId": "…",
  "ruleId": "SG-BEH-002",
  "ruleName": "Credential stuffing",
  "ruleVersion": 1,
  "severity": "CRITICAL",
  "sourceAddress": "203.0.113.7",
  "identityId": "…",
  "identityLabel": "ada@acme.test",
  "device": "idp-01",
  "asset": "auth-service",
  "firstSeenAt": "…",
  "lastSeenAt": "…",
  "occurrences": 6,
  "dedupeKey": "SG-BEH-002@1|203.0.113.7|1",
  "threatIntel": 2
}
```

The **summary** travels rather than the evidence, deliberately: a transport is somebody
else's system, and the observations that made the alert fire stay in the queue they belong
to. What is sent is what a person needs to decide whether to look — what fired, how bad it
is, what it is about, and the `dedupeKey` and `alertId` to find the row by. `threatIntel`
is the number of indicators the evidence matched, so a consumer can see why the alert is
louder than its rule.

## 3. What the transport must answer

A `2xx` means it was delivered. Anything else is the transport's refusal, and its own words
are kept (the first 200 characters of a `4xx` body, because that is usually the only thing
that says *why* a notification was rejected). A non-`2xx` status, a body that cannot be
read, and a timeout, DNS failure or refused connection are all one outcome — the transport
did not answer.

Every delivery lands on the organization's evidence chain as `guard.alert.notified` or
`guard.alert.notify.failed`, naming the transport, the rule and the severity. **"The detector
fired" and "somebody was told" are different claims**, and the chain is where the second one
is answerable.

## 4. What is deliberately yours

- **The adapter.** A JSON `POST` is small enough that a Slack hook, a ticket intake or a
  mail relay is a short piece of the operator's own — the same shape every telemetry source
  already uses — and the contract a transport needs is the `AlertNotification` body and
  nothing more. A vendor-specific integration in this repository would be a pager pretending
  to be a seam.
- **The dry run.** `RecordingAlertNotifier` keeps what it was told and does nothing with it.
  A deployment that wants the path exercised without a pager — after a change, or while
  writing an adapter — runs that one. It answers `ok` on purpose: it did what it was asked,
  which was to record.
- **The mute.** Delivery stops an alert going unheard; it does not stop one being raised.
  Suppression and maintenance windows — the *other* half of S4's "off switch" — are not in
  this build yet, so a known-noisy source still raises a row. See the road map.
