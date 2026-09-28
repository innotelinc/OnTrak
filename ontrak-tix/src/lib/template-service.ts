/**
 * Ticket template service (M1): CRUD over the desk's reusable ticket shapes,
 * plus the "apply this template" read used to prefill the new-ticket form.
 *
 * Thin on purpose — the storage port decides nothing and `template-rules` owns
 * every validation and every placeholder. The only decisions here are access
 * (managing templates is `ticket:update`, using one to raise a ticket is
 * `ticket:create`) and name uniqueness, which is a property of the collection
 * rather than of a single record.
 */

import { randomUUID } from "node:crypto";

import type { Actor } from "./access-rules";
import { hasPermission } from "./access-rules";
import type { TicketPriority, TicketType } from "./ticket-rules";
import { applyTicketTemplate, validateTicketTemplate, type TicketTemplate } from "./template-rules";

export interface TemplateStore {
  listForTenant(tenantId: string): Promise<TicketTemplate[]>;
  insert(template: TicketTemplate): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
}

export type TemplateResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TemplateIds {
  id(): string;
  now(): string;
}

export function systemTemplateIds(): TemplateIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface TemplateInput {
  name: string;
  subject: string;
  description: string;
  type: TicketType;
  priority: TicketPriority;
  queueId?: string | null;
}

export class TicketTemplateService {
  constructor(
    private readonly store: TemplateStore,
    private readonly ids: TemplateIds = systemTemplateIds(),
  ) {}

  /** Every template in the tenant, name-ordered — the order the picker shows. */
  async list(tenantId: string): Promise<TicketTemplate[]> {
    const all = await this.store.listForTenant(tenantId);
    return [...all].sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(actor: Actor, input: TemplateInput): Promise<TemplateResult<TicketTemplate>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You cannot manage ticket templates." };
    }

    const issues = validateTicketTemplate(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name.trim();
    const existing = await this.store.listForTenant(actor.tenantId);
    if (existing.some((template) => template.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: "A template with that name already exists." };
    }

    const at = this.ids.now();
    const template: TicketTemplate = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      name,
      subject: input.subject.trim(),
      description: input.description.trim(),
      type: input.type,
      priority: input.priority,
      queueId: input.queueId ?? null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.insert(template);
    return { ok: true, value: template };
  }

  async remove(actor: Actor, id: string): Promise<TemplateResult<{ id: string }>> {
    if (!hasPermission(actor.role, "ticket:update")) {
      return { ok: false, error: "You cannot manage ticket templates." };
    }
    await this.store.remove(actor.tenantId, id);
    return { ok: true, value: { id } };
  }

  /**
   * A template rendered into the fields a new ticket would start from. Returns
   * `null` when the template is unknown, so a stale link simply leaves the form
   * blank rather than failing the page.
   */
  async prefill(
    tenantId: string,
    id: string,
    values: Parameters<typeof applyTicketTemplate>[1] = {},
  ): Promise<ReturnType<typeof applyTicketTemplate> | null> {
    const template = (await this.store.listForTenant(tenantId)).find((candidate) => candidate.id === id);
    return template ? applyTicketTemplate(template, values) : null;
  }
}

/** Whether an actor may see the template library on the new-ticket form. */
export function canUseTicketTemplates(actor: Actor): boolean {
  return hasPermission(actor.role, "ticket:create") || hasPermission(actor.role, "ticket:update");
}

/** An in-memory store for tests and local development. */
export class MemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, TicketTemplate>();

  async listForTenant(tenantId: string): Promise<TicketTemplate[]> {
    return [...this.templates.values()]
      .filter((template) => template.tenantId === tenantId)
      .map((template) => structuredClone(template));
  }

  async insert(template: TicketTemplate): Promise<void> {
    this.templates.set(template.id, structuredClone(template));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const found = this.templates.get(id);
    if (found?.tenantId === tenantId) this.templates.delete(id);
  }
}
