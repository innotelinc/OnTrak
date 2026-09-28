/**
 * Client branding service (M4): storing the identity a client is shown in, and
 * deciding who may change it.
 *
 * Two decisions, both about consequences rather than convenience:
 *
 *  - **Branding follows the client scope.** A client an agent cannot see is a
 *    client they cannot re-brand, so the guard is the same `ClientService.scope`
 *    every other read uses — branding is a way to speak as the client, and
 *    speaking as a client you do not serve is exactly what act-as exists to
 *    prevent.
 *  - **One row per client, replaced rather than accumulated.** A brand is a
 *    current fact, not a history; the history is the audit chain, which records
 *    what changed and who changed it. So saving overwrites, and the previous
 *    value is not kept in the table where it could be mistaken for the current
 *    one.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  brandFor,
  contrastRatio,
  normalizeHexColor,
  validateClientBranding,
  type Brand,
  type ClientBrandingRecord,
} from "./client-branding-rules";
import type { ClientService } from "./client-service";
import type { ServiceResult } from "./ticket-service";

export interface ClientBrandingStore {
  listForTenant(tenantId: string): Promise<ClientBrandingRecord[]>;
  findByClient(tenantId: string, clientId: string): Promise<ClientBrandingRecord | null>;
  upsert(record: ClientBrandingRecord): Promise<void>;
}

export interface BrandingIds {
  id(): string;
  now(): string;
}

export function systemBrandingIds(): BrandingIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface BrandingInput {
  displayName: string;
  accentColor: string;
  logoUrl?: string | null;
  supportEmail?: string | null;
  signature?: string | null;
}

/** What a page needs to render a client's own identity. */
export interface BrandingView {
  clientId: string;
  clientName: string;
  brand: Brand;
  /** The stored row, or `null` when the client is shown in the desk's identity. */
  branding: ClientBrandingRecord | null;
  /** The contrast of the accent on the portal background, for the console. */
  contrast: number;
}

export class ClientBrandingService {
  constructor(
    private readonly store: ClientBrandingStore,
    private readonly clients: ClientService,
    private readonly audit: AuditSink | null = null,
    private readonly ids: BrandingIds = systemBrandingIds(),
  ) {}

  /** The branding in force for every client the actor can see. */
  async list(actor: Actor): Promise<ServiceResult<BrandingView[]>> {
    const known = await this.clients.list(actor);
    if (!known.ok) return known;

    const rows = await this.store.listForTenant(actor.tenantId);
    const byClient = new Map(rows.map((row) => [row.clientId, row]));

    return {
      ok: true,
      value: known.value.map((entry) => viewFor(entry.client, byClient.get(entry.client.id) ?? null)),
    };
  }

  /** The branding in force for one client, whether or not it has its own. */
  async for(actor: Actor, clientId: string): Promise<ServiceResult<BrandingView>> {
    const visible = await this.visible(actor, clientId);
    if (!visible.ok) return visible;
    const row = await this.store.findByClient(actor.tenantId, clientId);
    return { ok: true, value: viewFor(visible.value, row) };
  }

  /**
   * The branding for a client with no actor: the public survey page is answered
   * by somebody who holds a token and has no account, and it still has to look
   * like the client's supplier. Deliberately a separate, narrower entry point
   * than the actor-scoped one above, so the unauthenticated path can never reach
   * a list of clients.
   */
  async forToken(tenantId: string, clientId: string, clientName: string): Promise<Brand> {
    const row = await this.store.findByClient(tenantId, clientId);
    return brandFor({ name: clientName }, row);
  }

  async save(actor: Actor, clientId: string, input: BrandingInput): Promise<ServiceResult<ClientBrandingRecord>> {
    const visible = await this.visible(actor, clientId);
    if (!visible.ok) return visible;
    if (!hasPermission(actor.role, "client:manage")) {
      return { ok: false, error: "You do not manage clients." };
    }

    const issues = validateClientBranding(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.findByClient(actor.tenantId, clientId);
    const record: ClientBrandingRecord = {
      id: existing?.id ?? this.ids.id(),
      tenantId: actor.tenantId,
      clientId,
      displayName: input.displayName.trim(),
      accentColor: normalizeHexColor(input.accentColor) ?? input.accentColor.trim().toLowerCase(),
      logoUrl: input.logoUrl?.trim() ? input.logoUrl.trim() : null,
      supportEmail: input.supportEmail?.trim() ? input.supportEmail.trim() : null,
      signature: input.signature?.trim() ? input.signature.trim() : null,
      updatedBy: actor.id,
      updatedAt: this.ids.now(),
      createdAt: existing?.createdAt ?? this.ids.now(),
    };

    await this.store.upsert(record);
    await this.append(actor, existing ? "client.branding.update" : "client.branding.create", clientId, {
      displayName: record.displayName,
      accentColor: record.accentColor,
      hasLogo: record.logoUrl !== null,
      supportEmail: record.supportEmail,
      contrast: contrastRatio(record.accentColor, "#0b0d10"),
      previous: existing ? { displayName: existing.displayName, accentColor: existing.accentColor } : null,
    });
    return { ok: true, value: record };
  }

  private async visible(actor: Actor, clientId: string): Promise<ServiceResult<{ id: string; name: string }>> {
    const known = await this.clients.list(actor);
    if (!known.ok) return known;
    const entry = known.value.find((candidate) => candidate.client.id === clientId);
    if (!entry) return { ok: false, error: "Client not found." };
    return { ok: true, value: { id: entry.client.id, name: entry.client.name } };
  }

  private async append(actor: Actor, action: string, clientId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "client",
      targetId: clientId,
      detail,
    };
    await this.audit.append(event);
  }
}

function viewFor(client: { id: string; name: string }, row: ClientBrandingRecord | null): BrandingView {
  const brand = brandFor(client, row);
  return {
    clientId: client.id,
    clientName: client.name,
    brand,
    branding: row,
    contrast: contrastRatio(brand.accentColor, "#0b0d10"),
  };
}

/** An in-memory store, used by tests and local development. */
export class MemoryClientBrandingStore implements ClientBrandingStore {
  private readonly rows = new Map<string, ClientBrandingRecord>();

  async listForTenant(tenantId: string): Promise<ClientBrandingRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((row) => structuredClone(row));
  }

  async findByClient(tenantId: string, clientId: string): Promise<ClientBrandingRecord | null> {
    const found = [...this.rows.values()].find((row) => row.clientId === clientId && row.tenantId === tenantId);
    return found ? structuredClone(found) : null;
  }

  async upsert(record: ClientBrandingRecord): Promise<void> {
    this.rows.set(record.clientId, structuredClone(record));
  }
}
