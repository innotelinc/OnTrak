# Guard's syslog listener

Guard detects from telemetry it is handed. Until this, "handed" meant a sensor
posting a batch to `POST /guard/v1/events` — which makes the product a library
that something else has to drive. The listener is the part that stays open: it
binds a socket, frames what arrives, and feeds the same ingest path a relay's
POST goes to, so there is one door into detection rather than two.

```
  a device ──syslog/udp──▶ Sentinel ──▶ normalizer ──▶ rules ──▶ alerts
                                                                  └─ evidence chain
```

## Turning it on

```ini
SENTINEL_GUARD_TOKEN=<the deployment's ingest token>   # ingest must be on at all
SENTINEL_GUARD_ORGANIZATION=acme                        # which tenant these frames are
SENTINEL_GUARD_SYSLOG_PORT=5514                         # unset: no listener
SENTINEL_GUARD_SYSLOG_HOST=0.0.0.0                      # default 127.0.0.1
SENTINEL_GUARD_SYSLOG_TRANSPORT=both                    # udp | tcp | both
SENTINEL_GUARD_SYSLOG_SENSOR=relay-1                    # used when a frame names no sender
SENTINEL_GUARD_SYSLOG_MAX_LINE_BYTES=8192               # a longer line is dropped and counted
```

`SENTINEL_GUARD_SYSLOG_PORT` unset means no listener, which is the default: a
socket nobody asked for is a socket somebody finds.

**A port without an organization is a refusal at boot, deliberately.** A syslog
frame has nowhere to put an organization slug, so a listener that guessed would
file one tenant's traffic under whoever's name it happened to pick — and the
whole point of the ingest surface is that the caller does not choose the tenant.

The listener is mounted only when ingest is: without `SENTINEL_GUARD_TOKEN` there
is nothing to hand events to, and a socket that reads its input only to discard it
is worse than no socket.

## What arrives, and what is dropped

One line is one event, free text with the structured payload after it — the shape
`toObservedEventFromSyslog` already reads:

```
<134>1 2026-10-01T04:00:00Z sensor-7 app 4711 - - {"sourceAddress":"10.0.0.9","sourcePort":51234,"destinationAddress":"10.0.0.20","destinationPort":23,"protocol":"tcp"}
```

- **UDP**: one datagram is one frame. Its newline-separated lines are all events,
  and a trailing line without a newline is flushed rather than held for a next
  datagram that is a different frame entirely.
- **TCP**: a read is not a message boundary, so the remainder of an incomplete
  line is carried to the next read.
- **Over the ceiling** (`SENTINEL_GUARD_SYSLOG_MAX_LINE_BYTES`, 8 KiB): the line
  is dropped whole and counted. Truncating it would produce a parse error that
  reads like the sender's bug, and buffering it is the memory a peer could take.
- **Nothing throws.** A malformed frame, a refused event, a peer that vanishes
  mid-line: each is a counter in `stats()` and a line in the log. A listener that
  dies on bad input is a listener an attacker can switch off.

## Where it listens, and why that is the access control

Syslog has no authentication — that is the protocol, not an omission — so the
listener's protection is **the address it binds**. The default is `127.0.0.1`:
point a relay on the same host at it, and put the relay's authentication in front
of anything wider.

Binding `0.0.0.0` is a deployment saying "a relay in front of this authenticates".
It is a legitimate deployment and it is what a family stack does, because kernel
and firewall syslog has to come from somewhere else on the network — but it is one
variable and it is stated here rather than being the default nobody noticed.

What the events then do is not unguarded: the frame's address is resolved against
live sessions for correlation, the rules judge it, dedupe buckets repeats, and the
alert lands on the organization's evidence chain. A sender that can reach the port
can add events to *that* tenant's alert queue and nothing else.

## Checking it is alive

```bash
# from another host on the network, with the listener bound to 0.0.0.0
printf '<134>1 - - - - - - {"sourceAddress":"10.0.0.9","destinationAddress":"10.0.0.20","destinationPort":22,"direction":"INBOUND"}\n' \
  | nc -u -w1 <host> 5514
```

Then read the console's alert queue: a scan-shaped burst becomes one alert, not
one per packet, because the dedupe key is derived from what the event *is* — the
five-tuple plus a minute bucket.

If nothing arrives, the two things to check are the two that are easy to get
wrong: that `SENTINEL_GUARD_TOKEN` is set (no token, no listener), and that the
port is published (`docker compose` needs the mapping; a listener inside a
container is not reachable because it bound `0.0.0.0` in there).
