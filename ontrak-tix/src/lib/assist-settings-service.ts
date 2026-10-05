/**
 * Per-tenant assist settings (M7): whether *this desk* has an assistant.
 *
 * The feature started behind a deployment-wide environment variable, which is the
 * wrong shape for an opt-in: on a deployment serving more than one tenant, one
 * desk switching suggestions on turned them on for everybody, and an operator had
 * to redeploy to change one customer's mind. The answer belongs to the tenant, so it
 * is stored with the tenant and read per request.
 *
 * There is exactly one setting, and it is a boolean, because the milestone's promise
 * is "an assistant appears only where it was asked for" — a desk either has one or it
 * does not. A missing row means the default, which is off: a tenant that has never
 * been to the screen has not opted in, and the safest reading of silence is the one
 * that puts no assistant in front of an agent.
 *
 * Turning it on or off is `tenant:manage`, the same weight as configuring the desk's
 * identity provider, and it is recorded on the per-tenant hash chain as
 * `assist.settings`. A read that fails is reported as *off* rather than propagated:
 * the question is only ever "should a button appear?", and failing closed costs a
 * desk a suggestion while failing open would put an assistant in front of one that
 * did not ask for it.
 */

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditSink } from "./audit-chain";
import type { ServiceResult } from "./ticket-service";

/** The persistence port. One boolean per tenant, defaulting to off. */
export interface AssistSettingsStore {
  get(tenantId: string): Promise<boolean>;
  set(tenantId: string, enabled: boolean): Promise<void>;
}

export interface AssistSettingsIds {
  eventId(): string;
  now(): string;
}

export interface AssistSettingsPorts {
  store: AssistSettingsStore;
  audit: AuditSink;
  ids: AssistSettingsIds;
}

export class AssistSettingsService {
  constructor(private readonly ports: AssistSettingsPorts) {}

  /** Whether this tenant has opted in. A read that fails is read as off. */
  async isEnabled(tenantId: string): Promise<boolean> {
    try {
      return await this.ports.store.get(tenantId);
    } catch {
      return false;
    }
  }

  /**
   * Turn the assistant on or off for this tenant.
   *
   * The audit event names the state it was *left in* rather than the one it replaced:
   * a chain is read forwards, and "assist.settings {enabled: true}" three events ago
   * answers "when did this desk get an assistant?" without replaying anything.
   */
  async setEnabled(actor: Actor, enabled: boolean): Promise<ServiceResult<boolean>> {
    if (!actorHasPermission(actor, "tenant:manage")) {
      return { ok: false, error: "You do not administer this desk." };
    }

    await this.ports.store.set(actor.tenantId, enabled);
    await this.ports.audit.append({
      id: this.ports.ids.eventId(),
      tenantId: actor.tenantId,
      at: this.ports.ids.now(),
      actor: actor.id,
      action: "assist.settings",
      targetType: "tenant",
      targetId: actor.tenantId,
      detail: { enabled },
    });
    return { ok: true, value: enabled };
  }
}

/**
 * An in-memory store, used by tests and by local development before a database
 * exists. Present with the service in the modules the tests exercise without Prisma.
 */
export class MemoryAssistSettingsStore implements AssistSettingsStore {
  private readonly enabled = new Map<string, boolean>();

  async get(tenantId: string): Promise<boolean> {
    return this.enabled.get(tenantId) ?? false;
  }

  async set(tenantId: string, value: boolean): Promise<void> {
    this.enabled.set(tenantId, value);
  }
}
