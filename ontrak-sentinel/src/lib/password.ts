/**
 * Password hashing for the console's own sign-in.
 *
 * Sentinel is an identity provider, which means it is the one place in the family
 * that has to hold a password verifier rather than delegate one. The `Credential`
 * table stores a *hash* and nothing else, so a database copy is not a credential
 * dump; this module is what turns a typed password into that hash and back into a
 * yes/no.
 *
 * **scrypt from `node:crypto`, not a dependency.** Argon2id is the better answer on
 * paper and the schema comment names it first, but it would mean a native build in
 * every environment that runs this repo — including the ones that must stay
 * dependency-light. scrypt is memory-hard, in the standard library, and with the
 * parameters below (N=16384, r=8, p=1 → ~16 MiB per guess) sits in the same class as
 * Argon2id's default cost for the purpose of offline cracking. If a deployment wants
 * Argon2id later, the stored string is self-describing, so a new algorithm can be
 * added without a migration.
 *
 * **The parameters are stored with the hash.** `scrypt$16384$8$1$<salt>$<key>` — a
 * verifier that assumed today's cost would silently reject every password after the
 * cost was raised, which is the classic way a password reset becomes mandatory.
 *
 * **Never a `===`.** Comparison is `timingSafeEqual`, because a byte-by-byte compare
 * that returns early leaks the length of the shared prefix, and that is enough to
 * walk a hash out one byte at a time.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** The algorithm tag, first field of the stored string. */
const ALGORITHM = "scrypt";

/**
 * Today's cost. `N` is the CPU/memory work factor, `r` the block size and `p` the
 * parallelism. These are the parameters `node:crypto`'s own documentation calls the
 * default recommendation; raising `N` twice doubles the work for both sides.
 */
const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * `maxmem` has to be passed explicitly and generously.
 *
 * Node's default cap is 32 MiB, and scrypt's working set is roughly
 * `128 * N * r` = 16 MiB here — close enough to the cap that a modest bump to `N`
 * would throw "memory limit exceeded" instead of hashing.
 */
function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2;
}

export interface PasswordHashOptions {
  n?: number;
  r?: number;
  p?: number;
}

/**
 * Hash a password for storage.
 *
 * A fresh 16-byte salt every call, so two people who chose the same password do not
 * share a hash and a precomputed table cannot be used against the table as a whole.
 */
export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  const n = options.n ?? DEFAULT_N;
  const r = options.r ?? DEFAULT_R;
  const p = options.p ?? DEFAULT_P;
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: maxmemFor(n, r) });
  return [ALGORITHM, n, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Whether a typed password matches a stored hash.
 *
 * `false` for every failure — absent, malformed, wrong algorithm, wrong password.
 * The caller has one question and four ways of saying no would be four ways to leak
 * which one it was.
 *
 * An unrecognised algorithm is a `false` rather than a throw: a row written by a
 * future version is a credential that does not verify, and turning that into a 500
 * would turn a failed login into an outage.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6) return false;

  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] = parts as [string, string, string, string, string, string];
  if (algorithm !== ALGORITHM) return false;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  // Bounds rather than trust: these come out of the database, and a row edited to
  // `N=2**30` must be a `false` (or a hang), never a machine brought to its knees by
  // a login attempt.
  if (!Number.isInteger(n) || n < 2 || n > 1 << 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 64) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, "base64");
    expected = Buffer.from(rawKey, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: maxmemFor(n, r) });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Whether a stored hash needs rehashing under the current cost.
 *
 * The hook that makes raising the cost a non-event: sign-in verifies with whatever
 * is stored, then rewrites it at today's parameters when this returns `true`.
 */
export function needsRehash(stored: string, options: PasswordHashOptions = {}): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6) return true;
  const [algorithm, rawN, rawR, rawP] = parts as [string, string, string, string, string, string];
  if (algorithm !== ALGORITHM) return true;
  return (
    Number(rawN) < (options.n ?? DEFAULT_N) ||
    Number(rawR) < (options.r ?? DEFAULT_R) ||
    Number(rawP) < (options.p ?? DEFAULT_P)
  );
}

/** The parameters a newly written hash will use, for tests and for a config page. */
export const PASSWORD_HASH_PARAMETERS = { n: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P } as const;
