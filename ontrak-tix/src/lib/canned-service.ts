/**
 * Canned response service (M1): CRUD over the desk's reusable replies.
 *
 * Thin on purpose — the storage port decides nothing and the rules module owns
 * every validation. The only decision here is access: managing the shared
 * library is a staff action (`ticket:update`), while reading it is open to
 * anyone who can reply.
 */

import { randomUUID } from "node:crypto";

import { canLinkTickets } from "./link-rules";
import type { Actor } from "./access-rules";
import { hasPermission } from "./access-rules";
import { validateCannedResponse, type CannedResponse } from "./canned-rules";

export interface CannedStore {
  listForTenant(tenantId: string): Promise<CannedResponse[]>;
  insert(response: CannedResponse): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
}

export type CannedResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CannedIds {
  id(): string;
  now(): string;
}

export function systemCannedIds(): CannedIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export class CannedResponseService {
  constructor(
    private readonly store: CannedStore,
    private readonly ids: CannedIds = systemCannedIds(),
  ) {}

  /** Every response in the tenant, title-ordered — the order the picker shows. */
  async list(tenantId: string): Promise<CannedResponse[]> {
    const all = await this.store.listForTenant(tenantId);
    return [...all].sort((a, b) => a.title.localeCompare(b.title));
  }

  async create(
    actor: Actor,
    input: { title: string; body: string; shortcut?: string | null },
  ): Promise<CannedResult<CannedResponse>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You cannot manage canned responses." };
    }

    const shortcut = input.shortcut?.trim() ? input.shortcut.trim().toLowerCase() : null;
    const issues = validateCannedResponse({ title: input.title, body: input.body, shortcut });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.listForTenant(actor.tenantId);
    const title = input.title.trim();
    if (existing.some((response) => response.title.toLowerCase() === title.toLowerCase())) {
      return { ok: false, error: "A canned response with that title already exists." };
    }
    if (shortcut && existing.some((response) => response.shortcut === shortcut)) {
      return { ok: false, error: "That shortcut is already taken." };
    }

    const at = this.ids.now();
    const response: CannedResponse = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      title,
      body: input.body.trim(),
      shortcut,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.insert(response);
    return { ok: true, value: response };
  }

  async remove(actor: Actor, id: string): Promise<CannedResult<{ id: string }>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You cannot manage canned responses." };
    }
    await this.store.remove(actor.tenantId, id);
    return { ok: true, value: { id } };
  }
}

/** Whether an actor may see the canned-response library. */
export function canUseCannedResponses(actor: Actor): boolean {
  return hasPermission(actor.role, "ticket:reply") || canLinkTickets(actor);
}

/** An in-memory store for tests and local development. */
export class MemoryCannedStore implements CannedStore {
  private readonly responses = new Map<string, CannedResponse>();

  async listForTenant(tenantId: string): Promise<CannedResponse[]> {
    return [...this.responses.values()]
      .filter((response) => response.tenantId === tenantId)
      .map((response) => structuredClone(response));
  }

  async insert(response: CannedResponse): Promise<void> {
    this.responses.set(response.id, structuredClone(response));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const found = this.responses.get(id);
    if (found?.tenantId === tenantId) this.responses.delete(id);
  }
}
