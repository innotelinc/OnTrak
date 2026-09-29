/**
 * MFA service (S1): enrolling a TOTP factor, and spending a code.
 *
 * `mfa-rules.ts` decides whether a code is good; this file decides what happens
 * around it and what must outlive the request. Three choices worth stating out
 * loud:
 *
 *  - **The flag is the spine's, and only a confirmed code sets it.** `mfaEnrolled`
 *    is what `sessionDecision` reads at grant *and* at read, so it is set through
 *    `IdentityService.setMfaEnrolled` — one writer, one audit event, one place a
 *    future reviewer has to look. This service's job is to make sure that call
 *    only ever happens *after* a code from the secret verifies, which is the
 *    difference between a second factor and a checkbox.
 *  - **The secret is shown once.** `beginEnrollment` returns it (and the
 *    `otpauth://` URI built from it) and nothing reads it back out afterwards; the
 *    console can list factors without ever handling one. A support engineer who can
 *    read the database can still read the secret, which is why it is the
 *    deployment's job to encrypt that column — stated here rather than assumed.
 *  - **A spent step is recorded.** `verify` writes the step a code was accepted
 *    for, so the same six digits cannot be presented twice inside their window. A
 *    refusal is on the evidence chain too: "how many codes were tried against this
 *    identity?" is a question an incident asks.
 *
 * **Enrollment is self-service**, and that is the change this milestone makes. An
 * actor may enroll, confirm and remove factors on their own identity with no
 * administrator involved; an administrator may do it for anybody in their
 * organization. The rule lives in `requireEnrollable`, and the flag is still only
 * ever set through the spine, so "who may set it" widened while "what proves it"
 * did not. The verify half needs no actor at all: it is called from the login path,
 * where a password has already been checked and the only question left is the
 * second factor.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { AuditEventInput, AuditSink } from "./audit-chain";
import { canManageIdentities } from "./identity-rules";
import type { IdentityActor, IdentityService, ServiceResult } from "./identity-service";
import {
  DEFAULT_MFA_ISSUER,
  TOTP_SECRET_BYTES,
  base32Decode,
  base32Encode,
  mfaFactorSummary,
  otpauthUri,
  validateMfaFactor,
  verifyTotp,
  type MfaFactorRecord,
  type MfaFactorSummary,
  type MfaKind,
  type TotpSigner,
} from "./mfa-rules";

/* -------------------------------------------------------------------------- */
/*  The ports                                                                 */
/* -------------------------------------------------------------------------- */

export interface MfaStore {
  insertFactor(record: MfaFactorRecord): Promise<void>;
  findFactorById(organizationId: string, factorId: string): Promise<MfaFactorRecord | null>;
  /** The newest factor of one kind for an identity, or `null`. */
  findFactor(organizationId: string, identityId: string, kind: MfaKind): Promise<MfaFactorRecord | null>;
  listFactors(organizationId: string, identityId: string): Promise<MfaFactorRecord[]>;
  updateFactor(record: MfaFactorRecord): Promise<void>;
  removeFactor(organizationId: string, factorId: string): Promise<void>;
}

export interface MfaIds {
  id(): string;
  /** A fresh base32 shared secret. */
  secret(): string;
  now(): string;
  nowMs(): number;
}

export function systemMfaIds(): MfaIds {
  return {
    id: () => randomUUID(),
    secret: () => base32Encode(randomBytes(TOTP_SECRET_BYTES)),
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/**
 * HMAC-SHA-1, the primitive RFC 6238 specifies and every authenticator app
 * assumes. The rules module takes it as a parameter, so this is the one place the
 * algorithm is actually chosen.
 */
export function systemTotpSigner(): TotpSigner {
  return {
    sign: (key: Uint8Array, message: Uint8Array) =>
      createHmac("sha1", Buffer.from(key)).update(Buffer.from(message)).digest(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface BeginEnrollmentInput {
  /** What the authenticator app labels the entry. The identity's identifier fits. */
  account?: string;
  label?: string | null;
}

/** The one moment the shared secret is readable. */
export interface MfaEnrollment {
  factor: MfaFactorRecord;
  secret: string;
  /** `otpauth://` — what a QR code encodes and what an app can be given by hand. */
  uri: string;
}

export interface MfaStatus {
  identityId: string;
  /** Mirrors `Identity.mfaEnrolled`: a *confirmed* factor exists. */
  enrolled: boolean;
  /** The newest confirmed factor, of whichever kind. */
  confirmed: MfaFactorRecord | null;
  /** An enrollment waiting for its first code. Never satisfies the policy. */
  pending: MfaFactorRecord | null;
  /** Every factor, without any secret, so a console can list them. */
  factors: MfaFactorSummary[];
}

export interface MfaVerificationOutcome {
  ok: boolean;
  /** The step the code belonged to, when it verified. */
  counter: number | null;
  drift: number;
  reason: string | null;
  /** The factor that answered, so a caller can record which one was used. */
  factorId: string | null;
}

export interface VerifyInput {
  organizationId: string;
  identityId: string;
  code: string;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class MfaService {
  constructor(
    private readonly store: MfaStore,
    /** How the enrolled flag is set: the spine owns it, not this service. */
    private readonly identities: Pick<IdentityService, "setMfaEnrolled">,
    private readonly audit: AuditSink | null = null,
    private readonly ids: MfaIds = systemMfaIds(),
    private readonly signer: TotpSigner = systemTotpSigner(),
    /** The issuer name an authenticator app shows. */
    private readonly issuer: string = DEFAULT_MFA_ISSUER,
  ) {}

  /* ------------------------------------------------------- enrollment */

  /**
   * Generate a secret and start an enrollment.
   *
   * A pending enrollment already in place is discarded rather than kept, so a
   * second start is a restart: the code the user is looking at belongs to the
   * secret they were just shown, and a store quietly holding two candidate
   * secrets is how a working code gets refused.
   */
  async beginEnrollment(
    actor: IdentityActor,
    identityId: string,
    input: BeginEnrollmentInput = {},
  ): Promise<ServiceResult<MfaEnrollment>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const issues = validateMfaFactor({ kind: "TOTP", label: input.label ?? null });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.findFactor(actor.organizationId, identityId, "TOTP");
    if (existing?.confirmedAt) {
      return {
        ok: false,
        error: "That identity already has a confirmed authenticator; remove it before enrolling another.",
      };
    }
    if (existing) await this.store.removeFactor(actor.organizationId, existing.id);

    const secret = this.ids.secret();
    const factor: MfaFactorRecord = {
      id: this.ids.id(),
      organizationId: actor.organizationId,
      identityId,
      kind: "TOTP",
      secret,
      publicKey: null,
      signCount: null,
      label: input.label?.trim() || null,
      confirmedAt: null,
      lastUsedAt: null,
      lastUsedCounter: null,
      createdAt: this.ids.now(),
    };
    await this.store.insertFactor(factor);
    // The factor's id and the fact that a secret was minted — never the secret.
    await this.append(actor.organizationId, actor.id, "mfa.enroll.begin", factor.id, {
      identityId,
      kind: "TOTP",
    });

    return {
      ok: true,
      value: { factor, secret, uri: otpauthUri({ issuer: this.issuer, account: input.account?.trim() || identityId, secret }) },
    };
  }

  /**
   * Prove the enrollment by presenting a code from it.
   *
   * This is the only path that sets `mfaEnrolled` to true. The flag is set first
   * and the factor second, on purpose: the flag is what every session decision
   * reads, and a confirmed factor beside a false flag would leave an identity
   * enrolled and unable to sign in.
   */
  async confirmEnrollment(
    actor: IdentityActor,
    identityId: string,
    code: string,
  ): Promise<ServiceResult<{ factor: MfaFactorRecord; drift: number }>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const factor = await this.store.findFactor(actor.organizationId, identityId, "TOTP");
    if (!factor) return { ok: false, error: "There is no enrollment awaiting a code for that identity." };
    if (factor.confirmedAt) return { ok: false, error: "That authenticator is already confirmed." };

    const secret = base32Decode(factor.secret);
    if (!secret) {
      return { ok: false, error: "That enrollment's secret cannot be read; start the enrollment again." };
    }

    const check = verifyTotp({
      secret,
      code,
      atMs: this.ids.nowMs(),
      signer: this.signer,
      lastUsedCounter: factor.lastUsedCounter,
    });
    if (!check.ok) {
      // A refused enrollment is worth recording: somebody was shown a secret and
      // the code they typed did not match it, which is either a clock a long way
      // out or a hand-typed secret.
      await this.append(actor.organizationId, actor.id, "mfa.enroll.refuse", factor.id, {
        identityId,
        reason: check.reason,
      });
      return { ok: false, error: `That code did not verify: ${check.reason}.` };
    }

    const flagged = await this.identities.setMfaEnrolled(actor, identityId, true);
    if (!flagged.ok) return flagged;

    const now = this.ids.now();
    const confirmed: MfaFactorRecord = {
      ...factor,
      confirmedAt: now,
      lastUsedAt: now,
      // The enrollment's own code is spent like any other, so it cannot be
      // replayed as the first sign-in's second factor.
      lastUsedCounter: check.counter,
    };
    await this.store.updateFactor(confirmed);
    await this.append(actor.organizationId, actor.id, "mfa.enroll.confirm", factor.id, {
      identityId,
      drift: check.drift,
    });
    return { ok: true, value: { factor: confirmed, drift: check.drift } };
  }

  /* ------------------------------------------------------ verification */

  /**
   * Judge a code for an identity. The login path's step-up, and the only method
   * here that needs no actor: the caller has already proved the first factor.
   *
   * The refusal is deliberately one outcome rather than a reason per cause — a
   * caller cannot act on the difference between "no factor" and "wrong code", and
   * the distinction is on the evidence chain where it belongs.
   */
  async verify(input: VerifyInput): Promise<MfaVerificationOutcome> {
    const factor = await this.store.findFactor(input.organizationId, input.identityId, "TOTP");
    if (!factor || !factor.confirmedAt) {
      return {
        ok: false,
        counter: null,
        drift: 0,
        reason: "no confirmed authenticator is enrolled",
        factorId: factor?.id ?? null,
      };
    }

    const secret = base32Decode(factor.secret);
    if (!secret) {
      return {
        ok: false,
        counter: null,
        drift: 0,
        reason: "the enrolled secret cannot be read",
        factorId: factor.id,
      };
    }

    const check = verifyTotp({
      secret,
      code: input.code,
      atMs: this.ids.nowMs(),
      signer: this.signer,
      lastUsedCounter: factor.lastUsedCounter,
    });

    const who = `identity:${input.identityId}`;
    if (!check.ok) {
      await this.append(input.organizationId, who, "mfa.verify.refuse", factor.id, {
        identityId: input.identityId,
        reason: check.reason,
      });
      return { ...check, factorId: factor.id };
    }

    await this.store.updateFactor({
      ...factor,
      lastUsedAt: this.ids.now(),
      lastUsedCounter: check.counter,
    });
    await this.append(input.organizationId, who, "mfa.verify.ok", factor.id, {
      identityId: input.identityId,
      drift: check.drift,
    });
    return { ...check, factorId: factor.id };
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Remove every factor an identity holds and clear the flag.
   *
   * The two writes are one act: a factor left behind while the flag says "not
   * enrolled" would let the old code keep verifying at a login path that checks
   * the rule rather than the flag.
   */
  async removeEnrollment(actor: IdentityActor, identityId: string): Promise<ServiceResult<{ removed: number }>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const factors = await this.store.listFactors(actor.organizationId, identityId);
    for (const factor of factors) {
      await this.store.removeFactor(actor.organizationId, factor.id);
    }
    const flagged = await this.identities.setMfaEnrolled(actor, identityId, false);
    if (!flagged.ok) return flagged;

    await this.append(actor.organizationId, actor.id, "mfa.enroll.remove", identityId, {
      identityId,
      removed: factors.length,
    });
    return { ok: true, value: { removed: factors.length } };
  }

  /** Where an identity stands, as a console reads it. Never includes a secret. */
  async status(actor: IdentityActor, identityId: string): Promise<ServiceResult<MfaStatus>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const factors = await this.store.listFactors(actor.organizationId, identityId);
    const confirmed = [...factors].reverse().find((factor) => factor.confirmedAt !== null) ?? null;
    // A pending enrollment is only ever a TOTP one: a WebAuthn factor is written
    // already confirmed, because the ceremony is what proved it.
    const pending = factors.find((factor) => factor.kind === "TOTP" && factor.confirmedAt === null) ?? null;
    return {
      ok: true,
      value: { identityId, enrolled: confirmed !== null, confirmed, pending, factors: factors.map(mfaFactorSummary) },
    };
  }

  /** Every factor an identity holds, without its secret. */
  async listFactors(actor: IdentityActor, identityId: string): Promise<ServiceResult<MfaFactorSummary[]>> {
    const denied = requireEnrollable(actor, identityId);
    if (denied) return denied;

    const factors = await this.store.listFactors(actor.organizationId, identityId);
    return { ok: true, value: factors.map(mfaFactorSummary) };
  }

  /* ------------------------------------------------------------ internals */

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

/**
 * Whether this actor may change this identity's factors.
 *
 * **Self-service is the rule, and it is the whole point of the console.** An actor
 * may always enroll or remove factors on their own identity — that is what turns
 * `mfaEnrolled` from something an administrator does *to* somebody into something a
 * person does for themselves, which is also the only way it scales past a desk of
 * five. An administrator may do it for anybody in their organization, and neither
 * may do it for somebody in another one, because every caller looks the identity up
 * inside the actor's organization and it simply is not there.
 */
function requireEnrollable(actor: IdentityActor, identityId: string): ServiceResult<never> | null {
  if (actor.id === identityId) return null;
  if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not administer identities." };
  return null;
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryMfaStore implements MfaStore {
  private readonly factors = new Map<string, MfaFactorRecord>();

  async insertFactor(record: MfaFactorRecord): Promise<void> {
    this.factors.set(record.id, structuredClone(record));
  }

  async findFactorById(organizationId: string, factorId: string): Promise<MfaFactorRecord | null> {
    const found = this.factors.get(factorId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findFactor(organizationId: string, identityId: string, kind: MfaKind): Promise<MfaFactorRecord | null> {
    const matches = [...this.factors.values()]
      .filter((entry) => entry.organizationId === organizationId && entry.identityId === identityId && entry.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  async listFactors(organizationId: string, identityId: string): Promise<MfaFactorRecord[]> {
    return [...this.factors.values()]
      .filter((entry) => entry.organizationId === organizationId && entry.identityId === identityId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((entry) => structuredClone(entry));
  }

  async updateFactor(record: MfaFactorRecord): Promise<void> {
    this.factors.set(record.id, structuredClone(record));
  }

  async removeFactor(organizationId: string, factorId: string): Promise<void> {
    const found = this.factors.get(factorId);
    if (found && found.organizationId === organizationId) this.factors.delete(factorId);
  }
}
