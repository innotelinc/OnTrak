/**
 * Detection samples: a labelled corpus of telemetry, one batch per rule this build ships.
 *
 * A rulebook with no sample telemetry is a claim nobody has driven. This module is the
 * opposite: a small, readable set of payloads that a *live* deployment can post to Guard to
 * see the Control center light up, and that the test suite drives the shipped rulebook with
 * to prove each rule still fires on the traffic it names.
 *
 * Three decisions worth stating out loud:
 *
 *  - **It is data, not a script.** The batches are built by a pure function of a clock, so the
 *    same corpus can be posted by `scripts/seed-guard.ts` and evaluated by a test. There is no
 *    second copy of "what a port scan looks like" to drift from the rule.
 *  - **Every batch names the rule(s) it is meant to raise.** `expect` is the assertion: the
 *    test fails if a rule the sample exists for stops firing, and the seed script prints the
 *    same list so an operator can see at a glance which line did not light up.
 *  - **Timestamps are relative, anchored to a minute.** `agoSeconds` is turned into an
 *    absolute `timestamp` against a minute-aligned base, which is what makes the anomaly
 *    samples land in clean one-minute buckets instead of straddling a boundary depending on
 *    when the seed ran.
 *
 * What it is *not*: an attack. It is JSON that a sensor would have sent, with no payload bytes
 * and nothing executable — the same discipline the rest of the telemetry path keeps.
 */

import { TELEMETRY_SOURCES, type TelemetrySource } from "./telemetry-rules";

/** One labelled batch: what a sensor posts, and the rules it is meant to raise. */
export interface SampleBatch {
  /** A short name an operator reads in the seed script's output. */
  name: string;
  /** The source the batch is posted as, and the sensor that reports it. */
  source: TelemetrySource;
  sensor: string;
  /** Rule ids this batch exists to raise. */
  expect: string[];
  /** The payloads, as the ingest surface accepts them. */
  events: Record<string, unknown>[];
}

function event(over: Record<string, unknown>): Record<string, unknown> {
  return { protocol: "tcp", ...over };
}

/** The minute-aligned base the samples count back from, so buckets are clean. */
export function sampleBase(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

/**
 * Every sample batch, newest last.
 *
 * `nowMs` is the clock the samples count back from; the default is the caller's, so a running
 * deployment sees detections "just now" rather than dated to whenever this file was written.
 */
export function sampleBatches(nowMs: number = Date.now()): SampleBatch[] {
  const base = sampleBase(nowMs);
  const at = (agoSeconds: number): number => base - agoSeconds * 1000;

  const auth = (outcome: string, agoSeconds: number, sourceAddress: string, destinationAddress: string) =>
    event({
      kind: "AUTH",
      sourceAddress,
      destinationAddress,
      destinationPort: 443,
      at: at(agoSeconds),
      outcome,
    });

  /** A minute of one event each, then one loud minute at the end. */
  const quietMinutes = (count: number): number[] => Array.from({ length: count }, (_, index) => (index + 1) * 60);
  const anomalyBase = { sourceAddress: "203.0.113.99", destinationAddress: "10.9.0.1", direction: "OUTBOUND" };

  return [
    {
      name: "port-scan — 25 lateral connections to one port",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-BEH-001"],
      events: Array.from({ length: 25 }, (_, index) =>
        event({
          sourceAddress: "203.0.113.50",
          destinationAddress: "10.0.0.5",
          destinationPort: 445,
          direction: "LATERAL",
          at: at(24 - index),
        }),
      ),
    },
    {
      name: "telnet-egress — a plaintext management port",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-SIG-001"],
      events: [
        event({
          sourceAddress: "203.0.113.51",
          destinationAddress: "10.0.0.6",
          destinationPort: 23,
          direction: "OUTBOUND",
          at: at(1),
        }),
      ],
    },
    {
      name: "credential-stuffing — five failures then a success",
      source: "SYSLOG",
      sensor: "idp-collector",
      expect: ["SG-BEH-002"],
      events: [
        ...Array.from({ length: 5 }, (_, index) => auth("failure", 10 - index, "203.0.113.77", "10.0.0.20")),
        auth("success", 4, "203.0.113.77", "10.0.0.20"),
      ],
    },
    {
      name: "auth-spray — twelve failures that never land",
      source: "SYSLOG",
      sensor: "idp-collector",
      expect: ["SG-BEH-003"],
      events: Array.from({ length: 12 }, (_, index) => auth("failure", 12 - index, "203.0.113.88", "10.0.0.21")),
    },
    {
      name: "rdp-exposed — remote desktop answered from outside",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-SIG-002"],
      events: [
        event({
          sourceAddress: "198.51.100.9",
          destinationAddress: "10.0.0.30",
          destinationPort: 3389,
          direction: "INBOUND",
          at: at(1),
        }),
      ],
    },
    {
      name: "lateral-sweep — twelve hosts' management ports in a minute",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-BEH-004"],
      events: Array.from({ length: 12 }, (_, index) =>
        event({
          sourceAddress: "203.0.113.60",
          destinationAddress: `10.0.0.${40 + index}`,
          destinationPort: 5985,
          direction: "LATERAL",
          at: at(12 - index),
        }),
      ),
    },
    {
      name: "credential-dumping — mimikatz on a host",
      source: "EDR",
      sensor: "host-01",
      expect: ["SG-HOST-001"],
      events: [
        event({
          kind: "HOST",
          sourceAddress: "10.0.0.41",
          destinationAddress: "10.0.0.41",
          process: "mimikatz.exe",
          user: "CORP\\j.doe",
          at: at(2),
        }),
      ],
    },
    {
      name: "web-shell-shell — a web server spawned a shell",
      source: "EDR",
      sensor: "host-02",
      expect: ["SG-HOST-002"],
      events: [
        event({
          kind: "HOST",
          sourceAddress: "10.0.0.42",
          destinationAddress: "10.0.0.42",
          process: "bash",
          parentProcess: "nginx",
          at: at(2),
        }),
      ],
    },
    {
      name: "persistence — a scheduled task was installed",
      source: "EDR",
      sensor: "host-03",
      expect: ["SG-HOST-003"],
      events: [
        event({
          kind: "HOST",
          sourceAddress: "10.0.0.43",
          destinationAddress: "10.0.0.43",
          event: "scheduled_task_created",
          at: at(2),
        }),
      ],
    },
    {
      name: "webshell-request — a probe for a known shell path",
      source: "PROXY",
      sensor: "edge-proxy",
      expect: ["SG-HTTP-001"],
      events: [
        event({
          kind: "HTTP",
          sourceAddress: "198.51.100.23",
          destinationAddress: "10.0.0.50",
          destinationPort: 443,
          path: "/shell.php",
          method: "GET",
          status: "404",
          at: at(2),
        }),
      ],
    },
    {
      name: "volume-anomaly — one source's loud minute",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-ANM-001"],
      events: [
        ...quietMinutes(8).map((agoSeconds) =>
          event({ ...anomalyBase, destinationPort: 8443, at: at(agoSeconds) }),
        ),
        // Sixty connections in the final minute, well past the rule's floor of forty.
        ...Array.from({ length: 60 }, () => event({ ...anomalyBase, destinationPort: 8443, at: at(0) })),
      ],
    },
    {
      name: "fanout-anomaly — one source sweeping many destinations",
      source: "NETFLOW",
      sensor: "fw-1",
      expect: ["SG-ANM-002"],
      events: [
        ...quietMinutes(8).map((agoSeconds) =>
          event({ sourceAddress: "203.0.113.98", destinationAddress: "10.9.0.1", destinationPort: 443, at: at(agoSeconds) }),
        ),
        ...Array.from({ length: 20 }, (_, index) =>
          event({ sourceAddress: "203.0.113.98", destinationAddress: `10.0.2.${index + 1}`, destinationPort: 443, at: at(0) }),
        ),
      ],
    },
    {
      name: "listening-port-anomaly — a host that started listening on many ports",
      source: "EBPF",
      sensor: "host-anomaly",
      expect: ["SG-ANM-003"],
      events: [
        ...quietMinutes(8).map((agoSeconds) =>
          event({ kind: "HOST", sourceAddress: "10.0.0.60", destinationAddress: "10.0.0.60", destinationPort: 22, direction: "INBOUND", at: at(agoSeconds) }),
        ),
        ...Array.from({ length: 12 }, (_, index) =>
          event({ kind: "HOST", sourceAddress: "10.0.0.60", destinationAddress: "10.0.0.60", destinationPort: 10000 + index, direction: "INBOUND", at: at(0) }),
        ),
      ],
    },
  ];
}

/** Validate a source name, so a typo in a sample is caught rather than posted. */
export function isSampleSource(value: string): value is TelemetrySource {
  return (TELEMETRY_SOURCES as readonly string[]).includes(value);
}
