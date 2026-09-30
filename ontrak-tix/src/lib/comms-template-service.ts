/**
 * Incident communications template service (M3): a tenant's own drafts.
 *
 * The shipped templates answer \"what does a notice to the CSIRT look like?\". They
 * cannot answer \"what does *our* notice to *our* regulator look like?\" — that
 * wording comes from the contract, the regulator and the last time somebody
 * complained about it. So a desk can author its own draft for a regime, and the
 * console offers it ahead of ours.
 *
 * Managing the library is a staff action (`ticket:update`), the same gate the M1
 * canned responses use, because it is the same act: writing down what the desk
 * says. Reading is open to anyone who can read an incident.
 *
 * Two refusals carry the design:
 *
 *  - a draft is **validated at authoring time**, including its placeholders, so a
 *    typo is refused while a person is looking at the form rather than discovered
 *    by a duty at three in the morning;
 *  - a draft is **retired, never deleted** — a notice that cited it has to stay
 *    explainable, and the retired row is what explains it.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import {
  validateCommsTemplate,
  type CommsAudience,
  type IncidentCommsTemplate,
} from "./comms-rules";
import type { ServiceResult } from "./ticket-service";

export interface CommsTemplateRecord {
  id: string;
  tenantId: string;
  label: string;
  audience: CommsAudience;
  /** Regime keys this drafts. Empty means it fits any duty. */
  regimes: string[];
  subject: string;
  body: string;
  guidance: string | null;
  retiredAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommsTemplateStore {
  listForTenant(tenantId: string, options?: { includeRetired?: boolean }): Promise<CommsTemplateRecord[]>;
  find(tenantId: string, id: string): Promise<CommsTemplateRecord | null>;
  findByLabel(tenantId: string, label: string): Promise<CommsTemplateRecord | null>;
  insert(record: CommsTemplateRecord): Promise<void>;
  update(record: CommsTemplateRecord): Promise<void>;
}

export interface CommsTemplateIds {
  id(): string;
  now(): string;
}

export function systemCommsTemplateIds(): CommsTemplateIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** A stored draft as the rule set understands it, ready to offer on a duty. */
export function toCommsTemplate(record: CommsTemplateRecord): IncidentCommsTemplate {
  return {
    key: `tenant:${record.id}`,
    label: record.label,
    audience: record.audience,
    regimes: [...record.regimes],
    subject: record.subject,
    body: record.body,
    guidance: record.guidance ?? "",
    custom: true,
  };
}

export interface CommsTemplateInput {
  label: string;
  audience: string;
  regimes?: readonly string[];
  subject: string;
  body: string;
  guidance?: string | null;
}

export class IncidentCommsTemplateService {
  constructor(
    private readonly store: CommsTemplateStore,
    private readonly ids: CommsTemplateIds = systemCommsTemplateIds(),
  ) {}

  /** The tenant's live drafts, label-ordered — the order the picker shows. */
  async list(tenantId: string, options: { includeRetired?: boolean } = {}): Promise<CommsTemplateRecord[]> {
    return this.store.listForTenant(tenantId, options);
  }

  /** The live drafts as templates, for a console that is about to render duties. */
  async templatesFor(tenantId: string): Promise<IncidentCommsTemplate[]> {
    const records = await this.store.listForTenant(tenantId);
    return records.map(toCommsTemplate);
  }

  async create(actor: Actor, input: CommsTemplateInput): Promise<ServiceResult<CommsTemplateRecord>> {
    if (!actorHasPermission(actor, "ticket:update")) {
      return { ok: false, error: "You cannot manage incident notification templates." };
    }

    const regimes = [...new Set((input.regimes ?? []).map((regime) => regime.trim()).filter(Boolean))];
    const draft = {
      label: input.label.trim(),
      audience: input.audience,
      regimes,
      subject: input.subject.trim(),
      body: input.body.trim(),
      guidance: input.guidance?.trim() || null,
    };

    const issues = validateCommsTemplate(draft);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    // A label is how somebody picks the draft, so two with the same name would
    // be a coin toss at the worst moment.
    const existing = await this.store.findByLabel(actor.tenantId, draft.label);
    if (existing) return { ok: false, error: `A template called “${draft.label}” already exists.` };

    const now = this.ids.now();
    const record: CommsTemplateRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      audience: draft.audience as CommsAudience,
      label: draft.label,
      regimes: draft.regimes,
      subject: draft.subject,
      body: draft.body,
      guidance: draft.guidance,
      retiredAt: null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(record);
    return { ok: true, value: record };
  }

  /** Edit a draft in place. A retired one can be brought back the same way. */
  async update(actor: Actor, templateId: string, input: CommsTemplateInput): Promise<ServiceResult<CommsTemplateRecord>> {
    if (!actorHasPermission(actor, "ticket:update")) {
      return { ok: false, error: "You cannot manage incident notification templates." };
    }

    const found = await this.store.find(actor.tenantId, templateId);
    if (!found) return { ok: false, error: "Template not found." };

    const regimes = [...new Set((input.regimes ?? []).map((regime) => regime.trim()).filter(Boolean))];
    const draft = {
      label: input.label.trim(),
      audience: input.audience,
      regimes,
      subject: input.subject.trim(),
      body: input.body.trim(),
      guidance: input.guidance?.trim() || null,
    };
    const issues = validateCommsTemplate(draft);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const clash = await this.store.findByLabel(actor.tenantId, draft.label);
    if (clash && clash.id !== found.id) {
      return { ok: false, error: `A template called “${draft.label}” already exists.` };
    }

    const next: CommsTemplateRecord = {
      ...found,
      label: draft.label,
      audience: draft.audience as CommsAudience,
      regimes: draft.regimes,
      subject: draft.subject,
      body: draft.body,
      guidance: draft.guidance,
      updatedAt: this.ids.now(),
    };
    await this.store.update(next);
    return { ok: true, value: next };
  }

  /** Retire a draft: it stops being offered, and it stays on the record. */
  async retire(actor: Actor, templateId: string, retired: boolean): Promise<ServiceResult<CommsTemplateRecord>> {
    if (!actorHasPermission(actor, "ticket:update")) {
      return { ok: false, error: "You cannot manage incident notification templates." };
    }

    const found = await this.store.find(actor.tenantId, templateId);
    if (!found) return { ok: false, error: "Template not found." };

    const next: CommsTemplateRecord = {
      ...found,
      retiredAt: retired ? this.ids.now() : null,
      updatedAt: this.ids.now(),
    };
    await this.store.update(next);
    return { ok: true, value: next };
  }
}

/** An in-memory store, used by tests and local development. */
export class MemoryCommsTemplateStore implements CommsTemplateStore {
  private readonly records = new Map<string, CommsTemplateRecord>();

  async listForTenant(tenantId: string, options: { includeRetired?: boolean } = {}): Promise<CommsTemplateRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .filter((record) => options.includeRetired || record.retiredAt === null)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((record) => structuredClone(record));
  }

  async find(tenantId: string, id: string): Promise<CommsTemplateRecord | null> {
    const found = this.records.get(id);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findByLabel(tenantId: string, label: string): Promise<CommsTemplateRecord | null> {
    const found = [...this.records.values()].find(
      (record) => record.tenantId === tenantId && record.label.toLowerCase() === label.toLowerCase(),
    );
    return found ? structuredClone(found) : null;
  }

  async insert(record: CommsTemplateRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async update(record: CommsTemplateRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
}
