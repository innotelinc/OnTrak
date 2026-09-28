/**
 * Password hashing and cosmetic helpers.
 *
 * Kept separate from `auth.ts` on purpose: `auth.ts` touches Next.js request
 * APIs (cookies, `server-only`) and therefore cannot be imported by plain Node
 * scripts such as the database seed.  These primitives have no framework
 * dependencies at all.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

/** Palette names the UI knows how to render. */
export const ACCENT_COLORS = ["violet", "pink", "amber", "teal", "sky", "lime"] as const;

export type AccentName = (typeof ACCENT_COLORS)[number];

/** Deterministic accent so the same person always gets the same color. */
export function pickAccent(seed: string): AccentName {
  let total = 0;
  for (const ch of seed) total = (total + ch.charCodeAt(0)) % 997;
  return ACCENT_COLORS[total % ACCENT_COLORS.length];
}

/** Hash a password with scrypt. Format: `scrypt$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}
