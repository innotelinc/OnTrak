/**
 * Generate the provider's signing key once, into a file, and never again.
 *
 * This is the one-shot service a container stack runs before the provider starts,
 * and it exists to close a specific hole: with no key configured, the provider
 * generates an ephemeral one, so every ID token it has signed stops verifying the
 * moment the process restarts. A client that cached the JWKS is then holding a key
 * that no longer signs anything, and the symptom is a wave of token rejections
 * across everything the provider federates into rather than an error at startup.
 *
 * So the key is written to a file on a volume, and:
 *
 *  - **the first run creates it and every later run reuses it** — restarting,
 *    rebuilding the image or recreating the container all keep signing with the
 *    same key, which is the property the tokens depend on;
 *  - **an existing key is never overwritten.** A file that is present but
 *    unreadable is reported and the process fails, rather than being replaced with
 *    a fresh key: silently rotating a signing key invalidates everything it ever
 *    signed, which is precisely the outcome this script is here to prevent. An
 *    operator who really does want a new key moves the old one aside, on purpose,
 *    and accepts that;
 *  - **it is written `0600` and atomically.** A half-written PEM on a crash would
 *    leave a provider that cannot start on a key that looks present, so the bytes
 *    land in a temporary file and are renamed into place.
 *
 *   SENTINEL_SIGNING_KEY_FILE=/run/sentinel/signing-key.pem \
 *     node --import tsx scripts/signing-key.ts
 *
 * `SENTINEL_SIGNING_KEY` takes precedence over this at run time: a deployment that
 * resolves its secrets before the process starts says so with that, and knows
 * better than a file on a volume.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { generateSigningKey, signingKeyFromPem } from "../src/lib/oidc-keys";

const FILE_ENV = "SENTINEL_SIGNING_KEY_FILE";
const KID_ENV = "SENTINEL_SIGNING_KID";
const DEFAULT_KID = "sentinel-s1";

function fail(message: string): never {
  console.error(`[sentinel] signing key: ${message}`);
  process.exit(1);
}

function main(): void {
  const path = process.env[FILE_ENV]?.trim();
  if (!path) {
    fail(
      `${FILE_ENV} is unset, so there is nowhere to keep the key. A deployment that ` +
        "supplies the PEM directly sets SENTINEL_SIGNING_KEY instead and does not " +
        "run this at all.",
    );
  }

  const kid = process.env[KID_ENV]?.trim() || DEFAULT_KID;

  if (existsSync(path)) {
    // Present: prove it is usable before reporting success, because a file that
    // exists and a key that works are different claims and only the second one
    // lets the provider start.
    const existing = readFileSync(path, "utf8");
    try {
      signingKeyFromPem(existing, kid);
    } catch (error) {
      fail(
        `“${path}” exists but is not a private key this provider can use ` +
          `(${error instanceof Error ? error.message : String(error)}). It has been ` +
          "left untouched: replacing it would invalidate every token it has already " +
          "signed. Move it aside deliberately if that is what you intend.",
      );
    }
    console.log(`[sentinel] signing key: reusing the key already at ${path} (kid ${kid})`);
    return;
  }

  mkdirSync(dirname(path), { recursive: true });

  const pem = generateSigningKey(kid).privateKey.export({ type: "pkcs8", format: "pem" });
  // Renamed from a sibling so a crash mid-write cannot leave a truncated key where
  // the next run would find it and refuse to start.
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, pem, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone or was never created; either way there
      // is nothing to clean up and the real failure is the one below.
    }
    fail(
      `could not write “${path}”: ${error instanceof Error ? error.message : String(error)}. ` +
        "In a container this usually means the volume is not mounted or is not " +
        "writable by the user the image runs as.",
    );
  }

  console.log(`[sentinel] signing key: created ${path} (kid ${kid}, 0600). It will be reused from now on.`);
}

main();
