/**
 * Guard's pcap reader (S3): the capture a deployment already has.
 *
 * Syslog, NetFlow and OTLP are *live* sources — something keeps sending, and the
 * listener only has to stay open. A pcap is the opposite: a file an analyst or a
 * sensor wrote earlier, which is exactly what an incident review starts from.
 * Reading it with the same normalizer as the live listeners is what makes a
 * capture and a wire observation comparable, rather than two timelines that
 * happen to describe the same packet.
 *
 * Three decisions, each of which is a way this goes wrong:
 *
 *  - **The file's own timestamps are kept.** A packet's time is the only clock a
 *    capture has; replacing it with "now" would date every packet to the import
 *    and destroy the ordering an incident rests on.
 *  - **A truncated record is refused, not padded.** A capture cut off mid-packet
 *    is common (a rotated file, a full disk). Reading the bytes that are there
 *    and calling the result a packet invents a shorter frame, so the partial
 *    record and everything after it are dropped and counted.
 *  - **Only the link/IP/transport headers are decoded.** Payloads are
 *    attacker-controlled and this module never turns them into anything
 *    executable; the five-tuple is what detection reads, and the payload stays a
 *    byte range the caller may hand to a signature matcher deliberately.
 *
 * Classic pcap is supported (both endiannesses, microsecond and nanosecond
 * timestamps). pcapng is refused by name rather than misread: its block layout is
 * a different format, and quietly returning zero packets for a valid file would
 * read as "the capture was empty".
 */

import { toObservedEvent, type ObservedEvent } from "./telemetry-rules";

/* -------------------------------------------------------------------------- */
/*  The file                                                                  */
/* -------------------------------------------------------------------------- */

export interface PcapPacket {
  /** Capture time, epoch milliseconds. */
  at: number;
  /** Bytes actually present. */
  data: Uint8Array;
  /** Bytes on the wire; larger than `data` when the capture was snap-lengthed. */
  originalLength: number;
}

export interface PcapReadResult {
  /** LINKTYPE_* from the global header. */
  linkType: number;
  packets: PcapPacket[];
  /** Records that were malformed or truncated and therefore not returned. */
  refused: number;
}

export class PcapFormatError extends Error {}

// The magic as a big-endian read of the first four bytes. A little-endian file
// stores 0xa1b2c3d4 as `d4 c3 b2 a1`, which reads back as 0xd4c3b2a1 — hence the
// two values per precision rather than one magic with an endianness flag.
const PCAP_MAGIC = {
  microLittle: 0xd4c3b2a1,
  microBig: 0xa1b2c3d4,
  nanoLittle: 0x4d3cb2a1,
  nanoBig: 0xa1b23c4d,
} as const;

/**
 * Read a classic pcap file.
 *
 * The magic is read byte-for-byte rather than through a DataView before the
 * endianness is known: the four values above are what the same number looks like
 * after each byte order, and picking the wrong one reverses every field.
 */
export function readPcap(input: Uint8Array): PcapReadResult {
  if (input.length < 24) throw new PcapFormatError("a pcap file is at least 24 bytes");

  const magic = (input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3];
  let little: boolean;
  let nanos: boolean;
  switch (magic >>> 0) {
    case PCAP_MAGIC.microLittle:
      little = true;
      nanos = false;
      break;
    case PCAP_MAGIC.microBig:
      little = false;
      nanos = false;
      break;
    case PCAP_MAGIC.nanoLittle:
      little = true;
      nanos = true;
      break;
    case PCAP_MAGIC.nanoBig:
      little = false;
      nanos = true;
      break;
    case 0x0a0d0d0a:
      throw new PcapFormatError("pcapng is not supported; convert it to classic pcap first");
    default:
      throw new PcapFormatError("not a pcap file (bad magic)");
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);
  const linkType = u32(20);
  const packets: PcapPacket[] = [];
  let refused = 0;
  let offset = 24;

  while (offset < input.length) {
    // A trailing short record is a truncated file, not the end: the 16-byte header
    // must be complete before its lengths can be trusted.
    if (offset + 16 > input.length) {
      refused += 1;
      break;
    }
    const seconds = u32(offset);
    const fraction = u32(offset + 4);
    const included = u32(offset + 8);
    const original = u32(offset + 12);
    offset += 16;
    if (offset + included > input.length) {
      refused += 1;
      break;
    }
    // A snap length of zero is technically legal but carries no header to decode.
    if (included > 0) {
      const at = seconds * 1000 + (nanos ? Math.floor(fraction / 1_000_000) : Math.floor(fraction / 1_000));
      packets.push({ at, data: input.subarray(offset, offset + included), originalLength: original });
    }
    offset += included;
  }

  return { linkType, packets, refused };
}

/* -------------------------------------------------------------------------- */
/*  The packet                                                                */
/* -------------------------------------------------------------------------- */

export const PCAP_LINKTYPE = {
  ethernet: 1,
  raw: 101,
  linuxSll: 113,
  ipv4: 228,
  ipv6: 229,
} as const;

export interface PcapObservation {
  at: number;
  sourceAddress: string;
  destinationAddress: string;
  sourcePort: number | null;
  destinationPort: number | null;
  protocol: string;
  capturedLength: number;
  originalLength: number;
}

function ipv4(bytes: Uint8Array, offset: number): { header: number; protocol: number; src: string; dst: string } | null {
  if (offset + 20 > bytes.length) return null;
  const version = bytes[offset] >> 4;
  const header = (bytes[offset] & 0x0f) * 4;
  if (version !== 4 || header < 20 || offset + header > bytes.length) return null;
  const src = `${bytes[offset + 12]}.${bytes[offset + 13]}.${bytes[offset + 14]}.${bytes[offset + 15]}`;
  const dst = `${bytes[offset + 16]}.${bytes[offset + 17]}.${bytes[offset + 18]}.${bytes[offset + 19]}`;
  return { header, protocol: bytes[offset + 9], src, dst };
}

function ipv6(bytes: Uint8Array, offset: number): { header: number; protocol: number; src: string; dst: string } | null {
  if (offset + 40 > bytes.length) return null;
  if (bytes[offset] >> 4 !== 6) return null;
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const base = offset + 8 + i * 2;
    groups.push(((bytes[base] << 8) | bytes[base + 1]).toString(16));
  }
  const src = groups.slice(0, 4).join(":");
  const dst = groups.slice(4).join(":");
  // Walk extension headers (hop-by-hop, routing, destination options) to the
  // transport. Four is a ceiling, not a guess: a chain longer than that is
  // malformed, and reading further would be decoding attacker-chosen offsets.
  let next = bytes[offset + 6];
  let at = offset + 40;
  for (let hop = 0; hop < 4; hop += 1) {
    if (next === 0 || next === 43 || next === 60) {
      if (at + 2 > bytes.length) return null;
      const length = (bytes[at + 1] + 1) * 8;
      next = bytes[at];
      at += length;
      continue;
    }
    break;
  }
  return { header: at - offset, protocol: next, src, dst };
}

/** The IP header at `offset`, for the link type and the first nibble. */
function network(bytes: Uint8Array, linkType: number): { header: number; protocol: number; src: string; dst: string; base: number } | null {
  if (linkType === PCAP_LINKTYPE.raw) {
    const version = bytes[0] >> 4;
    if (version === 4) {
      const found = ipv4(bytes, 0);
      return found ? { ...found, base: 0 } : null;
    }
    if (version === 6) {
      const found = ipv6(bytes, 0);
      return found ? { ...found, base: 0 } : null;
    }
    return null;
  }
  if (linkType === PCAP_LINKTYPE.ipv4) {
    const found = ipv4(bytes, 0);
    return found ? { ...found, base: 0 } : null;
  }
  if (linkType === PCAP_LINKTYPE.ipv6) {
    const found = ipv6(bytes, 0);
    return found ? { ...found, base: 0 } : null;
  }
  if (linkType === PCAP_LINKTYPE.linuxSll) {
    if (bytes.length < 16) return null;
    const protocol = (bytes[14] << 8) | bytes[15];
    const base = 16;
    if (protocol === 0x0800) {
      const found = ipv4(bytes, base);
      return found ? { ...found, base } : null;
    }
    if (protocol === 0x86dd) {
      const found = ipv6(bytes, base);
      return found ? { ...found, base } : null;
    }
    return null;
  }
  if (linkType !== PCAP_LINKTYPE.ethernet) return null;
  if (bytes.length < 14) return null;
  let etherType = (bytes[12] << 8) | bytes[13];
  let base = 14;
  // 802.1Q and 802.1ad: the VLAN tag sits between the MACs and the type, and a
  // capture from a trunk carries it on every frame.
  for (let tag = 0; tag < 2 && (etherType === 0x8100 || etherType === 0x88a8); tag += 1) {
    if (base + 4 > bytes.length) return null;
    etherType = (bytes[base + 2] << 8) | bytes[base + 3];
    base += 4;
  }
  if (etherType === 0x0800) {
    const found = ipv4(bytes, base);
    return found ? { ...found, base } : null;
  }
  if (etherType === 0x86dd) {
    const found = ipv6(bytes, base);
    return found ? { ...found, base } : null;
  }
  return null;
}

const TRANSPORT: Record<number, string> = { 1: "ICMP", 6: "TCP", 17: "UDP", 58: "ICMPv6" };

/**
 * Decode one captured packet into the five-tuple, or `null` when there is no IP
 * header this reader understands. Non-IP frames are common on a real link
 * (ARP, LLDP, STP) and are not an error: they are skipped and counted.
 */
export function decodePcapPacket(linkType: number, data: Uint8Array, at: number, originalLength = data.length): PcapObservation | null {
  const net = network(data, linkType);
  if (!net) return null;
  const transportAt = net.base + net.header;
  const protocol = TRANSPORT[net.protocol] ?? `IP-${net.protocol}`;
  let sourcePort: number | null = null;
  let destinationPort: number | null = null;
  if ((protocol === "TCP" || protocol === "UDP") && transportAt + 4 <= data.length) {
    sourcePort = (data[transportAt] << 8) | data[transportAt + 1];
    destinationPort = (data[transportAt + 2] << 8) | data[transportAt + 3];
  }
  return {
    at,
    sourceAddress: net.src,
    destinationAddress: net.dst,
    sourcePort,
    destinationPort,
    protocol,
    capturedLength: data.length,
    originalLength,
  };
}

/** Decode a whole capture into observations, in capture order. */
export function readPcapObservations(input: Uint8Array): {
  observations: PcapObservation[];
  refused: number;
  skipped: number;
} {
  const file = readPcap(input);
  const observations: PcapObservation[] = [];
  let skipped = 0;
  for (const packet of file.packets) {
    const decoded = decodePcapPacket(file.linkType, packet.data, packet.at, packet.originalLength);
    if (decoded) observations.push(decoded);
    else skipped += 1;
  }
  return { observations, refused: file.refused, skipped };
}

/**
 * A capture as normalized telemetry, ready for the same detection path a live
 * listener feeds. `sensor` names the capture or the box it came from; the
 * timestamp is the packet's, not the import's.
 */
export function pcapEvents(
  input: Uint8Array,
  context: { sensor: string },
): { events: ObservedEvent[]; refused: number; skipped: number } {
  const read = readPcapObservations(input);
  const events: ObservedEvent[] = [];
  let skipped = read.skipped;
  for (const observation of read.observations) {
    const result = toObservedEvent(
      "PCAP",
      {
        sourceAddress: observation.sourceAddress,
        destinationAddress: observation.destinationAddress,
        sourcePort: observation.sourcePort,
        destinationPort: observation.destinationPort,
        protocol: observation.protocol,
        direction: null,
        capturedLength: observation.capturedLength,
        originalLength: observation.originalLength,
      },
      { sensor: context.sensor, at: observation.at },
    );
    if (result.ok) events.push(result.event);
    else skipped += 1;
  }
  return { events, refused: read.refused, skipped };
}
