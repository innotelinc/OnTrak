import assert from "node:assert/strict";
import test from "node:test";

import { PcapFormatError, decodePcapPacket, pcapEvents, readPcap } from "../src/lib/guard-pcap";

/** A little-endian pcap holding one Ethernet/IPv4/TCP frame. */
function capture(): Buffer {
  const ethernet = Buffer.from([
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, // destination MAC
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // source MAC
    0x08, 0x00, // IPv4
  ]);
  const ip = Buffer.from([
    0x45, 0x00, 0x00, 0x28, // v4, ihl 5, total length 40
    0x00, 0x01, 0x40, 0x00,
    0x40, 0x06, 0x00, 0x00, // TTL 64, TCP
    10, 0, 0, 5, // source
    10, 0, 0, 9, // destination
  ]);
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(12345, 0);
  tcp.writeUInt16BE(443, 2);
  const frame = Buffer.concat([ethernet, ip, tcp]);

  const global = Buffer.alloc(24);
  global.writeUInt32LE(0xa1b2c3d4, 0);
  global.writeUInt16LE(2, 4);
  global.writeUInt16LE(4, 6);
  global.writeUInt32LE(65_535, 16);
  global.writeUInt32LE(1, 20);

  const record = Buffer.alloc(16);
  record.writeUInt32LE(1_700_000_000, 0);
  record.writeUInt32LE(500_000, 4);
  record.writeUInt32LE(frame.length, 8);
  record.writeUInt32LE(frame.length, 12);
  return Buffer.concat([global, record, frame]);
}

test("pcap: reads the packet's own timestamp and five-tuple", () => {
  const read = readPcap(capture());
  assert.equal(read.linkType, 1);
  assert.equal(read.packets.length, 1);
  assert.equal(read.refused, 0);
  assert.equal(read.packets[0].at, 1_700_000_000_500);

  const decoded = decodePcapPacket(read.linkType, read.packets[0].data, read.packets[0].at);
  assert.ok(decoded);
  assert.equal(decoded.sourceAddress, "10.0.0.5");
  assert.equal(decoded.destinationAddress, "10.0.0.9");
  assert.equal(decoded.sourcePort, 12345);
  assert.equal(decoded.destinationPort, 443);
  assert.equal(decoded.protocol, "TCP");
});

test("pcap: normalized events carry the capture's time, not the import's", () => {
  const { events, refused, skipped } = pcapEvents(capture(), { sensor: "capture-01" });
  assert.equal(refused, 0);
  assert.equal(skipped, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "PCAP");
  assert.equal(events[0].kind, "NETWORK");
  assert.equal(events[0].at, 1_700_000_000_500);
  assert.equal(events[0].sourceAddress, "10.0.0.5");
  assert.equal(events[0].destinationPort, 443);
  assert.equal(events[0].protocol, "tcp");
  assert.equal(events[0].sensor, "capture-01");
});

test("pcap: a truncated record is refused rather than padded", () => {
  const full = capture();
  const cut = full.subarray(0, full.length - 4);
  const read = readPcap(cut);
  assert.equal(read.packets.length, 0);
  assert.equal(read.refused, 1);
});

test("pcap: pcapng is refused by name", () => {
  const pcapng = Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0]);
  assert.throws(() => readPcap(pcapng), PcapFormatError);
});

test("pcap: non-IP frames are skipped, not invented", () => {
  const ethernet = Buffer.alloc(14);
  ethernet.writeUInt16BE(0x0806, 12); // ARP
  assert.equal(decodePcapPacket(1, ethernet, 0), null);
});
