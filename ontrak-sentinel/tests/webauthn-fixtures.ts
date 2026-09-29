/**
 * WebAuthn fixtures: a ceremony a browser would actually produce, minus the browser.
 *
 * The point of writing these by hand rather than stubbing the verifier is that a
 * test which hands `verifyRegistration` a pre-verified answer proves nothing. Here
 * an EC key pair is really generated, the authenticator data is really assembled
 * byte by byte, the attestation object is really CBOR, and the signature is really
 * computed — so `systemWebAuthnCrypto` is exercised over a key it did not create,
 * and the checks in `webauthn-rules.ts` are the only reason a fixture verifies.
 *
 * Not a `*.test.ts` file on purpose: `npm test` runs `tests/*.test.ts`, so this is
 * a library the two ceremony suites share rather than a suite of its own.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  cborDecode,
  cborEncode,
  type CborValue,
  type WebAuthnAssertionResponse,
  type WebAuthnRegistrationResponse,
} from "../src/lib/webauthn-rules";

export interface FixtureAuthenticator {
  /** The base64url credential id the authenticator minted. */
  credentialId: string;
  /** Signs an assertion's message the way this device would. */
  sign(message: Uint8Array): Uint8Array;
  /** The COSE key, as the registration ceremony would carry it. */
  coseKey: Map<CborValue, CborValue>;
  /** A registration response for this credential and one challenge. */
  register(input: { challenge: string; origin: string; rpId: string; signCount?: number; format?: string }): WebAuthnRegistrationResponse;
  /** An assertion response for one challenge and one signature counter. */
  assert(input: {
    challenge: string;
    origin: string;
    rpId: string;
    signCount: number;
    type?: string;
  }): WebAuthnAssertionResponse;
  /** The assertion's signed message, so a test can sign something else entirely. */
  assertionMessage(input: { discovery: WebAuthnAssertionResponse }): Uint8Array;
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64"));
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function counterBytes(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.from(value)).digest());
}

/** UP | UV | AT — a registration where the user verified. */
const REGISTRATION_FLAGS = 0x45;
/** UP | UV — an assertion where the user verified. */
const ASSERTION_FLAGS = 0x05;

export function createFixtureAuthenticator(options: { credentialId?: string; aaguid?: Uint8Array } = {}): FixtureAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = options.credentialId ?? b64u(Buffer.from("fixture-credential-0001", "utf8"));
  const aaguid = options.aaguid ?? new Uint8Array(16);

  const coseKey = new Map<CborValue, CborValue>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, fromB64u(jwk.x)],
    [-3, fromB64u(jwk.y)],
  ]);

  const signWith = (message: Uint8Array): Uint8Array => new Uint8Array(sign("sha256", Buffer.from(message), privateKey));

  function authenticatorData(input: {
    rpId: string;
    signCount: number;
    flags: number;
    attested?: boolean;
  }): Uint8Array {
    const prefix = concat(
      sha256(Uint8Array.from(Buffer.from(input.rpId, "utf8"))),
      bytes(input.flags),
      counterBytes(input.signCount),
    );
    if (!input.attested) return prefix;
    const id = fromB64u(credentialId);
    return concat(prefix, aaguid, bytes((id.length >> 8) & 0xff, id.length & 0xff), id, cborEncode(coseKey));
  }

  return {
    credentialId,
    coseKey,
    sign: signWith,

    register(input) {
      const clientDataJSON = b64u(
        Buffer.from(
          JSON.stringify({ type: "webauthn.create", challenge: input.challenge, origin: input.origin, crossOrigin: false }),
          "utf8",
        ),
      );
      const authData = authenticatorData({
        rpId: input.rpId,
        signCount: input.signCount ?? 0,
        flags: REGISTRATION_FLAGS,
        attested: true,
      });
      const attestationObject = cborEncode(
        new Map<CborValue, CborValue>([
          ["fmt", input.format ?? "none"],
          ["attStmt", new Map<CborValue, CborValue>()],
          ["authData", authData],
        ]),
      );
      return {
        type: "public-key",
        id: credentialId,
        clientDataJSON,
        attestationObject: b64u(attestationObject),
        transports: ["usb"],
      };
    },

    assert(input) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: input.type ?? "webauthn.get", challenge: input.challenge, origin: input.origin, crossOrigin: false }),
        "utf8",
      );
      const authData = authenticatorData({ rpId: input.rpId, signCount: input.signCount, flags: ASSERTION_FLAGS });
      const message = concat(authData, sha256(new Uint8Array(clientDataJSON)));
      return {
        type: "public-key",
        id: credentialId,
        clientDataJSON: b64u(new Uint8Array(clientDataJSON)),
        authenticatorData: b64u(authData),
        signature: b64u(signWith(message)),
        userHandle: null,
      };
    },

    assertionMessage({ discovery }) {
      return concat(fromB64u(discovery.authenticatorData), sha256(fromB64u(discovery.clientDataJSON)));
    },
  };
}

/** A `packed`, self-attested registration: the credential signs its own registration. */
export function packedSelfAttestation(authenticator: FixtureAuthenticator, input: { challenge: string; origin: string; rpId: string }): WebAuthnRegistrationResponse {
  const registration = authenticator.register(input);
  const clientDataJSON = fromB64u(registration.clientDataJSON);
  const core = cborValue(registration.attestationObject);
  const authData = core.get("authData");
  if (!(authData instanceof Uint8Array)) throw new Error("fixture built no authenticator data");
  const signature = authenticator.sign(concat(authData, sha256(clientDataJSON)));
  const attestationObject = cborEncode(
    new Map<CborValue, CborValue>([
      ["fmt", "packed"],
      ["attStmt", new Map<CborValue, CborValue>([["alg", -7], ["sig", signature]])],
      ["authData", authData],
    ]),
  );
  return { ...registration, attestationObject: b64u(attestationObject) };
}

/**
 * Read a fixture's attestation object back, with the module's own decoder.
 *
 * Deliberately not a second parser: the fixtures and the verifier share one idea of
 * what the bytes mean, and the round trip is what makes that claim testable.
 */
function cborValue(encoded: string): Map<CborValue, CborValue> {
  const decoded = cborDecode(fromB64u(encoded));
  if (!(decoded instanceof Map)) throw new Error("fixture is not a CBOR map");
  return decoded;
}
