# Guard's OTLP receiver (OpenTelemetry)

Guard detects from telemetry it is handed, and it is handed telemetry three ways:
a sensor posting the family's own batch to `POST /guard/v1/events`, the syslog
listener, and the flow listener. The third protocol here is the one that is
*structured by design* — OpenTelemetry — because an agent that already ships logs
and spans to a collector should be able to point at Sentinel by changing a URL
rather than by writing an adapter.

```
  an OTel agent ──OTLP/HTTP──▶ Sentinel ──▶ normalizer ──▶ rules ──▶ alerts
                                                                     └─ evidence chain
```

It rides the existing HTTP listener, so it needs **no port and no new variable**:
it is mounted whenever the ingest surface is, and it authenticates with the same
deployment token.

## Turning it on

```ini
SENTINEL_GUARD_TOKEN=<the deployment's ingest token>   # ingest must be on at all
SENTINEL_GUARD_ORGANIZATION=acme                        # which tenant these records are
```

That is the whole configuration. Point an exporter at:

```ini
# An OpenTelemetry Collector exporter
exporters:
  otlphttp/sentinel:
    endpoint: https://id.example/guard/v1/otel
    headers:
      Authorization: "Bearer ${SENTINEL_GUARD_TOKEN}"
      X-Sentinel-Organization: "acme"
```

The receiver answers `200` on success with the family's own `accepted` / `refused` /
`alerts` report — an OTLP client ignores fields it does not know, and an operator
reads them. When some records were refused it also adds OTLP's own `partialSuccess`
object, so an exporter that inspects the response sees the shape it expects. A bad
token is `401`, and a body that is not an OTLP export is `400` with the reason.

## What is read

`POST /guard/v1/otel` accepts the OTLP/HTTP **JSON** encoding of both:

- **logs** — `resourceLogs[].scopeLogs[].logRecords[]`
- **traces** — `resourceSpans[].scopeSpans[].spans[]`

Metrics are deliberately not read: a metric is an aggregate over time and has no
five-tuple, so there is no honest `ObservedEvent` to make of one.

Each record is **flattened**, not mapped. The resource's attributes and the record's
attributes are merged into one object, and a JSON `body` string is parsed and merged
under them — exactly the way the syslog listener parses its structured tail. The
result goes through the same `toObservedEvent` every other source uses, so the
normalizer's existing spellings apply with no configuration at all: an agent that
carries `src_ip`, `dst_port`, `protocol` or `direction` as attributes is already
understood.

The exporter's name is taken from `service.name` or `host.name` on the resource and
becomes the event's sensor; with neither, the records are filed under `otel`.

**The kind is never invented.** OTLP does not say whether a record is network, host,
HTTP or auth telemetry, and the normalizer's rule is that a kind is stated or implied
by the source — `OTEL` implies `NETWORK`. An agent that emits host telemetry sets
`kind: HOST` on the record (an attribute, which the normalizer reads), and the
coverage map then reports it against that kind.

## Checking it is alive

The startup log names the path:

```
[sentinel] Guard OTLP:   POST https://id.example/guard/v1/otel (OpenTelemetry logs and traces, JSON)
```

The receiver is off when ingest is off, which is when `SENTINEL_GUARD_TOKEN` is
unset — the same switch as the rest of the surface, and the same reason: an endpoint
that exists only to say "configure me" is one somebody eventually finds a way to
write to.

Convert a record by hand to prove the seam:

```bash
curl -sS -X POST https://id.example/guard/v1/otel \
  -H "Authorization: Bearer $SENTINEL_GUARD_TOKEN" \
  -H "X-Sentinel-Organization: acme" \
  -H 'Content-Type: application/json' \
  -d '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"edge-1"}}]},
       "scopeLogs":[{"logRecords":[{"timeUnixNano":"1760000000000000000",
       "body":{"stringValue":"{\"sourceAddress\":\"10.0.0.9\",\"destinationAddress\":\"10.0.0.20\",\"destinationPort\":23,\"protocol\":\"tcp\",\"direction\":\"OUTBOUND\"}"}]}]}]}'
```

A connection to a plaintext management port raises the same `HIGH` alert the syslog
and flow listeners do — the point of one normalizer is that all three doors lead to
one detector.
