#!/usr/bin/env node
/**
 * Standalone Assurance Packet verifier (M3).
 *
 * The one thing the signed packet promised is that a third party — an auditor,
 * an insurer, a client — can check it with nothing but the file and the key. So
 * this script deliberately imports three modules and no more: the packet rules,
 * the signer, and the verification helper. No Prisma client, no session, no
 * `db.ts`, no network. It runs from a checkout that has never been configured
 * with the application's environment.
 *
 *   npm run verify:packet -- INC-000007-assurance-packet.json
 *   npm run verify:packet -- packet.json --key "$ONTRAK_TIX_ASSURANCE_SECRET"
 *   cat packet.json | npm run verify:packet
 *
 * Exit codes: 0 verified, 1 failed verification, 2 usage or read error. The
 * distinction matters — "the packet is forged" and "the packet file is missing"
 * are different answers, and a script that conflates them is not usable in a
 * pipeline.
 */

import { readFileSync } from "node:fs";

import { candidateSecrets, verifyPacketJson, type VerificationOutcome } from "../src/lib/assurance-verify";

const USAGE = `Verify a signed OnTrak Tix assurance packet offline.

Usage:
  verify-packet [<packet.json>] [--key <key>] [--quiet]

  <packet.json>   the packet to verify; omit to read from stdin
  --key <key>     the deployment's signing key
                  (default: $ONTRAK_TIX_ASSURANCE_SECRET, then TIX_AUTH_SECRET)
  --quiet         print only the headline

Exit codes: 0 verified, 1 failed, 2 usage or read error.`;

interface Args {
  path: string | null;
  key: string | null;
  quiet: boolean;
  help: boolean;
}

/** Parse the arguments by hand: a 40-line CLI should not pull in a parser. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { path: null, key: null, quiet: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--quiet" || value === "-q") args.quiet = true;
    else if (value === "--key") args.key = argv[++index] ?? null;
    else if (!value.startsWith("-") && args.path === null) args.path = value;
  }
  return args;
}

/** Read the packet from a file, or from stdin when none is named. */
export function readPacket(path: string | null): string {
  return readFileSync(path ?? 0, "utf8");
}

/** Print the outcome and return the process exit code. */
export function report(outcome: VerificationOutcome, quiet: boolean): number {
  const headline = outcome.report?.headline ?? `FAILED — ${outcome.reason ?? "the packet could not be read"}`;
  process.stdout.write(`${headline}\n`);

  if (!quiet && outcome.report) {
    for (const line of outcome.report.lines) process.stdout.write(`  ${line}\n`);
    if (outcome.report.missing.length > 0) {
      process.stdout.write("  still missing from the record:\n");
      for (const item of outcome.report.missing) process.stdout.write(`    - ${item}\n`);
    }
  }

  return outcome.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const key = args.key ?? candidateSecrets()[0];
  if (!key) {
    process.stderr.write(
      "No key given. Pass --key, or set ONTRAK_TIX_ASSURANCE_SECRET. Verification is an HMAC check: without the key there is nothing to check against.\n",
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

  return report(verifyPacketJson(text, key), args.quiet);
}

// Only run when invoked directly, so the tests can import the pieces above.
if (process.argv[1]?.endsWith("verify-packet.ts") || process.argv[1]?.endsWith("verify-packet.js")) {
  process.exitCode = main(process.argv.slice(2));
}
