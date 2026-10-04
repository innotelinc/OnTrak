/**
 * Guard's syslog listener (S3): the network side, actually listening.
 *
 * Everything up to here reads telemetry that something else has already
 * collected: a sensor posts a batch and the normalizer, the rules and the alert
 * pipeline do their work. That is a library. This is the part that makes it a
 * detector you can point at a network — a socket that stays open, parses what
 * arrives, and hands each event to *the same* ingest path a relay's POST takes,
 * so there is exactly one door into detection and the listener is not a second,
 * weaker one.
 *
 * Four decisions, each of which is a way this goes wrong:
 *
 * **The tenant is configuration, not a header.** A syslog frame has nowhere to
 * put an organization slug, so the listener refuses to start without
 * `SENTINEL_GUARD_ORGANIZATION`: a listener that guessed would file one tenant's
 * traffic under whoever's slug it happened to pick, and the ingest service's
 * whole point is that the caller does not choose the tenant.
 *
 * **The bind address is the access control.** Syslog has no authentication —
 * that is the protocol, not an implementation detail — so the default bind is
 * `127.0.0.1` and a deployment that widens it is saying "a relay in front of
 * this authenticates". Widening it is one variable and is stated in the docs
 * rather than being the default nobody noticed.
 *
 * **A line that is too long is dropped, not buffered.** A TCP stream is
 * attacker-controlled input: without a ceiling, an endless line is an endless
 * allocation. Past `maxLineBytes` the remainder of that line is discarded and
 * counted, so the failure is visible in `stats()` instead of in the OOM killer.
 *
 * **Nothing throws out of a socket handler.** A malformed frame, a sink that
 * refuses, a peer that vanishes mid-line: each is a counter and a log line. A
 * listener that dies on bad input is a listener an attacker can turn off.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";

import { toObservedEventFromSyslog, type ObservedEvent } from "./telemetry-rules";

export type SyslogTransport = "udp" | "tcp" | "both";

export interface GuardSyslogConfig {
  /** Address to bind. Default `127.0.0.1`: syslog cannot authenticate, so the bind is it. */
  host: string;
  port: number;
  transport: SyslogTransport;
  /** What these frames are attributed to when the payload names no sensor of its own. */
  sensor: string;
  /** The tenant every frame belongs to. Required: a syslog line cannot carry one. */
  organizationSlug: string;
  /** Longest line accepted. Longer is dropped and counted. */
  maxLineBytes: number;
}

export interface GuardSyslogStats {
  /** Frames and lines read off the wire. */
  received: number;
  /** Lines that became an event the sink accepted. */
  accepted: number;
  /** Lines the normalizer refused, or the sink did. */
  rejected: number;
  /** Lines dropped for exceeding `maxLineBytes`. */
  dropped: number;
  /** Socket-level errors, counted rather than thrown. */
  errors: number;
  /** When the last line arrived, ms since epoch, or null. */
  lastAt: number | null;
  /**
   * Why the most recent line that was **not** accepted was refused, for the
   * operator reading the log. A later accepted line does not clear it: under steady
   * good traffic, clearing it would blank the only record of the intermittent drops
   * an operator is looking for.
   */
  lastError: string | null;
}

/** One parsed event, in the shape the ingest path already accepts. */
export interface SyslogSink {
  accept(payload: { source: "SYSLOG"; sensor: string; event: ObservedEvent }, at: number): Promise<{ ok: boolean; error?: string }>;
}

export interface GuardSyslogHandle {
  config: GuardSyslogConfig;
  stats(): GuardSyslogStats;
  close(): Promise<void>;
}

const DEFAULT_MAX_LINE_BYTES = 8_192;
const DEFAULT_SENSOR = "syslog";
const DEFAULT_HOST = "127.0.0.1";

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function transportOf(raw: string | undefined): SyslogTransport {
  const lowered = (raw ?? "").trim().toLowerCase();
  return lowered === "udp" || lowered === "tcp" ? lowered : "both";
}

/**
 * The listener's settings, or null when this deployment does not listen.
 *
 * Throws rather than returning null for a listener that is *half* configured —
 * a port with no organization is a listener that would file events under the
 * wrong tenant, and a refusal at boot is the only place that is cheap to notice.
 */
export function guardSyslogConfigFromEnv(env: NodeJS.ProcessEnv): GuardSyslogConfig | null {
  const port = positiveInt(env.SENTINEL_GUARD_SYSLOG_PORT, 0);
  if (port === 0) return null;

  const organizationSlug = (env.SENTINEL_GUARD_ORGANIZATION ?? "").trim();
  if (organizationSlug === "") {
    throw new Error(
      "SENTINEL_GUARD_SYSLOG_PORT is set but SENTINEL_GUARD_ORGANIZATION is not: a syslog frame " +
        "cannot name its own tenant, so the listener must be told which one it serves.",
    );
  }

  return {
    host: (env.SENTINEL_GUARD_SYSLOG_HOST ?? "").trim() || DEFAULT_HOST,
    port,
    transport: transportOf(env.SENTINEL_GUARD_SYSLOG_TRANSPORT),
    sensor: (env.SENTINEL_GUARD_SYSLOG_SENSOR ?? "").trim() || DEFAULT_SENSOR,
    organizationSlug,
    maxLineBytes: positiveInt(env.SENTINEL_GUARD_SYSLOG_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES),
  };
}

export interface SplitResult {
  lines: string[];
  pending: string;
  /** Lines (or the tail of one) discarded for exceeding the ceiling. */
  dropped: number;
}

/**
 * Newline framing, with a ceiling — the whole of a stream's parsing.
 *
 * The remainder is carried forward because a TCP read is not a message
 * boundary; a datagram usually is, so a datagram without a trailing newline is
 * flushed by passing it through with `pending` empty. A line past the ceiling is
 * dropped whole rather than truncated: half a JSON object is not an event, and
 * truncating it would produce a parse error that reads like the sender's bug.
 */
export function splitSyslogLines(pending: string, chunk: string, maxLineBytes: number): SplitResult {
  const text = pending + chunk;
  const parts = text.split("\n");
  let rest = parts.pop() ?? "";
  let dropped = 0;

  const lines: string[] = [];
  for (const part of parts) {
    const line = part.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (line.length > maxLineBytes) {
      dropped += 1;
      continue;
    }
    lines.push(line);
  }

  if (rest.length > maxLineBytes) {
    // Past the ceiling with no newline in sight: the rest of this line is not
    // worth holding, and holding it is exactly the memory a peer could take.
    dropped += 1;
    rest = "";
  }

  return { lines, pending: rest, dropped };
}

/** The listener. Start it once per process; `close()` releases both sockets. */
export async function startGuardSyslog(
  config: GuardSyslogConfig,
  deps: { sink: SyslogSink; log?: (message: string) => void; now?: () => number },
): Promise<GuardSyslogHandle> {
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): number => Date.now());
  const stats: GuardSyslogStats = {
    received: 0,
    accepted: 0,
    rejected: 0,
    dropped: 0,
    errors: 0,
    lastAt: null,
    lastError: null,
  };

  /** One line, end to end. Never throws. */
  const handleLine = async (line: string): Promise<void> => {
    stats.received += 1;
    stats.lastAt = now();
    const parsed = toObservedEventFromSyslog(line, { sensor: config.sensor, at: now() });
    if (!parsed.ok) {
      stats.rejected += 1;
      stats.lastError = parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
      return;
    }
    let answer: { ok: boolean; error?: string };
    try {
      answer = await deps.sink.accept(
        { source: "SYSLOG", sensor: parsed.event.sensor, event: parsed.event },
        now(),
      );
    } catch (error) {
      answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (answer.ok) {
      stats.accepted += 1;
      return;
    }
    stats.rejected += 1;
    stats.lastError = answer.error ?? "the sink refused the event";
  };

  const noteDropped = (count: number): void => {
    if (count === 0) return;
    stats.dropped += count;
    log(`dropped ${count} syslog line(s) longer than ${config.maxLineBytes} bytes`);
  };

  const sockets: { udp?: UdpSocket; tcp?: Server } = {};

  if (config.transport !== "tcp") {
    const udp = createUdpSocket("udp4");
    udp.on("error", (error) => {
      stats.errors += 1;
      log(`syslog udp error: ${error.message}`);
    });
    udp.on("message", (message) => {
      // A datagram is one frame: its lines are already complete, so the trailing
      // partial is flushed rather than held for a next datagram that is a
      // different frame entirely.
      const split = splitSyslogLines("", message.toString("utf8"), config.maxLineBytes);
      const flushed = split.pending.trim() === "" ? [] : [split.pending];
      noteDropped(split.dropped);
      for (const line of [...split.lines, ...flushed]) void handleLine(line);
    });
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(config.port, config.host, () => {
        udp.removeListener("error", reject);
        resolve();
      });
    });
    sockets.udp = udp;
  }

  if (config.transport !== "udp") {
    const tcp = createServer();
    const pendingBySocket = new Map<Socket, string>();
    tcp.on("error", (error) => {
      stats.errors += 1;
      log(`syslog tcp error: ${error.message}`);
    });
    tcp.on("connection", (socket) => {
      pendingBySocket.set(socket, "");
      socket.on("error", (error) => {
        stats.errors += 1;
        log(`syslog tcp connection error: ${error.message}`);
        pendingBySocket.delete(socket);
      });
      socket.on("close", () => pendingBySocket.delete(socket));
      socket.on("data", (chunk) => {
        const pending = pendingBySocket.get(socket) ?? "";
        const split = splitSyslogLines(pending, chunk.toString("utf8"), config.maxLineBytes);
        pendingBySocket.set(socket, split.pending);
        noteDropped(split.dropped);
        for (const line of split.lines) void handleLine(line);
      });
    });
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(config.port, config.host, () => {
        tcp.removeListener("error", reject);
        resolve();
      });
    });
    sockets.tcp = tcp;
  }

  return {
    config,
    stats: () => ({ ...stats }),
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        if (sockets.udp === undefined) {
          resolve();
          return;
        }
        sockets.udp.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        if (sockets.tcp === undefined) {
          resolve();
          return;
        }
        sockets.tcp.close(() => resolve());
      });
    },
  };
}
