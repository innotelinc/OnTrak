/**
 * Password hashing (M0): the local sign-in fallback.
 *
 * scrypt with a per-password salt, encoded as `scrypt:salt:hash`. Pure and
 * dependency-free so it is unit-testable and portable; the OnTrak Sentinel IdP
 * supersedes it at M2, but a desk has to be signable-in before then.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCHEME = "scrypt";
const KEY_LENGTH = 64;

export const PASSWORD_MIN_LENGTH = 8;

/** A human-readable problem with a proposed password, or `null` when it is fine. */
export function passwordIssue(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `A password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

/** Hash a password into a self-describing `scrypt:salt:hash` string. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${SCHEME}:${salt}:${hash}`;
}

/** Verify a password against a stored hash, in constant time. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== SCHEME || !salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
