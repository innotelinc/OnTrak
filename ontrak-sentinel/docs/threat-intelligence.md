# Threat intelligence: judging an alert against a feed

Sentinel Guard's rules answer *what happened*. A feed answers the other half of the
question — *have we seen this before, and does anybody else think it is bad?* — by
joining an observation to a list of indicators somebody has already decided is worth
watching: IPv4 and IPv6 addresses, CIDR blocks, domains, URLs and MD5/SHA-1/SHA-256
digests.

This is the operator's side of it: the paste format, what a match does and does *not*
do, who is allowed to write a feed, and the parts that are deliberately not here yet.
For the design and the reasoning, see S3 in [../ROADMAP.md](../ROADMAP.md) and the
`threat-intel-*` modules described in [../README.md](../README.md).

## Before you start

- **You need an administrator session in the console.** Adding and withdrawing
  indicators both require `canManagePolicies`, the same permission that governs the
  policy pages — a feed decides how detections are judged, which is a policy act.
  Reading the list needs only `canReadDirectory`, so a role that may read the directory
  may read what is watched without being able to change it.
- **Nothing is configured for this.** Unlike the Guard ingest surface, threat
  intelligence needs no token and no environment variable: the service is built with
  the rest of the console, and an empty list is a valid state (a feed that has told us
  nothing cannot raise anything, which is the correct behaviour and an empty security
  posture).
- **No feed is pulled automatically.** A row gets in because a person pasted it, or
  because something called `ThreatIntelService.ingest`. STIX/TAXII transport is S6 work
  (see *What is deliberately absent* below).

## 1. Paste a feed

Open `/console/intel` and use **Add indicators**. Every line is one indicator, and the
fields after the value are separated by a pipe:

```
# a header line is skipped
203.0.113.9
*.bad.example | 80
44d88612fea8a8f36de82e1278abb02f | 90 | CRITICAL | 2027-01-01
```

| Position | Field | Required | Accepts |
| --- | --- | --- | --- |
| 1 | `value` | yes | an address, CIDR block, domain, URL or digest |
| 2 | `confidence` | no | 0–100; defaults to the confidence floor, 60 |
| 3 | `severity` | no | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| 4 | `expires` | no | an ISO instant, or a bare `YYYY-MM-DD` |

Four decisions in that format are worth knowing before a line is refused:

- **A pipe separates, not a comma.** A URL can contain a comma and a CIDR cannot
  contain a pipe, so the delimiter that cannot appear in the value is the one that is
  safe.
- **A blank line and a `#` comment are skipped, not refused.** A feed file with a
  header is a normal feed file, and reporting its comments as bad rows would train an
  operator to ignore the refusal list.
- **A field may be left empty.** `value || CRITICAL` sets the severity and not a
  confidence, because that is what the person meant.
- **A bare date expires at the *end* of that day.** "expires 2027-01-01" is how a person
  writes "stop using it after the 1st"; reading it as midnight at the *start* of the day
  would withdraw the indicator a day early.

## 2. What the value is classified as

The kind is worked out from the shape of the value — you do not have to say it, and
saying the wrong one is refused rather than quietly corrected:

```
CIDR → IPv4 or IPv6 → digest by length (32/40/64 hex) → URL → domain
```

A stated `kind` that disagrees with the value is an error, because a feed that labels an
address as a domain has a bug and re-labelling it silently would hide it. A value that
cannot be classified at all — prose, `localhost`, `203.0.113.999`, `10.0.0.0/33` — is
refused by name.

The row's id is derived from the kind and the canonical value, not generated. That is
what makes re-ingesting a feed an **update rather than a duplicate**: a feed polled
hourly for a year is a table that reflects the feed, not a table that grew by its size
every hour. When two feeds name the same address it is one row, and the provenance is
the feed that spoke last.

## 3. What a match does

**A match does not raise an alert.** "This address is on a list" is not a claim that
anything happened, and an alert that says only that is one nobody can action. What a
match does is change how an *existing* detection is judged, and the alert then keeps:

- the indicator and its canonical value,
- the feed it came from,
- the confidence and the feed's own severity,
- the field that matched — `sourceAddress`, `destinationAddress`, or the named
  attribute the sensor put it in (a DNS query log names its resolver in a field, not in
  the five-tuple), and
- whether it escalated.

An alert that is already raised keeps its matches even after the indicator is withdrawn,
so the escalation can still be reviewed against the list that produced it.

The severity rules are deliberately conservative:

- **An expired indicator never matches.** Curation is a gift with a date on it: an
  address is reassigned, a domain is re-registered, and a list nobody pruned reports the
  innocent for years. Expiry is enforced in the matcher rather than by a sweep, so there
  is no window in which the sweep has not run yet.
- **Below the confidence floor (60) a match only annotates.** A fifty-source feed and a
  hobby list are not equally worth waking somebody for.
- **A feed's severity is only ever a floor.** A feed that says `LOW` about an address
  this deployment's own rule called `CRITICAL` is not evidence for a downgrade, because
  the rule saw the behaviour and the feed has only read about the address. A feed without
  an opinion still says "somebody has already met this address", which lifts a `LOW` or a
  `MEDIUM` detection to `HIGH`.
- **An unmatched `*.` is not a subdomain grant.** `*.bad.example` means the domain *and*
  anything under it. Anything else matches one host exactly: a feed that says
  `bad.example` is not claiming its subdomains are bad, and pretending it did is how a
  shared-hosting neighbour becomes an incident.

## 4. Withdrawing an indicator

Every row on `/console/intel` has its own **Withdraw** button. Both an ingest and a
withdrawal land on the organization's evidence chain (`guard.intel.ingested`,
`guard.intel.withdrawn`), and the withdrawal records the value, the kind and the feed —
not merely that something was removed, because "was this address ever watched, and when
did we stop?" is a question an auditor asks.

There is deliberately **no "clear the feed" button**. A named withdrawal is a decision
somebody can be asked about; a bulk erase is what a panicking operator reaches for at
03:00 and regrets at 09:00.

## 5. Reading it from a script

The console takes form posts, and the session travels in the `sentinel_session` cookie
(or the `X-Sentinel-Session` header). `npm run serve` prints the cookie line that gets a
browser — or a script — into the console.

```bash
COOKIE='sentinel_session=<the value printed at startup>'
BASE='http://127.0.0.1:8787'

# What is watched: totals by feed and by kind, and how many rows carry no expiry.
curl -sS -b "$COOKIE" "$BASE/console/intel" | grep -o 'indicator(s)[^<]*'

# A paste. The report renders in place, so a refusal is readable rather than hidden
# behind a redirect.
curl -sS -b "$COOKIE" -X POST "$BASE/console/intel/feed" \
  --data-urlencode 'source=abuse-ch' \
  --data-urlencode 'rows=203.0.113.9
*.bad.example | 80' | grep -o 'new indicator(s)[^<]*'

# A withdrawal is a redirect back to the list.
curl -sS -i -b "$COOKIE" -X POST "$BASE/console/intel/indicator/withdraw" \
  --data-urlencode 'indicatorId=ipv4-1a2b3c4d' | head -1
```

A row that will never match anything is refused by name and **not stored** — a row that
reads as protection and matches nothing is worse than no row at all — and the refusals
are listed in the page's report card, by line where the line was unreadable and by value
where the classifier refused it.

## What is deliberately absent

- **No STIX/TAXII transport and no automatic refresh.** A feed is pasted by a person or
  posted to the service; a subscription that polls a TAXII collection is S6 work. The
  indicator model and its matcher are the part that carries over.
- **No scheduled expiry sweep.** Expiry is enforced where the list is read, in one place,
  which is what makes a sweep unnecessary rather than merely postponed.
- **No feed-level enable/disable and no bulk import from a file or URL.** Withdrawal is
  per indicator today; a feed that turns out to be wrong can at least say which rows it
  withdrew.
- **No triage UI.** The match lands on an alert and is readable in the store; acting on
  that alert from the console is not built.
- **No detection from a feed alone.** By design: an indicator never raises an alert of
  its own, only changes how one that already fired is judged.
