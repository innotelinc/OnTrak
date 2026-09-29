/**
 * Form service (M6): the fields a desk defines and the form each queue gets.
 *
 * `form-rules.ts` decides everything; this file stores the result, checks who may change it
 * and records it. Three things it adds are worth reading:
 *
 *  - **`validateTicketValues` is the one door.** A ticket can be raised from the console, the
 *    requester portal or the API, and the answer to "is this form filled in?" has to be the
 *    same at all three. So the validation is a method here rather than a copy in each
 *    caller, and it resolves the layout itself from the queue the ticket is landing in.
 *  - **A field's key is immutable once it holds a value.** Renaming a *label* is ordinary
 *    editing; changing a key would orphan every value already stored under it, so the
 *    service refuses it and says why. The alternative — rewriting history to match a
 *    rename — is exactly the kind of silent edit this product does not do.
 *  - **Removing a field is archiving it.** There is no delete: the field is part of the
 *    tickets that answered it, and a desk that could delete it could make a past ticket
 *    unreadable.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  canManageForms,
  resolveLayout,
  validateField,
  validateLayout,
  validateValues,
  type CustomFieldRecord,
  type CustomValues,
  type FieldType,
  type FormIssue,
  type FormLayout,
  type FormSection,
  type QueueFormRecord,
} from "./form-rules";
import type { ServiceResult } from "./ticket-service";

/* -------------------------------------------------------------------------- */
/*  The store port                                                            */
/* -------------------------------------------------------------------------- */

export interface FormStore {
  listFields(tenantId: string): Promise<CustomFieldRecord[]>;
  findField(tenantId: string, fieldId: string): Promise<CustomFieldRecord | null>;
  findFieldByKey(tenantId: string, key: string): Promise<CustomFieldRecord | null>;
  insertField(record: CustomFieldRecord): Promise<void>;
  updateField(record: CustomFieldRecord): Promise<void>;

  listLayouts(tenantId: string): Promise<QueueFormRecord[]>;
  findLayout(tenantId: string, queueId: string | null): Promise<QueueFormRecord | null>;
  upsertLayout(record: QueueFormRecord): Promise<void>;
  removeLayout(tenantId: string, queueId: string | null): Promise<void>;
}

export interface FormIds {
  id(): string;
  now(): string;
}

export function systemFormIds(): FormIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface FieldInput {
  key?: string;
  label?: string;
  type?: string;
  options?: readonly string[];
  requiredByDefault?: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface LayoutInput {
  /** `null` is the tenant's default form. */
  queueId?: string | null;
  sections?: readonly FormSection[];
}

/** One field as a console renders it: the record, plus whether it is on any form. */
export interface FieldOverview {
  field: CustomFieldRecord;
  /** How many layouts name it, so "off the form" is visible rather than inferred. */
  usedByLayouts: number;
}

export class FormService {
  constructor(
    private readonly store: FormStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: FormIds = systemFormIds(),
  ) {}

  /* --------------------------------------------------------------- fields */

  async fields(actor: Actor): Promise<ServiceResult<FieldOverview[]>> {
    if (!hasPermission(actor.role, "ticket:read")) return { ok: false, error: "You do not have access to the desk's fields." };
    const [fields, layouts] = await Promise.all([this.store.listFields(actor.tenantId), this.store.listLayouts(actor.tenantId)]);
    return {
      ok: true,
      value: fields.map((field) => ({
        field,
        usedByLayouts: layouts.filter((layout) => layout.sections.some((section) => section.fieldKeys.includes(field.key))).length,
      })),
    };
  }

  async createField(actor: Actor, input: FieldInput): Promise<ServiceResult<CustomFieldRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    // The key is lower-cased *before* it is validated, because that is the form it will
    // be stored in: refusing “Location” only to normalise a lowercase one would make the
    // rule depend on how the caller capitalised a word.
    const key = input.key?.trim().toLowerCase() ?? "";
    const issues = validateField({ ...input, key });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    if (await this.store.findFieldByKey(actor.tenantId, key)) {
      return { ok: false, error: `A field with the key “${key}” already exists.` };
    }

    const now = this.ids.now();
    const record: CustomFieldRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      key,
      label: input.label!.trim(),
      type: (input.type ?? "TEXT").toUpperCase() as FieldType,
      options: (input.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0),
      requiredByDefault: input.requiredByDefault === true,
      placeholder: input.placeholder?.trim() ?? "",
      helpText: input.helpText?.trim() ?? "",
      archived: false,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertField(record);
    await this.append(actor, "form.field.create", record.key, {
      label: record.label,
      type: record.type,
      required: record.requiredByDefault,
    });
    return { ok: true, value: record };
  }

  async updateField(actor: Actor, fieldId: string, input: FieldInput): Promise<ServiceResult<CustomFieldRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const found = await this.store.findField(actor.tenantId, fieldId);
    if (!found) return { ok: false, error: "That field does not exist." };

    const merged: FieldInput = {
      key: found.key,
      label: input.label ?? found.label,
      type: input.type ?? found.type,
      options: input.options ?? found.options,
      placeholder: input.placeholder ?? found.placeholder,
      helpText: input.helpText ?? found.helpText,
      requiredByDefault: input.requiredByDefault ?? found.requiredByDefault,
    };
    const issues = validateField(merged);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    // A key is the name a value was stored under. Changing it would orphan every answer
    // already given, so it is refused rather than renamed into a hole.
    if (input.key !== undefined && input.key.trim().toLowerCase() !== found.key) {
      return {
        ok: false,
        error: `A field's key cannot change (“${found.key}”): every value already recorded is stored under it. Change the label instead.`,
      };
    }

    const next: CustomFieldRecord = {
      ...found,
      label: merged.label!.trim(),
      type: (merged.type ?? found.type).toUpperCase() as FieldType,
      options: (merged.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0),
      requiredByDefault: merged.requiredByDefault === true,
      placeholder: merged.placeholder?.trim() ?? "",
      helpText: merged.helpText?.trim() ?? "",
      updatedAt: this.ids.now(),
    };
    await this.store.updateField(next);
    await this.append(actor, "form.field.update", next.key, {
      label: next.label,
      type: next.type,
      required: next.requiredByDefault,
    });
    return { ok: true, value: next };
  }

  /** Take a field off new forms. Values already recorded stay, and stay readable. */
  async archiveField(actor: Actor, fieldId: string, archived: boolean): Promise<ServiceResult<CustomFieldRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const found = await this.store.findField(actor.tenantId, fieldId);
    if (!found) return { ok: false, error: "That field does not exist." };
    if (found.archived === archived) return { ok: true, value: found };

    const next: CustomFieldRecord = { ...found, archived, updatedAt: this.ids.now() };
    await this.store.updateField(next);
    await this.append(actor, archived ? "form.field.archive" : "form.field.restore", next.key, { label: next.label });
    return { ok: true, value: next };
  }

  /* -------------------------------------------------------------- layouts */

  async layouts(actor: Actor): Promise<ServiceResult<QueueFormRecord[]>> {
    if (!hasPermission(actor.role, "ticket:read")) return { ok: false, error: "You do not have access to the desk's forms." };
    return { ok: true, value: await this.store.listLayouts(actor.tenantId) };
  }

  /** The form a queue shows, and — for the console — which of the two it came from. */
  async layoutFor(actor: Actor, queueId: string | null): Promise<ServiceResult<FormLayout>> {
    if (!hasPermission(actor.role, "ticket:read")) return { ok: false, error: "You do not have access to the desk's forms." };
    const [fields, layouts] = await Promise.all([this.store.listFields(actor.tenantId), this.store.listLayouts(actor.tenantId)]);
    return { ok: true, value: resolveLayout(fields, layouts, queueId) };
  }

  async setLayout(actor: Actor, input: LayoutInput): Promise<ServiceResult<QueueFormRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const queueId = input.queueId ?? null;
    const sections = input.sections ?? [];
    const fields = await this.store.listFields(actor.tenantId);
    const issues = validateLayout(sections, fields);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const normalized: FormSection[] = sections.map((section) => ({
      title: section.title.trim(),
      fieldKeys: [...section.fieldKeys],
      ...(section.requiredKeys && section.requiredKeys.length > 0 ? { requiredKeys: [...section.requiredKeys] } : {}),
    }));

    const existing = await this.store.findLayout(actor.tenantId, queueId);
    const record: QueueFormRecord = {
      // The default form's id is deterministic, because `(tenantId, queueId)` cannot be a
      // unique key when one of them is NULL — Postgres treats NULLs as distinct, so two
      // racing writes of the *default* form would both insert. A derived primary key makes
      // the database refuse the second, and a queue's layout is protected by the pair.
      id: existing?.id ?? (queueId === null ? `${actor.tenantId}:default` : this.ids.id()),
      tenantId: actor.tenantId,
      queueId,
      sections: normalized,
      updatedBy: actor.id,
      updatedAt: this.ids.now(),
    };
    await this.store.upsertLayout(record);
    await this.append(actor, "form.layout.set", queueId ?? "default", {
      queueId,
      sections: normalized.map((section) => ({ title: section.title, fields: section.fieldKeys.length })),
    });
    return { ok: true, value: record };
  }

  /** Forget a queue's layout, so it inherits the default again. */
  async removeLayout(actor: Actor, queueId: string | null): Promise<ServiceResult<{ removed: true }>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;
    if (queueId === null) return { ok: false, error: "The default form is not a queue layout; set it rather than removing it." };

    const existing = await this.store.findLayout(actor.tenantId, queueId);
    if (!existing) return { ok: false, error: "That queue has no layout of its own." };

    await this.store.removeLayout(actor.tenantId, queueId);
    await this.append(actor, "form.layout.remove", queueId, { queueId });
    return { ok: true, value: { removed: true } };
  }

  /* -------------------------------------------------------------- tickets */

  /**
   * The values a ticket in this queue may carry.
   *
   * Called from the ticket-creation path rather than from a form handler, because a ticket
   * arrives from the portal and from the API too, and a rule that only held on one of those
   * would be a rule somebody can walk around.
   */
  async validateTicketValues(
    tenantId: string,
    queueId: string | null,
    values: unknown,
  ): Promise<ServiceResult<CustomValues>> {
    const [fields, layouts] = await Promise.all([this.store.listFields(tenantId), this.store.listLayouts(tenantId)]);
    const layout = resolveLayout(fields, layouts, queueId);
    const validated = validateValues(layout, values);
    if (!validated.ok) return { ok: false, error: describeIssues(validated.issues) };
    return { ok: true, value: validated.value };
  }

  /** The fields a stored ticket's values name, for rendering one back. */
  async describeTicket(actor: Actor, queueId: string | null, values: CustomValues | undefined) {
    const layout = await this.layoutFor(actor, queueId);
    if (!layout.ok) return layout;
    const fields = layout.value.fields;
    return {
      ok: true as const,
      value: fields.filter((field) => values !== undefined && field.key in values),
    };
  }

  /* ------------------------------------------------------------ internals */

  private requireManage(actor: Actor): ServiceResult<never> | null {
    if (!canManageForms(actor.role)) return { ok: false, error: "You do not administer the desk's forms." };
    return null;
  }

  private async append(actor: Actor, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "CustomField",
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** The sentences a form's refusals become, one per line, with the field named. */
export function describeIssues(issues: readonly FormIssue[]): string {
  return issues.map((issue) => issue.message).join(" ");
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests                                         */
/* -------------------------------------------------------------------------- */

export class MemoryFormStore implements FormStore {
  private readonly fields = new Map<string, CustomFieldRecord>();
  private readonly layouts = new Map<string, QueueFormRecord>();

  private layoutKey(tenantId: string, queueId: string | null): string {
    return `${tenantId}\u0000${queueId ?? "default"}`;
  }

  async listFields(tenantId: string): Promise<CustomFieldRecord[]> {
    return [...this.fields.values()]
      .filter((field) => field.tenantId === tenantId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
      .map((field) => structuredClone(field));
  }

  async findField(tenantId: string, fieldId: string): Promise<CustomFieldRecord | null> {
    const found = this.fields.get(fieldId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findFieldByKey(tenantId: string, key: string): Promise<CustomFieldRecord | null> {
    const found = [...this.fields.values()].find((field) => field.tenantId === tenantId && field.key === key);
    return found ? structuredClone(found) : null;
  }

  async insertField(record: CustomFieldRecord): Promise<void> {
    this.fields.set(record.id, structuredClone(record));
  }

  async updateField(record: CustomFieldRecord): Promise<void> {
    this.fields.set(record.id, structuredClone(record));
  }

  async listLayouts(tenantId: string): Promise<QueueFormRecord[]> {
    return [...this.layouts.values()]
      .filter((layout) => layout.tenantId === tenantId)
      .map((layout) => structuredClone(layout));
  }

  async findLayout(tenantId: string, queueId: string | null): Promise<QueueFormRecord | null> {
    const found = this.layouts.get(this.layoutKey(tenantId, queueId));
    return found ? structuredClone(found) : null;
  }

  async upsertLayout(record: QueueFormRecord): Promise<void> {
    this.layouts.set(this.layoutKey(record.tenantId, record.queueId), structuredClone(record));
  }

  async removeLayout(tenantId: string, queueId: string | null): Promise<void> {
    this.layouts.delete(this.layoutKey(tenantId, queueId));
  }
}
