/**
 * WebAuthn service (S1): registering a key, and signing in with one.
 *
 * `webauthn-rules.ts` judges the ceremony; this file mints the challenge, keeps it
 * until it is spent, stores what the ceremony produced and records both on the
 * organization's evidence chain. Three choices worth stating out loud:
 *
 *  - **The challenge lives on the server, and is consumed by the write that used
 *    it.** It is a row, not a signed blob in the page: "spent" has to be a fact
 *    about our database, and a row can only be spent once. It expires in two
 *    minutes, so a challenge logged by a proxy is not a credential by dinner.
 *  - **A registration is complete when the ceremony verifies — there is no second
 *    step.** TOTP needs two because a secret can be mistyped; a key that completed
 *    the ceremony has already proved it holds the private half, so asking for a
 *    code afterwards would be asking the user to prove the same thing twice. The
 *    factor is written *confirmed*.
 *  - **Enrollment is self-service.** An actor may register or remove keys on their
 *    own identity, and an administrator may do it for anybody in their
 *    organization; nobody may do it for somebody in another one, because the
 *    identity is looked up inside the actor's organization and simply is not
 *    there. This is the same rule `MfaService` applies to TOTP, and it is what
 *    turns `mfaEnrolled` from an administrator's act into a user's.
 *
 * Verification of the assertion needs no actor at all: it is called from the login
 * path, where the password has already been checked and the only question left is
 * the second factor.
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

import type { AuditEventInput, AuditSink } from "./audit-chain";
import { canManageIdentities } from "./identity-rules";
import type { IdentityActor, IdentityService, ServiceResult } from "./identity-service";
import { DEFAULT_MFA_ISSUER, type MfaFactorRecord } from "./mfa-rules";
import type { MfaStore } from "./mfa-service";
import {
  WEBAUTHN_CHALLENGE_BYTES,
  WEBAUTHN_CHALLENGE_SECONDS,
  base64UrlEncode,
  isWebAuthnChallengeUsable,
  parseStoredPublicKey,
  validateWebAuthnConfig,
  verifyAssertion,
  verifyRegistration,
  type CoseAlgorithm,
  type CosePublicKey,
  type WebAuthnAssertionResponse,
  type WebAuthnChallengeRecord,
  type WebAuthnCeremony,
  type WebAuthnCrypto,
  type WebAuthnRegistrationResponse,
  type WebAuthnVerification,
} from "./webauthn-rules";

/* -------------------------------------------------------------------------- */
/*  The ports                                                                 */
/* -------------------------------------------------------------------------- */

export interface WebAuthnChallengeStore {
  insertChallenge(record: WebAuthnChallengeRecord): Promise<void>;
  findChallenge(organizationId: string, challengeId: string): Promise<WebAuthnChallengeRecord | null>;
  /** The newest unspent challenge for one ceremony, so a restart can supersede it. */
  findLiveChallenge(
    organizationId: string,
    identityId: string,
    ceremony: WebAuthnCeremony,
  ): Promise<WebAuthnChallengeRecord | null>;
  updateChallenge(record: WebAuthnChallengeRecord): Promise<void>;
  /** Spend a challenge in one conditional write, so two ceremonies cannot share it. */
  consumeChallenge(organizationId: string, challengeId: string, atMs: number): Promise<boolean>;
  /** Drop a challenge's row. Used when minting supersedes a pending one. */
  removeChallenge(organizationId: string, challengeId: string): Promise<void>;
}

export interface WebAuthnIds {
  id(): string;
  /** A fresh base64url challenge. */
  challenge(): string;
  now(): string;
  nowMs(): number;
}

export function systemWebAuthnIds(): WebAuthnIds {
  return {
    id: () => randomUUID(),
    challenge: () => base64UrlEncode(randomBytes(WEBAUTHN_CHALLENGE_BYTES)),
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/**
 * The real primitives: `SHA-256`, and Node's signature check over a public key
 * imported from the COSE key's JWK shape.
 *
 * Importing from a JWK rather than assembling DER is deliberate — the JWK fields
 * are exactly the COSE fields (`x`/`y` for EC, `n`/`e` for RSA) with the same
 * base64url encoding, so nothing here has to get a length prefix right.
 */
export function systemWebAuthnCrypto(): WebAuthnCrypto {
  return {
    sha256: (bytes) => new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest()),
    verify: ({ publicKey, message, signature }) => {
      const jwk =
        publicKey.kty === "EC"
          ? { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y }
          : { kty: "RSA", n: publicKey.n, e: publicKey.e };
      try {
        const key = createPublicKey({ key: jwk, format: "jwk" });
        return verify("sha256", Buffer.from(message), key, Buffer.from(signature));
      } catch {
        // A key that cannot be imported verifies nothing. It is a refusal, not a
        // server error: the value came off the wire.
        return false;
      }
    },
  };
}

export interface WebAuthnConfig {
  /** The relying party's id: a hostname, and every key is bound to it. */
  rpId: string;
  /** What the browser shows in its own prompt. */
  rpName: string;
  /** The origin ceremonies must run on, compared exactly against `clientDataJSON`. */
  origin: string;
  /** How long a minted challenge is good for. */
  challengeSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface WebAuthnRegistrationOptions {
  challengeId: string;
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: CoseAlgorithm }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "preferred"; userVerification: "preferred" };
  excludeCredentials: { type: "public-key"; id: string; transports?: readonly string[] }[];
}

export interface WebAuthnAuthenticationOptions {
  challengeId: string;
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "preferred";
  allowCredentials: { type: "public-key"; id: string }[];
}

export interface WebAuthnCredentialSummary {
  /** The factor's id, for a console to act on. */
  factorId: string;
  credentialId: string;
  label: string | null;
  confirmed: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface FinishRegistrationInput {
  response: WebAuthnRegistrationResponse;
  label?: string | null;
  /** The transports the browser reported, so a later prompt can be narrowed. */
  transports?: readonly string[];
}

export interface FinishAuthenticationInput {
  organizationId: string;
  identityId: string;
  challengeId: string;
  response: WebAuthnAssertionResponse;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class WebAuthnService {
  private readonly challengeSeconds: number;

  constructor(
    private readonly store: MfaStore,
    private readonly challenges: WebAuthnChallengeStore,
    /** How the enrolled flag is set: the spine owns it, not this service. */
    private readonly identities: Pick<IdentityService, "setMfaEnrolled" | "identity">,
    private readonly config: WebAuthnConfig,
    private readonly audit: AuditSink | null = null,
    private readonly ids: WebAuthnIds = systemWebAuthnIds(),
    private readonly crypto: WebAuthnCrypto = systemWebAuthnCrypto(),
  ) {
    const issues = validateWebAuthnConfig({
      rpId: config.rpId,
      origin: config.origin,
      rpName: config.rpName || DEFAULT_MFA_ISSUER,
    });
    // Configuration is checked at construction, so a deployment with a mismatched
    // RP ID fails when it starts rather than when somebody tries to register a key
    // and the browser refuses for reasons it will not explain.
    if (issues.length > 0) throw new Error(`WebAuthn is misconfigured: ${issues[0].message}`);
    this.challengeSeconds = config.challengeSeconds ?? WEBAUTHN_CHALLENGE_SECONDS;
  }

  /* ------------------------------------------------------- registration */

  /**
   * Mint a challenge and the parameters the browser needs.
   *
   * `excludeCredentials` is not decoration: it is what stops the same key being
   * registered twice, which would leave a person with two rows for one device and
   * a console that cannot tell them apart.
   */
  async registrationOptions(
    actor: IdentityActor,
    identityId: string,
    input: { userName?: string; displayName?: string } = {},
  ): Promise<ServiceResult<WebAuthnRegistrationOptions>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    // The identity is resolved the way every other read resolves it — inside the
    // actor's organization — so a key can never be registered against a row in
    // somebody else's tenant.
    const found = await this.identities.identity(actor, identityId);
    if (!found.ok) return found;

    const challenge = await this.mint(actor.organizationId, identityId, "REGISTRATION");
    const existing = (await this.store.listFactors(actor.organizationId, identityId)).filter(
      (factor) => factor.kind === "WEBAUTHN",
    );

    return {
      ok: true,
      value: {
        challengeId: challenge.id,
        challenge: challenge.challenge,
        rp: { id: this.config.rpId, name: this.config.rpName || DEFAULT_MFA_ISSUER },
        user: {
          // The user handle is opaque and stable: it is what a discoverable
          // credential is found by, so it must not be the identifier somebody may
          // later change.
          id: base64UrlEncode(Buffer.from(identityId, "utf8")),
          name: input.userName?.trim() || found.value.identifier,
          displayName:
            input.displayName?.trim() || input.userName?.trim() || found.value.displayName || found.value.identifier,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: this.challengeSeconds * 1000,
        attestation: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        excludeCredentials: existing.map((factor) => ({ type: "public-key", id: factor.secret })),
      },
    };
  }

  /**
   * Judge the ceremony and store the key.
   *
   * The challenge is spent **before** the factor is written, and only if it was
   * still live. Doing it the other way round would leave a window in which the same
   * ceremony could be replayed into a second row.
   */
  async finishRegistration(
    actor: IdentityActor,
    identityId: string,
    challengeId: string,
    input: FinishRegistrationInput,
  ): Promise<ServiceResult<{ credential: WebAuthnCredentialSummary; verification: WebAuthnVerification }>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const challenge = await this.challenges.findChallenge(actor.organizationId, challengeId);
    if (!challenge) return { ok: false, error: "That registration challenge does not exist." };
    if (challenge.identityId !== identityId) return { ok: false, error: "That challenge belongs to somebody else." };
    // Asked before the ceremony is judged, so a replay is refused as a replay rather
    // than as whatever the second attempt happens to look like. The conditional write
    // below is still the thing that makes it true under a race.
    if (!isWebAuthnChallengeUsable(challenge, this.ids.nowMs())) {
      return { ok: false, error: "That challenge has already been used or has expired." };
    }

    const verification = verifyRegistration({
      response: { ...input.response, transports: input.transports ?? input.response.transports },
      challenge,
      crypto: this.crypto,
    });
    if (!verification.ok || !verification.credential) {
      await this.append(actor.organizationId, actor.id, "mfa.webauthn.refuse", challengeId, {
        identityId,
        ceremony: "REGISTRATION",
        reason: verification.reason,
      });
      return { ok: false, error: `That security key was refused: ${verification.reason}.` };
    }

    const consumed = await this.challenges.consumeChallenge(actor.organizationId, challengeId, this.ids.nowMs());
    if (!consumed) return { ok: false, error: "That challenge has already been used or has expired." };

    const now = this.ids.now();
    const factor: MfaFactorRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      identityId,
      kind: "WEBAUTHN",
      // The credential id: the one value an assertion arrives naming, and the one
      // this column can hold for a factor whose secret is a public key.
      secret: verification.credential.credentialId,
      label: input.label?.trim() || null,
      publicKey: verification.credential.publicKey,
      signCount: verification.credential.signCount,
      // A completed ceremony is a confirmed factor; there is nothing left to prove.
      confirmedAt: now,
      lastUsedAt: now,
      lastUsedCounter: null,
      createdAt: now,
    };
    await this.store.insertFactor(factor);
    const flagged = await this.identities.setMfaEnrolled(actor, identityId, true);
    if (!flagged.ok) return flagged;

    await this.append(actor.organizationId, actor.id, "mfa.webauthn.register", factor.id, {
      identityId,
      credentialId: factor.secret,
      transports: verification.credential.transports,
      aaguid: verification.credential.aaguid,
    });

    return { ok: true, value: { credential: summarize(factor), verification } };
  }

  /* ------------------------------------------------------ authentication */

  /**
   * The challenge and the allowed credentials for a sign-in. No actor: the caller
   * has already checked the first factor, exactly as `MfaService.verify` is called.
   *
   * An identity with no registered key gets an empty `allowCredentials` and an
   * error, rather than a challenge that cannot be answered — a browser handed one
   * shows a prompt for a key that will never work.
   */
  async authenticationOptions(input: {
    organizationId: string;
    identityId: string;
  }): Promise<ServiceResult<WebAuthnAuthenticationOptions>> {
    const factors = (await this.store.listFactors(input.organizationId, input.identityId)).filter(
      (factor) => factor.kind === "WEBAUTHN" && factor.confirmedAt !== null,
    );
    if (factors.length === 0) return { ok: false, error: "No security key is registered for that identity." };

    const challenge = await this.mint(input.organizationId, input.identityId, "AUTHENTICATION");
    return {
      ok: true,
      value: {
        challengeId: challenge.id,
        challenge: challenge.challenge,
        rpId: this.config.rpId,
        timeout: this.challengeSeconds * 1000,
        userVerification: "preferred",
        allowCredentials: factors.map((factor) => ({ type: "public-key", id: factor.secret })),
      },
    };
  }

  /**
   * Judge an assertion. This is the step-up at a login, so there is no actor and no
   * permission check — the password was the first factor and this is the second.
   *
   * The counter is written back, because it is the only state that makes the *next*
   * assertion's clone check possible.
   */
  async finishAuthentication(input: FinishAuthenticationInput): Promise<WebAuthnVerification> {
    const challenge = await this.challenges.findChallenge(input.organizationId, input.challengeId);
    if (!challenge) return { ok: false, reason: "that challenge does not exist" };
    if (challenge.identityId !== input.identityId) return { ok: false, reason: "that challenge belongs to somebody else" };
    // A spent challenge is refused before any cryptography runs: the answer is the
    // same either way, and doing the work first would report a replay as whatever the
    // counter or the signature happens to say the second time.
    if (!isWebAuthnChallengeUsable(challenge, this.ids.nowMs())) {
      return { ok: false, reason: "that challenge has already been used or has expired" };
    }

    // The assertion names its credential, so resolve it by id rather than assuming
    // the newest one: an identity may hold several keys and only one of them
    // answered, and the unregistered-key refusal is the interesting half of this.
    const candidates = await this.store.listFactors(input.organizationId, input.identityId);
    const stored =
      candidates.find(
        (entry) => entry.kind === "WEBAUTHN" && entry.confirmedAt !== null && entry.secret === input.response.id,
      ) ?? null;
    if (!stored) {
      await this.append(input.organizationId, `identity:${input.identityId}`, "mfa.webauthn.refuse", input.challengeId, {
        identityId: input.identityId,
        ceremony: "AUTHENTICATION",
        reason: "that credential is not registered here",
      });
      return { ok: false, reason: "that credential is not registered here" };
    }

    const publicKey = parseStoredPublicKey(stored.publicKey);
    if (!publicKey) {
      return { ok: false, reason: "the stored public key cannot be read" };
    }

    const verification = verifyAssertion({
      response: input.response,
      challenge,
      stored: { credentialId: stored.secret, publicKey, signCount: stored.signCount },
      crypto: this.crypto,
    });

    const who = `identity:${input.identityId}`;
    if (!verification.ok) {
      await this.append(input.organizationId, who, "mfa.webauthn.refuse", input.challengeId, {
        identityId: input.identityId,
        ceremony: "AUTHENTICATION",
        reason: verification.reason,
      });
      return verification;
    }

    const consumed = await this.challenges.consumeChallenge(input.organizationId, input.challengeId, this.ids.nowMs());
    if (!consumed) return { ok: false, reason: "that challenge has already been used or has expired" };

    await this.store.updateFactor({
      ...stored,
      signCount: verification.signCount ?? stored.signCount,
      lastUsedAt: this.ids.now(),
    });
    await this.append(input.organizationId, who, "mfa.webauthn.ok", stored.id, {
      identityId: input.identityId,
      credentialId: stored.secret,
      signCount: verification.signCount,
    });
    return verification;
  }

  /* ---------------------------------------------------------- lifecycle */

  /** Every registered key, without the material a console must never handle. */
  async credentials(actor: IdentityActor, identityId: string): Promise<ServiceResult<WebAuthnCredentialSummary[]>> {
    const denied = requireReadable(actor, identityId);
    if (denied) return denied;
    const factors = (await this.store.listFactors(actor.organizationId, identityId)).filter(
      (factor) => factor.kind === "WEBAUTHN",
    );
    return { ok: true, value: factors.map(summarize) };
  }

  /**
   * Remove one key.
   *
   * The enrolled flag is recomputed rather than cleared: an identity may hold a TOTP
   * factor and two keys, and removing one key must not claim it owes no second
   * factor at all. That would refuse its next sign-in while a working authenticator
   * sits on its phone.
   */
  async removeCredential(
    actor: IdentityActor,
    identityId: string,
    credentialId: string,
  ): Promise<ServiceResult<{ removed: number; stillEnrolled: boolean }>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const factors = await this.store.listFactors(actor.organizationId, identityId);
    const doomed = factors.filter((factor) => factor.kind === "WEBAUTHN" && factor.secret === credentialId);
    if (doomed.length === 0) return { ok: false, error: "That security key is not registered here." };
    for (const factor of doomed) await this.store.removeFactor(actor.organizationId, factor.id);

    const remaining = factors.filter((factor) => !doomed.includes(factor) && factor.confirmedAt !== null);
    const stillEnrolled = remaining.length > 0;
    if (!stillEnrolled) {
      const flagged = await this.identities.setMfaEnrolled(actor, identityId, false);
      if (!flagged.ok) return flagged;
    }

    await this.append(actor.organizationId, actor.id, "mfa.webauthn.remove", doomed[0].id, {
      identityId,
      credentialId,
      removed: doomed.length,
      stillEnrolled,
    });
    return { ok: true, value: { removed: doomed.length, stillEnrolled } };
  }

  /* ------------------------------------------------------------ internals */

  private async mint(
    organizationId: string,
    identityId: string,
    ceremony: WebAuthnCeremony,
  ): Promise<WebAuthnChallengeRecord> {
    // One live challenge per ceremony per identity: minting a second supersedes the
    // first, so a page reload cannot leave two acceptable challenges lying around.
    const live = await this.challenges.findLiveChallenge(organizationId, identityId, ceremony);
    if (live) await this.challenges.removeChallenge(organizationId, live.id);

    const nowMs = this.ids.nowMs();
    const record: WebAuthnChallengeRecord = {
      id: this.ids.id(),
      organizationId,
      identityId,
      ceremony,
      challenge: this.ids.challenge(),
      origin: this.config.origin,
      rpId: this.config.rpId,
      createdAt: nowMs,
      expiresAt: nowMs + this.challengeSeconds * 1000,
      usedAt: null,
    };
    await this.challenges.insertChallenge(record);
    return record;
  }

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType: "MfaFactor",
      targetId,
      // The organization rides in the detail so the log routes the event to the
      // right chain — one chain per organization, exactly as the spine does it.
      detail: { ...detail, organizationId },
    };
    await this.audit.append(event);
  }
}

function summarize(factor: MfaFactorRecord): WebAuthnCredentialSummary {
  return {
    factorId: factor.id,
    credentialId: factor.secret,
    label: factor.label,
    confirmed: factor.confirmedAt !== null,
    createdAt: factor.createdAt,
    lastUsedAt: factor.lastUsedAt,
  };
}

/**
 * Whether this actor may change this identity's factors.
 *
 * Self-service is the point: an actor always may act on their own identity, and an
 * administrator may act on anybody in their organization. The identity is looked up
 * inside the actor's organization by every caller, so "somebody in another tenant"
 * is not a case this has to forbid — they are not there.
 */
function requireEnrollable(actor: IdentityActor, identityId: string): ServiceResult<never> | null {
  if (actor.id === identityId) return null;
  if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not administer identities." };
  return null;
}

function requireReadable(actor: IdentityActor, identityId: string): ServiceResult<never> | null {
  return requireEnrollable(actor, identityId);
}

/* -------------------------------------------------------------------------- */
/*  An in-memory challenge store, used by tests and local development         */
/* -------------------------------------------------------------------------- */

export class MemoryWebAuthnChallengeStore implements WebAuthnChallengeStore {
  private readonly records = new Map<string, WebAuthnChallengeRecord>();

  async insertChallenge(record: WebAuthnChallengeRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async findChallenge(organizationId: string, challengeId: string): Promise<WebAuthnChallengeRecord | null> {
    const found = this.records.get(challengeId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findLiveChallenge(
    organizationId: string,
    identityId: string,
    ceremony: WebAuthnCeremony,
  ): Promise<WebAuthnChallengeRecord | null> {
    const live = [...this.records.values()]
      .filter(
        (entry) =>
          entry.organizationId === organizationId &&
          entry.identityId === identityId &&
          entry.ceremony === ceremony &&
          entry.usedAt === null,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return live[0] ? structuredClone(live[0]) : null;
  }

  async updateChallenge(record: WebAuthnChallengeRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async consumeChallenge(organizationId: string, challengeId: string, atMs: number): Promise<boolean> {
    const found = this.records.get(challengeId);
    if (!found || found.organizationId !== organizationId) return false;
    if (found.usedAt !== null || atMs > found.expiresAt) return false;
    this.records.set(challengeId, structuredClone({ ...found, usedAt: atMs }));
    return true;
  }

  async removeChallenge(organizationId: string, challengeId: string): Promise<void> {
    const found = this.records.get(challengeId);
    if (found && found.organizationId === organizationId) this.records.delete(challengeId);
  }
}
