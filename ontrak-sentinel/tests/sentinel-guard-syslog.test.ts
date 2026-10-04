/**
 * Sentinel S3 tests: the listener on the network side.
 *
 * The detector already had a normalizer, rules and an alert pipeline; what it did
 * not have was anything listening, which is the difference between a library and
 * a product. So these tests are about the things a listener gets wrong:
 *
 *  - **It guesses the tenant.** A syslog frame cannot carry an organization
 *    slug, so a listener without one must refuse to start rather than file
 *    traffic under whoever's name it picked first.
 *  - **It buffers without a ceiling.** A TCP stream is attacker-controlled; an
 *    endless line must cost a counter, not the process.
 *  - **It dies on bad input.** A malformed frame, a sink that refuses, a peer
 *    that vanishes: each is a statistic, and the socket stays up.
 *  - **It is a second, weaker door.** What it accepts goes to the same sink a
 *    relay's POST goes to, so there is one path into detection and not two.
 *
 * The sockets here are real: a datagram is sent, a socket is opened, bytes are
 * written and read. A listener tested only through its parser is a listener whose
 * bind, framing and error handling have never run.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";
import { connect as connectTcp, type Socket } from "node:net";
import { test } from "node:test";

import {
  guardSyslogConfigFromEnv,
  splitSyslogLines,
  startGuardSyslog,
  type GuardSyslogConfig,
  type SyslogSink,
} from "../src/lib/guard-syslog";
import type { ObservedEvent } from "../src/lib/telemetry-rules";

const PORT = 15_514;
const AT = 1_760_000_000_000;

function config(overrides: Partial<GuardSyslogConfig> = {}): GuardSyslogConfig {
  return {
    host: "127.0.0.1",
    port: PORT,
    transport: "both",
    sensor: "relay-1",
    organizationSlug: "acme",
    maxLineBytes: 4_096,
    ...overrides,
  };
}

/** A line the normalizer accepts: free text with the structured payload relayed after it. */
function line(overrides: Record<string, unknown> = {}): string {
  return (
    "<134>1 2026-10-01T04:00:00Z sensor-7 app 4711 - - " +
    JSON.stringify({
      sourceAddress: "10.0.0.9",
      sourcePort: 51_234,
      destinationAddress: "10.0.0.20",
      destinationPort: 23,
      protocol: "tcp",
      ...overrides,
    })
  );
}

/** Records what the listener handed over, and can refuse on demand. */
function collector(): { sink: SyslogSink; events: ObservedEvent[]; refusals: number } {
  const events: ObservedEvent[] = [];
  let refusals = 0;
  const sink: SyslogSink = {
    async accept(payload) {
      if (refusals > 0) {
        refusals -= 1;
        return { ok: false, error: "the sink refused it" };
      }
      events.push(payload.event);
      return { ok: true };
    },
  };
  return {
    sink,
    events,
    get refusals(): number {
      return refusals;
    },
    set refusals(value: number) {
      refusals = value;
    },
  };
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a predicate rather than a duration.
 *
 * A socket test that sleeps a fixed time is a test that passes on a laptop and
 * fails in CI: the assertion is about what arrived, so it waits for exactly that.
 */
async function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle(25);
}

test("syslog listener: a port without a tenant refuses to start", () => {
  // The one mistake that cannot be seen later: events filed under the wrong
  // organization. A syslog line has nowhere to put a slug, so the deployment
  // has to say which tenant it serves.
  assert.throws(
    () => guardSyslogConfigFromEnv({ SENTINEL_GUARD_SYSLOG_PORT: "5514" }),
    /SENTINEL_GUARD_ORGANIZATION/,
  );

  const configured = guardSyslogConfigFromEnv({
    SENTINEL_GUARD_SYSLOG_PORT: "5514",
    SENTINEL_GUARD_ORGANIZATION: "acme",
  });
  assert.equal(configured?.organizationSlug, "acme");
  assert.equal(configured?.host, "127.0.0.1", "loopback is the default: syslog cannot authenticate");
  assert.equal(configured?.transport, "both");
  assert.equal(configured?.sensor, "syslog");

  // Unset is off, not a listener on a default port nobody asked for.
  assert.equal(guardSyslogConfigFromEnv({ SENTINEL_GUARD_ORGANIZATION: "acme" }), null);
});

test("syslog listener: a line past the ceiling is dropped, not buffered", () => {
  const framed = splitSyslogLines("", `${line()}\n${line({ sourceAddress: "10.0.0.11" })}\npart`, 4_096);
  assert.equal(framed.lines.length, 2);
  assert.equal(framed.pending, "part", "an incomplete line is carried to the next read");

  const long = splitSyslogLines("", `${"x".repeat(5_000)}\n`, 4_096);
  assert.equal(long.lines.length, 0);
  assert.equal(long.dropped, 1);

  // A pending line that never ends is the memory a peer could take, so the
  // ceiling applies to the carry-over too.
  const unbounded = splitSyslogLines("", "y".repeat(5_000), 4_096);
  assert.equal(unbounded.pending, "");
  assert.equal(unbounded.dropped, 1);

  const blank = splitSyslogLines("", "\n\n  \n", 4_096);
  assert.deepEqual(blank.lines, [], "a blank line is not an event");
});

test("syslog listener: a datagram becomes events, and a bad line is a counter", async () => {
  const collected = collector();
  const listener = await startGuardSyslog(config({ transport: "udp" }), { sink: collected.sink });
  const udp: UdpSocket = createUdpSocket("udp4");

  try {
    const send = (payload: string): Promise<void> =>
      new Promise((resolve) => udp.send(Buffer.from(payload, "utf8"), PORT, "127.0.0.1", () => resolve()));

    // Two lines in one datagram, and the last one has no trailing newline: a
    // datagram is a frame, so its tail is a line rather than a wait.
    await send(`${line()}\n${line({ destinationPort: 445 })}\n${line({ destinationPort: 3389 })}`);
    await waitFor(() => collected.events.length >= 3);

    assert.equal(collected.events.length, 3);
    assert.equal(collected.events[0]?.destinationPort, 23);
    assert.equal(collected.events[2]?.destinationPort, 3389, "a datagram's trailing line is flushed");
    assert.equal(collected.events[0]?.sensor, "sensor-7", "the payload's own sensor wins over the default");
    assert.equal(collected.events[0]?.source, "SYSLOG");

    // A frame with no structured payload is refused by the normalizer, counted,
    // and does not stop the next one.
    await send("just a plain syslog line with no JSON\n");
    await send(`${line({ sourceAddress: "10.0.0.12" })}\n`);
    await waitFor(() => listener.stats().received >= 5);

    assert.equal(collected.events.length, 4);
    const stats = listener.stats();
    assert.equal(stats.received, 5);
    assert.equal(stats.accepted, 4);
    assert.equal(stats.rejected, 1);
    assert.match(stats.lastError ?? "", /structured payload/);
  } finally {
    // Close the sender on the way out, pass or fail: a socket left open on an
    // assertion keeps the test runner's event loop alive and hangs CI.
    udp.close();
    await listener.close();
  }
});

test("syslog listener: a refused event is counted rather than throwing", async () => {
  const collected = collector();
  const listener = await startGuardSyslog(config({ transport: "udp" }), { sink: collected.sink });
  const udp: UdpSocket = createUdpSocket("udp4");

  try {
    const send = (payload: string): Promise<void> =>
      new Promise((resolve) => udp.send(Buffer.from(payload, "utf8"), PORT, "127.0.0.1", () => resolve()));

    collected.refusals = 1;
    await send(`${line()}\n`);
    await waitFor(() => listener.stats().rejected >= 1);

    const stats = listener.stats();
    assert.equal(stats.accepted, 0);
    assert.equal(stats.rejected, 1);
    assert.match(stats.lastError ?? "", /refused/);
  } finally {
    udp.close();
    await listener.close();
  }
});

test("syslog listener: a TCP stream is reassembled across reads", async () => {
  const collected = collector();
  const listener = await startGuardSyslog(config({ transport: "tcp" }), { sink: collected.sink });

  const socket: Socket = connectTcp(PORT, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const payload = `${line()}\n${line({ destinationPort: 8080 })}\n`;
    // One line split across two writes: a read is not a message boundary, which
    // is the whole reason a listener keeps a remainder.
    socket.write(payload.slice(0, 40));
    await settle(80);
    assert.equal(collected.events.length, 0, "a partial line is not an event yet");
    socket.write(payload.slice(40));
    await waitFor(() => collected.events.length >= 2);

    assert.equal(collected.events.length, 2);
    assert.equal(listener.stats().accepted, 2);
  } finally {
    socket.destroy();
    await listener.close();
  }
});

test("syslog listener: closing releases the ports", async () => {
  const collected = collector();
  const listener = await startGuardSyslog(config({ transport: "udp" }), { sink: collected.sink });
  await listener.close();

  // Binding again is the assertion: a listener that leaked its socket would
  // refuse the second start with EADDRINUSE.
  const second = await startGuardSyslog(config({ transport: "udp" }), { sink: collected.sink });
  await second.close();
  assert.equal(listener.stats().received, 0);
});

test("syslog listener: an event with no clock of its own is stamped with the listener's", async () => {
  const collected = collector();
  const listener = await startGuardSyslog(config({ transport: "udp" }), {
    sink: collected.sink,
    now: () => AT,
  });

  const udp = createUdpSocket("udp4");
  try {
    // A frame that names no time: the listener's clock is the only one there is,
    // and using it is what keeps an incident's timeline ordered.
    await new Promise<void>((resolve) =>
      udp.send(
        Buffer.from(
          '<134>plain relay frame {"sourceAddress":"10.0.0.9","destinationAddress":"10.0.0.20"}\n',
          "utf8",
        ),
        PORT,
        "127.0.0.1",
        () => resolve(),
      ),
    );
    await waitFor(() => collected.events.length >= 1);
    assert.equal(collected.events[0]?.at, AT);
  } finally {
    udp.close();
    await listener.close();
  }
});
