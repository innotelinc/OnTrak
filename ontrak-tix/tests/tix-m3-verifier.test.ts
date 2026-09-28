/**
 * OnTrak Tix M3 tests: the standalone assurance-packet verifier.
 *
 * The point of this tool is that a third party can check a packet with nothing
 * but the file and the key, so these tests behave like that third party: they
 * hash and sign with nothing but `node:crypto`, verify through the same code path
 * the CLI uses, and try to break it — a doctored packet, a foreign key, a file
 * that is not a packet at all.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m3-verifier.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { packetHash, candidateSecrets, verifyPacketJson, verifyPacketObject } from "../src/lib/assurance-verify";
import { buildAssurancePacket, type AssurancePacket, type AssurancePacketInput } from "../src/lib/assurance-rules";
import { hmacSigner } from "../src/lib/assurance-sign";
import { buildEvidenceManifest } from "../src/lib/evidence-rules";
import { parseArgs, readPacket, report } from "../scripts/verify-packet";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const KEY = "test-assurance-key-that-is-long-enough";
const sign = hmacSigner(KEY);

/* ------------------------------------------------------------------ fixture */

const COLLECTED = {
  id: "c1",
  tenantId: "tenant-a",
  incidentId: "inc-1",
  evidenceId: "ev-1",
  at: "2026-09-20T09:05:00.000Z",
  action: "COLLECTED" as const,
  fromActor: "user-1",
  toActor: "user-1",
  reason: null,
};

function packetInput(overrides: Partial<Parameters<typeof buildEvidenceManifest>[0]> = {}): AssurancePacketInput {
  const manifest = buildEvidenceManifest(
    {
      incident: {
        ref: "INC-000007",
        title: "Mail outage",
        severity: "SEV2",
        phase: "REVIEWED",
        detectedAt: "2026-09-20T08:55:00.000Z",
        declaredAt: "2026-09-20T09:00:00.000Z",
        roles: [{ role: "COMMANDER", userId: "user-1" }],
      },
      steps: [{ key: "declare", title: "Declare", status: "DONE", completedAt: "2026-09-20T09:01:00.000Z", completedBy: "user-1" }],
      evidence: [
        { id: "ev-1", kind: "LOG", label: "Auth log", reference: "s3://evidence/1", sha256: "b".repeat(64), collectedBy: "user-1", collectedAt: "2026-09-20T09:05:00.000Z" },
      ],
      custody: [COLLECTED],
      legalHold: null,
      timeline: [{ at: "2026-09-20T09:00:00.000Z", kind: "declared", actor: "user-1", summary: "Declared SEV2" }],
      generatedAt: "2026-09-20T12:00:00.000Z",
      ...overrides,
    },
    sha256,
  );

  return {
    manifest,
    audit: {
      head: "a".repeat(64),
      length: 7,
      verified: true,
      exportSeq: 8,
      excerpt: [{ seq: 3, at: "2026-09-20T09:00:00.000Z", actor: "user-1", action: "incident.declare", recordHash: "c".repeat(64) }],
    },
    generatedAt: "2026-09-20T12:00:00.000Z",
  };
}

const PACKET = buildAssurancePacket(packetInput(), sha256, sign);

/* -------------------------------------------------------------------- happy */

test("the tool's hash is the app's hash, so a packet verifies offline", () => {
  // The verifier must not depend on the app's hasher; this is the proof that the
  // two agree without either importing the other.
  assert.equal(packetHash("anything"), sha256("anything"));

  const outcome = verifyPacketJson(JSON.stringify(PACKET), KEY);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, null);
  assert.ok(outcome.report);
  assert.match(outcome.report!.headline, /^VERIFIED/);
  assert.deepEqual(outcome.report!.missing, [], "this fixture is a complete record");

  const lines = outcome.report!.lines.join("\n");
  assert.match(lines, /incident: INC-000007 — Mail outage/);
  assert.match(lines, /severity \/ phase: SEV2 \/ REVIEWED/);
  assert.match(lines, /record hash: [a-f0-9]{64}/);
  assert.match(lines, new RegExp(`content hash: ${PACKET.contentHash}`));
  assert.match(lines, /HMAC-SHA256/);
  assert.match(lines, /incident-response@1\.0/);
  assert.match(lines, /exported at: 2026-09-20T12:00:00\.000Z/);
});

test("an incomplete record still verifies, and says what a reviewer is missing", () => {
  const thin = buildAssurancePacket(
    packetInput({ incident: { ref: "INC-000008", title: "Thin", severity: "SEV3", phase: "DETECTED", detectedAt: "2026-09-20T08:55:00.000Z", declaredAt: "2026-09-20T09:00:00.000Z", roles: [] }, steps: [], evidence: [], custody: [], timeline: [] }),
    sha256,
    sign,
  );
  const outcome = verifyPacketObject(thin, KEY);
  assert.equal(outcome.ok, true);
  assert.match(outcome.report!.headline, /VERIFIED — the packet is intact, and/);
  assert.ok(outcome.report!.missing.includes("the incident has not been reviewed"));
  assert.ok(outcome.report!.missing.includes("no evidence was collected"));
});

/* ----------------------------------------------------------------- tampering */

test("an edited packet is refused, and the reason says which digest failed", () => {
  const edited = JSON.parse(JSON.stringify(PACKET)) as AssurancePacket;
  edited.incident = { ...edited.incident, title: "Something else entirely" };

  const outcome = verifyPacketObject(edited, KEY);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "The packet contents do not match its content hash.");
  assert.equal(outcome.report!.headline, "FAILED — The packet contents do not match its content hash.");
});

test("editing only the audit anchor is caught too, because the signature covers it", () => {
  const edited = JSON.parse(JSON.stringify(PACKET)) as AssurancePacket;
  edited.audit = { ...edited.audit, head: "b".repeat(64), length: 99 };

  const outcome = verifyPacketObject(edited, KEY);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "The packet contents do not match its content hash.");
});

test("a signature recomputed with a foreign key still fails", () => {
  const attacker = buildAssurancePacket(packetInput(), sha256, hmacSigner("some-other-key-that-is-long-enough"));
  const outcome = verifyPacketObject(attacker, KEY);
  assert.equal(outcome.ok, false);
  // The digests are consistent — the attacker re-signed properly — so the refusal
  // is about the key, which is exactly what the HMAC is for.
  assert.match(outcome.reason ?? "", /not match/);
  const honest = verifyPacketObject(attacker, "some-other-key-that-is-long-enough");
  assert.equal(honest.ok, true);
});

test("the wrong key on an untouched packet fails on the signature", () => {
  const outcome = verifyPacketObject(JSON.parse(JSON.stringify(PACKET)), "not-the-deployment-key-at-all");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "The signature does not match this deployment's key.");
});

/* ------------------------------------------------------------------ bad input */

test("a file that is not a packet produces a readable failure, not an exception", () => {
  const notJson = verifyPacketJson("this is a screenshot, honestly", KEY);
  assert.equal(notJson.ok, false);
  assert.equal(notJson.reason, "That file is not valid JSON.");
  assert.equal(notJson.report, null);

  const list = verifyPacketJson("[1,2,3]", KEY);
  assert.equal(list.ok, false);
  assert.match(list.reason ?? "", /expected a JSON object/);

  const empty = verifyPacketJson("{}", KEY);
  assert.equal(empty.ok, false);
  assert.ok(empty.reason);
  // Even a hopeless document still gets a report line rather than a stack trace.
  assert.ok(empty.report);
  assert.match(empty.report!.lines.join("\n"), /\(unidentified incident\)/);
});

/* --------------------------------------------------------------- the CLI bits */

test("arguments are parsed the way the usage says", () => {
  assert.deepEqual(parseArgs([]), { path: null, key: null, quiet: false, help: false });
  assert.deepEqual(parseArgs(["packet.json"]), { path: "packet.json", key: null, quiet: false, help: false });
  assert.deepEqual(parseArgs(["packet.json", "--key", "s3cret"]), { path: "packet.json", key: "s3cret", quiet: false, help: false });
  assert.deepEqual(parseArgs(["--quiet", "--help"]), { path: null, key: null, quiet: true, help: true });
  assert.deepEqual(parseArgs(["-q", "-h"]), { path: null, key: null, quiet: true, help: true });
  // A stray flag neither becomes the path nor swallows the one after it.
  assert.deepEqual(parseArgs(["--wat", "packet.json"]), { path: "packet.json", key: null, quiet: false, help: false });
});

test("the key candidates fall back in order, without duplicates", () => {
  assert.deepEqual(candidateSecrets({ ONTRAK_TIX_ASSURANCE_SECRET: "a" }), ["a"]);
  assert.deepEqual(candidateSecrets({ TIX_AUTH_SECRET: "b", AUTH_SECRET: "c" }), ["b", "c"]);
  // The same value in two variables is tried once.
  assert.deepEqual(candidateSecrets({ ONTRAK_TIX_ASSURANCE_SECRET: "same", TIX_AUTH_SECRET: "same" }), ["same"]);
  assert.deepEqual(candidateSecrets({ ONTRAK_TIX_ASSURANCE_SECRET: "", TIX_AUTH_SECRET: undefined }), []);
});

test("the CLI reads a packet from a file, and reports an exit code a pipeline can use", () => {
  const dir = mkdtempSync(join(tmpdir(), "ontrak-packet-"));
  const path = join(dir, "INC-000007-assurance-packet.json");
  try {
    writeFileSync(path, JSON.stringify(PACKET, null, 2));
    const text = readPacket(path);
    assert.equal(verifyPacketJson(text, KEY).ok, true);

    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(report(verifyPacketJson(text, KEY), false), 0);
      assert.match(writes.join(""), /^VERIFIED/);

      writes.length = 0;
      const edited = JSON.parse(text) as AssurancePacket;
      edited.incident = { ...edited.incident, ref: "INC-999999" };
      assert.equal(report(verifyPacketObject(edited, KEY), false), 1);
      assert.match(writes.join(""), /^FAILED — The packet contents do not match its content hash\./);

      // Quiet mode prints one line and nothing else.
      writes.length = 0;
      assert.equal(report(verifyPacketObject(PACKET, KEY), true), 0);
      assert.equal(writes.length, 1);
    } finally {
      process.stdout.write = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
