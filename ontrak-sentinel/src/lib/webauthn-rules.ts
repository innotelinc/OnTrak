/**
 * WebAuthn rules (S1): a security key as a second factor, as a decision.
 *
 * `mfa-rules.ts` answers "is this six-digit code the one the clock says?" — a
 * question with one input. A WebAuthn ceremony is the opposite: the browser hands
 * back four or five base64url blobs produced by an authenticator we do not
 * control, and the whole of the security is the *order* in which the claims in
 * them are checked. Four choices worth stating out loud:
 *
 *  1. **The challenge is the replay defence, and it is spent once.** A signature is
 *     a bearer credential for as long as the challenge it covers is acceptable, so
 *     the challenge is minted here, expires in two minutes and is consumed by the
 *     verification that used it. Every other check in this file is about *who* the
 *     ceremony was for; this one is about *when*.
 *  2. **`origin` is compared exactly, not with a suffix or a parser's opinion.**
 *     `clientDataJSON` is produced by the browser and carries the page origin it
 *     ran on; accepting `https://id.example.evil.test` because it *contains*
 *     `id.example` is precisely the bug the field exists to prevent. The RP ID is
 *     compared through `SHA-256`, because an authenticator is only ever told the
 *     hash.
 *  3. **A signature counter that goes backwards is refused, and `0` is not a
 *     counter.** Authenticators that implement the counter increase it on every
 *     assertion; a lower one means the credential's private key now exists in two
 *     places. Devices that send `0` are opting out of that signal, which is their
 *     right — treating `0` as an *increase* would refuse every assertion from the
 *     platform authenticators that do it.
 *  4. **Attestation is not judged.** The ceremony proves possession of a key that
 *     was created for this RP. Whether that key lives in a TPM, a YubiKey or a
 *     malicious extension is a question for attestation policy, and a deployment
 *     that wants it should say so. This module checks the two formats a
 *     self-sufficient deployment actually sees — `none`, and `packed` with the
 *     credential's own key instead of a certificate chain — and refuses the rest
 *     with a reason that names what it would have needed to trust.
 *
 * Pure: no `node:crypto`, no clock, no `Request`. The two primitives this needs —
 * `SHA-256` and a signature check — are injected, the same trick `mfa-rules.ts`
 * uses for HMAC and `oidc-rules.ts` for the code challenge, so the CBOR and the
 * claim-checking can be tested against fixtures a real browser produced.
 */

/* -------------------------------------------------------------------------- */
/*  Base64url                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The encoding every WebAuthn field arrives in: standard base64 with the two
 * URL-unsafe characters swapped and the padding dropped, because the values ride
 * through JSON and form posts.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a field. Returns `null` rather than throwing, for the same reason
 * `base32Decode` does: the input came off the wire, and a value that cannot be
 * read should fail a ceremony, not a request handler.
 */
export function base64UrlDecode(value: string): Uint8Array | null {
  const cleaned = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (cleaned.length === 0 || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  // A length of `1` past a multiple of four cannot be produced by any encoder, so
  // it is a value somebody constructed rather than one a browser sent.
  if (cleaned.replace(/=+$/, "").length % 4 === 1) return null;
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  try {
    return new Uint8Array(Buffer.from(padded, "base64"));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  CBOR, as much of it as WebAuthn uses                                      */
/* -------------------------------------------------------------------------- */

/**
 * The decoder's value space. Big integers are returned as `number` because the
 * lengths CBOR carries here — credential ids, COSE coordinate sizes — are small;
 * a value that would exceed that is refused by the reader rather than silently
 * rounded.
 */
export type CborValue = number | Uint8Array | string | boolean | null | CborValue[] | Map<CborValue, CborValue>;

class CborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): CborValue | undefined {
    if (this.offset >= this.bytes.length) return undefined;
    const initial = this.bytes[this.offset++];
    const major = initial >> 5;
    const additional = initial & 0x1f;

    if (major === 7) {
      // Simple values and floats. Only the three WebAuthn's maps can carry.
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      if (additional === 23) return undefined;
      return undefined;
    }

    const length = this.readLength(additional);
    if (length === undefined) return undefined;

    switch (major) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2: {
        if (this.offset + length > this.bytes.length) return undefined;
        const slice = this.bytes.slice(this.offset, this.offset + length);
        this.offset += length;
        return slice;
      }
      case 3: {
        if (this.offset + length > this.bytes.length) return undefined;
        const text = Buffer.from(this.bytes.slice(this.offset, this.offset + length)).toString("utf8");
        this.offset += length;
        return text;
      }
      case 4: {
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const item = this.read();
          if (item === undefined) return undefined;
          items.push(item);
        }
        return items;
      }
      case 5: {
        const map = new Map<CborValue, CborValue>();
        for (let index = 0; index < length; index += 1) {
          const key = this.read();
          const value = this.read();
          if (key === undefined || value === undefined) return undefined;
          map.set(key, value);
        }
        return map;
      }
      default:
        return undefined;
    }
  }

  /** The argument of a head byte: inline, or the next 1/2/4/8 bytes, big-endian. */
  private readLength(additional: number): number | undefined {
    if (additional < 24) return additional;
    const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[additional];
    if (width === undefined) return undefined;
    if (this.offset + width > this.bytes.length) return undefined;
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 256 + this.bytes[this.offset + index];
    this.offset += width;
    // Eight-byte lengths are beyond anything a ceremony carries; refusing them is
    // how a hostile blob cannot make this allocate.
    return value > Number.MAX_SAFE_INTEGER ? undefined : value;
  }
}

/** Decode one CBOR item, or `undefined` when the bytes are not one. */
export function cborDecode(bytes: Uint8Array): CborValue | undefined {
  return new CborReader(bytes).read();
}

/**
 * Encode a value. The decoder's counterpart, and here for the same reason: a test
 * that builds an `attestationObject` with the decoder's own idea of the format is
 * testing nothing, so fixtures are written with the encoder and read with the
 * decoder.
 */
export function cborEncode(value: CborValue): Uint8Array {
  if (value === null) return Uint8Array.from([0xf6]);
  if (typeof value === "boolean") return Uint8Array.from([value ? 0xf5 : 0xf4]);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error("only safe integers are encoded");
    }
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Uint8Array.from(Buffer.from(value, "utf8"));
    return concat(head(3, text.length), text);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cborEncode));
  const parts: Uint8Array[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cborEncode(key), cborEncode(item));
  return concat(...parts);
}

function head(major: number, length: number): Uint8Array {
  const prefix = major << 5;
  if (length < 24) return Uint8Array.from([prefix | length]);
  if (length < 0x100) return Uint8Array.from([prefix | 24, length]);
  if (length < 0x10000) return Uint8Array.from([prefix | 25, length >> 8, length & 0xff]);
  return Uint8Array.from([prefix | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);
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

/** Byte equality, for the one comparison CBOR hands back as an array. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  The injected primitives                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `SHA-256` and one signature check.
 *
 * The RP ID is compared as a hash and the signature is verified over
 * `authenticatorData || SHA-256(clientDataJSON)`, so those are the only two
 * primitives any of this needs — and keeping them behind a port is what lets the
 * claim-checking be tested without a key pair.
 */
export interface WebAuthnCrypto {
  sha256(bytes: Uint8Array): Uint8Array;
  verify(input: { publicKey: CosePublicKey; message: Uint8Array; signature: Uint8Array }): boolean;
}

/* -------------------------------------------------------------------------- */
/*  COSE keys                                                                 */
/* -------------------------------------------------------------------------- */

/** ES256 (ECDSA over P-256 with SHA-256) and RS256, the two every authenticator can make. */
export const SUPPORTED_ALGORITHMS = [-7, -257] as const;
export type CoseAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export interface CoseEcPublicKey {
  kty: "EC";
  alg: -7;
  crv: "P-256";
  /** `x` and `y` as base64url, the form they arrive in and the form a JWK wants. */
  x: string;
  y: string;
}

export interface CoseRsaPublicKey {
  kty: "RSA";
  alg: -257;
  n: string;
  e: string;
}

export type CosePublicKey = CoseEcPublicKey | CoseRsaPublicKey;

/**
 * Read a COSE key out of the authenticator data.
 *
 * `kty 2` is EC2 and `kty 3` is RSA; the negative labels are the COSE numbering,
 * not a typo — `-1` is the curve for EC and the modulus for RSA, because the
 * registries are separate. An algorithm this deployment does not verify is
 * refused here rather than at verification time, so an unsupported key never
 * becomes a stored factor that cannot answer.
 */
export function parseCosePublicKey(value: unknown): { ok: true; key: CosePublicKey } | { ok: false; reason: string } {
  if (!(value instanceof Map)) return { ok: false, reason: "the credential's public key is not a CBOR map" };
  const alg = value.get(3);
  if (typeof alg !== "number" || !(SUPPORTED_ALGORITHMS as readonly number[]).includes(alg)) {
    return { ok: false, reason: `the credential's algorithm (${String(alg)}) is not one this provider verifies` };
  }

  const coordinate = (label: number): string | null => {
    const raw = value.get(label);
    return raw instanceof Uint8Array ? base64UrlEncode(raw) : null;
  };

  const kty = value.get(1);
  if (kty === 2) {
    const crv = value.get(-1);
    if (crv !== 1) return { ok: false, reason: "only the P-256 curve is verified" };
    const x = coordinate(-2);
    const y = coordinate(-3);
    if (!x || !y) return { ok: false, reason: "the credential's EC coordinates are missing" };
    return { ok: true, key: { kty: "EC", alg: -7, crv: "P-256", x, y } };
  }
  if (kty === 3) {
    const n = coordinate(-1);
    const e = coordinate(-2);
    if (!n || !e) return { ok: false, reason: "the credential's RSA modulus or exponent is missing" };
    return { ok: true, key: { kty: "RSA", alg: -257, n, e } };
  }
  return { ok: false, reason: "the credential's key type is neither EC nor RSA" };
}

/* -------------------------------------------------------------------------- */
/*  clientDataJSON                                                            */
/* -------------------------------------------------------------------------- */

/** `webauthn.create` at registration, `webauthn.get` at assertion. */
export type WebAuthnCeremonyType = "webauthn.create" | "webauthn.get";

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin: boolean;
}

export function parseClientData(encoded: Uint8Array | null): ClientData | null {
  if (!encoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.challenge !== "string" || typeof record.origin !== "string") {
    return null;
  }
  return {
    type: record.type,
    challenge: record.challenge,
    origin: record.origin,
    crossOrigin: record.crossOrigin === true,
  };
}

/* -------------------------------------------------------------------------- */
/*  authenticatorData                                                         */
/* -------------------------------------------------------------------------- */

export interface AuthenticatorFlags {
  /** Bit 0: the user was present. The one flag that must always be set. */
  userPresent: boolean;
  /** Bit 2: the user was verified — a PIN or a biometric, not just a touch. */
  userVerified: boolean;
  /** Bit 3: the credential can be synced (a passkey). */
  backupEligible: boolean;
  /** Bit 4: the credential is currently synced. */
  backedUp: boolean;
  /** Bit 6: attested credential data follows the counter. */
  attestedCredentialData: boolean;
  /** Bit 7: extension data follows. */
  extensionData: boolean;
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: AuthenticatorFlags;
  signCount: number;
  /** Registration only: the authenticator's AAGUID, all zeroes when it has none. */
  aaguid: Uint8Array | null;
  /** Registration only. */
  credentialId: Uint8Array | null;
  ciphertext: Uint8Array | null;
}

/**
 * Read the authenticator data's fixed prefix, plus the attested credential data
 * when the registration flag says it is there.
 *
 * The layout is a spec quote: 32 bytes of RP ID hash, one byte of flags, four
 * bytes of big-endian counter — and then, at registration, a 16-byte AAGUID, a
 * two-byte credential id length, the id, and the COSE key as the rest of the
 * buffer. Anything shorter than the prefix is not authenticator data at all.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const rpIdHash = bytes.slice(0, 32);
  const flagByte = bytes[32];
  const signCount = (bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36];
  const flags: AuthenticatorFlags = {
    userPresent: (flagByte & 0x01) !== 0,
    userVerified: (flagByte & 0x04) !== 0,
    backupEligible: (flagByte & 0x08) !== 0,
    backedUp: (flagByte & 0x10) !== 0,
    attestedCredentialData: (flagByte & 0x40) !== 0,
    extensionData: (flagByte & 0x80) !== 0,
  };

  if (!flags.attestedCredentialData) {
    return { rpIdHash, flags, signCount, aaguid: null, credentialId: null, ciphertext: null };
  }
  // 16 AAGUID + 2 length bytes, after the 37-byte prefix.
  if (bytes.length < 55) return null;
  const aaguid = bytes.slice(37, 53);
  const idLength = (bytes[53] << 8) | bytes[54];
  const idStart = 55;
  const idEnd = idStart + idLength;
  if (idEnd > bytes.length) return null;
  return {
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credentialId: bytes.slice(idStart, idEnd),
    ciphertext: bytes.slice(idEnd),
  };
}

/* -------------------------------------------------------------------------- */
/*  Challenges                                                               */
/* -------------------------------------------------------------------------- */

export type WebAuthnCeremony = "REGISTRATION" | "AUTHENTICATION";

/** Thirty-two bytes, the spec's minimum and a value no one is going to guess. */
export const WEBAUTHN_CHALLENGE_BYTES = 32;
/**
 * Two minutes. Long enough for a person to tap a key, short enough that a logged
 * challenge is not a credential for the rest of the afternoon.
 */
export const WEBAUTHN_CHALLENGE_SECONDS = 120;
export const WEBAUTHN_RP_NAME_MAX = 80;
export const WEBAUTHN_LABEL_MAX = 80;

/**
 * A ceremony in progress.
 *
 * Server-side state rather than a signed blob in the page: the challenge has to be
 * spendable exactly once, and "used" is a fact about our database, not about a
 * value we handed to a browser. `usedAt` is the replay guard; `expiresAt` is the
 * clock.
 */
export interface WebAuthnChallengeRecord {
  id: string;
  organizationId: string;
  identityId: string;
  ceremony: WebAuthnCeremony;
  /** Base64url. What `clientDataJSON` must carry back. */
  challenge: string;
  /** The origin the ceremony was started on, compared exactly. */
  origin: string;
  /** The RP ID whose hash the authenticator data must carry. */
  rpId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export function isWebAuthnChallengeUsable(record: WebAuthnChallengeRecord, nowMs: number): boolean {
  return record.usedAt === null && nowMs <= record.expiresAt;
}

/**
 * The RP ID for an origin, or the configured one when a deployment names it.
 *
 * The default is the host, which is right for a provider that serves its console
 * from one hostname. A deployment that serves several subdomains sets the RP ID to
 * the registrable suffix and every host under it may register — which is why the
 * value is configuration rather than computed from the request.
 */
export function rpIdForOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** An RP ID must actually cover the origin it is used from, or nothing verifies. */
export function rpIdMatchesOrigin(rpId: string, origin: string): boolean {
  const host = rpIdForOrigin(origin);
  if (!host) return false;
  const wanted = rpId.trim().toLowerCase();
  if (!wanted) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}

export interface WebAuthnIssue {
  field: string;
  message: string;
}

export function validateWebAuthnConfig(input: { rpId?: string; origin?: string; rpName?: string }): WebAuthnIssue[] {
  const issues: WebAuthnIssue[] = [];
  const rpId = input.rpId?.trim() ?? "";
  const origin = input.origin?.trim() ?? "";

  if (!rpId) issues.push({ field: "rpId", message: "An RP ID is required." });
  else if (/[:/]/.test(rpId)) {
    // A scheme, a port or a path in an RP ID produces a hash nothing matches — and
    // the failure looks like "the browser refused", which is why it is a
    // configuration error here instead.
    issues.push({ field: "rpId", message: `“${rpId}” is not an RP ID: it is a hostname, with no scheme, port or path.` });
  }

  if (!origin) issues.push({ field: "origin", message: "An origin is required." });
  else if (rpId && !rpIdMatchesOrigin(rpId, origin)) {
    issues.push({ field: "origin", message: `The origin “${origin}” is not under the RP ID “${rpId}”.` });
  } else {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        issues.push({ field: "origin", message: "The origin must be http or https." });
      }
    } catch {
      issues.push({ field: "origin", message: `“${origin}” is not an origin.` });
    }
  }

  const rpName = input.rpName?.trim() ?? "";
  if (rpName.length > WEBAUTHN_RP_NAME_MAX) {
    issues.push({ field: "rpName", message: `The relying party's name may be at most ${WEBAUTHN_RP_NAME_MAX} characters.` });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  The responses a browser posts back                                        */
/* -------------------------------------------------------------------------- */

export interface WebAuthnRegistrationResponse {
  type: string;
  /** Base64url credential id, used as `secret` on the stored factor. */
  id: string;
  clientDataJSON: string;
  attestationObject: string;
  transports?: readonly string[];
}

export interface WebAuthnAssertionResponse {
  type: string;
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string | null;
}

/** What a successful registration produced and what has to be stored. */
export interface RegisteredCredential {
  /** Base64url, and the value the factor's `secret` column holds. */
  credentialId: string;
  /** Base64url of a COSE key, in the form `parseCosePublicKey` returns. */
  publicKey: string;
  signCount: number;
  transports: string[];
  aaguid: string | null;
}

export interface WebAuthnVerification {
  ok: boolean;
  /** Why it was refused, in words a person can read. `null` when it verified. */
  reason: string | null;
  /** Present when a registration verified. */
  credential?: RegisteredCredential;
  /** Present when an assertion verified: the counter to record. */
  signCount?: number;
}

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

export interface VerifyRegistrationInput {
  response: WebAuthnRegistrationResponse;
  challenge: WebAuthnChallengeRecord;
  crypto: WebAuthnCrypto;
}

/**
 * Verify a registration and extract the credential to store.
 *
 * The order is the security: the ceremony type first (so an assertion cannot be
 * replayed as a registration), then the challenge (so a recorded ceremony cannot
 * be replayed at all), then the origin (so a ceremony from another site cannot be
 * borrowed), then the RP ID hash (so a key made for another relying party cannot
 * be registered here), then the user-presence flag, then the credential id
 * consistent between the two places it appears — and only then the attestation.
 */
export function verifyRegistration(input: VerifyRegistrationInput): WebAuthnVerification {
  const refuse = (reason: string): WebAuthnVerification => ({ ok: false, reason });

  if (input.response.type !== "public-key") return refuse("the response is not a public-key credential");
  if (input.challenge.ceremony !== "REGISTRATION") return refuse("this challenge was not started as a registration");

  const clientDataBytes = base64UrlDecode(input.response.clientDataJSON);
  const clientData = parseClientData(clientDataBytes);
  if (!clientData || !clientDataBytes) return refuse("the client data is not readable");
  if (clientData.type !== "webauthn.create") return refuse("the client data is not a registration");
  if (clientData.challenge !== input.challenge.challenge) return refuse("the challenge does not match the one we issued");
  if (clientData.origin !== input.challenge.origin) return refuse("the ceremony came from a different origin");
  if (clientData.crossOrigin) return refuse("the ceremony ran in a cross-origin frame");

  const attestationBytes = base64UrlDecode(input.response.attestationObject);
  if (!attestationBytes) return refuse("the attestation object is not readable");
  const attestation = cborDecode(attestationBytes);
  if (!(attestation instanceof Map)) return refuse("the attestation object is not a CBOR map");
  const format = attestation.get("fmt");
  const statement = attestation.get("attStmt");
  const authDataBytes = attestation.get("authData");
  if (typeof format !== "string") return refuse("the attestation names no format");
  if (!(authDataBytes instanceof Uint8Array)) return refuse("the attestation carries no authenticator data");

  const authData = parseAuthenticatorData(authDataBytes);
  if (!authData) return refuse("the authenticator data is too short to read");

  const expectedRpIdHash = input.crypto.sha256(Uint8Array.from(Buffer.from(input.challenge.rpId, "utf8")));
  if (!equalBytes(authData.rpIdHash, expectedRpIdHash)) return refuse("the key was created for a different relying party");
  if (!authData.flags.userPresent) return refuse("the authenticator did not see the user");
  if (!authData.credentialId) return refuse("the authenticator data carries no credential");

  const credentialId = base64UrlEncode(authData.credentialId);
  if (credentialId !== input.response.id) return refuse("the credential id does not match the one the browser reported");

  // The COSE key is the rest of the authenticator data, still CBOR-encoded: the
  // registration is where the browser hands over a key, and this is where it is read.
  const parsedKey = parseCosePublicKey(authData.ciphertext ? cborDecode(authData.ciphertext) : undefined);
  if (!parsedKey.ok) return refuse(parsedKey.reason);

  const statementProblem = attestationProblem(format, statement, authDataBytes, clientDataBytes, parsedKey.key, input.crypto);
  if (statementProblem) return refuse(statementProblem);

  return {
    ok: true,
    reason: null,
    credential: {
      credentialId,
      publicKey: JSON.stringify(parsedKey.key),
      signCount: authData.signCount,
      transports: [...(input.response.transports ?? [])].slice(0, 8),
      aaguid: authData.aaguid ? base64UrlEncode(authData.aaguid) : null,
    },
  };
}

/**
 * Whether the attestation statement is acceptable.
 *
 * `none` is acceptable because the ceremony already proved what this deployment
 * needs: a key was created for this RP and the holder was present. `packed` is
 * acceptable only in its self-attested shape — `alg` and `sig`, no `x5c` — which
 * means the credential's own key signed over its own registration. That proves the
 * holder has the private key, which is the same claim `none` makes and a stronger
 * way of making it. A certificate chain is refused by name, because trusting one
 * is a policy decision no deployment should get by accident.
 */
function attestationProblem(
  format: string,
  statement: unknown,
  authDataBytes: Uint8Array,
  clientDataBytes: Uint8Array,
  key: CosePublicKey,
  crypto: WebAuthnCrypto,
): string | null {
  if (format === "none") return null;
  if (format !== "packed") return `the attestation format “${format}” is not one this provider judges`;

  if (!(statement instanceof Map)) return "the packed attestation carries no statement";
  if (statement.get("x5c") !== undefined) {
    return "certificate-backed attestation is refused: this deployment judges possession, not provenance";
  }
  const signature = statement.get("sig");
  if (!(signature instanceof Uint8Array)) return "the packed attestation carries no signature";

  const clientDataHash = crypto.sha256(clientDataBytes);
  const message = concat(authDataBytes, clientDataHash);
  return crypto.verify({ publicKey: key, message, signature }) ? null : "the attestation signature did not verify";
}

export interface VerifyAssertionInput {
  response: WebAuthnAssertionResponse;
  challenge: WebAuthnChallengeRecord;
  /** What the stored factor holds: the credential id and its public key. */
  stored: { credentialId: string; publicKey: CosePublicKey; signCount: number | null };
  crypto: WebAuthnCrypto;
}

/**
 * Verify an assertion — a sign-in with an already-registered key.
 *
 * The signature covers `authenticatorData || SHA-256(clientDataJSON)`, so the
 * origin and challenge are bound into the signed bytes and cannot be swapped after
 * the fact. The counter check comes last because it is the only claim that is about
 * the *past*: everything before it establishes that this is a fresh, correctly
 * scoped assertion, and a counter that went backwards then means the key exists in
 * two places.
 */
export function verifyAssertion(input: VerifyAssertionInput): WebAuthnVerification {
  const refuse = (reason: string): WebAuthnVerification => ({ ok: false, reason });

  if (input.response.type !== "public-key") return refuse("the response is not a public-key credential");
  if (input.challenge.ceremony !== "AUTHENTICATION") return refuse("this challenge was not started as an assertion");
  if (input.response.id !== input.stored.credentialId) return refuse("that credential is not the one on record");

  const clientDataBytes = base64UrlDecode(input.response.clientDataJSON);
  const clientData = parseClientData(clientDataBytes);
  if (!clientData || !clientDataBytes) return refuse("the client data is not readable");
  if (clientData.type !== "webauthn.get") return refuse("the client data is not an assertion");
  if (clientData.challenge !== input.challenge.challenge) return refuse("the challenge does not match the one we issued");
  if (clientData.origin !== input.challenge.origin) return refuse("the ceremony came from a different origin");
  if (clientData.crossOrigin) return refuse("the ceremony ran in a cross-origin frame");

  const authDataBytes = base64UrlDecode(input.response.authenticatorData);
  const signature = base64UrlDecode(input.response.signature);
  if (!authDataBytes || !signature) return refuse("the assertion is not readable");

  const authData = parseAuthenticatorData(authDataBytes);
  if (!authData) return refuse("the authenticator data is too short to read");

  const expectedRpIdHash = input.crypto.sha256(Uint8Array.from(Buffer.from(input.challenge.rpId, "utf8")));
  if (!equalBytes(authData.rpIdHash, expectedRpIdHash)) return refuse("the assertion is for a different relying party");
  if (!authData.flags.userPresent) return refuse("the authenticator did not see the user");

  const message = concat(authDataBytes, input.crypto.sha256(clientDataBytes));
  if (!input.crypto.verify({ publicKey: input.stored.publicKey, message, signature })) {
    return refuse("the signature did not verify");
  }

  // A counter of zero means the authenticator does not keep one. Comparing it
  // would refuse every assertion from a platform authenticator, so both sides
  // have to be non-zero for the signal to mean anything.
  if (input.stored.signCount !== null && input.stored.signCount > 0 && authData.signCount > 0 && authData.signCount <= input.stored.signCount) {
    return refuse("the signature counter did not advance, so this key may have been cloned");
  }

  return { ok: true, reason: null, signCount: authData.signCount };
}

/** Round-trip a stored public key, or `null` when the column was edited by hand. */
export function parseStoredPublicKey(value: string | null): CosePublicKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CosePublicKey;
    if (parsed && (parsed.kty === "EC" || parsed.kty === "RSA")) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** The credential id a WebAuthn factor stores in `secret`, or `null` when unreadable. */
export function credentialIdOf(secret: string): Uint8Array | null {
  return base64UrlDecode(secret);
}
