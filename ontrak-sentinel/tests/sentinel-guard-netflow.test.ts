/**
 * Sentinel S3 tests: the *flow* listener — the second protocol on the network side.
 *
 * The syslog suite proved the shape of "listening": a socket that stays open, frames what
 * arrives and hands each event to the same ingest path a relay's POST takes. This suite is
 * about what is specific to flow export, which is that it is **binary** and has **two
 * generations with different framing**. The ways it goes wrong, and therefore the ways these
 * tests are written:
 *
 *  - **The version is guessed.** v5 has no templates, v9 and IPFIX do, and the two template
 *    headers put the observation domain at different offsets. A reader that mixed them up
 *    would decode one exporter's flows against another's layout.
 *  - **An unknown template is decoded anyway.** A v9/IPFIX record whose template has not
 *    arrived cannot be read by position; decoding it would be fabricated telemetry, so it is
 *    dropped and *counted*.
 *  - **A malformed datagram is fatal.** A listener that dies on bad input is one an attacker
 *    can switch off.
 *  - **A flow is not normalised like the rest.** The decoded record has to reach detection as
 *    the same `ObservedEvent` a syslog frame becomes, or a rule written for the network would
 *    silently miss every flow.
 *
 * The UDP test is real: a socket is bound, a datagram is sent, bytes are written and read. A
 * parser tested only through a function is a parser whose bind, framing and error handling
 * have never run.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";
import { test } from "node:test";

import {
  TemplateCache,
  guardNetflowConfigFromEnv,
  parseNetflowMessage,
  startGuardNetflow,
  type GuardNetflowConfig,
  type NetflowSink,
} from "../src/lib/guard-netflow";
import type { ObservedEvent } from "../src/lib/telemetry-rules";

const PORT = 15_525;
const AT = 1_760_000_000_000;
const SRC = "10.0.0.9";
const DST = "203.0.113.20";

/* -------------------------------------------------------------------------- */
/*  Builders — the wire format, written by hand                                */
/* -------------------------------------------------------------------------- */

function writeIpv4(buffer: Buffer, offset: number, address: string): void {
  const octets = address.split(".").map(Number);
  assert.equal(octets.length, 4);
  for (let index = 0; index < 4; index += 1) buffer[offset + index] = octets[index]!;
}

/** A NetFlow v5 message: a 24-octet header and 48-octet records. */
function v5(
  records: { src?: string; dst?: string; sport?: number; dport?: number; protocol?: number; packets?: number; bytes?: number }[],
): Buffer {
  const buffer = Buffer.alloc(24 + records.length * 48);
  buffer.writeUInt16BE(5, 0);
  buffer.writeUInt16BE(records.length, 2);
  buffer.writeUInt32BE(1_000, 4);
  buffer.writeUInt32BE(Math.floor(AT / 1000), 8);

  records.forEach((record, index) => {
    const start = 24 + index * 48;
    writeIpv4(buffer, start, record.src ?? SRC);
    writeIpv4(buffer, start + 4, record.dst ?? DST);
    buffer.writeUInt32BE(record.packets ?? 3, start + 16);
    buffer.writeUInt32BE(record.bytes ?? 512, start + 20);
    buffer.writeUInt16BE(record.sport ?? 51_234, start + 32);
    buffer.writeUInt16BE(record.dport ?? 23, start + 34);
    buffer[start + 37] = 0;
    buffer[start + 38] = record.protocol ?? 6;
    buffer.writeUInt16BE(0, start + 40);
    buffer.writeUInt16BE(0, start + 42);
  });
  return buffer;
}

/** The IANA field ids the reader understands, named for readability. */
const FIELD = { SRC_IPV4: 8, DST_IPV4: 12, SRC_PORT: 7, DST_PORT: 11, PROTOCOL: 4, IN_BYTES: 1, IN_PKTS: 2 } as const;

/** A template field set: one template describing a small five-tuple record. */
function templateFields(): { type: number; length: number }[] {
  return [
    { type: FIELD.SRC_IPV4, length: 4 },
    { type: FIELD.DST_IPV4, length: 4 },
    { type: FIELD.SRC_PORT, length: 2 },
    { type: FIELD.DST_PORT, length: 2 },
    { type: FIELD.PROTOCOL, length: 1 },
    { type: FIELD.IN_BYTES, length: 4 },
  ];
}

function dataRecord(buffer: Buffer, offset: number, record: { sport?: number; dport?: number; protocol?: number }): void {
  writeIpv4(buffer, offset, SRC);
  writeIpv4(buffer, offset + 4, DST);
  buffer.writeUInt16BE(record.sport ?? 51_234, offset + 8);
  buffer.writeUInt16BE(record.dport ?? 23, offset + 10);
  buffer[offset + 12] = record.protocol ?? 6;
  buffer.writeUInt32BE(4096, offset + 13);
}

/** NetFlow v9: header (20) + a template flow set (id 0) + a data flow set (id 256). */
function v9(domain = 7, includeTemplate = true): Buffer {
  const fields = templateFields();
  const recordLength = fields.reduce((total, field) => total + field.length, 0);
  const templateSet = 4 + 4 + fields.length * 4;
  const dataSet = 4 + recordLength;
  const buffer = Buffer.alloc(20 + (includeTemplate ? templateSet : 0) + dataSet);
  buffer.writeUInt16BE(9, 0);
  buffer.writeUInt16BE(2, 2);
  buffer.writeUInt32BE(1_000, 4);
  buffer.writeUInt32BE(Math.floor(AT / 1000), 8);
  buffer.writeUInt32BE(0, 12);
  buffer.writeUInt32BE(domain, 16);

  let offset = 20;
  if (includeTemplate) {
    buffer.writeUInt16BE(0, offset);
    buffer.writeUInt16BE(templateSet, offset + 2);
    buffer.writeUInt16BE(256, offset + 4);
    buffer.writeUInt16BE(fields.length, offset + 6);
    fields.forEach((field, index) => {
      buffer.writeUInt16BE(field.type, offset + 8 + index * 4);
      buffer.writeUInt16BE(field.length, offset + 10 + index * 4);
    });
    offset += templateSet;
  }

  buffer.writeUInt16BE(256, offset);
  buffer.writeUInt16BE(dataSet, offset + 2);
  dataRecord(buffer, offset + 4, {});
  return buffer;
}

/** IPFIX (v10): header (16) + a template set (id 2) + a data set (id 256). */
function ipfix(domain = 11, includeTemplate = true): Buffer {
  const fields = templateFields();
  const recordLength = fields.reduce((total, field) => total + field.length, 0);
  const templateSet = 4 + 4 + fields.length * 4;
  const dataSet = 4 + recordLength;
  const length = 16 + (includeTemplate ? templateSet : 0) + dataSet;
  const buffer = Buffer.alloc(length);
  buffer.writeUInt16BE(10, 0);
  buffer.writeUInt16BE(length, 2);
  buffer.writeUInt32BE(Math.floor(AT / 1000), 4);
  buffer.writeUInt32BE(0, 8);
  buffer.writeUInt32BE(domain, 12);

  let offset = 16;
  if (includeTemplate) {
    buffer.writeUInt16BE(2, offset);
    buffer.writeUInt16BE(templateSet, offset + 2);
    buffer.writeUInt16BE(256, offset + 4);
    buffer.writeUInt16BE(fields.length, offset + 6);
    fields.forEach((field, index) => {
      buffer.writeUInt16BE(field.type, offset + 8 + index * 4);
      buffer.writeUInt16BE(field.length, offset + 10 + index * 4);
    });
    offset += templateSet;
  }

  buffer.writeUInt16BE(256, offset);
  buffer.writeUInt16BE(dataSet, offset + 2);
  dataRecord(buffer, offset + 4, {});
  return buffer;
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

test("flow listener: a port without a tenant refuses to start", () => {
  assert.throws(() => guardNetflowConfigFromEnv({ SENTINEL_GUARD_NETFLOW_PORT: "2055" }), /SENTINEL_GUARD_ORGANIZATION/);

  const configured = guardNetflowConfigFromEnv({
    SENTINEL_GUARD_NETFLOW_PORT: "2055",
    SENTINEL_GUARD_ORGANIZATION: "acme",
  });
  assert.equal(configured?.organizationSlug, "acme");
  assert.equal(configured?.host, "127.0.0.1", "loopback is the default: flow export cannot authenticate");
  assert.equal(configured?.sensor, "netflow");

  // Unset is off, not a collector on a default port nobody asked for.
  assert.equal(guardNetflowConfigFromEnv({ SENTINEL_GUARD_ORGANIZATION: "acme" }), null);
});

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

test("flow: a v5 message decodes its records into the normalizer's vocabulary", () => {
  const parsed = parseNetflowMessage(v5([{}, { sport: 40_000, dport: 443, protocol: 17 }]), new TemplateCache(), AT);
  assert.ok(parsed);
  assert.equal(parsed.source, "NETFLOW");
  assert.equal(parsed.flows.length, 2);
  assert.deepEqual(parsed.issues, []);

  const first = parsed.flows[0]!.payload;
  assert.equal(first.sourceAddress, SRC);
  assert.equal(first.destinationAddress, DST);
  assert.equal(first.sourcePort, 51_234);
  assert.equal(first.destinationPort, 23);
  assert.equal(first.protocol, "tcp", "protocol 6 is named, not left as a number");
  assert.equal(first.bytes, 512);
  assert.equal(first.packets, 3);
  // The header's own clock is the timestamp, because a v5 record carries only sysUptime.
  assert.equal(parsed.flows[0]!.at, Math.floor(AT / 1000) * 1000);
});

test("flow: a v9 template is learned, and the data set behind it decodes", () => {
  const templates = new TemplateCache();
  const parsed = parseNetflowMessage(v9(), templates, AT);
  assert.ok(parsed);
  assert.equal(parsed.source, "NETFLOW");
  assert.equal(parsed.flows.length, 1);
  assert.equal(parsed.flows[0]!.payload.destinationPort, 23);
  assert.equal(templates.get("9:7", 256)?.length, 6, "the template is kept under its exporter's domain");
});

test("flow: a data set with no template is skipped and named, not guessed", () => {
  // A fresh cache, so the template in the datagram is *not* learned before the data set in
  // this message... it is, because v9 sends the template first. Send the data-only message
  // instead, which is what a collector sees after a restart.
  const parsed = parseNetflowMessage(v9(7, false), new TemplateCache(), AT);
  assert.ok(parsed);
  assert.equal(parsed.flows.length, 0, "a record decoded without a layout would be fabricated telemetry");
  assert.ok(parsed.issues.some((issue) => issue.includes("no template for data set 256")));
});

test("flow: IPFIX is read at its own header offset and filed as its own source", () => {
  const templates = new TemplateCache();
  const parsed = parseNetflowMessage(ipfix(), templates, AT);
  assert.ok(parsed);
  assert.equal(parsed.source, "IPFIX", "v10 is IPFIX, not NetFlow");
  assert.equal(parsed.flows.length, 1);
  assert.equal(parsed.flows[0]!.payload.sourceAddress, SRC);
  // The observation domain sits at offset 12 in IPFIX and 16 in v9; learning it at the wrong
  // offset would file this template under the v9 namespace.
  assert.equal(templates.get("10:11", 256)?.length, 6);
  assert.equal(templates.get("10:16", 256), null);
});

test("flow: two exporters' templates do not share a namespace", () => {
  const templates = new TemplateCache();
  parseNetflowMessage(v9(1), templates, AT);
  parseNetflowMessage(v9(2, false), templates, AT);
  // Domain 2 was never given the template, so its data set is skipped even though domain 1's
  // identical template id exists.
  assert.ok(templates.get("9:1", 256));
  assert.equal(templates.get("9:2", 256), null);
});

test("flow: a version this build does not read is refused, not treated as empty", () => {
  const stray = Buffer.alloc(8);
  stray.writeUInt16BE(8, 0); // NetFlow v8: not implemented.
  assert.equal(parseNetflowMessage(stray, new TemplateCache(), AT), null);
  assert.equal(parseNetflowMessage(Buffer.alloc(1), new TemplateCache(), AT), null);
});

/* -------------------------------------------------------------------------- */
/*  The listener                                                              */
/* -------------------------------------------------------------------------- */

function config(overrides: Partial<GuardNetflowConfig> = {}): GuardNetflowConfig {
  return {
    host: "127.0.0.1",
    port: PORT,
    sensor: "collector-1",
    organizationSlug: "acme",
    maxDatagramBytes: 65_507,
    ...overrides,
  };
}

function collector(): { sink: NetflowSink; events: ObservedEvent[] } {
  const events: ObservedEvent[] = [];
  return {
    events,
    sink: {
      async accept(payload) {
        events.push(payload.event);
        return { ok: true };
      },
    },
  };
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle(25);
}

test("flow listener: a datagram becomes an observed event, and a bad one is a counter", async () => {
  const collected = collector();
  const listener = await startGuardNetflow(config(), { sink: collected.sink });
  const udp: UdpSocket = createUdpSocket("udp4");

  try {
    const send = (buffer: Buffer): Promise<void> =>
      new Promise((resolve) => udp.send(buffer, PORT, "127.0.0.1", () => resolve()));

    await send(v5([{}]));
    await waitFor(() => collected.events.length === 1);

    assert.equal(collected.events.length, 1);
    const event = collected.events[0]!;
    // The one thing that makes this a listener rather than a parser: what arrived is the
    // normalizer's own record, filed under a source the coverage map already knows.
    assert.equal(event.kind, "NETWORK");
    assert.equal(event.source, "NETFLOW");
    assert.equal(event.sourceAddress, SRC);
    assert.equal(event.destinationAddress, DST);
    assert.equal(event.destinationPort, 23);
    assert.equal(event.protocol, "tcp");
    assert.equal(event.sensor, "collector-1", "a flow that names no exporter is attributed to the collector");

    // A version this build does not read is dropped and counted, and the socket survives it.
    await send((() => {
      const stray = Buffer.alloc(8);
      stray.writeUInt16BE(8, 0);
      return stray;
    })());
    await waitFor(() => listener.stats().dropped >= 1);

    // A v9 data set with no template is skipped rather than decoded by guesswork.
    await send(v9(99, false));
    await waitFor(() => listener.stats().received >= 3);

    const stats = listener.stats();
    assert.equal(stats.dropped, 1, "only the unknown version was dropped");
    assert.equal(stats.accepted, 1, "one flow reached the sink");
    assert.ok(stats.received >= 3, "the socket is still up and counting");
    assert.ok(stats.errors === 0, `no socket errors expected, saw ${stats.errors}`);
  } finally {
    udp.close();
    await listener.close();
  }
});
