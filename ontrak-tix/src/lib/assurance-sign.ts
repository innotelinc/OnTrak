/**
 * The Assurance Packet's signing seam (M3).
 *
 * The packet's rules are pure and take the signer as an argument; this is where
 * a real key is turned into one. An HMAC is the right primitive here: a packet
 * is produced by this deployment and verified by this deployment (or by someone
 * it gives the key to), and an HMAC proves exactly that — the contents are ours
 * and have not been edited — without the ceremony of a certificate chain.
 *
 * The key is read from the environment and never stored per tenant, so a
 * database dump is not enough to forge a packet. It falls back to the session
 * secret so a fresh checkout works, but a deployment that hands packets to third
 * parties should set its own.
 */

import { createHmac } from "node:crypto";

import type { SignFn } from "./assurance-rules";

export const ASSURANCE_SECRET_ENV = "ONTRAK_TIX_ASSURANCE_SECRET";

/** The key packets are signed with. Throws when it is missing or too short. */
export function assuranceSecret(env: Record<string, string | undefined> = process.env): string {
  const value = env[ASSURANCE_SECRET_ENV] ?? env.TIX_AUTH_SECRET ?? env.AUTH_SECRET ?? "";
  if (value.length < 16) {
    throw new Error(
      `${ASSURANCE_SECRET_ENV} (or TIX_AUTH_SECRET) is missing or too short. Set a long random value before exporting assurance packets.`,
    );
  }
  return value;
}

/** A signer over the deployment's key. */
export function hmacSigner(secret: string): SignFn {
  return (payload) => createHmac("sha256", secret).update(payload).digest("hex");
}

export function assuranceSigner(env: Record<string, string | undefined> = process.env): SignFn {
  return hmacSigner(assuranceSecret(env));
}
