/**
 * The trailing slash in Authentik's issuer, asserted.
 *
 * This is the bug that reached a browser: Authentik's application-scoped issuer
 * ends in a slash (`.../application/o/ontrak/`) and that is the string it puts in
 * an ID token's `iss`, while the portal — correctly — stores the issuer with the
 * slash trimmed, because `.env` has three readers that disagree about it. `jose`
 * compares its `issuer` option literally, so the normalized string rejected a
 * perfectly valid token with `unexpected "iss" claim value`, after the password
 * had been typed.
 *
 * The first test reproduces that with a real signature and a real JWKS, so the
 * failure mode cannot come back unnoticed; the rest pin the rule that picks which
 * string the verifier is handed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";

import { checkClaims, verificationIssuer, type IdTokenClaims } from "../src/lib/oidc-rules";

const CONFIGURED = "https://auth.cerulean.innotel.us/application/o/ontrak";
const ADVERTISED = `${CONFIGURED}/`;

describe("the issuer a byte-for-byte verifier is handed", () => {
  it("accepts a token whose iss carries the slash Authentik advertises", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });

    const token = await new SignJWT({ aud: "ontrak", nonce: "n" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ADVERTISED)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    // The bug, reproduced: the normalized form is what the configuration holds,
    // and `jose` refuses the token over one character.
    await assert.rejects(
      () => jwtVerify(token, jwks, { issuer: CONFIGURED, audience: "ontrak" }),
      /unexpected "iss" claim value/,
    );

    // The fix: hand the verifier the issuer the provider advertised.
    const verified = await jwtVerify(token, jwks, {
      issuer: verificationIssuer(ADVERTISED, CONFIGURED),
      audience: "ontrak",
    });
    assert.equal(verified.payload.iss, ADVERTISED);
  });

  it("prefers the advertised string whenever it names the same issuer", () => {
    assert.equal(verificationIssuer(ADVERTISED, CONFIGURED), ADVERTISED);
    // A document that happens to omit the slash is still the same issuer.
    assert.equal(verificationIssuer(CONFIGURED, CONFIGURED), CONFIGURED);
    // Surrounding whitespace is a `.env` artefact, not an issuer.
    assert.equal(verificationIssuer(`  ${ADVERTISED}  `, CONFIGURED), ADVERTISED);
  });

  it("falls back to the configured issuer when the document names none", () => {
    assert.equal(verificationIssuer(undefined, CONFIGURED), CONFIGURED);
    assert.equal(verificationIssuer("", CONFIGURED), CONFIGURED);
    assert.equal(verificationIssuer("   ", CONFIGURED), CONFIGURED);
  });

  it("keeps the configured issuer when the document renames it", () => {
    // A document that points somewhere else must not be able to widen what this
    // portal accepts: the verifier is given our issuer, and the token from the
    // other provider fails the signature check anyway.
    assert.equal(verificationIssuer("https://evil.example/application/o/ontrak/", CONFIGURED),
                 CONFIGURED);
  });

  it("still compares the claim itself with the slash ignored", () => {
    const claims: IdTokenClaims = {
      iss: ADVERTISED,
      aud: "ontrak",
      sub: "someone",
      email: "someone@innotel.us",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "n",
    };
    const checked = checkClaims(claims, { issuer: CONFIGURED, clientId: "ontrak", nonce: "n" });
    assert.equal(checked.ok, true);
    // …and a claim from somewhere else still fails, slash or no slash.
    const elsewhere = checkClaims({ ...claims, iss: "https://evil.example/application/o/ontrak/" },
                                  { issuer: CONFIGURED, clientId: "ontrak", nonce: "n" });
    assert.equal(elsewhere.ok, false);
  });
});
