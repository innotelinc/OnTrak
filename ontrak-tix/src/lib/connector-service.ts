/**
 * Connector marketplace service (M6): installing a connector, and routing an
 * event to the ones that asked for it.
 *
 * `connector-rules.ts` decides everything — what a manifest may say, whether a
 * config would install, who hears an event. This file carries those decisions out
 * and writes the three things that must outlive the request: the installation row,
 * an audit event per change, and the outcome of a dispatch.
 *
 * Five choices worth stating out loud:
 *
 *  - **Installing is `tenant:manage`.** A connector decides where a customer's
 *    ticket subject and a desk's alert stream go, which is the same authority a
 *    webhook endpoint or a chat channel already needs. It is not handed to agents.
 *  - **Config is validated before it is stored, in both directions.** A blank
 *    required field and a key the manifest does not declare are both refused
 *    (`validateInstallation`) — never saved and hoped about — because a connector
 *    missing its endpoint fails silently at the first event.
 *  - **A secret never reaches the audit trail.** The chain records which fields were
 *    set and which of them are secrets (`auditConfigSummary`), never a value. A chain
 *    entry is a document that outlives the deployment, and a credential inside the
 *    evidence is a liability, not a record.
 *  - **Config values are never echoed back**, so a caller or a handler cannot
 *    accidentally log one.
 *  - **Dispatch is a query over authority, not a list.** The connectors that hear an
 *    event are the enabled installations whose manifest declares the capability, at
 *    that moment — so enabling one takes effect on the next event with nothing to
 *    re-register.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  MASKED_VALUE,
  auditConfigSummary,
  installationsForCapability,
  maskConfig,
  validateInstallation,
  type ConnectorCapability,
  type ConnectorDispatchContext,
  type ConnectorDispatchOutcome,
  type ConnectorHandler,
  type ConnectorInstallationRecord,
  type ConnectorManifest,
  type ConnectorRegistry,
} from "./connector-rules";
import type { ServiceResult } from "./ticket-service";

/* -------------------------------------------------------------------------- */
/*  The ports                                                                 */
/* -------------------------------------------------------------------------- */

export interface ConnectorStore {
  find(tenantId: string, connectorId: string): Promise<ConnectorInstallationRecord | null>;
  findById(tenantId: string, id: string): Promise<ConnectorInstallationRecord | null>;
  list(tenantId: string): Promise<ConnectorInstallationRecord[]>;
  insert(record: ConnectorInstallationRecord): Promise<void>;
  update(record: ConnectorInstallationRecord): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
}

export interface ConnectorIds {
  id(): string;
  now(): string;
}

export function systemConnectorIds(): ConnectorIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/* -------------------------------------------------------------------------- */
/*  Catalog view                                                              */
/* -------------------------------------------------------------------------- */

/** One row a console renders: the manifest, this desk's installation, and the masked config. */
export interface CatalogEntry {
  manifest: ConnectorManifest;
  installation: ConnectorInstallationRecord | null;
  /** The config as it may be shown — secrets masked, blanks omitted. */
  shownConfig: Record<string, string>;
}

/** The catalog, split the way a console shows it: installed, installable, built-in. */
export function catalogSections(entries: readonly CatalogEntry[]): {
  installed: CatalogEntry[];
  available: CatalogEntry[];
  builtin: CatalogEntry[];
} {
  return {
    installed: entries.filter((entry) => entry.installation !== null),
    available: entries.filter((entry) => entry.installation === null && !entry.manifest.builtin),
    builtin: entries.filter((entry) => entry.installation === null && entry.manifest.builtin),
  };
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

/** What one capability produced, per installation that heard it. */
export interface DispatchOutcome {
  connectorId: string;
  installationId: string;
  outcome: ConnectorDispatchOutcome;
}

export interface DispatchReport {
  capability: ConnectorCapability;
  delivered: DispatchOutcome[];
  /** Installations with no handler — a registration bug, reported rather than hidden. */
  unanswered: DispatchOutcome[];
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class ConnectorService {
  constructor(
    private readonly store: ConnectorStore,
    private readonly registry: ConnectorRegistry,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ConnectorIds = systemConnectorIds(),
  ) {}

  /**
   * Everything this desk could connect, with what it has already connected.
   *
   * Built-ins are included but always appear uninstalled: they are configured on
   * their own consoles (`managePath`) and a row here would be a second source of
   * truth for the same endpoint.
   */
  async catalog(tenantId: string): Promise<CatalogEntry[]> {
    const installed = await this.store.list(tenantId);
    const byId = new Map(installed.map((record) => [record.connectorId, record]));
    return this.registry.list().map((manifest) => {
      const installation = byId.get(manifest.id) ?? null;
      return {
        manifest,
        installation,
        shownConfig: installation ? maskConfig(manifest, installation.config) : {},
      };
    });
  }

  /** One installation, for a console that names it. */
  async installation(tenantId: string, id: string): Promise<ConnectorInstallationRecord | null> {
    return this.store.findById(tenantId, id);
  }

  /** Install a third-party connector with its config. Built-ins are refused. */
  async install(
    actor: Actor,
    input: { connectorId: string; config?: Record<string, unknown>; enabled?: boolean },
  ): Promise<ServiceResult<ConnectorInstallationRecord>> {
    if (!actorHasPermission(actor, "tenant:manage")) {
      return { ok: false, error: "You do not manage connectors." };
    }

    const manifest = this.registry.get(input.connectorId.trim());
    if (!manifest) {
      return { ok: false, error: `There is no “${input.connectorId}” connector in the catalog.` };
    }
    if (manifest.builtin) {
      return {
        ok: false,
        error: manifest.managePath
          ? `${manifest.name} is configured on its own screen (${manifest.managePath}), not installed here.`
          : `${manifest.name} is configured by the deployment, not installed here.`,
      };
    }

    const existing = await this.store.find(actor.tenantId, manifest.id);
    if (existing) {
      return { ok: false, error: `${manifest.name} is already installed for this desk — change its settings instead.` };
    }

    const config = cleanConfig(manifest, input.config ?? {});
    const issues = validateInstallation(manifest, config);
    if (issues.length > 0) return { ok: false, error: issues.map((issue) => issue.message).join(" ") };

    const now = this.ids.now();
    const enabled = input.enabled ?? true;
    const record: ConnectorInstallationRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      connectorId: manifest.id,
      config,
      enabled,
      installedBy: actor.id,
      installedAt: now,
      updatedAt: now,
      disabledAt: enabled ? null : now,
    };
    await this.store.insert(record);
    await this.append(actor, "connector.install", record, {
      name: manifest.name,
      ...auditConfigSummary(manifest, config),
    });
    return { ok: true, value: record };
  }

  /**
   * Replace an installation's config. The connector it points at cannot change.
   *
   * **A blank field means "keep", not "clear".** The console cannot re-post a
   * secret it never showed — it holds a placeholder — so the only useful semantics
   * for an edit that does not mention a field is to leave it as it was. A required
   * field therefore cannot be emptied, which is correct: a connector missing its
   * endpoint is one that fails at the first event. An unknown key is still refused.
   */
  async configure(
    actor: Actor,
    installationId: string,
    config: Record<string, unknown>,
  ): Promise<ServiceResult<ConnectorInstallationRecord>> {
    if (!actorHasPermission(actor, "tenant:manage")) {
      return { ok: false, error: "You do not manage connectors." };
    }
    const current = await this.store.findById(actor.tenantId, installationId);
    if (!current) return { ok: false, error: "No such connector installation." };

    const manifest = this.registry.get(current.connectorId);
    if (!manifest) {
      return { ok: false, error: `The “${current.connectorId}” connector is no longer in the catalog.` };
    }

    const submitted = config ?? {};
    const unknown = Object.keys(submitted).find(
      (key) => !manifest.configFields.some((field) => field.key === key),
    );
    if (unknown) {
      return { ok: false, error: `“${unknown}” is not a setting the ${manifest.name} connector has.` };
    }

    const merged: Record<string, string> = { ...current.config };
    for (const field of manifest.configFields) {
      const value = asText(submitted[field.key]);
      // The masked placeholder is what a blank-looking secret field renders as; either
      // way, the stored value stays.
      if (value === "" || value === MASKED_VALUE) continue;
      merged[field.key] = value;
    }
    const next = cleanConfig(manifest, merged);
    const issues = validateInstallation(manifest, next);
    if (issues.length > 0) return { ok: false, error: issues.map((issue) => issue.message).join(" ") };

    const updated: ConnectorInstallationRecord = { ...current, config: next, updatedAt: this.ids.now() };
    await this.store.update(updated);
    await this.append(actor, "connector.configure", updated, {
      name: manifest.name,
      ...auditConfigSummary(manifest, next),
    });
    return { ok: true, value: updated };
  }

  /** Turn an installation on. Its config was validated when it was written. */
  async enable(actor: Actor, installationId: string): Promise<ServiceResult<ConnectorInstallationRecord>> {
    return this.setEnabled(actor, installationId, true);
  }

  /** Turn an installation off, keeping its config for the moment it comes back. */
  async disable(actor: Actor, installationId: string): Promise<ServiceResult<ConnectorInstallationRecord>> {
    return this.setEnabled(actor, installationId, false);
  }

  /** Remove an installation entirely. The audit chain keeps the history. */
  async remove(actor: Actor, installationId: string): Promise<ServiceResult<{ removed: boolean }>> {
    if (!actorHasPermission(actor, "tenant:manage")) {
      return { ok: false, error: "You do not manage connectors." };
    }
    const current = await this.store.findById(actor.tenantId, installationId);
    if (!current) return { ok: false, error: "No such connector installation." };

    const manifest = this.registry.get(current.connectorId);
    await this.store.remove(actor.tenantId, installationId);
    await this.append(actor, "connector.remove", current, {
      name: manifest?.name ?? current.connectorId,
    });
    return { ok: true, value: { removed: true } };
  }

  /** Hand an event to every enabled installation that declared the capability. */
  async dispatch(input: {
    tenantId: string;
    capability: ConnectorCapability;
    payload: unknown;
  }): Promise<DispatchReport> {
    const installations = await this.store.list(input.tenantId);
    const chosen = installationsForCapability(
      installations,
      (id) => this.registry.get(id),
      input.capability,
    );

    const delivered: DispatchOutcome[] = [];
    const unanswered: DispatchOutcome[] = [];

    for (const installation of chosen) {
      const handler = this.registry.handler(installation.connectorId);
      if (!handler) {
        // A connector that declares a capability but has no handler is a
        // registration mistake. Reported, not swallowed: the alternative is an
        // event that "went to" a connector which does nothing.
        unanswered.push({
          connectorId: installation.connectorId,
          installationId: installation.id,
          outcome: { ok: false, error: `No handler is registered for “${installation.connectorId}”.` },
        });
        continue;
      }
      const context: ConnectorDispatchContext = {
        tenantId: input.tenantId,
        installation,
        at: this.ids.now(),
      };
      delivered.push({
        connectorId: installation.connectorId,
        installationId: installation.id,
        outcome: await runHandler(handler, input.payload, context),
      });
    }

    return { capability: input.capability, delivered, unanswered };
  }

  private async setEnabled(
    actor: Actor,
    installationId: string,
    enabled: boolean,
  ): Promise<ServiceResult<ConnectorInstallationRecord>> {
    if (!actorHasPermission(actor, "tenant:manage")) {
      return { ok: false, error: "You do not manage connectors." };
    }
    const current = await this.store.findById(actor.tenantId, installationId);
    if (!current) return { ok: false, error: "No such connector installation." };

    // Turning one on whose connector has left the catalog would route events at
    // something that cannot answer, so that is refused rather than allowed to fail
    // silently later. Turning one *off* always works — removing authority never
    // needs the catalog's permission.
    if (enabled && !this.registry.get(current.connectorId)) {
      return { ok: false, error: `The “${current.connectorId}” connector is no longer in the catalog.` };
    }

    const now = this.ids.now();
    const updated: ConnectorInstallationRecord = {
      ...current,
      enabled,
      disabledAt: enabled ? null : now,
      updatedAt: now,
    };
    await this.store.update(updated);
    await this.append(actor, enabled ? "connector.enable" : "connector.disable", updated, {
      name: this.registry.get(current.connectorId)?.name ?? current.connectorId,
    });
    return { ok: true, value: updated };
  }

  private async append(
    actor: Actor,
    action: string,
    record: ConnectorInstallationRecord,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "connector",
      // The connector, not the installation: an install can be removed and a new one
      // created, and the chain should read as the connector's history either way.
      targetId: record.connectorId,
      detail: {
        installationId: record.id,
        enabled: record.enabled,
        ...detail,
      },
    };
    await this.audit.append(event);
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** One dispatch, with a throwing handler kept from taking the caller down with it. */
async function runHandler(
  handler: ConnectorHandler,
  payload: unknown,
  context: ConnectorDispatchContext,
): Promise<ConnectorDispatchOutcome> {
  try {
    return await handler(payload, context);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The connector threw while handling the event.",
    };
  }
}

/**
 * Drop undeclared keys and blank values, keeping only a declared key's text.
 *
 * `validateInstallation` has already refused unknown keys by the time this runs, so
 * this is not a second gate — it is the other half of one: what gets stored is
 * exactly what the rules judged, with a blank meaning "not set" rather than a
 * present-but-empty value that masks a missing setting.
 */
export function cleanConfig(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const field of manifest.configFields) {
    const value = asText(config[field.key]);
    if (value !== "") clean[field.key] = value;
  }
  return clean;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                    */
/* -------------------------------------------------------------------------- */

export class MemoryConnectorStore implements ConnectorStore {
  private readonly records = new Map<string, ConnectorInstallationRecord>();

  private key(tenantId: string, connectorId: string): string {
    return `${tenantId}\u0000${connectorId}`;
  }

  async find(tenantId: string, connectorId: string): Promise<ConnectorInstallationRecord | null> {
    return this.records.get(this.key(tenantId, connectorId)) ?? null;
  }

  async findById(tenantId: string, id: string): Promise<ConnectorInstallationRecord | null> {
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.id === id) return record;
    }
    return null;
  }

  async list(tenantId: string): Promise<ConnectorInstallationRecord[]> {
    return [...this.records.values()].filter((record) => record.tenantId === tenantId);
  }

  async insert(record: ConnectorInstallationRecord): Promise<void> {
    this.records.set(this.key(record.tenantId, record.connectorId), record);
  }

  async update(record: ConnectorInstallationRecord): Promise<void> {
    this.records.set(this.key(record.tenantId, record.connectorId), record);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    for (const [key, record] of this.records.entries()) {
      if (record.tenantId === tenantId && record.id === id) {
        this.records.delete(key);
        return;
      }
    }
  }
}
