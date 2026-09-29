/**
 * Outbound sync (M2): the desk pushes its people to the identity provider.
 *
 * The plan is a pure function in `scim-rules.ts` and the transport is a seam in
 * `scim-client.ts`; this service is the part that decides *whose* people, in what
 * order, and what is recorded. It shares the ticket stack's audit sink, so a
 * person appearing at the provider joins the same per-tenant hash chain as the
 * ticket that put them in the desk's history.
 *
 * Two behaviours worth stating:
 *
 *  - **One person's failure does not abandon the run.** A provider that refuses a
 *    duplicate user name has told us about *that* person; stopping there would
 *    leave everybody after them unsynced, and an alphabetical accident would
 *    decide who exists. Every failure is collected and reported with the
 *    provider's own words.
 *  - **Only applied changes are audited.** A `NOOP` is not an event: a sync that
 *    recorded "nothing happened" a hundred times would bury the one entry that
 *    matters.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import type { IdentityUser } from "./identity-service";
import type { ScimClient, ScimRequestError } from "./scim-client";
import {
  deskPerson,
  planScimPush,
  type DeskPerson,
  type ScimPush,
  type ScimPushAction,
} from "./scim-rules";
import type { ServiceResult } from "./ticket-service";

/** The accounts a sync run pushes: the desk's people for one tenant. */
export interface ScimPeopleSource {
  listUsers(tenantId: string): Promise<IdentityUser[]>;
}

export interface ScimPushOutcome {
  email: string;
  action: ScimPushAction;
  reason: string;
}

export interface ScimSyncOutcome {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  unchanged: number;
  pushed: ScimPushOutcome[];
  failures: { email: string; reason: string }[];
}

export interface ScimSyncIds {
  now(): string;
}

export function systemScimSyncIds(): ScimSyncIds {
  return { now: () => new Date().toISOString() };
}

export class ScimSyncService {
  constructor(
    private readonly people: ScimPeopleSource,
    private readonly client: ScimClient | null,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ScimSyncIds = systemScimSyncIds(),
  ) {}

  /** Whether this deployment has somewhere to push to at all. */
  configured(): boolean {
    return this.client !== null;
  }

  /**
   * Push every account a tenant holds, on behalf of somebody who asked.
   *
   * The permission check is here rather than in the console's action because a
   * server action is not the only caller — and the check has to be where the
   * write is, not where the button is.
   */
  async push(actor: Actor): Promise<ServiceResult<ScimSyncOutcome>> {
    if (!hasPermission(actor.role, "tenant:manage")) {
      return { ok: false, error: "You cannot provision identities for this tenant." };
    }
    return this.pushTenant(actor.tenantId);
  }

  /**
   * Push one tenant's people, with no caller to check.
   *
   * This is what the scheduler calls: a cron has no session to authorize, the
   * deployment's own configuration is what decides whether it may run at all, and
   * every change it makes is audited as `system:scim-sync` — so the trail still
   * names whom the write is attributable to.
   *
   * The lookup is two queries per person and that is deliberate: `externalId`
   * first, because it is the key that survives somebody changing their address,
   * and `userName` second, so a provider that was populated before this
   * deployment ever synced is adopted rather than duplicated.
   */
  async pushTenant(tenantId: string): Promise<ServiceResult<ScimSyncOutcome>> {
    if (!this.client) {
      return { ok: false, error: "This deployment has no outbound identity provider configured." };
    }

    const users = await this.people.listUsers(tenantId);
    const outcome: ScimSyncOutcome = {
      total: users.length,
      created: 0,
      updated: 0,
      deactivated: 0,
      unchanged: 0,
      pushed: [],
      failures: [],
    };

    for (const user of users) {
      const person = deskPerson(user);
      try {
        const existing =
          (await this.client.findByExternalId(person.id)) ?? (await this.client.findByUserName(person.email));
        const plan = planScimPush(person, existing);
        await this.apply(person, existing, plan);

        if (plan.action === "NOOP") outcome.unchanged += 1;
        else {
          if (plan.action === "CREATE") outcome.created += 1;
          if (plan.action === "REPLACE") outcome.updated += 1;
          if (plan.action === "DEACTIVATE") outcome.deactivated += 1;
          outcome.pushed.push({ email: person.email, action: plan.action, reason: plan.reason });
          if (this.audit) {
            await this.audit.append(scimPushAudit(tenantId, person, plan, outcome.pushed.length, this.ids.now()));
          }
        }
      } catch (error) {
        outcome.failures.push({
          email: person.email,
          reason: messageFor(error),
        });
      }
    }

    return { ok: true, value: outcome };
  }

  private async apply(
    person: DeskPerson,
    existing: { id: string } | null,
    plan: ScimPush,
  ): Promise<void> {
    if (!this.client) return;
    switch (plan.action) {
      case "CREATE":
        await this.client.create(person);
        return;
      case "REPLACE":
        if (existing) await this.client.replace(existing.id, person);
        return;
      case "DEACTIVATE":
        if (existing) await this.client.deactivate(existing.id);
        return;
      case "NOOP":
        return;
    }
  }
}

/** A refusal's own sentence, when the provider gave one. */
function messageFor(error: unknown): string {
  const request = error as Partial<ScimRequestError> | null;
  if (request && typeof request.message === "string") return request.message;
  return error instanceof Error ? error.message : "The identity provider refused the request.";
}

/**
 * One applied push, on the evidence chain.
 *
 * The action is `identity.scim.push` — distinct from `identity.scim.provision`,
 * which records the *inbound* direction. Reading the trail, the two are the two
 * halves of one conversation, and an investigation wants to see which side spoke.
 */
export function scimPushAudit(
  tenantId: string,
  person: DeskPerson,
  plan: ScimPush,
  sequence: number,
  at: string,
): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId,
    at,
    actor: "system:scim-sync",
    action: "identity.scim.push",
    targetType: "user",
    targetId: person.id,
    detail: { action: plan.action, email: person.email, reason: plan.reason, sequence },
  };
}
