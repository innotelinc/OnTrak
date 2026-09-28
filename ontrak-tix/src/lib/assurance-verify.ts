/**
 * Assurance Packet verification (M3): the third party's side of the export.
 *
 * A packet is worth nothing if checking it requires this codebase's database,
 * session or config. So verification takes exactly two things — the packet's
 * bytes and the deployment's key — and nothing else: no Prisma, no session, no
 * `db.ts`. That is what makes `scripts/verify-packet.ts` runnable from a checkout
 * that has never seen the application's environment, and what lets the HTTP
 * verifier stay an unauthenticated, compute-only endpoint.
 *
 * It is also deliberately *total*: a file that is not JSON, or JSON that is not a
 * packet, produces a readable failure rather than an exception. The whole point
 * of verifying a suspicious document is that you cannot assume it is a document.
 */

import { createHash } from "node:crypto";

import { packetVerificationReport, verifyAssurancePacket, type AssurancePacket, type PacketReport } from "./assurance-rules";
import { hmacSigner } from "./assurance-sign";
import type { HashFn } from "./audit-chain";

/** The digest the packet was built with. Kept here so the tool needs no store. */
export const packetHash: HashFn = (input) => createHash("sha256").update(input).digest("hex");

export interface VerificationOutcome {
  ok: boolean;
  /** Why it failed, when it did. */
  reason: string | null;
  /** The readable report; null only when the input was not a packet at all. */
  report: PacketReport | null;
}

/** Verify a packet that has already been parsed. Never throws. */
export function verifyPacketObject(value: unknown, secret: string): VerificationOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "That is not an assurance packet (expected a JSON object).", report: null };
  }

  const packet = value as AssurancePacket;

  let result;
  try {
    result = verifyAssurancePacket(packet, packetHash, hmacSigner(secret));
  } catch {
    return { ok: false, reason: "That document is not shaped like an assurance packet.", report: null };
  }

  return {
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    report: packetVerificationReport(packet, result),
  };
}

/** Verify a packet's text (from a file, an upload or a form). Never throws. */
export function verifyPacketJson(text: string, secret: string): VerificationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file is not valid JSON.", report: null };
  }
  return verifyPacketObject(parsed, secret);
}

/** The key a verifier should try first, then the alternatives the app signs with. */
export function candidateSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const candidates = [env.ONTRAK_TIX_ASSURANCE_SECRET, env.TIX_AUTH_SECRET, env.AUTH_SECRET];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && value.length > 0))];
}
