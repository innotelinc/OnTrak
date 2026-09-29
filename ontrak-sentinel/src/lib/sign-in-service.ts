/**
 * The console sign-in, which is the one login in the family Sentinel owns.
 *
 * Sentinel is an identity *provider*, so every other product in the Network signs in
 * through someone else. Its own console is the exception: it holds the identities, so
 * it has to check the password itself. `IdentityService.issueSession` was written with
 * that split in mind — its comment says the caller "is assumed to have verified the
 * credential already — that check is the part of a login this milestone does not
 * have." This is that part.
 *
 * The order of the checks matters and is the whole security story:
 *
 *  1. **Same answer for every failure.** "No such account", "wrong password" and
 *     "deactivated" all surface as one sentence. Distinguishing them turns the form
 *     into an account-enumeration oracle, which is the first step of a targeted
 *     attack and costs the attacker nothing to run.
 *  2. **The password is verified before the code.** A second factor checked first
 *     would let codes be guessed without ever proving the password — and TOTP codes
 *     are six digits, so that is 10^6 guesses, not a search space worth hiding behind.
 *  3. **The session is issued last, by the spine.** `issueSession` re-checks the
 *     policy on the identity it is handed, so a session cannot be conjured for an
 *     inactive identity or one that owes a factor this service did not collect.
 *
 * Failure is also *recorded*. A refused login appends to the organization's evidence
 * chain with the identifier that was tried — the thing an administrator needs when
 * somebody reports "I cannot get in" — but never with the password or the code.
 */

import type { AuditSink } from "./audit-chain";
import type { CredentialStore } from "./credential-store";
import type { IdentityRecord } from "./identity-rules";
import type { IdentityStore } from "./identity-service";
import { IdentityService, type ServiceResult } from "./identity-service";
import type { MfaService } from "./mfa-service";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { signInProblem, SIGN_IN_FAILURE, type SignInInput } from "./sign-in-rules";

/** What a caller gets back: a live session id, and where to send the browser. */
export interface SignInOutcome {
  sessionId: string;
  identityId: string;
  /** The console path the browser should land on. */
  redirectTo: string;
  /** True when the stored verifier was rewritten at today's cost. */
  rehashed: boolean;
}

export interface SignInIds {
  id(): string;
  now(): string;
}

/** The clock and id source, matching the spine's shape. */
export function systemSignInIds(): SignInIds {
  let n = 0;
  return {
    id: () => `signin-${Date.now().toString(36)}-${(++n).toString(36)}`,
    now: () => new Date().toISOString(),
  };
}

export interface SignInServiceOptions {
  /** The organization signed into when the form left the field blank. */
  defaultOrganizationSlug?: string;
  /** Where a successful sign-in lands. */
  landingPath?: string;
}

export class SignInService {
  constructor(
    /** For the organization, the identity and the session. */
    private readonly store: Pick<
      IdentityStore,
      "findOrganization" | "findOrganizationBySlug" | "findIdentityByIdentifier"
    >,
    private readonly credentials: CredentialStore,
    private readonly mfa: Pick<MfaService, "verify">,
    private readonly spine: Pick<IdentityService, "issueSession">,
    private readonly audit: AuditSink | null = null,
    private readonly ids: SignInIds = systemSignInIds(),
    private readonly options: SignInServiceOptions = {},
  ) {}

  /**
   * Verify a password (and a code when one is owed) and start a session.
   *
   * Every refusal is the same `ServiceResult` error string, except for the missing
   * field complaint, which is about the form rather than the account and so cannot
   * leak anything about it.
   */
  async signIn(input: SignInInput): Promise<ServiceResult<SignInOutcome>> {
    const problem = signInProblem(input);
    if (problem) return { ok: false, error: problem };

    const identifier = input.identifier.trim().toLowerCase();
    const organization = await this.resolveOrganization(input.organization);
    if (!organization) {
      return { ok: false, error: SIGN_IN_FAILURE };
    }

    const identity = await this.store.findIdentityByIdentifier(organization.id, identifier);
    if (!identity || !identity.active) {
      await this.refuse(organization.id, identifier, "no active identity by that name");
      return { ok: false, error: SIGN_IN_FAILURE };
    }

    const credential = await this.credentials.findForIdentity(organization.id, identity.id);
    if (!credential) {
      await this.refuse(organization.id, identity.id, "identity has no password");
      return { ok: false, error: SIGN_IN_FAILURE };
    }

    const passwordOk = await verifyPassword(input.password, credential.hash);
    if (!passwordOk) {
      await this.refuse(organization.id, identity.id, "password did not match");
      return { ok: false, error: SIGN_IN_FAILURE };
    }

    // The factor is collected only when one is enrolled. An identity that owes a
    // factor it has never enrolled is refused by `issueSession` below, which is the
    // right place for that rule: this service should not be the second opinion.
    if (identity.mfaEnrolled) {
      const code = (input.code ?? "").trim();
      if (!code) {
        await this.refuse(organization.id, identity.id, "a second factor is required but none was supplied");
        return { ok: false, error: "Enter the six-digit code from your authenticator app." };
      }
      const verification = await this.mfa.verify({
        organizationId: organization.id,
        identityId: identity.id,
        code,
      });
      if (!verification.ok) {
        await this.refuse(organization.id, identity.id, `second factor refused: ${verification.reason ?? "unknown"}`);
        return { ok: false, error: "That code did not verify." };
      }
    }

    const session = await this.spine.issueSession(organization.id, identity.id, {
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    });
    // A refusal here is a policy sentence ("MFA is required but not enrolled") and is
    // shown as-is: it is about the account's configuration, which the person signing
    // in is entitled to know and cannot use to find other accounts.
    if (!session.ok) return { ok: false, error: session.error };

    // Raise the cost of a stored hash once the right password has proved it can be.
    // Doing it here rather than at reset time means nobody has to reset anything.
    let rehashed = false;
    if (needsRehash(credential.hash)) {
      const upgraded = await hashPassword(input.password);
      await this.credentials.replace(organization.id, identity.id, upgraded);
      rehashed = true;
    }

    await this.append(organization.id, identity.id, "identity.signin", identity.id, {
      identifier,
      mfa: identity.mfaEnrolled,
      rehashed,
    });

    return {
      ok: true,
      value: {
        sessionId: session.value.id,
        identityId: identity.id,
        redirectTo: this.options.landingPath ?? "/console",
        rehashed,
      },
    };
  }

  /**
   * Which organization the sign-in is for.
   *
   * A deployment of this size has one, so the form's workspace field is optional and
   * a blank one means the configured default. It is still *read* when given, because
   * an identifier is only unique within an organization — resolving a bare email
   * across tenants would eventually sign somebody into the wrong one.
   */
  private async resolveOrganization(slug: string | undefined | null): Promise<{ id: string } | null> {
    const wanted = (slug ?? "").trim() || (this.options.defaultOrganizationSlug ?? "");
    if (!wanted) return null;
    const organization = await this.store.findOrganizationBySlug(wanted);
    return organization ? { id: organization.id } : null;
  }

  /** Record a refusal. Never the password, never the code. */
  private async refuse(organizationId: string, actor: string, reason: string): Promise<void> {
    await this.append(organizationId, actor, "identity.signin.refuse", null, { reason });
  }

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType: "Identity",
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/**
 * Write a password verifier for an identity, replacing whatever was there.
 *
 * The path an administrator's first password takes, and the path a bootstrapped
 * deployment's configured password takes on every start. Idempotence is the caller's
 * business: this always writes, so a caller that only wants to set a password when
 * none exists has to look first.
 */
export async function setPassword(
  store: Pick<IdentityStore, "findIdentity">,
  credentials: CredentialStore,
  organizationId: string,
  identityId: string,
  password: string,
): Promise<IdentityRecord | null> {
  const identity = await store.findIdentity(organizationId, identityId);
  if (!identity) return null;
  const hash = await hashPassword(password);
  await credentials.replace(organizationId, identityId, hash);
  return identity;
}
