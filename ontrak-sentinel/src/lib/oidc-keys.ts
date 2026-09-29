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
 *  - **The `kid` is in the header and in the JWKS.** Rotation is then a matter of
 *    publishing a second key and switching, without a client having to guess
 *    which one signed what it just received.
 *  - **Signing and verifying live together**, because a test that signs a token
 *    and checks its own work with different code would pass while the real
 *    verifier failed. `verifyJwt` is also what a client would do, including the
 *    claim checks the standard puts on the consumer: issuer, audience, expiry.
 *
 * Node's crypto only; no dependency. A hardware-backed signer can replace
 * `signJwt` without any of the rules changing.
 */

import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** The provider's signing key. One is enough until rotation arrives. */
export interface SigningKey {
  kid: string;
  alg: "RS256";
  privateKey: KeyObject;
  publicKey: KeyObject;
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
 */
export function verifyJwt(token: string, key: SigningKey, expect: JwtExpectation = {}): JwtResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "A compact JWS has three parts." };
  const [headerPart, claimsPart, signaturePart] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "The token header is not JSON." };
  }
  if (header.alg !== key.alg) return { ok: false, reason: `The token says it was signed with “${String(header.alg)}”.` };
  if (header.kid !== key.kid) return { ok: false, reason: "The token names a signing key this provider does not have." };

  const valid = verify(
    "sha256",
    Buffer.from(`${headerPart}.${claimsPart}`, "utf8"),
    { key: key.publicKey, padding: constants.RSA_PKCS1_PADDING },
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
