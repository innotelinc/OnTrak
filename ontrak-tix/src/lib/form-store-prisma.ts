/**
 * Prisma adapter for custom fields and queue forms (M6).
 *
 * The same split as every other adapter here: this file owns the rows, the `Date`
 * conversions and the JSON, and decides nothing. The mappers are pure, so the conversions
 * are tested without a database.
 *
 * Two habits are worth reading, because both are about *not* crashing on data the domain
 * would not have written:
 *
 *  - **`options` and `sections` are treated as hostile.** A `sections` value that is not an
 *    array of sections reads as `[]`, and a field type the domain does not know reads as
 *    `TEXT`. A desk whose layout was hand-edited then sees a form with the wrong fields
 *    rather than a page that throws — and can fix it, because the page still renders.
 *  - **The default form's row is `queueId: null`, and its id is derived from the tenant.**
 *    The service computes that id; this file simply upserts by primary key, which is what
 *    makes two racing writes of the default form collapse into one.
 */

import type { FormStore } from "./form-service";
import {
  FIELD_TYPES,
  type CustomFieldRecord,
  type FieldType,
  type FormSection,
  type QueueFormRecord,
} from "./form-rules";

/* -------------------------------------------------------------------------- */
/*  Row shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface CustomFieldRow {
  id: string;
  tenantId: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  requiredByDefault: boolean;
  placeholder: string;
  helpText: string;
  archived: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueFormRow {
  id: string;
  tenantId: string;
  queueId: string | null;
  sections: unknown;
  updatedBy: string;
  updatedAt: Date;
}

export interface FormPrismaClient {
  customField: {
    findMany(args: unknown): Promise<CustomFieldRow[]>;
    findFirst(args: unknown): Promise<CustomFieldRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
  queueForm: {
    findMany(args: unknown): Promise<QueueFormRow[]>;
    findFirst(args: unknown): Promise<QueueFormRow | null>;
    upsert(args: { where: unknown; create: unknown; update: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Mappers (pure)                                                            */
/* -------------------------------------------------------------------------- */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fieldTypeOf(value: string): FieldType {
  const upper = value.toUpperCase();
  return (FIELD_TYPES as readonly string[]).includes(upper) ? (upper as FieldType) : "TEXT";
}

/** Sections that are not sections are dropped; the form still renders. */
function sectionsOf(value: unknown): FormSection[] {
  if (!Array.isArray(value)) return [];
  const sections: FormSection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { title?: unknown; fieldKeys?: unknown; requiredKeys?: unknown };
    if (typeof candidate.title !== "string") continue;
    const keys = Array.isArray(candidate.fieldKeys) ? candidate.fieldKeys.filter((key): key is string => typeof key === "string") : [];
    const required = Array.isArray(candidate.requiredKeys)
      ? candidate.requiredKeys.filter((key): key is string => typeof key === "string")
      : [];
    sections.push({
      title: candidate.title,
      fieldKeys: keys,
      ...(required.length > 0 ? { requiredKeys: required } : {}),
    });
  }
  return sections;
}

export function toFieldRecord(row: CustomFieldRow): CustomFieldRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    label: row.label,
    type: fieldTypeOf(row.type),
    options: row.options ?? [],
    requiredByDefault: row.requiredByDefault,
    placeholder: row.placeholder ?? "",
    helpText: row.helpText ?? "",
    archived: row.archived,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toFieldCreate(record: CustomFieldRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    key: record.key,
    label: record.label,
    type: record.type,
    options: [...record.options],
    requiredByDefault: record.requiredByDefault,
    placeholder: record.placeholder,
    helpText: record.helpText,
    archived: record.archived,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** The mutable half. A field's key and its creator never change. */
export function toFieldUpdate(record: CustomFieldRecord) {
  return {
    label: record.label,
    type: record.type,
    options: [...record.options],
    requiredByDefault: record.requiredByDefault,
    placeholder: record.placeholder,
    helpText: record.helpText,
    archived: record.archived,
    updatedAt: new Date(record.updatedAt),
  };
}

export function toLayoutRecord(row: QueueFormRow): QueueFormRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    queueId: row.queueId,
    sections: sectionsOf(row.sections),
    updatedBy: row.updatedBy,
    updatedAt: toIso(row.updatedAt),
  };
}

export function toLayoutUpsert(record: QueueFormRecord) {
  const sections = record.sections.map((section) => ({
    title: section.title,
    fieldKeys: [...section.fieldKeys],
    ...(section.requiredKeys && section.requiredKeys.length > 0 ? { requiredKeys: [...section.requiredKeys] } : {}),
  }));
  return {
    where: { id: record.id },
    create: {
      id: record.id,
      tenantId: record.tenantId,
      queueId: record.queueId,
      sections,
      updatedBy: record.updatedBy,
      updatedAt: new Date(record.updatedAt),
    },
    update: {
      sections,
      updatedBy: record.updatedBy,
      updatedAt: new Date(record.updatedAt),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                 */
/* -------------------------------------------------------------------------- */

export class PrismaFormStore implements FormStore {
  constructor(private readonly db: FormPrismaClient) {}

  async listFields(tenantId: string): Promise<CustomFieldRecord[]> {
    const rows = await this.db.customField.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "asc" }, { key: "asc" }],
    });
    return rows.map(toFieldRecord);
  }

  /** A tenant-scoped read: another desk's field is simply not there. */
  async findField(tenantId: string, fieldId: string): Promise<CustomFieldRecord | null> {
    const row = await this.db.customField.findFirst({ where: { tenantId, id: fieldId } });
    return row ? toFieldRecord(row) : null;
  }

  async findFieldByKey(tenantId: string, key: string): Promise<CustomFieldRecord | null> {
    const row = await this.db.customField.findFirst({ where: { tenantId, key } });
    return row ? toFieldRecord(row) : null;
  }

  async insertField(record: CustomFieldRecord): Promise<void> {
    await this.db.customField.create({ data: toFieldCreate(record) });
  }

  async updateField(record: CustomFieldRecord): Promise<void> {
    await this.db.customField.update({ where: { id: record.id }, data: toFieldUpdate(record) });
  }

  async listLayouts(tenantId: string): Promise<QueueFormRecord[]> {
    const rows = await this.db.queueForm.findMany({ where: { tenantId } });
    return rows.map(toLayoutRecord);
  }

  /** `queueId: null` is the tenant's default form — one row, found by the pair's null half. */
  async findLayout(tenantId: string, queueId: string | null): Promise<QueueFormRecord | null> {
    const row = await this.db.queueForm.findFirst({ where: { tenantId, queueId } });
    return row ? toLayoutRecord(row) : null;
  }

  async upsertLayout(record: QueueFormRecord): Promise<void> {
    await this.db.queueForm.upsert(toLayoutUpsert(record));
  }

  async removeLayout(tenantId: string, queueId: string | null): Promise<void> {
    // Scoped by tenant as well as by the queue, so a wrong id is a no-op rather than a
    // delete of somebody else's layout.
    await this.db.queueForm.deleteMany({ where: { tenantId, queueId } });
  }
}
