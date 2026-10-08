# Guard's flow listener (NetFlow & IPFIX)

Guard detects from telemetry it is handed, and until this it was handed telemetry
two ways: a sensor posting a batch to `POST /guard/v1/events`, and the syslog
listener. Both suit a device that logs. A firewall or a router usually does not
log every connection — it *exports flows*, in a binary format called NetFlow or
its standardised successor, IPFIX. This is the listener that reads those.

```
  a firewall ──netflow/ipfix/udp──▶ Sentinel ──▶ normalizer ──▶ rules ──▶ alerts
                                                                            └─ evidence chain
```

It is one collector socket for all three generations, and it feeds the **same**
`guardService.ingest` a relay's POST goes to — so there is one door into
detection and this is not a second, weaker one.

## Turning it on

```ini
SENTINEL_GUARD_TOKEN=<the deployment's ingest token>   # ingest must be on at all
SENTINEL_GUARD_ORGANIZATION=acme                        # which tenant these flows are
SENTINEL_GUARD_NETFLOW_PORT=2055                        # unset: no listener
SENTINEL_GUARD_NETFLOW_HOST=0.0.0.0                     # default 127.0.0.1
SENTINEL_GUARD_NETFLOW_SENSOR=collector-1               # used when a record names no exporter
SENTINEL_GUARD_NETFLOW_MAX_DATAGRAM_BYTES=65507         # a longer datagram is dropped and counted
```

`SENTINEL_GUARD_NETFLOW_PORT` unset means no listener, which is the default.
`SENTINEL_GUARD_ORGANIZATION` is shared with the syslog listener, and for the same
reason: **a port without a tenant is a refusal at boot**, because a flow record has
nowhere to put an organization slug and a listener that guessed would file one
tenant's traffic under whoever's name it picked.

## What arrives

One UDP datagram is one export message. Three versions share the port:

- **NetFlow v5** — a fixed 24-octet header and 48-octet records, no templates. Still
  exported by plenty of routers, so it is read rather than ignored.
- **NetFlow v9** — template-based: the exporter describes its record layout in a
  template sent separately (and re-sent periodically), then sends data sets against it.
- **IPFIX (v10)** — the standardised version of v9, with a slightly different header.

Every decoded flow becomes the normalizer's own `ObservedEvent` (kind `NETWORK`,
source `NETFLOW` or `IPFIX`), so the rules that judge a syslog frame judge a flow
the same way. The five-tuple is mapped from the IANA field ids; the counters
(`octetDeltaCount`, `packetDeltaCount`), TCP flags, interface indices and AS numbers
are kept as attributes; a field this build does not name is kept by its type id
rather than dropped, so the layout is never shifted.

**Direction is not invented.** NetFlow carries no inbound/outbound flag — only the
interface a flow entered or left on, and the system uptime it started and ended at.
The normalizer's rule is that a direction is stated, never inferred, so a flow
arrives with `direction: null` and its interface indices as attributes. A rule that
needs direction names it and will not fire on flows that do not carry one.

## What is skipped, and why that is the honest answer

- **A data set with no template.** v9 and IPFIX describe records with templates sent
  ahead of them; after a collector restart, or for a template that has not been
  re-sent yet, a data set arrives with no layout. It is **dropped and counted**, not
  decoded by guesswork — a record read at the wrong offsets is fabricated telemetry,
  which is worse than missing telemetry.
- **Two exporters' templates do not share a namespace.** The cache is keyed by the
  observation domain as well as the template id, so two devices numbering their
  templates independently cannot decode each other's records.
- **A version this build does not read** (v1–v4, v8) is a dropped datagram and a
  counter, not an empty export.
- **A datagram over the ceiling** is dropped whole and counted rather than buffered.
- **Nothing throws.** A malformed export, an unknown template, a refused event: each
  is a counter in `stats()` and a log line. A listener that dies on bad input is one
  an attacker can switch off.

## Where it listens

Flow export, like syslog, has no authentication to offer, so the listener's
protection is **the address it binds**. The default is `127.0.0.1`: point a
collector on the same host at it, and put the collector's authentication in front of
anything wider. Binding `0.0.0.0` is a deployment saying "the network in front of
this is trusted" — legitimate for a family stack where the firewall is on another
host, one variable, and stated here rather than being the default nobody noticed.

What the events then do is not unguarded: addresses are resolved against live
sessions for correlation, the rules judge each flow, dedupe buckets repeats, and the
alert lands on the organization's evidence chain. A sender that can reach the port
can add flows to *that* tenant's alert queue and nothing else.

## Checking it is alive

The startup log says which listeners are up:

```
[sentinel] Guard netflow: udp on 0.0.0.0:2055 as “acme”
```

A deployment that set the host's port but sees `off` has the port unset in the
*container's* environment rather than the host's. The two things that are easy to
get wrong are the same two syslog has: that
`SENTINEL_GUARD_TOKEN` is set (no token, no listener at all), and that the port is
published by the compose file (`docker-compose.all.yml` maps
`${SENTINEL_GUARD_NETFLOW_PORT:-2055}/udp`).

Convert it once by hand if you want to prove the seam — a v5 packet is small enough
to build with a script — and then read the console's control center: the flow raises
an alert there beside the syslog events, and the coverage map already lists
`NETFLOW` and `IPFIX` as read.
