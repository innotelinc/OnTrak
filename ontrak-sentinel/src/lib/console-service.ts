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
import {
  canManageIdentities,
  DEFAULT_IDENTITY_POLICY,
  policyForRole,
  toIdentityPolicy,
  type IdentityPolicy,
  type IdentityRole,
} from "./identity-rules";
import type { MfaService, MfaStatus } from "./mfa-service";
import type { OidcStore } from "./oidc-service";
import type { ScimService } from "./scim-service";
import type { WebAuthnRegistrationResponse } from "./webauthn-rules";
import type { WebAuthnRegistrationOptions, WebAuthnService } from "./webauthn-service";
import type {
  ConsoleActor,
  ConsoleConnectionView,
  ConsoleDirectoryView,
  ConsoleFactorView,
  ConsoleMfaView,
  ConsoleOverviewView,
  ConsolePoliciesView,
  ConsolePolicyView,
  ConsoleProvisioningView,
  ConsoleSessionView,
  ConsoleSyncReportView,
} from "./console-rules";
import { policyScopeTitle, policyScopes } from "./console-rules";
import type { DirectoryService } from "./directory-service";
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
    /**
     * The provisioning stack, for minting and revoking connector tokens.
     *
     * Note what this file does *not* do with it: it never lets a SCIM token mint
     * another one. `mintToken` is reached only from here, where the actor came from a
     * browser session, because a machine-facing API that could widen its own access
     * would have no ceiling.
     */
    private readonly scim: ScimService | null = null,
    /**
     * Reading a directory (S2). Absent in a deployment that has no reader configured, in
     * which case the page says so rather than offering a form that cannot work.
     */
    private readonly directories: DirectoryService | null = null,
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

  /* ------------------------------------------------------------- directories */

  async directory(sessionId: string): Promise<ServiceResult<ConsoleDirectoryView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.directories) return { ok: false, error: "This deployment reads no directories." };

    const [connections, runs, session] = await Promise.all([
      this.directories.connections(context.value.actor),
      this.directories.runs(context.value.actor),
      this.spine.resolveOwnSession(context.value.sessionId),
    ]);
    if (!connections.ok) return connections;
    if (!runs.ok) return runs;
    if (!session.ok) return session;

    const views: ConsoleConnectionView[] = connections.value.map((connection) => ({
      id: connection.id,
      name: connection.name,
      source: connection.source,
      url: connection.settings["url"] ?? "",
      conflictPolicy: connection.conflictPolicy,
      defaultRole: connection.defaultRole,
      hasSecret: connection.hasSecret,
      lastSyncedAt: connection.lastSyncedAt,
    }));

    return {
      ok: true,
      value: {
        actor: consoleActor(await this.organizationName(context.value), session.value.identity),
        session: sessionView(session.value.session),
        connections: views,
        sources: this.directories.sources(),
        runs: runs.value.slice(0, 10).map((run) => ({
          connectionId: run.connectionId,
          startedAt: run.startedAt,
          status: run.status,
          detail: run.detail,
        })),
      },
    };
  }

  async connectDirectory(
    sessionId: string,
    input: {
      name: string;
      source: string;
      settings: Record<string, string>;
      conflictPolicy: string;
      defaultRole: string;
      secret: string | null;
    },
  ): Promise<ServiceResult<{ name: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.directories) return { ok: false, error: "This deployment reads no directories." };

    const created = await this.directories.createConnection(context.value.actor, input);
    return created.ok ? { ok: true, value: { name: created.value.name } } : created;
  }

  async removeDirectory(sessionId: string, connectionId: string): Promise<ServiceResult<{ name: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.directories) return { ok: false, error: "This deployment reads no directories." };

    const listed = await this.directories.connections(context.value.actor);
    const name = listed.ok ? (listed.value.find((entry) => entry.id === connectionId)?.name ?? "that connection") : "that connection";
    const removed = await this.directories.removeConnection(context.value.actor, connectionId);
    return removed.ok ? { ok: true, value: { name } } : removed;
  }

  async syncDirectory(sessionId: string, connectionId: string, dryRun: boolean): Promise<ServiceResult<ConsoleSyncReportView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.directories) return { ok: false, error: "This deployment reads no directories." };

    const listed = await this.directories.connections(context.value.actor);
    const connection = listed.ok ? listed.value.find((entry) => entry.id === connectionId) : null;

    const result = await this.directories.sync(context.value.actor, connectionId, { dryRun });
    if (!result.ok) return result;

    return {
      ok: true,
      value: {
        connectionName: connection?.name ?? "this connection",
        dryRun: result.value.dryRun,
        detail: result.value.detail ?? "",
        changes: result.value.plan.changes.map((change) => ({ action: change.action, detail: change.detail })),
        skipped: result.value.plan.skipped,
      },
    };
  }

  /* --------------------------------------------------------------- policies */

  /**
   * The policy page: every scope, what is stored for it, and what it resolves to.
   *
   * The resolved number is computed through the *same* `policyForRole` a sign-in uses,
   * so the page cannot describe a policy the login path does not apply — the mistake
   * that would make this screen worse than no screen at all. The identity count is
   * read from the directory, because "who does this govern?" is the question somebody
   * has immediately before they change it.
   */
  async policies(sessionId: string): Promise<ServiceResult<ConsolePoliciesView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const [stored, identities, session] = await Promise.all([
      this.spine.policies(context.value.actor),
      this.spine.listIdentities(context.value.actor),
      this.spine.resolveOwnSession(context.value.sessionId),
    ]);
    if (!stored.ok) return stored;
    if (!identities.ok) return identities;
    if (!session.ok) return session;

    const baseline = stored.value.find((row) => row.scope === "ALL") ?? null;
    const byScope = new Map(stored.value.map((row) => [row.scope, row]));
    const effectiveFor = (scope: string): IdentityPolicy =>
      scope === "ALL"
        ? baseline
          ? toIdentityPolicy(baseline)
          : DEFAULT_IDENTITY_POLICY
        : policyForRole(stored.value, scope as IdentityRole);

    const policies: ConsolePolicyView[] = policyScopes().map((scope) => {
      const row = byScope.get(scope) ?? null;
      const effective = effectiveFor(scope);
      return {
        scope,
        title: policyScopeTitle(scope),
        stored: row
          ? {
              requireMfa: row.requireMfa,
              maxSessionSeconds: row.maxSessionSeconds,
              idleTimeoutSeconds: row.idleTimeoutSeconds,
              updatedAt: row.updatedAt,
            }
          : null,
        effective,
        identities:
          scope === "ALL"
            ? identities.value.length
            : identities.value.filter((identity) => identity.role === scope).length,
      };
    });

    return {
      ok: true,
      value: {
        actor: consoleActor(await this.organizationName(context.value), session.value.identity),
        session: sessionView(session.value.session),
        policies,
      },
    };
  }

  /** Write one scope's policy. The spine owns the permission and the validation. */
  async setPolicy(
    sessionId: string,
    input: { scope: string; requireMfa: boolean; maxSessionSeconds: number; idleTimeoutSeconds: number },
  ): Promise<ServiceResult<{ scope: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;

    const written = await this.spine.setPolicy(context.value.actor, input.scope, {
      requireMfa: input.requireMfa,
      maxSessionSeconds: input.maxSessionSeconds,
      idleTimeoutSeconds: input.idleTimeoutSeconds,
    });
    if (!written.ok) return written;
    return { ok: true, value: { scope: written.value.scope } };
  }

  /* ----------------------------------------------------------- provisioning */

  async provisioning(sessionId: string): Promise<ServiceResult<ConsoleProvisioningView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    return this.provisioningView(context.value);
  }

  async mintScimToken(
    sessionId: string,
    label: string | null,
  ): Promise<ServiceResult<{ view: ConsoleProvisioningView; plaintext: string; label: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.scim) return { ok: false, error: "This deployment has no provisioning stack configured." };

    const minted = await this.scim.mintToken(context.value.actor, label);
    if (!minted.ok) return minted;

    const view = await this.provisioningView(context.value);
    if (!view.ok) return view;
    return {
      ok: true,
      value: {
        view: view.value,
        plaintext: minted.value.plaintext,
        label: minted.value.token.label ?? "this connector",
      },
    };
  }

  async revokeScimToken(
    sessionId: string,
    tokenId: string,
  ): Promise<ServiceResult<{ view: ConsoleProvisioningView; label: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.scim) return { ok: false, error: "This deployment has no provisioning stack configured." };

    const revoked = await this.scim.revokeToken(context.value.actor, tokenId);
    if (!revoked.ok) return revoked;

    const view = await this.provisioningView(context.value);
    if (!view.ok) return view;
    return { ok: true, value: { view: view.value, label: revoked.value.label ?? "that token" } };
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

  /**
   * Assemble the provisioning page.
   *
   * The permission is checked *here* rather than on the page, so the refusal is the
   * same sentence the SCIM service would give an actor who could not mint a token:
   * one rule, asked once. A SERVICE identity — which the default policy would not even
   * let hold a session — has nothing to see here.
   */
  private async provisioningView(context: ConsoleContext): Promise<ServiceResult<ConsoleProvisioningView>> {
    if (!canManageIdentities(context.actor.role)) return { ok: false, error: "You do not administer identities." };
    if (!this.scim) return { ok: false, error: "This deployment has no provisioning stack configured." };

    const [tokens, groups, organization, session] = await Promise.all([
      this.scim.listTokens(context.actor),
      this.scim.listGroupsForActor(context.actor),
      this.spine.organization(context.actor),
      this.spine.resolveOwnSession(context.sessionId),
    ]);
    if (!tokens.ok) return tokens;
    if (!groups.ok) return groups;
    if (!organization.ok) return organization;
    if (!session.ok) return session;

    return {
      ok: true,
      value: {
        actor: consoleActor(organization.value, session.value.identity),
        session: sessionView(session.value.session),
        tokens: tokens.value.map((token) => ({
          id: token.id,
          label: token.label ?? token.tokenHash.slice(0, 8) + "…",
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
          revokedAt: token.revokedAt,
        })),
        groups: groups.value,
        scimBase: this.scim.baseUrl(),
      },
    };
  }

  /** The organization's display name, for the header every console page carries. */
  private async organizationName(context: ConsoleContext): Promise<{ name: string; slug: string }> {
    const organization = await this.spine.organization(context.actor);
    return organization.ok ? organization.value : { name: context.actor.organizationId, slug: "" };
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
