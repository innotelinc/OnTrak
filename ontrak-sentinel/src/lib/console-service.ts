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
  ConsoleSignInView,
  ConsoleActor,
  ConsoleConnectionView,
  ConsoleDirectoryView,
  ConsoleFactorView,
  ConsoleFeedReportView,
  ConsoleIntelView,
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
import type { ThreatIntelService } from "./threat-intel-service";
import { isActive, parseFeedLines } from "./threat-intel-rules";
import type { ConsoleEndpoints } from "./console-http";
import type { AuditEvent } from "./audit-chain";
import type { SignInService } from "./sign-in-service";
import type { SignInInput } from "./sign-in-rules";

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
     * The login, when this deployment has one.
     *
     * Optional, and left that way, so a deployment that has not configured a console
     * password still starts and still serves the OIDC endpoints — the console then
     * says plainly that sign-in is not configured rather than 404ing at `/` or, worse,
     * letting somebody in. Sentinel is an identity provider first and a console
     * second; the order matters when the two disagree.
     */
    private readonly signInService: Pick<SignInService, "signIn"> | null = null,
    /**
     * The organization the console signs into, when it serves exactly one.
     *
     * `null` means "ask", which is the honest answer for a console that could serve
     * several: an email address is unique within an organization, not across them.
     */
    private readonly signInOrganization: string | null = null,
    /**
     * Reading a directory (S2). Absent in a deployment that has no reader configured, in
     * which case the page says so rather than offering a form that cannot work.
     */
    private readonly directories: DirectoryService | null = null,
    /**
     * The indicators this organization matches against (S3). Absent in a deployment that
     * has configured no feed, in which case the page says so rather than offering a box that
     * would accept a paste and then silently match nothing.
     */
    private readonly threatIntel: ThreatIntelService | null = null,
  ) {}

  /* ------------------------------------------------------------ sign in */

  /**
   * The sign-in page shows one thing that depends on the deployment: whether it names
   * a workspace. Nothing here reads an account, so the page is safe to render for an
   * unknown visitor.
   */
  async signInView(): Promise<ServiceResult<ConsoleSignInView>> {
    return { ok: true, value: { identifier: null, organization: this.signInOrganization, error: null, flash: null } };
  }

  /**
   * The login itself, delegated to `SignInService`.
   *
   * The console adds one thing: the deployment's default workspace, when the form did
   * not carry one. Everything else — the single failure sentence, the order of the
   * password and the factor, the audit entries — belongs to the sign-in service, and
   * duplicating any of it here is how a second, subtly different login appears.
   */
  async signIn(input: SignInInput): Promise<ServiceResult<{ sessionId: string; redirectTo: string }>> {
    if (!this.signInService) {
      return {
        ok: false,
        error:
          "Console sign-in is not configured on this deployment (set SENTINEL_ADMIN_PASSWORD and restart). " +
          "The console is still reached with a session minted by the OIDC flow.",
      };
    }
    const organization = (input.organization ?? "").trim() || this.signInOrganization || undefined;
    const result = await this.signInService.signIn({ ...input, organization });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, value: { sessionId: result.value.sessionId, redirectTo: result.value.redirectTo } };
  }

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

  /* ------------------------------------------------------- threat intelligence */

  async intel(sessionId: string): Promise<ServiceResult<ConsoleIntelView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    return this.intelView(context.value, null);
  }

  /**
   * Take a paste of feed text.
   *
   * The line format is read here rather than in the HTTP layer for the usual reason —
   * `console-http.ts` moves bytes — and for one specific one: a line the *format* refused and
   * a row the *classifier* refused belong in the same list on the page, in the order they
   * appear in the box, or an operator reconciling a 400-line feed has to diff two tables.
   * The format’s own refusals are therefore folded into the ingest report before the page
   * sees it.
   *
   * The feed's name is required *here*, before anything is parsed, so a blank name is one
   * sentence rather than one refusal per row. It is then stamped onto every row, because the
   * box asked for it once and a source that had to be repeated per line is a source somebody
   * would forget on line 300.
   */
  async ingestIntel(
    sessionId: string,
    input: { source: string; text: string },
  ): Promise<ServiceResult<ConsoleIntelView>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.threatIntel) return { ok: false, error: "This deployment has no threat intelligence feeds configured." };

    const source = input.source.trim();
    if (!source) {
      return {
        ok: false,
        error: "Name the feed these indicators came from. Provenance is what makes one withdrawable when the feed is wrong.",
      };
    }

    const parsed = parseFeedLines(input.text);
    if (parsed.rows.length === 0 && parsed.issues.length === 0) {
      return { ok: false, error: "Nothing to add: the box held no indicator." };
    }

    const ingested = await this.threatIntel.ingest(
      context.value.actor,
      parsed.rows.map((row) => ({ ...row, source })),
    );
    if (!ingested.ok) return ingested;

    return this.intelView(context.value, {
      accepted: ingested.value.accepted,
      updated: ingested.value.updated,
      rejected: [
        ...parsed.issues.map((issue) => ({ value: issue.raw, reason: `line ${issue.line}: ${issue.reason}` })),
        ...ingested.value.rejected,
      ],
    });
  }

  /**
   * Withdraw one indicator.
   *
   * Returns what was withdrawn rather than the refreshed page, because the caller redirects:
   * a withdrawal is a state change, and a state change that answers with a body re-runs on a
   * refresh. The flash names the value, so the audit entry and the sentence agree.
   */
  async withdrawIntel(
    sessionId: string,
    indicatorId: string,
  ): Promise<ServiceResult<{ value: string; source: string }>> {
    const context = await this.context(sessionId);
    if (!context.ok) return context;
    if (!this.threatIntel) return { ok: false, error: "This deployment has no threat intelligence feeds configured." };

    const withdrawn = await this.threatIntel.withdraw(context.value.actor, indicatorId);
    if (!withdrawn.ok) return withdrawn;
    return { ok: true, value: { value: withdrawn.value.value, source: withdrawn.value.source } };
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

  /**
   * Assemble the feed page.
   *
   * Two reads rather than one: the list is what the page renders, and the counts are what a
   * deployment checks. They come from the same service so they cannot disagree about what an
   * active indicator is — a page whose footer says "12 usable" above a table with nine live
   * rows is a page nobody trusts again.
   *
   * Expiry is applied to the *rendered* rows with the same `isActive` the matcher uses, at
   * this request's instant, so an expired row is visibly expired rather than quietly absent.
   * A list that hid them would leave an operator unable to find what to withdraw.
   */
  private async intelView(
    context: ConsoleContext,
    report: ConsoleFeedReportView | null,
  ): Promise<ServiceResult<ConsoleIntelView>> {
    if (!this.threatIntel) return { ok: false, error: "This deployment has no threat intelligence feeds configured." };

    const [stats, rows, session] = await Promise.all([
      this.threatIntel.stats(context.actor),
      this.threatIntel.list(context.actor),
      this.spine.resolveOwnSession(context.sessionId),
    ]);
    if (!stats.ok) return stats;
    if (!rows.ok) return rows;
    if (!session.ok) return session;

    const at = Date.now();
    return {
      ok: true,
      value: {
        actor: consoleActor(await this.organizationName(context), session.value.identity),
        session: sessionView(session.value.session),
        stats: stats.value,
        indicators: rows.value.map((row) => ({
          id: row.id,
          kind: row.kind,
          value: row.value,
          source: row.source,
          confidence: row.confidence,
          severity: row.severity,
          labels: [...row.labels],
          firstSeenAt: new Date(row.firstSeenAt).toISOString(),
          expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
          active: isActive(row, at),
        })),
        report,
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
