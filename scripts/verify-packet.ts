#!/usr/bin/env node
/**
 * One verifier for the family's signed assurance packets.
 *
 * OnTrak Tix and OnTrak Sentinel export two different *subjects* in one envelope,
 * and both files say why in as many words: Tix's envelope exists "so that
 * verification can be written once", and Sentinel's packet is "deliberately one
 * format rather than two", because "a verifier that has to know which product
 * produced a document is a verifier that gets rewritten for the third product".
 * Until now each product shipped half of that promise: Tix had
 * `ontrak-tix/scripts/verify-packet.ts`, and Sentinel had no offline tool at all —
 * its compliance packets could only be checked from inside a running console.
 *
 * So this tool is the family's, and it is the contract Tix's tool already
 * documented: a third party holding a file and a key, nothing else. No database,
 * no session, no `db.ts`, no network — and deliberately no import from either
 * product. The first version imported each product's own rules and verified the
 * document by kind; that reads better and breaks the training image, which builds
 * the app without the sibling checkouts beside it, so `next build` could not
 * resolve the imports. The envelope is the stable thing here: canonical JSON,
 * SHA-256 for the two digests, HMAC-SHA256 over the content digest. This file
 * implements exactly that, and the two products' own suites keep asserting their
 * builders agree with it.
 *
 *   npm run verify:packet -- COMPLIANCE.json
 *   npm run verify:packet -- packet.json --key "$ONTRAK_TIX_ASSURANCE_SECRET"
 *   npm run verify:packet -- packet.json --key "$ONTRAK_TIX_ASSURANCE_SECRET" \
 *                                        --key "$SENTINEL_ASSURANCE_SECRET"
 *   cat packet.json | npm run verify:packet
 *
 * Without `--key` every key either product signs with is tried, in the order a
 * deployment sets them: Tix's assurance secret, then the session secrets it falls
 * back to, then Sentinel's assurance secret and its signing key. Passing `--key`
 * more than once narrows that list, so a reviewer can check two packets from two
 * products without exporting both secrets into their shell.
 *
 * Exit codes: 0 verified, 1 failed verification, 2 usage or read error. The
 * distinction is Tix's and worth keeping — "the packet is forged" and "the packet
 * file is missing" are different answers, and a script that conflates them is not
 * usable in a pipeline.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** The shared assurance-packet format version. Both products ship "1.0". */
export const PACKET_VERSION = "1.0";

/** The one algorithm the family's packets are signed with. */
export const ALGORITHM = "HMAC-SHA256";

/** Sentinel's compliance-posture packets name their kind in `packet`. */
export const SENTINEL_POSTURE_KIND = "sentinel-compliance-posture";

/** Tix's audit-chain exports name their kind in `kind`. */
export const TIX_AUDIT_CHAIN_KIND = "ontrak-tix-audit-chain";

/** The keys Sentinel signs with, in the order its signer prefers them. */
export const SENTINEL_KEY_ENVS = ["SENTINEL_ASSURANCE_SECRET", "SENTINEL_SIGNING_KEY"] as const;

/**
 * Tix's keys, in `candidateSecrets`' order: the assurance secret, then the session
 * secrets its signer falls back to so a fresh checkout can export at all.
 */
export const TIX_KEY_ENVS = ["ONTRAK_TIX_ASSURANCE_SECRET", "TIX_AUTH_SECRET", "AUTH_SECRET"] as const;

const USAGE = `Verify a signed OnTrak assurance packet offline — Tix incident packets,
Tix audit-chain exports and Sentinel compliance-posture packets.

Usage:
  verify-packet [<packet.json>] [--key <key>]... [--quiet]

  <packet.json>   the packet to verify; omit to read from stdin
  --key <key>     a signing key to try; repeat to try several
                  (default: ONTRAK_TIX_ASSURANCE_SECRET, TIX_AUTH_SECRET,
                  AUTH_SECRET, SENTINEL_ASSURANCE_SECRET, SENTINEL_SIGNING_KEY)
  --quiet         print only the headline

Exit codes: 0 verified, 1 failed, 2 usage or read error.`;

/* -------------------------------------------------------------------------- */
/*  The format                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The canonical bytes both products digest: object keys sorted, arrays in order,
 * `undefined` members dropped. This is the format's definition, not a convenience
 * — a digest over different bytes is a different document.
 */
export function stableStringify(value: unknown): string {
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

export const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

export const hmac = (input: string, key: string): string =>
  createHmac("sha256", key).update(input).digest("hex");

/** Constant-time compare, so a signature check does not leak how far it matched. */
function sameDigest(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/*  What the document is                                                      */
/* -------------------------------------------------------------------------- */

export type PacketKind = "sentinel-posture" | "tix-incident" | "tix-audit-chain" | "unknown";

/**
 * Read the subject out of the document rather than out of its filename.
 *
 * A packet that names neither kind is still worth checking: verification is about
 * the envelope, and saying "I cannot name this subject" is not the same answer as
 * "this signature is not ours". So `unknown` is verified too.
 */
export function packetKind(value: unknown): PacketKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const packet = value as Record<string, unknown>;
  if (packet.packet === SENTINEL_POSTURE_KIND) return "sentinel-posture";
  if (packet.kind === TIX_AUDIT_CHAIN_KIND) return "tix-audit-chain";
  if (typeof packet.incident === "object" && packet.incident !== null) return "tix-incident";
  return "unknown";
}

function describeKind(kind: PacketKind): string {
  switch (kind) {
    case "sentinel-posture":
      return "Sentinel compliance posture";
    case "tix-incident":
      return "Tix incident assurance packet";
    case "tix-audit-chain":
      return "Tix audit-chain export";
    case "unknown":
      return "unrecognised subject (checked as the shared envelope)";
  }
}

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

/** A verification reduced to what this tool prints. */
export interface Outcome {
  ok: boolean;
  reason: string | null;
  report: { headline: string; lines: string[] } | null;
}

/**
 * Verify a packet without the database: recompute both digests from the packet's
 * own contents and check the signature over the content digest. An edit after
 * signing fails the signature check; a hand-rewritten packet fails the digest
 * checks; and a packet whose *record* was altered fails the record check even if
 * somebody recomputed the rest. Never throws: a verifier is handed files that
 * might not be packets at all.
 */
export function verifyDocument(value: unknown, key: string): Outcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "That is not an assurance packet (expected a JSON object).", report: null };
  }

  const packet = value as Record<string, unknown>;
  const { generatedAt, contentHash, recordHash, signature, algorithm, ...content } = packet;
  void generatedAt;

  const lines = reportLines(packet);

  if (typeof contentHash !== "string" || typeof recordHash !== "string" || typeof signature !== "string") {
    return {
      ok: false,
      reason: "That document is not shaped like an assurance packet.",
      report: { headline: "FAILED — That document is not shaped like an assurance packet.", lines },
    };
  }

  if (sha256(stableStringify(content)) !== contentHash) {
    return fail("The packet contents do not match its content hash.", lines);
  }

  const { audit, ...record } = content;
  void audit;
  if (sha256(stableStringify(record)) !== recordHash) {
    // The record's label differs by product; the assertion is the same one.
    return fail(
      packetKind(packet) === "sentinel-posture"
        ? "The posture record does not match its record hash."
        : "The incident record does not match its record hash.",
      lines,
    );
  }

  if (algorithm !== ALGORITHM) {
    return fail(`Unknown signature algorithm "${String(algorithm)}".`, lines);
  }
  if (!sameDigest(hmac(contentHash, key), signature)) {
    return fail("The signature does not match this deployment's key.", lines);
  }

  return { ok: true, reason: null, report: { headline: `VERIFIED — ${subject(packet)}`, lines } };
}

function fail(reason: string, lines: string[]): Outcome {
  return { ok: false, reason, report: { headline: `FAILED — ${reason}`, lines } };
}

/** One line saying what the intact document is about. */
function subject(packet: Record<string, unknown>): string {
  switch (packetKind(packet)) {
    case "sentinel-posture": {
      const controls = Array.isArray(packet.controls) ? packet.controls : [];
      const failed = controls.filter((control) => (control as { state?: unknown })?.state === "FAIL").length;
      const warned = controls.filter((control) => (control as { state?: unknown })?.state === "WARN").length;
      const state = failed > 0 ? `${failed} control(s) read FAIL` : warned > 0 ? `${warned} control(s) read WARN` : "every control reads OK";
      return `the compliance packet is intact, and ${state}.`;
    }
    case "tix-incident":
      return "the incident packet is intact.";
    case "tix-audit-chain":
      return "the audit-chain export is intact.";
    case "unknown":
      return "the document is intact (its subject could not be named).";
  }
}

/** What a reviewer reads next, whichever product wrote the document. */
function reportLines(packet: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const kind = packetKind(packet);
  lines.push(`packet kind: ${describeKind(kind)}`);
  lines.push(`packet version: ${asText(packet.version)}`);

  const incident = packet.incident as { ref?: unknown; title?: unknown; severity?: unknown; phase?: unknown } | undefined;
  if (incident) {
    lines.push(`incident: ${asText(incident.ref)}${typeof incident.title === "string" ? ` — ${incident.title}` : ""}`);
    lines.push(`severity / phase: ${asText(incident.severity)} / ${asText(incident.phase)}`);
  }
  if (kind === "sentinel-posture") {
    lines.push(`organization: ${asText(packet.organization)}`);
    const controls = Array.isArray(packet.controls) ? packet.controls : [];
    lines.push(`controls: ${controls.length}`);
  }

  lines.push(`record hash: ${asText(packet.recordHash)}`);
  lines.push(`content hash: ${asText(packet.contentHash)}`);
  lines.push(`signature: ${asText(packet.signature)} (${asText(packet.algorithm)})`);

  const audit = packet.audit as { length?: unknown; verified?: unknown; exportSeq?: unknown } | undefined;
  const cut =
    audit?.exportSeq === undefined
      ? `audit anchor: ${asText(audit?.length)} event(s), verified at export: ${asText(audit?.verified)}`
      : `audit anchor: seq ${asText(audit?.exportSeq)} after a chain of ${asText(audit?.length)} (verified at export: ${asText(audit?.verified)})`;
  lines.push(cut);

  const policies = Array.isArray(packet.policies) ? packet.policies : [];
  lines.push(
    `policies in force: ${
      policies.length === 0
        ? "(none recorded)"
        : policies.map((policy) => `${(policy as { key?: unknown })?.key}@${(policy as { version?: unknown })?.version}`).join(", ")
    }`,
  );
  lines.push(`exported at: ${asText(packet.generatedAt)}`);

  // Counts, not a judgement: whether the record is *complete* is Tix's rule, and
  // its own verifier answers it for Tix packets.
  const counts: string[] = [];
  for (const [label, field] of [
    ["evidence", "evidence"],
    ["custody", "custody"],
    ["timeline", "timeline"],
    ["chains", "entries"],
  ] as const) {
    const list = packet[field];
    if (Array.isArray(list)) counts.push(`${list.length} ${label}`);
  }
  if (counts.length > 0) lines.push(`record holds: ${counts.join(", ")}`);

  return lines;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "(absent)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "(unreadable)";
}

/* -------------------------------------------------------------------------- */
/*  Which key                                                                 */
/* -------------------------------------------------------------------------- */

export interface CandidateKey {
  key: string;
  /** Where the key came from, so a reviewer can tell which one worked. */
  source: string;
}

/**
 * The keys to try, in order: the ones named on the command line, then every key
 * the two products sign with. Blank values are dropped the way both products'
 * secret readers drop them — an unset variable passed through by a compose file
 * arrives as `""`, and trying it would report "wrong key" about a key nobody
 * supplied.
 */
export function candidateKeys(
  explicit: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CandidateKey[] {
  const candidates: CandidateKey[] = explicit.map((key) => ({ key, source: "--key" }));
  for (const name of TIX_KEY_ENVS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") candidates.push({ key: value, source: name });
  }
  for (const name of SENTINEL_KEY_ENVS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") candidates.push({ key: value, source: name });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.key.trim() === "" || seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
}

/** A failure that is not about the key is more useful than one that is. */
const SIGNATURE_MISMATCH = /signature does not match/i;

/**
 * Try each key until one verifies, then report that one.
 *
 * When none does, the *document* being broken outranks the key being wrong: if a
 * packet fails its content hash, no key can rescue it and saying "the signature
 * does not match" would send the reviewer after the wrong thing.
 */
export function verifyWithKeys(
  value: unknown,
  keys: readonly CandidateKey[],
): { outcome: Outcome; key: CandidateKey | null } {
  const failures: { outcome: Outcome; key: CandidateKey }[] = [];
  for (const key of keys) {
    const outcome = verifyDocument(value, key.key);
    if (outcome.ok) return { outcome, key };
    failures.push({ outcome, key });
  }

  const preferred =
    failures.find((failure) => !SIGNATURE_MISMATCH.test(failure.outcome.reason ?? "")) ?? failures[0];
  return preferred
    ? { outcome: preferred.outcome, key: null }
    : { outcome: { ok: false, reason: "No key to verify with.", report: null }, key: null };
}

/* -------------------------------------------------------------------------- */
/*  The command                                                               */
/* -------------------------------------------------------------------------- */

interface Args {
  path: string | null;
  keys: string[];
  quiet: boolean;
  help: boolean;
}

/** Parse the arguments by hand: a 400-line CLI should not pull in a parser. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { path: null, keys: [], quiet: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--quiet" || value === "-q") args.quiet = true;
    else if (value === "--key") {
      const key = argv[++index];
      if (typeof key === "string" && key !== "") args.keys.push(key);
    } else if (!value.startsWith("-") && args.path === null) args.path = value;
  }
  return args;
}

/** Read the packet from a file, or from stdin when none is named. */
export function readPacket(path: string | null): string {
  return readFileSync(path ?? 0, "utf8");
}

/** Print the outcome and return the process exit code. */
export function report(
  value: unknown,
  outcome: Outcome,
  key: CandidateKey | null,
  quiet: boolean,
): number {
  const headline = outcome.report?.headline ?? `FAILED — ${outcome.reason ?? "the packet could not be read"}`;
  process.stdout.write(`${headline}\n`);

  if (!quiet) {
    if (key) process.stdout.write(`  key: ${key.source}\n`);
    for (const line of outcome.report?.lines ?? []) process.stdout.write(`  ${line}\n`);
    if (!outcome.report) process.stdout.write(`  subject: ${describeKind(packetKind(value))}\n`);
  }

  return outcome.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const keys = candidateKeys(args.keys);
  if (keys.length === 0) {
    process.stderr.write(
      "No key given. Pass --key, or set ONTRAK_TIX_ASSURANCE_SECRET or SENTINEL_ASSURANCE_SECRET. " +
        "Verification is an HMAC check: without the key there is nothing to check against.\n",
    );
    return 2;
  }

  let text: string;
  try {
    text = readPacket(args.path);
  } catch (error) {
    process.stderr.write(`Could not read ${args.path ?? "stdin"}: ${(error as Error).message}\n`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stdout.write("FAILED — That file is not valid JSON.\n");
    return 1;
  }

  const { outcome, key } = verifyWithKeys(parsed, keys);
  return report(parsed, outcome, key, args.quiet);
}

// Only run when invoked directly, so the tests can import the pieces above.
if (process.argv[1]?.endsWith("verify-packet.ts") || process.argv[1]?.endsWith("verify-packet.js")) {
  process.exitCode = main(process.argv.slice(2));
}
