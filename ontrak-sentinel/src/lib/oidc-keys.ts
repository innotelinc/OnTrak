/**
 * ID-token signing (S1): the one part of the handshake that is not pure.
 *
 * An ID token is only worth anything because a client can check that the
 * provider signed it and nobody else did. That means a key pair, a signature
 * over the token, and a public JWKS a client can fetch and cache:
 *
 *  - **RS256, not HS256.** The signing key is a private key the provider never
 *    shares, and clients verify with the public one. A shared secret would mean
 *    every client — including a customer's own app — holds something that can
 *    mint identity, which is the wrong shape for an IdP.
 *  - **The `kid` is in the header and in the JWKS.** Rotation is a matter of
 *    publishing a second key before switching to it, without a client having to
 *    guess which one signed what it just received. `SigningKeys` is that overlap
 *    made explicit: every published key, active first.
 *  - **Signing and verifying live together**, because a test that signs a token
 *    and checks its own work with different code would pass while the real
 *    verifier failed. `verifyJwt` is also what a client would do, including the
 *    claim checks the standard puts on the consumer: issuer, audience, expiry.
 *
 * Node's crypto only; no dependency. A hardware-backed signer can replace
 * `signJwt` without any of the rules changing.
 *
 * The last section reads the deployment's own variables (`loadSigningKeys`), so the
 * decision of *which* key signs and *which* keys are published is testable without
 * starting a process — the misconfigurations below are the ones worth catching, and a
 * provider that only reveals them at boot reveals them in production.
 */

import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** The provider's signing key. */
export interface SigningKey {
  kid: string;
  alg: "RS256";
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/**
 * Every key this provider publishes, **active first**.
 *
 * `keys[0]` is what new signatures are made with; the rest are keys a client may
 * still be holding a token signed by. A non-empty tuple rather than a
 * `{ active, all }` pair, because the two invariants that matter — there is always
 * an active key, and the active key is always published — are then the type rather
 * than a comment somebody has to keep true.
 *
 * Rotation is the reason this is a set at all: a key cannot be swapped in a single
 * step, because for as long as the old key's tokens are valid the new key has to be
 * *published* before it can be *used*. The overlap is the whole mechanism.
 */
export type SigningKeys = readonly [SigningKey, ...SigningKey[]];

/** The set of one: a provider that has not been given a second key to publish yet. */
export function oneKey(key: SigningKey): SigningKeys {
  return [key];
}

/**
 * One key or a set of them. A caller verifying its own signature holds the one key it
 * signed with; a provider holds the set, because after a rotation those are different
 * questions. `Array.isArray` is the whole discriminator — a key is an object and a set
 * is an array — but it is named here so the check reads as intent rather than as a
 * trick, and so the narrowing is in one place for the compiler to follow.
 */
function isKeySet(key: SigningKey | SigningKeys): key is SigningKeys {
  return Array.isArray(key);
}

/** The key new signatures are made with. */
export function activeKey(keys: SigningKeys): SigningKey {
  return keys[0];
}

/**
 * The key a token names, or `null` when it names one this provider does not have.
 *
 * Resolving the `kid` rather than assuming the active key is the point of the whole
 * exercise: a token signed before a rotation is still valid, and the client
 * verifying it holds the key it was signed with, not the one signing now.
 */
export function keyForKid(keys: SigningKeys, kid: string): SigningKey | null {
  return keys.find((candidate) => candidate.kid === kid) ?? null;
}

const DEFAULT_KID = "sentinel-s1";

/** A fresh 2048-bit RSA key pair, for a deployment that has not been given one. */
export function generateSigningKey(kid: string = DEFAULT_KID): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, alg: "RS256", privateKey, publicKey };
}

/**
 * A key pair loaded from a PEM private key — how a deployment keeps the signing
 * key out of the source tree and out of a generated one.
 */
export function signingKeyFromPem(privatePem: string, kid: string = DEFAULT_KID): SigningKey {
  const privateKey = createPrivateKey(privatePem);
  return { kid, alg: "RS256", privateKey, publicKey: createPublicKey(privateKey) };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** The compact JWS: `base64url(header).base64url(claims).base64url(signature)`. */
export function signJwt(claims: Record<string, unknown>, key: SigningKey): string {
  const header = { alg: key.alg, typ: "JWT", kid: key.kid };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  // PKCS#1 v1.5 over SHA-256 is what `RS256` means; the defaults are right, and
  // they are named here so nobody has to remember that.
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: key.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export interface JwtExpectation {
  issuer?: string;
  audience?: string;
  nonce?: string;
  nowMs?: number;
  /** Seconds of clock skew to allow on `exp`. */
  leewaySeconds?: number;
}

export type JwtResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Verify a compact JWS and, when expectations are given, the claims only the
 * consumer can check. The signature is checked first: every claim check below it
 * is meaningless if the payload was not signed by this provider.
 *
 * `key` is either the one key that signed the token, or the set to look it up in —
 * a client that cached a JWKS before a rotation verifies against the set, and the
 * `kid` in the header decides which of them it needs.
 */
export function verifyJwt(token: string, key: SigningKey | SigningKeys, expect: JwtExpectation = {}): JwtResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "A compact JWS has three parts." };
  const [headerPart, claimsPart, signaturePart] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "The token header is not JSON." };
  }
  const keys = isKeySet(key) ? key : oneKey(key);
  // The algorithm is judged against the set's own algorithm rather than against the
  // resolved key, so a header naming an algorithm we never chose is refused even
  // when it also names a `kid` we do not have — the cheap refusal comes first.
  if (header.alg !== keys[0].alg) return { ok: false, reason: `The token says it was signed with “${String(header.alg)}”.` };
  const signer = keyForKid(keys, typeof header.kid === "string" ? header.kid : "");
  if (signer === null) return { ok: false, reason: "The token names a signing key this provider does not have." };

  const valid = verify(
    "sha256",
    Buffer.from(`${headerPart}.${claimsPart}`, "utf8"),
    { key: signer.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(signaturePart, "base64url"),
  );
  if (!valid) return { ok: false, reason: "The signature does not verify against this provider's public key." };

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "The token payload is not JSON." };
  }

  if (expect.issuer !== undefined && claims.iss !== expect.issuer.replace(/\/+$/, "")) {
    return { ok: false, reason: "The token was not issued by this provider." };
  }
  if (expect.audience !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expect.audience)) return { ok: false, reason: "The token was issued for another audience." };
  }
  if (expect.nonce !== undefined && claims.nonce !== expect.nonce) {
    return { ok: false, reason: "The token does not answer this sign-in request." };
  }
  if (expect.nowMs !== undefined && typeof claims.exp === "number") {
    const leeway = (expect.leewaySeconds ?? 0) * 1000;
    if (expect.nowMs - leeway >= claims.exp * 1000) return { ok: false, reason: "The token has expired." };
  }
  return { ok: true, claims };
}

/** A JWK Set for `/oauth2/.well-known/jwks.json`. Public parts only. */
export function jwks(...keys: readonly SigningKey[]): { keys: Record<string, unknown>[] } {
  return {
    keys: keys.map((key) => {
      const jwk = key.publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
      return { kty: jwk.kty, use: "sig", alg: key.alg, kid: key.kid, n: jwk.n, e: jwk.e };
    }),
  };
}

/** The PEM a deployment stores; the paired key file is the one that must not leak. */
export function privateKeyToPem(key: SigningKey): string {
  return key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/* -------------------------------------------------------------------------- */
/*  Where a deployment's keys come from                                      */
/* -------------------------------------------------------------------------- */

/** The variables this provider reads its signing keys from. */
export const SIGNING_KEY_ENV = {
  /** The active key's PEM, as a value. */
  key: "SENTINEL_SIGNING_KEY",
  /** The active key's PEM, as a path. What a container stack with a mounted volume uses. */
  keyFile: "SENTINEL_SIGNING_KEY_FILE",
  /** The active key's `kid`. Optional; defaults to a stable name, not a random one. */
  kid: "SENTINEL_SIGNING_KID",
  /** The retired key's PEM, as a value. Published, never used to sign. */
  previousKey: "SENTINEL_SIGNING_PREVIOUS_KEY",
  /** The retired key's PEM, as a path. */
  previousKeyFile: "SENTINEL_SIGNING_PREVIOUS_KEY_FILE",
  /** The retired key's `kid`. Required with either of the two above. */
  previousKid: "SENTINEL_SIGNING_PREVIOUS_KID",
} as const;

/** How the loader gets a PEM that is named as a path rather than handed over as a value. */
export type ReadPemFile = (path: string) => string;

export interface LoadedSigningKeys {
  keys: SigningKeys;
  /**
   * True when the deployment supplied no key at all, so this process is signing with
   * one that dies with it. Returned rather than warned about here, because the warning
   * belongs with the rest of the startup log rather than in the middle of a library.
   */
  ephemeral: boolean;
}

export type SigningKeyEnv = Record<string, string | undefined>;

/** A PEM from the value or the file a variable names, or `null` when neither is set. */
function pemFrom(
  env: SigningKeyEnv,
  valueVar: string,
  fileVar: string,
  readPemFile: ReadPemFile,
  /** What a failed read says to look at — and it has to say *which* variable. */
  refusingBecause: string,
): string | null {
  const value = env[valueVar];
  if (value) return value;

  const file = env[fileVar];
  if (!file) return null;
  try {
    return readPemFile(file);
  } catch (error) {
    throw new Error(
      `${fileVar} is set to “${file}” but could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}. ${refusingBecause}`,
    );
  }
}

/**
 * The keys this process publishes, from the deployment's own variables.
 *
 * Two independent decisions, and keeping them apart is the whole of rotation: **which
 * key signs** and **which keys are published**. They are the same thing until a
 * rotation is half-finished, and half-finished is the correct place to be — the new key
 * is published and not yet used, so that clients can learn it before anything depends
 * on them having done so.
 *
 * Every misconfiguration below **throws**, because each one produces a provider that
 * starts and then quietly misbehaves: a mounted file that was not read would otherwise
 * fall through to an ephemeral key, a retired key with no `kid` would publish two keys
 * under one name, and naming the active key as its own predecessor would do the same
 * thing less obviously. All three surface later as clients failing to verify.
 */
export function loadSigningKeys(
  env: SigningKeyEnv = process.env,
  readPemFile: ReadPemFile = (path) => readFileSync(path, "utf8"),
): LoadedSigningKeys {
  const activePem = pemFrom(
    env,
    SIGNING_KEY_ENV.key,
    SIGNING_KEY_ENV.keyFile,
    readPemFile,
    "Refusing to start on an ephemeral key instead, which would invalidate every token " +
      "this provider has already signed.",
  );

  if (activePem === null) {
    return { keys: oneKey(generateSigningKey()), ephemeral: true };
  }
  const active = signingKeyFromPem(activePem, env[SIGNING_KEY_ENV.kid]);

  const previousPem = pemFrom(
    env,
    SIGNING_KEY_ENV.previousKey,
    SIGNING_KEY_ENV.previousKeyFile,
    readPemFile,
    "Refusing to start rather than publishing a key nobody agreed on, which would make " +
      "every token and assertion signed by the retired key fail to verify.",
  );
  if (previousPem === null) return { keys: oneKey(active), ephemeral: false };

  const kid = env[SIGNING_KEY_ENV.previousKid];
  if (!kid) {
    throw new Error(
      `${SIGNING_KEY_ENV.previousKey} is set but ${SIGNING_KEY_ENV.previousKid} is not. ` +
        "The one thing a published-but-unused key is for is letting a token say which key " +
        "signed it, and two keys under one `kid` is the collision a rotation exists to " +
        "avoid. Name the retired key.",
    );
  }
  if (kid === active.kid) {
    throw new Error(
      `${SIGNING_KEY_ENV.previousKid} is “${kid}”, which is also the active key's. A ` +
        "retired key has to be a different key: a JWKS carrying one `kid` twice leaves a " +
        "client unable to tell which of the two to verify with.",
    );
  }

  return { keys: [active, signingKeyFromPem(previousPem, kid)], ephemeral: false };
}
