/**
 * The compliance packet's signing seam (S4).
 *
 * The packet's rules are pure and take the signer as an argument; this is where a real
 * key becomes one. An HMAC is the right primitive for the same reason OnTrak Tix gives
 * for the incident packet: the document is produced by this deployment and verified by
 * this deployment (or by somebody it hands the key to), which is exactly what an HMAC
 * proves — the contents are ours and have not been edited — without the ceremony of a
 * certificate chain.
 *
 * The key is read from the environment and never stored per organization, so a copy of
 * the database is not enough to forge a packet. `SENTINEL_ASSURANCE_SECRET` is the one
 * a deployment that hands packets to third parties should set; the fallback is the
 * IdP's own signing key, which is already a secret this deployment holds and rotates,
 * so a deployment that has an identity provider at all can export a packet without
 * being told about a second variable first.
 */

import { createHmac } from "node:crypto";

import type { SignFn } from "./assurance-packet";

export const ASSURANCE_SECRET_ENV = "SENTINEL_ASSURANCE_SECRET";

/**
 * The key packets are signed with. Throws when there is nothing to sign with, rather
 * than signing with an empty string and producing a document that looks signed.
 */
export function assuranceSecret(env: Record<string, string | undefined> = process.env): string {
  const value = env[ASSURANCE_SECRET_ENV] ?? env.SENTINEL_SIGNING_KEY ?? "";
  if (value.length < 16) {
    throw new Error(
      `${ASSURANCE_SECRET_ENV} (or SENTINEL_SIGNING_KEY) is missing or too short. ` +
        "Set a long random value before exporting compliance packets.",
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
