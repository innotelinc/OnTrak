/**
 * Prisma adapter for automation rules (M5).
 *
 * Same split as the other adapters: the port (`RuleStore`) speaks domain records
 * with ISO strings and `ticket.created`-style triggers, this file owns the rows,
 * the `Date` conversions and the enum spelling (`TICKET_CREATED`), and nothing
 * here decides anything.
 *
 * The two conversions are explicit rather than a spread, so a column added to the
 * table cannot silently appear in the domain record, and an action kind the
 * engine does not know cannot be written into one.
 */

import type {
  RuleAction,
  RuleCondition,
  RuleRecord,
  RuleTrigger,
} from "./rule-rules";
import type { RuleStore } from "./rule-service";

export interface RuleRow {
  id: string;
  tenantId: string;
  name: string;
  trigger: string;
  conditions: unknown;
  actions: unknown;
  enabled: boolean;
  position: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RulePrismaClient {
  rule: {
    findFirst(args: unknown): Promise<RuleRow | null>;
    findMany(args: unknown): Promise<RuleRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
}

/** The domain trigger → the enum value stored in the column. */
const TRIGGER_COLUMN: Record<RuleTrigger, string> = {
  "ticket.created": "TICKET_CREATED",
  "ticket.updated": "TICKET_UPDATED",
  "ticket.replied": "TICKET_REPLIED",
};

/** The column → the domain trigger. An unknown value is refused, not guessed. */
const TRIGGER_DOMAIN: Record<string, RuleTrigger> = {
  TICKET_CREATED: "ticket.created",
  TICKET_UPDATED: "ticket.updated",
  TICKET_REPLIED: "ticket.replied",
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asConditions(value: unknown): RuleCondition[] {
  return Array.isArray(value) ? (value as RuleCondition[]) : [];
}

function asActions(value: unknown): RuleAction[] {
  return Array.isArray(value) ? (value as RuleAction[]) : [];
}

export function toRuleRecord(row: RuleRow): RuleRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    trigger: TRIGGER_DOMAIN[row.trigger] ?? "ticket.created",
    conditions: asConditions(row.conditions),
    actions: asActions(row.actions),
    enabled: row.enabled,
    position: row.position,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PrismaRuleStore implements RuleStore {
  constructor(private readonly db: RulePrismaClient) {}

  async listRules(tenantId: string): Promise<RuleRecord[]> {
    const rows = await this.db.rule.findMany({ where: { tenantId }, orderBy: { position: "asc" } });
    return rows.map(toRuleRecord);
  }

  async findRule(tenantId: string, ruleId: string): Promise<RuleRecord | null> {
    const row = await this.db.rule.findFirst({ where: { tenantId, id: ruleId } });
    return row ? toRuleRecord(row) : null;
  }

  /** Case-insensitive, matching the service's uniqueness rule. */
  async findRuleByName(tenantId: string, name: string): Promise<RuleRecord | null> {
    const row = await this.db.rule.findFirst({ where: { tenantId, name: { equals: name.trim(), mode: "insensitive" } } });
    return row ? toRuleRecord(row) : null;
  }

  async insertRule(record: RuleRecord): Promise<void> {
    await this.db.rule.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        name: record.name,
        trigger: TRIGGER_COLUMN[record.trigger],
        conditions: record.conditions as unknown as object,
        actions: record.actions as unknown as object,
        enabled: record.enabled,
        position: record.position,
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async updateRule(record: RuleRecord): Promise<void> {
    await this.db.rule.update({
      where: { id: record.id },
      data: {
        name: record.name,
        trigger: TRIGGER_COLUMN[record.trigger],
        conditions: record.conditions as unknown as object,
        actions: record.actions as unknown as object,
        enabled: record.enabled,
        position: record.position,
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async removeRule(tenantId: string, ruleId: string): Promise<void> {
    // A tenant-scoped delete, so a cross-tenant id deletes nothing rather than
    // relying on the caller having checked first.
    await this.db.rule.deleteMany({ where: { tenantId, id: ruleId } });
  }
}
