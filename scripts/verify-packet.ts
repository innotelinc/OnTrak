#!/usr/bin/env node
/**
 * One verifier for the family's signed assurance packets.
 *
 * OnTrak Tix and OnTrak Sentinel export two different *subjects* in one envelope,
 * and both files say why in as many words: Tix's envelope exists "so that
 * verification can be written once", and Sentinel's packet is "deliberately one
 * format rather than two", because "a verifier that has to know which product
 * produced a document is a verifier that gets rewritten for the third product".
 * Until now each product shipped its own half of that promise: Tix had
 * `ontrak-tix/scripts/verify-packet.ts`, and Sentinel had no offline tool at all —
 * its compliance packets could only be checked from inside a running console.
 *
 * This is the family's verifier, and it is the same contract Tix's tool already
 * documented: a third party holding a file and a key, nothing else. No database,
 * no session, no `db.ts`, no network. It recognises the packet by what is inside
 * it — Sentinel's `packet` kind, Tix's `audit` kind, or Tix's `incident` — and
 * hands it to that product's own verification rules, so each product keeps one
 * implementation of "is this signature ours" and there are still only two.
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

import { readFileSync } from "node:fs";

import {
  COMPLIANCE_PACKET_KIND,
  packetVerificationReport as postureReport,
  verifyCompliancePacket,
  type CompliancePacket,
} from "../ontrak-sentinel/src/lib/assurance-packet";
import { hmacSigner as postureSigner } from "../ontrak-sentinel/src/lib/assurance-sign";
import { sha256Hex } from "../ontrak-sentinel/src/lib/hash";
import {
  candidateSecrets as tixCandidateSecrets,
  verifyPacketObject as verifyAsTixPacket,
} from "../ontrak-tix/src/lib/assurance-verify";

/** Tix's audit-chain export, which states its kind rather than its subject. */
export const TIX_AUDIT_CHAIN_KIND = "ontrak-tix-audit-chain";

/** The keys Sentinel signs with, in the order its signer prefers them. */
export const SENTINEL_KEY_ENVS = ["SENTINEL_ASSURANCE_SECRET", "SENTINEL_SIGNING_KEY"] as const;

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
/*  What the document is                                                      */
/* -------------------------------------------------------------------------- */

export type PacketKind = "sentinel-posture" | "tix-incident" | "tix-audit-chain" | "unknown";

/**
 * Read the subject out of the document rather than out of its filename.
 *
 * A packet that names neither kind is still worth checking: verification is about
 * the envelope, and saying "I cannot name this subject" is not the same answer as
 * "this signature is not ours". So `unknown` goes down the shared envelope path.
 */
export function packetKind(value: unknown): PacketKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const packet = value as Record<string, unknown>;
  if (packet.packet === COMPLIANCE_PACKET_KIND) return "sentinel-posture";
  if (packet.kind === TIX_AUDIT_CHAIN_KIND) return "tix-audit-chain";
  if (typeof packet.incident === "object" && packet.incident !== null) return "tix-incident";
  return "unknown";
}

/** A verification reduced to what this tool prints, whichever product produced it. */
export interface Outcome {
  ok: boolean;
  reason: string | null;
  report: { headline: string; lines: string[]; missing: string[] } | null;
}

/**
 * Sentinel's verification, made total like Tix's.
 *
 * Sentinel verifies inside its console, where a packet has already been built by
 * its own code, so `verifyCompliancePacket` may throw on a shape it does not know.
 * A verifier handed a suspicious file cannot assume the file is a packet, and the
 * whole point of checking one is that it might not be.
 */
export function verifyPosturePacket(value: unknown, key: string): Outcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "That is not an assurance packet (expected a JSON object).", report: null };
  }

  const packet = value as CompliancePacket;
  let result;
  try {
    result = verifyCompliancePacket(packet, sha256Hex, postureSigner(key));
  } catch {
    return { ok: false, reason: "That document is not shaped like an assurance packet.", report: null };
  }

  const report = postureReport(packet, result);
  return {
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    report: { headline: report.headline, lines: report.lines, missing: [] },
  };
}

/** Verify a parsed document with the rules of the product that wrote it. */
export function verifyDocument(value: unknown, key: string): Outcome {
  if (packetKind(value) === "sentinel-posture") return verifyPosturePacket(value, key);
  const outcome = verifyAsTixPacket(value, key);
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    report: outcome.report
      ? { headline: outcome.report.headline, lines: outcome.report.lines, missing: outcome.report.missing }
      : null,
  };
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
 * the two products sign with. Blank and short values are dropped the way both
 * products' own secret readers drop them — an unset variable passed through by a
 * compose file arrives as `""`, and trying it would report "wrong key" about a key
 * nobody supplied.
 */
export function candidateKeys(
  explicit: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CandidateKey[] {
  const candidates: CandidateKey[] = explicit.map((key) => ({ key, source: "--key" }));
  for (const key of tixCandidateSecrets(env)) candidates.push({ key, source: "Tix secret" });
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

  const preferred = failures.find((failure) => !SIGNATURE_MISMATCH.test(failure.outcome.reason ?? "")) ?? failures[0];
  return preferred ? { outcome: preferred.outcome, key: null } : { outcome: { ok: false, reason: "No key to verify with.", report: null }, key: null };
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

/** Parse the arguments by hand: a 200-line CLI should not pull in a parser. */
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
  const kind = packetKind(value);
  const headline = outcome.report?.headline ?? `FAILED — ${outcome.reason ?? "the packet could not be read"}`;
  process.stdout.write(`${headline}\n`);

  if (!quiet) {
    process.stdout.write(`  packet: ${describeKind(kind)}\n`);
    if (key) process.stdout.write(`  key: ${key.source}\n`);
    for (const line of outcome.report?.lines ?? []) process.stdout.write(`  ${line}\n`);
    if (outcome.report && outcome.report.missing.length > 0) {
      process.stdout.write("  still missing from the record:\n");
      for (const item of outcome.report.missing) process.stdout.write(`    - ${item}\n`);
    }
  }

  return outcome.ok ? 0 : 1;
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
