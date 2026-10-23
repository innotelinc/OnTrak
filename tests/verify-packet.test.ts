/**
 * The family assurance-packet verifier, tested like the third party it is for.
 *
 * The packet's promise is that somebody holding a file and a key can check it with
 * nothing else, so these fixtures are built the way that third party would build
 * them: canonical JSON, SHA-256 and an HMAC, all from `node:crypto`, with no import
 * of either product's builders. If the tool only agreed with the products' own
 * helpers, it would agree with a shared mistake.
 *
 * The two products are covered in the same file on purpose — the point of the tool
 * is that one command checks both, and one test file is what keeps that true.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SENTINEL_KEY_ENVS,
  TIX_AUDIT_CHAIN_KIND,
  candidateKeys,
  packetKind,
  parseArgs,
  verifyWithKeys,
} from "../scripts/verify-packet";

const KEY = "family-verifier-test-key-long-enough";
const OTHER_KEY = "a-different-deployment-key-long-enough";
const GENERATED_AT = "2026-10-01T09:00:00.000Z";

/* --------------------------------------------------------------- the format */

/** The family's canonical bytes: object keys sorted, arrays in order. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const hmac = (input: string, key: string) => createHmac("sha256", key).update(input).digest("hex");

/** The envelope both products ship around their record. */
type Sealed<T> = T & {
  audit: Record<string, unknown>;
  generatedAt: string;
  recordHash: string;
  contentHash: string;
  signature: string;
  algorithm: string;
};

/** Sign a record and an audit anchor into the envelope both products ship. */
function seal<T extends Record<string, unknown>>(record: T, audit: Record<string, unknown>, key = KEY): Sealed<T> {
  const content = { ...record, audit };
  const contentHash = sha256(stableStringify(content));
  return {
    ...content,
    generatedAt: GENERATED_AT,
    recordHash: sha256(stableStringify(record)),
    contentHash,
    signature: hmac(contentHash, key),
    algorithm: "HMAC-SHA256",
  };
}

/* ----------------------------------------------------------------- fixtures */

/** A Tix incident packet, complete enough to read as such. */
function tixPacket(key = KEY) {
  return seal(
    {
      version: "1.0",
      incident: {
        ref: "INC-000007",
        title: "Mail outage",
        severity: "SEV2",
        phase: "REVIEWED",
      },
      playbook: [{ key: "declare", title: "Declare", status: "DONE" }],
      evidence: [{ id: "ev-1", kind: "LOG", label: "Auth log", sha256: "b".repeat(64) }],
      evidenceManifestHash: "c".repeat(64),
      custody: [{ evidenceId: "ev-1", action: "COLLECTED", at: "2026-09-20T09:05:00.000Z" }],
      legalHold: null,
      timeline: [{ at: "2026-09-20T09:00:00.000Z", text: "Declared" }],
      policies: [{ key: "evidence-retention", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" }],
    },
    {
      head: "a".repeat(64),
      length: 7,
      verified: true,
      exportSeq: 8,
      excerpt: [{ seq: 3, at: "2026-09-20T09:00:00.000Z", actor: "agent-1", action: "incident.declare" }],
    },
    key,
  );
}

/** A Tix tenant audit-chain export: the same envelope, a different subject. */
function auditChainPacket(key = KEY) {
  return seal(
    {
      kind: TIX_AUDIT_CHAIN_KIND,
      version: "1.0",
      entries: [{ seq: 1, at: "2026-09-20T09:00:00.000Z", actor: "agent-1", action: "incident.declare", recordHash: "d".repeat(64) }],
      policies: [{ key: "audit-chain", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" }],
    },
    { head: "d".repeat(64), length: 1, verified: true },
    key,
  );
}

/** A Sentinel compliance-posture packet. */
function posturePacket(key = KEY) {
  return seal(
    {
      packet: "sentinel-compliance-posture",
      version: "1.0",
      organization: "Innotel",
      generatedBy: "admin@innotel.us",
      controls: [
        { control: "A second factor is required before a session is granted", state: "OK", detail: "All 3 scopes require one." },
        { control: "An active administrator exists", state: "OK", detail: "1 active administrator(s)." },
      ],
      roles: [],
      identities: { total: 2, humans: 2, services: 0, active: 2, inactive: 0, mfaEnrolled: 2 },
      alerts: null,
      chain: { ok: true, length: 12, detail: "The chain verifies end to end." },
      policies: { stored: 1, baselineStored: true, scopes: 3 },
      policyVersions: [{ key: "session-policy", version: "1.0", effectiveAt: "2026-01-01T00:00:00.000Z" }],
    },
    { verified: true, length: 12, detail: "The chain verifies end to end." },
    key,
  );
}

/* ------------------------------------------------------------------- tests */

test("names the subject each product exports, without reading a filename", () => {
  assert.equal(packetKind(posturePacket()), "sentinel-posture");
  assert.equal(packetKind(tixPacket()), "tix-incident");
  assert.equal(packetKind(auditChainPacket()), "tix-audit-chain");
  assert.equal(packetKind({ anything: true }), "unknown");
  assert.equal(packetKind("not a packet"), "unknown");
  assert.equal(packetKind(null), "unknown");
  assert.equal(packetKind([posturePacket()]), "unknown");
});

test("verifies both products' packets with the one command", () => {
  for (const [name, packet] of [
    ["Sentinel posture", posturePacket()],
    ["Tix incident", tixPacket()],
    ["Tix audit chain", auditChainPacket()],
  ] as const) {
    const { outcome, key } = verifyWithKeys(packet, [{ key: KEY, source: "--key" }]);
    assert.equal(outcome.ok, true, `${name} should verify`);
    assert.equal(key?.source, "--key");
    assert.match(outcome.report?.headline ?? "", /^VERIFIED/, `${name} should print a verified headline`);
  }
});

test("an edit after signing is caught, in either product's packet", () => {
  const editedPosture = posturePacket();
  editedPosture.controls[0].state = "FAIL";
  const posture = verifyWithKeys(editedPosture, [{ key: KEY, source: "--key" }]);
  assert.equal(posture.outcome.ok, false);
  assert.match(posture.outcome.reason ?? "", /do not match its content hash/);
  assert.match(posture.outcome.report?.headline ?? "", /^FAILED/);

  const editedTix = tixPacket();
  editedTix.incident.phase = "OPEN";
  const tix = verifyWithKeys(editedTix, [{ key: KEY, source: "--key" }]);
  assert.equal(tix.outcome.ok, false);
  assert.match(tix.outcome.reason ?? "", /do not match its content hash/);
});

test("a foreign key fails on the signature, not on the contents", () => {
  for (const packet of [posturePacket(OTHER_KEY), tixPacket(OTHER_KEY)]) {
    const { outcome } = verifyWithKeys(packet, [{ key: KEY, source: "--key" }]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /signature does not match/);
  }
});

test("tries each key and keeps the most useful failure when none works", () => {
  // The right key is second: a reviewer holding two deployments' secrets should not
  // have to know which one signed the file they were handed.
  const verified = verifyWithKeys(tixPacket(), [
    { key: OTHER_KEY, source: "--key" },
    { key: KEY, source: "second" },
  ]);
  assert.equal(verified.outcome.ok, true);
  assert.equal(verified.key?.source, "second");

  // The document itself is broken, so no key can save it — and reporting a key
  // mismatch would send the reviewer after the wrong thing.
  const broken = posturePacket();
  broken.organization = "Someone Else";
  const failure = verifyWithKeys(broken, [
    { key: OTHER_KEY, source: "--key" },
    { key: KEY, source: "second" },
  ]);
  assert.equal(failure.outcome.ok, false);
  assert.match(failure.outcome.reason ?? "", /content hash/);
});

test("collects keys from both products' environments and drops blanks", () => {
  const keys = candidateKeys([], {
    ONTRAK_TIX_ASSURANCE_SECRET: "tix-secret-long-enough",
    TIX_AUTH_SECRET: "",
    AUTH_SECRET: "session-secret-long-enough",
    SENTINEL_ASSURANCE_SECRET: "sentinel-secret-long-enough",
    SENTINEL_SIGNING_KEY: "sentinel-signing-key-long-enough",
  });
  assert.deepEqual(
    keys.map((entry) => entry.key),
    ["tix-secret-long-enough", "session-secret-long-enough", "sentinel-secret-long-enough", "sentinel-signing-key-long-enough"],
  );

  // An unset variable passed through by a compose file arrives as "", and every
  // named env is reachable by name so a reviewer can be told which one worked.
  const named = candidateKeys([], { [SENTINEL_KEY_ENVS[0]]: "sentinel-secret-long-enough" });
  assert.deepEqual(named, [{ key: "sentinel-secret-long-enough", source: "SENTINEL_ASSURANCE_SECRET" }]);

  // The same key named twice is one attempt, and --key comes first.
  const explicit = candidateKeys(["--value", "--value"], { ONTRAK_TIX_ASSURANCE_SECRET: "tix-secret-long-enough" });
  assert.deepEqual(explicit, [
    { key: "--value", source: "--key" },
    { key: "tix-secret-long-enough", source: "ONTRAK_TIX_ASSURANCE_SECRET" },
  ]);
});

test("parses repeated --key and a single path", () => {
  assert.deepEqual(parseArgs(["--key", "one", "--quiet", "packet.json", "--key", "two"]), {
    path: "packet.json",
    keys: ["one", "two"],
    quiet: true,
    help: false,
  });
  assert.deepEqual(parseArgs(["--help"]), { path: null, keys: [], quiet: false, help: true });
});

test("the command reports a verified packet, a forged one and an unreadable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-verify-packet-"));
  try {
    const good = join(dir, "posture.json");
    writeFileSync(good, JSON.stringify(posturePacket()));

    const forged = posturePacket();
    forged.organization = "Somebody Else Ltd";
    const forgedPath = join(dir, "forged.json");
    writeFileSync(forgedPath, JSON.stringify(forged));

    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-packet.ts", ...args], {
        encoding: "utf8",
        timeout: 120_000,
      });

    const verified = run(good, "--key", KEY);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^VERIFIED/);
    assert.match(verified.stdout, /packet kind: Sentinel compliance posture/);

    const failed = run(forgedPath, "--key", KEY);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /^FAILED/);

    // 2 is "could not read it", which a pipeline must be able to tell from "it is forged".
    const missing = run(join(dir, "absent.json"), "--key", KEY, "--quiet");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Could not read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
