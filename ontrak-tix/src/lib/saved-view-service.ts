/**
 * Saved view service (M0/M1): named inbox filters, per desk and per user.
 *
 * The rules module owns sanitizing and validation; this layer owns access — who
 * can see a view (the owner, or everyone when it is shared) and who can remove
 * it (its owner, or an admin) — and the wiring to a store port.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import { sanitizeInboxFilter, validateSavedView, type SavedView } from "./saved-view-rules";
import type { InboxFilter } from "./inbox-rules";

export interface SavedViewStore {
  listForTenant(tenantId: string): Promise<SavedView[]>;
  insert(view: SavedView): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
}

export type SavedViewResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SavedViewIds {
  id(): string;
  now(): string;
}

export function systemSavedViewIds(): SavedViewIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export class SavedViewService {
  constructor(
    private readonly store: SavedViewStore,
    private readonly ids: SavedViewIds = systemSavedViewIds(),
  ) {}

  /** The views an actor may see: their own plus the desk's shared ones, by name. */
  async list(actor: Actor): Promise<SavedView[]> {
    const all = await this.store.listForTenant(actor.tenantId);
    return all
      .filter((view) => view.shared || view.ownerId === actor.id)
      .sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name));
  }

  async create(
    actor: Actor,
    input: { name: string; filter: InboxFilter | unknown; shared?: boolean },
  ): Promise<SavedViewResult<SavedView>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You cannot save inbox views." };
    }

    const name = input.name?.trim() ?? "";
    const issues = validateSavedView({ name });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.listForTenant(actor.tenantId);
    if (existing.some((view) => view.ownerId === actor.id && view.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: "You already have a view with that name." };
    }

    const view: SavedView = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      ownerId: actor.id,
      name,
      filter: sanitizeInboxFilter(input.filter),
      shared: input.shared === true && actorHasPermission(actor, "ticket:update"),
      createdAt: this.ids.now(),
    };
    await this.store.insert(view);
    return { ok: true, value: view };
  }

  /** Remove a view. Only its owner, or an admin, may. */
  async remove(actor: Actor, id: string): Promise<SavedViewResult<{ id: string }>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You cannot remove inbox views." };
    }
    const all = await this.store.listForTenant(actor.tenantId);
    const view = all.find((candidate) => candidate.id === id);
    if (!view) return { ok: false, error: "View not found." };
    if (view.ownerId !== actor.id && actor.role !== "ADMIN") {
      return { ok: false, error: "Only the owner can remove this view." };
    }
    await this.store.remove(actor.tenantId, id);
    return { ok: true, value: { id } };
  }
}

/** An in-memory store for tests and local development. */
export class MemorySavedViewStore implements SavedViewStore {
  private readonly views = new Map<string, SavedView>();

  async listForTenant(tenantId: string): Promise<SavedView[]> {
    return [...this.views.values()]
      .filter((view) => view.tenantId === tenantId)
      .map((view) => structuredClone(view));
  }

  async insert(view: SavedView): Promise<void> {
    this.views.set(view.id, structuredClone(view));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const found = this.views.get(id);
    if (found?.tenantId === tenantId) this.views.delete(id);
  }
}
