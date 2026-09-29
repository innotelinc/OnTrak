/**
 * SSO sign-in service: what a verified assertion *does* to this deployment.
 *
 * `oidc-rules.ts` decides what an assertion means; this module decides what it
 * changes. It is the training app's counterpart to OnTrak Tix's
 * `IdentityService.signIn`, and it exists because single sign-on is only half a
 * feature without an answer to the other half: **who is this person here, and do
 * they already exist?**
 *
 * Three answers, in order:
 *
 *  1. **By provider subject first.** `User.externalId` holds the `sub`. Matching
 *     on it is what makes a rename in the directory a *move* rather than a second
 *     account — matching on the email alone would create a new user and orphan
 *     the first one's attempts, class memberships and certificates.
 *  2. **By email second**, so a deployment that already has accounts from before
 *     it had a provider adopts them on the first SSO sign-in instead of
 *     duplicating every one of them.
 *  3. **Create**, with no password at all.
 *
 * The store and the audit sink are injected, so this is exercised against fakes
 * and the app shares the same audit trail the rest of the product writes to.
 */

import { pickAccent } from "./auth-hash";
import { applySsoRole, type SsoAuthorization, type SsoRole } from "./oidc-rules";

/** The account fields the SSO path reads and writes. */
export interface SsoUserRecord {
  id: string;
  email: string;
  name: string;
  role: SsoRole;
  active: boolean;
  accent: string;
  /** The provider's stable `sub`, or null for an account that predates SSO. */
  externalId: string | null;
}

export interface SsoUserStore {
  findBySubject(subject: string): Promise<SsoUserRecord | null>;
  findByEmail(email: string): Promise<SsoUserRecord | null>;
  countOtherActiveAdmins(excludeId: string): Promise<number>;
  create(input: { email: string; name: string; role: SsoRole; accent: string; externalId: string }): Promise<SsoUserRecord>;
  update(id: string, patch: { email: string; name: string; role: SsoRole; externalId: string }): Promise<SsoUserRecord>;
}

export interface SsoAuditEvent {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

export type SsoAuditSink = (event: SsoAuditEvent) => Promise<void>;

export interface SsoSignInResult {
  user: SsoUserRecord;
  /** True when this sign-in created the account. */
  provisioned: boolean;
  roleChanged: boolean;
  /** Why the role was not written, when it was not. */
  note: string | null;
}

export type SsoSignInOutcome = { ok: true; value: SsoSignInResult } | { ok: false; error: string };

export async function resolveSsoSignIn(
  store: SsoUserStore,
  authorization: SsoAuthorization,
): Promise<SsoSignInOutcome> {
  const bySubject = await store.findBySubject(authorization.subject);
  const existing = bySubject ?? (await store.findByEmail(authorization.email));

  if (!existing) {
    const user = await store.create({
      email: authorization.email,
      name: authorization.name,
      role: authorization.role,
      accent: pickAccent(authorization.email),
      externalId: authorization.subject,
    });
    return { ok: true, value: { user, provisioned: true, roleChanged: false, note: null } };
  }

  // A local switch off is final for this deployment: the directory's opinion that
  // somebody exists does not undo an administrator's decision that they may not
  // sign in here.
  if (!existing.active) {
    return { ok: false, error: "This account has been deactivated. Ask an administrator to re-enable it." };
  }

  // A rename at the provider is authoritative, but it may not silently take over
  // an account somebody else already holds — that would be one person signing in
  // as another.
  if (authorization.email !== existing.email) {
    const owner = await store.findByEmail(authorization.email);
    if (owner && owner.id !== existing.id) {
      return {
        ok: false,
        error: "The identity provider's address for this person already belongs to another account here.",
      };
    }
  }

  const decision = applySsoRole({
    current: existing.role,
    mapped: authorization.role,
    otherActiveAdmins: await store.countOtherActiveAdmins(existing.id),
    active: true,
  });

  const user = await store.update(existing.id, {
    email: authorization.email,
    name: authorization.name,
    role: decision.role,
    externalId: authorization.subject,
  });

  return {
    ok: true,
    value: {
      user,
      provisioned: false,
      roleChanged: decision.role !== existing.role,
      note: decision.note,
    },
  };
}

/**
 * The audit entries the SSO path appends.
 *
 * A successful sign-in is recorded as `auth.sso_sign_in` — which account, which
 * provider, and whether it provisioned — and a refusal as
 * `auth.sso_sign_in_denied` with the reason. A denied sign-in is exactly the
 * event an investigation looks for, so it is not swallowed.
 */
export function ssoSignInAudit(
  authorization: SsoAuthorization,
  result: SsoSignInResult,
  provider: string,
): SsoAuditEvent {
  return {
    actorId: result.user.id,
    action: "auth.sso_sign_in",
    targetType: "user",
    targetId: result.user.id,
    detail: {
      provider,
      provisioned: result.provisioned,
      mapped: authorization.mapped,
      role: result.user.role,
      ...(result.roleChanged ? { roleChanged: true } : {}),
      ...(result.note ? { note: result.note } : {}),
    },
  };
}

export function ssoDeniedAudit(provider: string, reason: string): SsoAuditEvent {
  return {
    actorId: null,
    action: "auth.sso_sign_in_denied",
    targetType: "user",
    targetId: "",
    // The address is deliberately absent: a refused sign-in must not write the
    // email somebody attempted into the trail. The reason is enough to act on.
    detail: { provider, reason },
  };
}
