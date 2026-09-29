/**
 * Console service (S0/S1): the session-resolving, self-service half of the console.
 *
 * `console-rules.ts` builds the pages and `console-http.ts` moves the bytes; this
 * file answers two questions those two cannot answer on their own, and answers them
 * once each:
 *
 *  - **Who is this?** A browser holds one cookie and no organization, so the actor
 *    is resolved through `IdentityService.resolveOwnSession` — the same policy check
 *    authorize uses, from the organization stored on the session row. Every handler
 *    below starts here, so there is exactly one way into the console and it is the
 *    one that reads a session.
 *  - **What may they do to their own factors?** Nothing here checks a permission,
 *    and that is deliberate: `MfaService` and `WebAuthnService` already answer it,
 *    and an actor reaching this file *is* the subject. A permission check here would
 *    be a second copy of a rule, which is how two copies drift.
 *
 * The only thing this file decides is which of the two factor services a request
 * belongs to, and it says so in a switch rather than in a comment.
 */

import type { IdentityActor, IdentityService, ServiceResult } from "./identity-service";
import type { MfaService, MfaStatus } from "./mfa-service";
import type { OidcStore } from "./oidc-service";
import type { WebAuthnRegistrationResponse } from "./webauthn-rules";
import type { WebAuthnRegistrationOptions, WebAuthnService } from "./webauthn-service";
import type {
  ConsoleActor,
  ConsoleFactorView,
  ConsoleMfaView,
  ConsoleOverviewView,
  ConsoleSessionView,
} from "./console-rules";
import type { ConsoleEndpoints } from "./console-http";
import type { AuditEvent } from "./audit-chain";

/** What resolving a session gives every handler. */
interface ConsoleContext {
  actor: IdentityActor;
  sessionId: string;
  organizationId: string;
  identityId: string;
}

export class ConsoleService implements ConsoleEndpoints {
  constructor(
    private readonly spine: IdentityService,
    private readonly mfa: MfaService,
    /** Absent when a deployment has not configured WebAuthn. */
    private readonly webauthn: WebAuthnService | null = null,
    /**
     * Where the OIDC grant rows live, for one thing only: sign-out has to revoke the
     * access tokens the session minted. Ending the session alone leaves them live, and
     * a console sign-out that leaves a working token behind is not a sign-out.
     */
    private readonly tokens: Pick<OidcStore, "revokeTokensForSession"> | null = null,
  ) {}

  /* ------------------------------------------------------------ the pages */

  async overview(sessionId: string): Promise<ServiceResult<ConsoleOverviewView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const [mfa, session, organization] = await Promise.all([
      this.mfa.status(context.value.actor, context.value.identityId),
      this.spine.resolveOwnSession(context.value.sessionId),
      this.spine.organization(context.value.actor),
    ]);
    if (!mfa.ok) return mfa;
    if (!session.ok) return session;
    if (!organization.ok) return organization;

    // The trail is a directory read — an ADMIN, AGENT or AUDITOR may have it. A
    // SERVICE identity still gets the page, minus the evidence, rather than a
    // refusal that hides its own second-factor state.
    const trail = await this.spine.auditTrail(context.value.actor);

    return {
      ok: true,
      value: {
        actor: consoleActor(organization.value, session.value.identity),
        session: sessionView(session.value.session),
        enrolled: mfa.value.enrolled,
        factorCount: mfa.value.factors.length,
        events: trail.ok ? trail.value.events.map(summarizeEvent) : [],
        chainOk: trail.ok ? trail.value.verification.ok : false,
        chainLength: trail.ok ? (trail.value.verification.ok ? trail.value.verification.length : 0) : 0,
        chainDetail: trail.ok
          ? trail.value.verification.ok
            ? "The organization's evidence chain verifies end to end."
            : `The evidence chain is broken: ${trail.value.verification.reason}`
          : trail.error,
      },
    };
  }

  async mfaView(sessionId: string): Promise<ServiceResult<ConsoleMfaView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const status = await this.mfa.status(context.value.actor, context.value.identityId);
    if (!status.ok) return status;
    return { ok: true, value: await this.view(context.value, status.value, null) };
  }

  /* ------------------------------------------------------- authenticator app */

  /**
   * Mint a TOTP secret and show it, once.
   *
   * `beginEnrollment` discards a previous pending enrollment, so this is also the
   * "start over" the page offers when somebody mistyped the secret into their app.
   */
  async beginTotp(sessionId: string, label: string | null): Promise<ServiceResult<ConsoleMfaView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const begun = await this.mfa.beginEnrollment(context.value.actor, context.value.identityId, {
      account: context.value.actor.id,
      label,
    });
    if (!begun.ok) return begun;

    const status = await this.mfa.status(context.value.actor, context.value.identityId);
    if (!status.ok) return status;
    return {
      ok: true,
      value: await this.view(context.value, status.value, {
        secret: begun.value.secret,
        uri: begun.value.uri,
      }),
    };
  }

  async confirmTotp(sessionId: string, code: string): Promise<ServiceResult<ConsoleMfaView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const confirmed = await this.mfa.confirmEnrollment(context.value.actor, context.value.identityId, code);
    if (!confirmed.ok) return confirmed;

    const status = await this.mfa.status(context.value.actor, context.value.identityId);
    if (!status.ok) return status;
    return { ok: true, value: await this.view(context.value, status.value, null) };
  }

  /* ---------------------------------------------------------- security key */

  async beginWebAuthn(sessionId: string): Promise<ServiceResult<WebAuthnRegistrationOptions>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.webauthn) return { ok: false, error: "This deployment has no WebAuthn relying party configured." };
    return this.webauthn.registrationOptions(context.value.actor, context.value.identityId);
  }

  async finishWebAuthn(
    sessionId: string,
    input: { challengeId: string; label: string | null; response: WebAuthnRegistrationResponse },
  ): Promise<ServiceResult<{ credentialId: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.webauthn) return { ok: false, error: "This deployment has no WebAuthn relying party configured." };

    const finished = await this.webauthn.finishRegistration(context.value.actor, context.value.identityId, input.challengeId, {
      response: input.response,
      label: input.label,
      transports: input.response.transports,
    });
    if (!finished.ok) return finished;
    return { ok: true, value: { credentialId: finished.value.credential.credentialId } };
  }

  async removeCredential(sessionId: string, credentialId: string): Promise<ServiceResult<{ removed: number }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.webauthn) return { ok: false, error: "This deployment has no WebAuthn relying party configured." };

    const removed = await this.webauthn.removeCredential(context.value.actor, context.value.identityId, credentialId);
    if (!removed.ok) return removed;
    return { ok: true, value: { removed: removed.value.removed } };
  }

  /* ------------------------------------------------------------- lifecycle */

  async removeFactors(sessionId: string): Promise<ServiceResult<{ removed: number }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const removed = await this.mfa.removeEnrollment(context.value.actor, context.value.identityId);
    if (!removed.ok) return removed;
    return { ok: true, value: { removed: removed.value.removed } };
  }

  /**
   * Sign out of the console.
   *
   * The *same* call the OIDC end-session endpoint makes: the session is ended
   * through the spine and every token it minted is revoked. A console sign-out that
   * only cleared the cookie would leave a live session and live tokens behind — which
   * is what makes a shared laptop an incident.
   */
  async logout(sessionId: string): Promise<ServiceResult<{ revoked: number }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    // `endOwnSession`, not `revokeAllForIdentity`: this is a person ending their own
    // session, and holding the session id is the proof — requiring an administrator
    // would mean an agent could never sign out of the console.
    const ended = await this.spine.endOwnSession(
      context.value.organizationId,
      context.value.sessionId,
      "signed out of the console",
    );
    if (!ended.ok) return ended;

    const revoked = this.tokens
      ? await this.tokens.revokeTokensForSession(context.value.organizationId, context.value.sessionId, Date.now())
      : 0;
    return { ok: true, value: { revoked } };
  }

  /* ------------------------------------------------------------- internals */

  private async context(sessionId: string): Promise<ServiceResult<ConsoleContext>> {
    const resolved = await this.spine.resolveOwnSession(sessionId.trim());
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      value: {
        actor: { id: resolved.value.identity.id, organizationId: resolved.value.organizationId, role: resolved.value.identity.role },
        sessionId: resolved.value.session.id,
        organizationId: resolved.value.organizationId,
        identityId: resolved.value.identity.id,
      },
    };
  }

  /** Assemble the page's data, including the credential ids a key needs to be removed. */
  private async view(
    context: ConsoleContext,
    status: MfaStatus,
    pending: { secret: string; uri: string } | null,
  ): Promise<ConsoleMfaView> {
    const [organization, session, keys] = await Promise.all([
      this.spine.organization(context.actor),
      this.spine.resolveOwnSession(context.sessionId),
      this.webauthn ? this.webauthn.credentials(context.actor, context.identityId) : Promise.resolve(null),
    ]);
    if (!organization.ok) throw new Error(organization.error);
    if (!session.ok) throw new Error(session.error);

    const credentialIds = new Map((keys?.ok ? keys.value : []).map((key) => [key.factorId, key.credentialId]));
    const factors: ConsoleFactorView[] = status.factors.map((factor) => ({
      ...factor,
      credentialId: credentialIds.get(factor.id) ?? null,
    }));

    return {
      actor: consoleActor(organization.value, session.value.identity),
      session: sessionView(session.value.session),
      enrolled: status.enrolled,
      factors,
      pending,
      awaitingCode: factors.some((factor) => factor.kind === "TOTP" && !factor.confirmed),
      identityId: context.identityId,
    };
  }
}

function consoleActor(
  organization: { name: string; slug: string },
  identity: { identifier: string; displayName: string; role: string },
): ConsoleActor {
  return {
    identifier: identity.identifier,
    displayName: identity.displayName,
    role: identity.role,
    organizationName: organization.name,
    organizationSlug: organization.slug,
  };
}

function sessionView(session: { id: string; issuedAt: number; lastSeenAt: number; expiresAt: number }): ConsoleSessionView {
  return {
    id: session.id,
    issuedAt: new Date(session.issuedAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/** Only the columns the table shows; `detail` is not rendered, on purpose. */
function summarizeEvent(event: AuditEvent): ConsoleOverviewView["events"][number] {
  return {
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
  };
}
