/**
 * SAML signing (S1): the one part of the assertion path that is not pure.
 *
 * An assertion is only worth anything because a service provider can check that
 * the IdP signed it. That means the same three things OIDC's ID token needs —
 * a key pair, a digest over the thing being asserted, and an RS256 signature
 * over the metadata that names the digest — with one SAML-shaped difference: the
 * document is XML, so the bytes being covered have to be *reproducible*.
 *
 *  - **The signature covers `<ds:SignedInfo>`, and the digest covers the
 *    assertion.** That is XML-DSig's enveloped-signature shape: `SignedInfo`
 *    contains `base64(SHA256(assertion-without-its-signature))`, and the RSA
 *    signature is over `SignedInfo` itself. Signing the digest's container rather
 *    than the digest is what lets a verifier check the signature first and the
 *    document second, which is the order that avoids parsing attacker-controlled
 *    XML before knowing it was signed.
 *  - **Exclusive canonicalisation is named, and earned.** `saml-rules.ts` writes
 *    every element with no inter-element whitespace and no comments, so exclusive
 *    c14n of the document is the document — `assertionCanonical` is a deletion of
 *    the signature block, not a re-serialisation. `verifySamlAssertion` proves
 *    that by reproducing it from what was actually sent.
 *  - **`base64url` key material is re-encoded, not re-derived.** The JWKS publishes
 *    the modulus and exponent as base64url; SAML's `RSAKeyValue` wants base64 of
 *    the same octets, so the conversion is a re-encoding and the numbers cannot
 *    drift from the key that signs.
 *
 * Node's crypto only, no dependency. `oidc-keys.ts` owns the key pair, so the
 * SAML signature and the OIDC one come from the same material and rotate together.
 */

import { constants, sign, verify } from "node:crypto";

import type { HashFn } from "./audit-chain";
import type { SigningKey } from "./oidc-keys";
import { assertionCanonical, samlSignatureParts, signedInfoXml } from "./saml-rules";

/* -------------------------------------------------------------------------- */
/*  base64, the two dialects XML and JOSE each want                           */
/* -------------------------------------------------------------------------- */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard, padded base64 with the `+`/`/` alphabet. Written out rather than
 * taken from `Buffer` so the digest helper is usable in a test with no globals,
 * and so the padding rule is visible: XML wants it, JOSE does not.
 */
export function base64Encode(bytes: readonly number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) {
      out += "==";
      break;
    }
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) {
      out += "=";
      break;
    }
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** A hex digest as bytes. The injected hash returns hex; XML needs octets. */
export function bytesFromHex(hex: string): number[] {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("a hash must be an even-length hexadecimal digest");
  }
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

/** `base64(SHA256(input))` — the `DigestValue` of our enveloped signature. */
export function digestValueB64(input: string, hash: HashFn): string {
  return base64Encode(bytesFromHex(hash(input)));
}

/** base64url without padding, as JOSE writes it, re-expressed as padded base64. */
export function base64UrlToBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
}

/* -------------------------------------------------------------------------- */
/*  Signing and verifying                                                     */
/* -------------------------------------------------------------------------- */

/** RS256 over a UTF-8 payload, returning base64. What the service is handed. */
export type XmlSigner = (payload: string) => string;

/** The signer for a signing key. PKCS#1 v1.5 over SHA-256 is what RS256 means. */
export function rsaXmlSigner(key: SigningKey): XmlSigner {
  return (payload) =>
    sign("sha256", Buffer.from(payload, "utf8"), {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64");
}

export type XmlVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Check an assertion the way a service provider would.
 *
 * The signature is checked **first** and the digest second, because the digest
 * is computed over the document itself: deciding anything about bytes an
 * attacker supplied before knowing they were signed is the mistake this order
 * avoids. `expectedIssuer` and `expectedAudience` are the two claims only the
 * consumer can check, so they are checked here rather than left to the caller.
 */
export function verifySamlAssertion(
  assertionXml: string,
  key: SigningKey,
  options: { hash: HashFn; expectedIssuer?: string; expectedAudience?: string },
): XmlVerifyResult {
  const parts = samlSignatureParts(assertionXml);
  if (!parts.signedInfoXml || !parts.signatureValueB64) {
    return { ok: false, reason: "The assertion carries no signature." };
  }
  if (parts.referenceUri === null) return { ok: false, reason: "The signature names no reference." };
  if (parts.assertionId === null || parts.referenceUri !== `#${parts.assertionId}`) {
    return { ok: false, reason: "The signature covers a different element than the assertion it sits in." };
  }

  const valid = verify(
    "sha256",
    Buffer.from(parts.signedInfoXml, "utf8"),
    { key: key.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(parts.signatureValueB64, "base64"),
  );
  if (!valid) return { ok: false, reason: "The signature does not verify against this provider's public key." };

  // The digest is recomputed from the document as it arrived, so an edited
  // attribute changes the answer even though the signature over `SignedInfo` is
  // untouched.
  const canonical = assertionCanonical(assertionXml);
  const expectedDigest = digestValueB64(canonical, options.hash);
  if (parts.digestB64 !== expectedDigest) {
    return { ok: false, reason: "The assertion's contents do not match the digest that was signed." };
  }

  if (options.expectedIssuer !== undefined && !canonical.includes(`<saml:Issuer>${options.expectedIssuer}</saml:Issuer>`)) {
    return { ok: false, reason: "The assertion was not issued by this provider." };
  }
  if (options.expectedAudience !== undefined && !canonical.includes(`<saml:Audience>${options.expectedAudience}</saml:Audience>`)) {
    return { ok: false, reason: "The assertion was issued for another audience." };
  }
  return { ok: true };
}

/** The key material an `RSAKeyValue` needs, taken from the signing key's JWK. */
export function signingKeyMaterial(key: SigningKey): { kid: string; modulusB64: string; exponentB64: string } {
  const jwk = key.publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { kid: key.kid, modulusB64: base64UrlToBase64(jwk.n), exponentB64: base64UrlToBase64(jwk.e) };
}

/** Re-exported so a caller building a signature block does not import two files. */
export { signedInfoXml };
