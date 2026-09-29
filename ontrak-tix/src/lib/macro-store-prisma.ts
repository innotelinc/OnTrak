/**
 * Prisma adapter for macros (M5).
 *
 * Same split as the other adapters: the port (`MacroStore`) speaks domain
 * records with ISO strings and `RuleAction` objects, this file owns the row, the
 * `Date` conversions and the JSON columns, and nothing here decides anything.
 *
 * A macro stores actions exactly the way a rule does — one JSON column, read and
 * written whole — because a macro is authored, previewed and run as one list.
 * The conversions are explicit rather than a spread, so a column added to the
 * table cannot silently appear in the domain record.
 */

import type { MacroRecord } from "./macro-rules";
import type { RuleAction } from "./rule-rules";
import type { MacroStore } from "./macro-service";

export interface MacroRow {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  actions: unknown;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MacroPrismaClient {
  macro: {
    findFirst(args: unknown): Promise<MacroRow | null>;
    findMany(args: unknown): Promise<MacroRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asActions(value: unknown): RuleAction[] {
  return Array.isArray(value) ? (value as RuleAction[]) : [];
}

export function toMacroRecord(row: MacroRow): MacroRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    actions: asActions(row.actions),
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PrismaMacroStore implements MacroStore {
  constructor(private readonly db: MacroPrismaClient) {}

  async listMacros(tenantId: string): Promise<MacroRecord[]> {
    const rows = await this.db.macro.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
    return rows.map(toMacroRecord);
  }

  async findMacro(tenantId: string, macroId: string): Promise<MacroRecord | null> {
    const row = await this.db.macro.findFirst({ where: { tenantId, id: macroId } });
    return row ? toMacroRecord(row) : null;
  }

  /** Case-insensitive, matching the service's uniqueness rule. */
  async findMacroByName(tenantId: string, name: string): Promise<MacroRecord | null> {
    const row = await this.db.macro.findFirst({ where: { tenantId, name: { equals: name.trim(), mode: "insensitive" } } });
    return row ? toMacroRecord(row) : null;
  }

  async insertMacro(record: MacroRecord): Promise<void> {
    await this.db.macro.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        name: record.name,
        description: record.description,
        actions: record.actions as unknown as object,
        enabled: record.enabled,
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async updateMacro(record: MacroRecord): Promise<void> {
    await this.db.macro.update({
      where: { id: record.id },
      data: {
        name: record.name,
        description: record.description,
        actions: record.actions as unknown as object,
        enabled: record.enabled,
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async removeMacro(tenantId: string, macroId: string): Promise<void> {
    // A tenant-scoped delete, so a cross-tenant id deletes nothing rather than
    // relying on the caller having checked first.
    await this.db.macro.deleteMany({ where: { tenantId, id: macroId } });
  }
}
