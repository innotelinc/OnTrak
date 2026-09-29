/**
 * MFA rules (S1): TOTP, as a decision rather than a login screen.
 *
 * S0 stored a boolean called `mfaEnrolled` and refused every session while it was
 * false — which is the policy working, and also a dead end, because nothing in
 * the product could make it true by *proving* anything. This module is the other
 * half: the arithmetic of RFC 6238, the window a code is accepted in, and the one
 * rule that makes a second factor worth having — **a code is spent once**.
 *
 * Four choices worth stating out loud:
 *
 *  1. **The secret never has to be trusted, only the code.** Enrollment is two
 *     steps: a secret is generated and shown once, and the flag is set only after
 *     a code from that secret verifies. A secret that was mistyped into an app,
 *     or never reached the app at all, therefore cannot leave an identity looking
 *     enrolled and unable to sign in.
 *  2. **The code is a function of the clock, so the window has to be named.** A
 *     code is accepted for the step it belongs to, plus one step either side, which
 *     is the drift a phone's clock and a server's clock actually have. Widening it
 *     is how a 6-digit code becomes guessable; narrowing it is how a correct code
 *     is refused once a month.
 *  3. **A verified step is recorded and never accepted again.** Without this, a
 *     code captured off the wire stays valid for the rest of its window, and the
 *     second factor is only as good as the password it was meant to strengthen.
 *  4. **SHA-1 is deliberate.** It is the RFC 6238 default, and it is what every
 *     authenticator app assumes when it is handed an `otpauth://` URI with no
 *     `algorithm` parameter. HMAC-SHA-1 is not broken for this construction; the
 *     collision attacks that retired SHA-1 are irrelevant to a 160-bit HMAC key.
 *
 * Pure: no `node:crypto`, no clock, no `Request`. The HMAC is injected (the same
 * trick `oidc-rules.ts` uses for `sha256`) and the time is handed in, so the RFC's
 * own test vectors can be pinned in a test and the drift arithmetic does not have
 * to wait thirty seconds to be exercised.
 */

/* -------------------------------------------------------------------------- */
/*  Kinds and constants                                                       */
/* -------------------------------------------------------------------------- */

export type MfaKind = "TOTP" | "WEBAUTHN";

export const MFA_KINDS: readonly MfaKind[] = ["TOTP", "WEBAUTHN"];

export function isMfaKind(value: unknown): value is MfaKind {
  return typeof value === "string" && (MFA_KINDS as readonly string[]).includes(value);
}

/** What an authenticator app shows as the account's issuer when we do not say. */
export const DEFAULT_MFA_ISSUER = "OnTrak Sentinel";

/** Six digits is what every app renders and what RFC 6238 §5.3 recommends. */
export const TOTP_DIGITS = 6;
/** Thirty seconds, the step the RFC and every app assume. */
export const TOTP_STEP_SECONDS = 30;
/** 160 bits: RFC 4226 §4's recommended key length for HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;
/**
 * How far from "now" a code may be and still count.
 *
 * One step either way. RFC 6238 §6 suggests exactly this for a 30-second step:
 * a phone's clock slips by seconds, not by minutes, and every extra step widens
 * the guessing window.
 */
export const TOTP_DRIFT_STEPS = 1;
/** The only algorithm we put in a provisioning URI, and the only one we verify. */
export const TOTP_ALGORITHM = "SHA1";

export const MFA_LABEL_MAX = 80;

/* -------------------------------------------------------------------------- */
/*  Base32 (RFC 4648, uppercase, unpadded)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Base32 rather than hex or base64, because it is the only encoding an
 * authenticator app is guaranteed to accept for a shared secret — and it is
 * case-insensitive and copy-pasteable, which matters for a value a person types
 * into a phone by hand.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decode a secret. Returns `null` rather than throwing, because the input may be
 * a value that came off a database column somebody edited by hand — and a secret
 * that cannot be read should fail a verification, not a request handler.
 *
 * Padding (`=`) and lower case are accepted: both are commonly produced by other
 * tools, and refusing them would reject a working secret for a cosmetic reason.
 */
export function base32Decode(value: string): Uint8Array | null {
  const cleaned = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/** A secret in groups of four, which is how an app and a person read one back. */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/* -------------------------------------------------------------------------- */
/*  The counter and the code                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The HMAC, injected.
 *
 * `mfa-rules.ts` knows the shape of a TOTP digest — HMAC over an eight-byte
 * counter, then the dynamic truncation from RFC 4226 §5.3 — and nothing about
 * which primitive produces it. That is what makes the RFC's test vectors
 * expressible as a test rather than as a claim in a comment.
 */
export interface TotpSigner {
  /** HMAC over `message` with `key`, as raw bytes. */
  sign(key: Uint8Array, message: Uint8Array): Uint8Array;
}

/** The step `atMs` falls in. Steps are counted from the Unix epoch, not from enrollment. */
export function totpCounter(atMs: number, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/** The counter as the eight-byte big-endian message of RFC 4226 §5.2. */
export function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = Math.max(0, Math.floor(counter));
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

/**
 * The code for one step: HMAC, dynamic truncation, modulo 10^digits.
 *
 * Not "pure" in the sense of having no input that varies — it is a pure function
 * of the secret, the step and the signer, which is the whole point: the same
 * inputs give the same six digits on our server and on somebody's phone.
 */
export function totpCode(
  secret: Uint8Array,
  counter: number,
  signer: TotpSigner,
  digits: number = TOTP_DIGITS,
): string {
  const digest = signer.sign(secret, counterBytes(counter));
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks the
  // four-byte window, and the high bit is masked off so the value is positive on
  // every platform.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * A presented code, as a value worth comparing.
 *
 * Spaces and dashes are stripped because a person typing six digits off a screen
 * writes `123 456`, and refusing that is a support ticket about a correct code.
 * Anything that is not exactly `digits` digits afterwards is not a code at all.
 */
export function normalizeTotpCode(value: string, digits: number = TOTP_DIGITS): string | null {
  const cleaned = value.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${digits}}$`).test(cleaned) ? cleaned : null;
}

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

export interface TotpVerification {
  ok: boolean;
  /** The step the code belonged to, when it verified. */
  counter: number | null;
  /** How many steps from `now` the accepted code was. 0 is the current step. */
  drift: number;
  /** Why it was refused, in words a person can read. `null` when it verified. */
  reason: string | null;
}

export interface VerifyTotpInput {
  secret: Uint8Array;
  code: string;
  /** Epoch milliseconds, handed in rather than read. */
  atMs: number;
  signer: TotpSigner;
  /**
   * The last step a code was accepted for. A code at or below it is refused, so
   * presenting the same six digits twice does not work twice.
   */
  lastUsedCounter?: number | null;
  driftSteps?: number;
  digits?: number;
  stepSeconds?: number;
}

/**
 * Whether a code verifies, and if so which step it belonged to.
 *
 * The steps are walked nearest-first, so a code that is valid both now and at the
 * previous step is attributed to *now* — which matters, because the counter is
 * recorded and the next code the user sees must not be mistaken for a replay.
 */
export function verifyTotp(input: VerifyTotpInput): TotpVerification {
  const digits = input.digits ?? TOTP_DIGITS;
  const stepSeconds = input.stepSeconds ?? TOTP_STEP_SECONDS;
  const driftSteps = input.driftSteps ?? TOTP_DRIFT_STEPS;

  const code = normalizeTotpCode(input.code, digits);
  if (!code) {
    return { ok: false, counter: null, drift: 0, reason: `a code is ${digits} digits` };
  }

  const current = totpCounter(input.atMs, stepSeconds);
  const offsets: number[] = [0];
  for (let distance = 1; distance <= driftSteps; distance += 1) offsets.push(-distance, distance);

  for (const offset of offsets) {
    const counter = current + offset;
    if (counter < 0) continue;
    if (totpCode(input.secret, counter, input.signer, digits) !== code) continue;
    // The step is right, so the only remaining question is whether it has already
    // been spent. Answering "no" before this check would make a replayed code a
    // successful sign-in.
    if (input.lastUsedCounter != null && counter <= input.lastUsedCounter) {
      return { ok: false, counter: null, drift: offset, reason: "that code has already been used" };
    }
    return { ok: true, counter, drift: offset, reason: null };
  }

  return { ok: false, counter: null, drift: 0, reason: "the code did not match" };
}

/* -------------------------------------------------------------------------- */
/*  The provisioning URI                                                      */
/* -------------------------------------------------------------------------- */

export interface OtpauthInput {
  issuer: string;
  /** What the app labels the entry — an email address is the useful choice. */
  account: string;
  /** The base32 secret. */
  secret: string;
  digits?: number;
  stepSeconds?: number;
}

/**
 * The `otpauth://totp/…` URI an authenticator app scans or reads.
 *
 * The issuer appears twice — in the label path and as a parameter — because apps
 * disagree about which one they read, and a factor showing up as "Sentinel" when
 * somebody has three is how the wrong one gets deleted.
 */
export function otpauthUri(input: OtpauthInput): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.stepSeconds ?? TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/*  The record                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An enrolled (or in-progress) second factor.
 *
 * `confirmedAt` is the field that decides whether this factor counts: `null` means
 * somebody generated a secret and nobody has proved they hold it, which is an
 * enrollment, not a factor. The session policy never reads this — it reads the
 * spine's `Identity.mfaEnrolled`, which is only ever set from a confirmed factor.
 */
export interface MfaFactorRecord {
  id: string;
  organizationId: string;
  identityId: string;
  kind: MfaKind;
  /**
   * TOTP: the base32 shared secret.
   *
   * This is the one value in Sentinel that has to be stored in a form it can be
   * read back from, because a TOTP code is computed *from* it. A hash cannot be
   * used here the way it is for a token; the deployment is expected to encrypt it
   * at rest, exactly as it does a webhook signing secret.
   */
  secret: string;
  /**
   * WebAuthn only: the credential's public key, as the COSE key parsed from the
   * registration ceremony.
   *
   * A public key is not a secret, so unlike the TOTP column this one is safe to
   * store in the clear and safe to read back — it is what an assertion is verified
   * *against*, and losing it means the key can never answer again.
   */
  publicKey: string | null;
  /** WebAuthn only: the last authenticator signature counter, for the clone check. */
  signCount: number | null;
  label: string | null;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  lastUsedCounter: number | null;
  createdAt: string;
}

export interface MfaIssue {
  field: string;
  message: string;
}

export function validateMfaFactor(input: { kind?: string; label?: string | null }): MfaIssue[] {
  const issues: MfaIssue[] = [];

  const kind = input.kind ?? "TOTP";
  if (!isMfaKind(kind)) {
    issues.push({ field: "kind", message: `“${kind}” is not a second factor this provider issues.` });
  }

  const label = input.label?.trim() ?? "";
  if (label.length > MFA_LABEL_MAX) {
    issues.push({ field: "label", message: `A factor's name may be at most ${MFA_LABEL_MAX} characters.` });
  }

  return issues;
}

/** Whether a stored factor counts towards the policy. */
export function isConfirmedFactor(record: MfaFactorRecord): boolean {
  return record.confirmedAt !== null;
}

/** A factor as a console reads it. Deliberately without the secret. */
export interface MfaFactorSummary {
  id: string;
  kind: MfaKind;
  label: string | null;
  confirmed: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export function mfaFactorSummary(record: MfaFactorRecord): MfaFactorSummary {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    confirmed: isConfirmedFactor(record),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/** What a person calls a factor in a list. A kind is a word nobody says out loud. */
export function mfaKindLabel(kind: MfaKind): string {
  return kind === "TOTP" ? "Authenticator app" : "Security key";
}
