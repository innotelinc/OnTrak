/**
 * Rule service (M5): the rules a desk has written, and what they would do.
 *
 * The split matches the rest of the product: `rule-rules.ts` decides everything
 * (matching, ordering, first-writer-wins, hazards) and this file only stores the
 * result and records it. Two decisions are worth stating out loud:
 *
 *  - **A rule is configuration, not data.** Writing one changes what happens to
 *    *every* ticket from then on, so every write needs `rule:manage` and every
 *    write is audited with the rule's whole body. "Who made the desk reply to
 *    everything from that address?" has an answer on the chain.
 *  - **Names are unique case-insensitively**, the same rule the SLA policies
 *    follow. Two rules called "Monitoring alerts" are a support ticket of their
 *    own: nobody can tell from the inbox which one fired.
 *
 * `preview` runs the *same* functions the live path runs, over tickets that
 * already exist, so the dry run cannot drift from what switching a rule on does.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  dryRun,
  evaluateRules,
  planTicketChanges,
  ruleHazards,
  validateRule,
  type DryRunReport,
  type RuleCondition,
  type RuleAction,
  type RulePlan,
  type RuleRecord,
  type RuleTicketView,
  type RuleTrigger,
} from "./rule-rules";
import type { ServiceResult } from "./ticket-service";

export interface RuleStore {
  listRules(tenantId: string): Promise<RuleRecord[]>;
  findRule(tenantId: string, ruleId: string): Promise<RuleRecord | null>;
  findRuleByName(tenantId: string, name: string): Promise<RuleRecord | null>;
  insertRule(record: RuleRecord): Promise<void>;
  updateRule(record: RuleRecord): Promise<void>;
  removeRule(tenantId: string, ruleId: string): Promise<void>;
}

export interface RuleIds {
  id(): string;
  now(): string;
}

export function systemRuleIds(): RuleIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What a console needs to render one rule: the record, plus what to warn about. */
export interface RuleOverview {
  rule: RuleRecord;
  hazards: string[];
}

export interface RuleInput {
  name?: string;
  trigger?: string;
  conditions?: readonly RuleCondition[];
  actions?: readonly RuleAction[];
}

export class RuleService {
  constructor(
    private readonly store: RuleStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: RuleIds = systemRuleIds(),
  ) {}

  /* ------------------------------------------------------------- reading */

  /** Every rule the tenant has, in the order they run. */
  async list(actor: Actor): Promise<ServiceResult<RuleOverview[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's rules." };
    }
    const rules = await this.store.listRules(actor.tenantId);
    return {
      ok: true,
      value: [...rules]
        .sort((a, b) => a.position - b.position)
        .map((rule) => ({ rule, hazards: ruleHazards(rule) })),
    };
  }

  /**
   * What the rules would do to a ticket, without doing it.
   *
   * This is the harness the roadmap asks for, and it is deliberately the live
   * functions rather than a second implementation: a preview that disagrees with
   * production is worse than no preview.
   */
  async preview(
    actor: Actor,
    tickets: readonly (RuleTicketView & { id: string })[],
    trigger?: RuleTrigger,
  ): Promise<ServiceResult<DryRunReport>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rules = await this.store.listRules(actor.tenantId);
    return { ok: true, value: dryRun(rules, tickets, trigger) };
  }

  /**
   * What *one* rule would do — including a rule that is switched off.
   *
   * This is the question the console is actually asked ("what happens if I turn
   * this on?"), and `preview` cannot answer it: a disabled rule is not a
   * candidate for the live engine, so a whole-ruleset dry run reports nothing
   * for it and makes every switched-off rule look safe. So the rule is run as if
   * it were enabled, through the same `dryRun` the live path uses, and only the
   * rule asked about is run — a blast radius that is one rule's, not the
   * ruleset's.
   */
  async previewRule(
    actor: Actor,
    ruleId: string,
    tickets: readonly (RuleTicketView & { id: string })[] = [],
  ): Promise<ServiceResult<DryRunReport>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rule = await this.store.findRule(actor.tenantId, ruleId);
    if (!rule) return { ok: false, error: "That rule does not exist." };

    return { ok: true, value: dryRun([{ ...rule, enabled: true }], tickets, rule.trigger) };
  }

  /**
   * The plan for one ticket, as the intake path applies it.
   *
   * Takes no actor because it runs on the ticket's behalf — from an inbound
   * email or a portal submission — where there is no one at a keyboard. It
   * returns the plan *and* the rules that produced it, so whatever writes the
   * ticket can record which rule fired rather than leaving the outcome a mystery.
   */
  async planForTicket(
    tenantId: string,
    ticket: RuleTicketView,
    trigger: RuleTrigger,
  ): Promise<{ plan: RulePlan; rules: RuleRecord[] }> {
    const rules = await this.store.listRules(tenantId);
    const matched = evaluateRules(rules, ticket, trigger);
    return { plan: planTicketChanges(matched), rules: matched };
  }

  /* ------------------------------------------------------------- writing */

  async create(actor: Actor, input: RuleInput): Promise<ServiceResult<RuleRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const issues = validateRule(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name!.trim();
    if (await this.store.findRuleByName(actor.tenantId, name)) {
      return { ok: false, error: `A rule called “${name}” already exists.` };
    }

    const existing = await this.store.listRules(actor.tenantId);
    const now = this.ids.now();
    const record: RuleRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      name,
      trigger: input.trigger as RuleTrigger,
      conditions: input.conditions ?? [],
      actions: input.actions ?? [],
      enabled: true,
      // New rules run last, so adding one cannot silently change what the rules
      // already in place do.
      position: existing.reduce((highest, rule) => Math.max(highest, rule.position), 0) + 1,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insertRule(record);
    await this.append(actor, "rule.create", record.id, {
      name: record.name,
      trigger: record.trigger,
      conditions: record.conditions,
      actions: record.actions,
    });
    return { ok: true, value: record };
  }

  async update(actor: Actor, ruleId: string, input: RuleInput): Promise<ServiceResult<RuleRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rule = await this.store.findRule(actor.tenantId, ruleId);
    if (!rule) return { ok: false, error: "That rule does not exist." };

    const merged: RuleInput = {
      name: input.name ?? rule.name,
      trigger: input.trigger ?? rule.trigger,
      conditions: input.conditions ?? rule.conditions,
      actions: input.actions ?? rule.actions,
    };

    const issues = validateRule(merged);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = merged.name!.trim();
    const clash = await this.store.findRuleByName(actor.tenantId, name);
    if (clash && clash.id !== rule.id) {
      return { ok: false, error: `A rule called “${name}” already exists.` };
    }

    const next: RuleRecord = {
      ...rule,
      name,
      trigger: merged.trigger as RuleTrigger,
      conditions: merged.conditions ?? [],
      actions: merged.actions ?? [],
      updatedAt: this.ids.now(),
    };

    await this.store.updateRule(next);
    await this.append(actor, "rule.update", rule.id, {
      name: next.name,
      trigger: next.trigger,
      // The whole body, because the question the chain has to answer is what the
      // rule said *after* the change, not which field moved.
      conditions: next.conditions,
      actions: next.actions,
    });
    return { ok: true, value: next };
  }

  async setEnabled(actor: Actor, ruleId: string, enabled: boolean): Promise<ServiceResult<RuleRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rule = await this.store.findRule(actor.tenantId, ruleId);
    if (!rule) return { ok: false, error: "That rule does not exist." };

    const next: RuleRecord = { ...rule, enabled, updatedAt: this.ids.now() };
    await this.store.updateRule(next);
    await this.append(actor, enabled ? "rule.enable" : "rule.disable", rule.id, { name: rule.name });
    return { ok: true, value: next };
  }

  /**
   * Move a rule one place in the order it runs.
   *
   * Order is not decoration here: the first rule to set a field owns it, so the
   * position *is* the policy. A console that could write rules but not reorder
   * them would leave a desk to delete and retype everything to fix one, so the
   * order it can see is an order it can change. Positions are rewritten as a
   * clean 1..n run, which also repairs any duplicate left by earlier data.
   */
  async move(actor: Actor, ruleId: string, direction: "up" | "down"): Promise<ServiceResult<{ moved: string; swappedWith: string }>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rule = await this.store.findRule(actor.tenantId, ruleId);
    if (!rule) return { ok: false, error: "That rule does not exist." };

    const ordered = (await this.store.listRules(actor.tenantId)).sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((entry) => entry.id === rule.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    const target = ordered[targetIndex];
    if (!target) return { ok: false, error: direction === "up" ? "That rule already runs first." : "That rule already runs last." };

    const reordered = [...ordered];
    reordered[index] = target;
    reordered[targetIndex] = rule;

    const now = this.ids.now();
    for (const [at, entry] of reordered.entries()) {
      const position = at + 1;
      if (entry.position !== position) await this.store.updateRule({ ...entry, position, updatedAt: now });
    }

    // Position is what decides which rule wins, so the move is a policy change
    // and belongs on the chain beside the rules themselves.
    await this.append(actor, "rule.move", rule.id, {
      name: rule.name,
      direction,
      from: index + 1,
      to: targetIndex + 1,
      swappedWith: target.name,
    });
    return { ok: true, value: { moved: rule.id, swappedWith: target.id } };
  }

  async remove(actor: Actor, ruleId: string): Promise<ServiceResult<{ id: string }>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const rule = await this.store.findRule(actor.tenantId, ruleId);
    if (!rule) return { ok: false, error: "That rule does not exist." };

    await this.store.removeRule(actor.tenantId, rule.id);
    // Kept on the chain after the row is gone: "this rule used to exist, and this
    // is what it did" is exactly the question an audit asks months later.
    await this.append(actor, "rule.delete", rule.id, {
      name: rule.name,
      trigger: rule.trigger,
      conditions: rule.conditions,
      actions: rule.actions,
    });
    return { ok: true, value: { id: rule.id } };
  }

  /* ------------------------------------------------------------- internals */

  private requireManage(actor: Actor): ServiceResult<never> | null {
    if (!hasPermission(actor.role, "rule:manage")) return { ok: false, error: "You do not manage the desk's rules." };
    return null;
  }

  private async append(actor: Actor, action: string, ruleId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "Rule",
      targetId: ruleId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** An in-memory store, used by tests and local development. */
export class MemoryRuleStore implements RuleStore {
  private readonly rules = new Map<string, RuleRecord>();

  async listRules(tenantId: string): Promise<RuleRecord[]> {
    return [...this.rules.values()].filter((rule) => rule.tenantId === tenantId).map((rule) => structuredClone(rule));
  }

  async findRule(tenantId: string, ruleId: string): Promise<RuleRecord | null> {
    const rule = this.rules.get(ruleId);
    return rule && rule.tenantId === tenantId ? structuredClone(rule) : null;
  }

  /** Case-insensitive, because two rules differing only in case are one rule. */
  async findRuleByName(tenantId: string, name: string): Promise<RuleRecord | null> {
    const wanted = name.trim().toLowerCase();
    const rule = [...this.rules.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.name.trim().toLowerCase() === wanted,
    );
    return rule ? structuredClone(rule) : null;
  }

  async insertRule(record: RuleRecord): Promise<void> {
    this.rules.set(record.id, structuredClone(record));
  }

  async updateRule(record: RuleRecord): Promise<void> {
    this.rules.set(record.id, structuredClone(record));
  }

  async removeRule(tenantId: string, ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (rule && rule.tenantId === tenantId) this.rules.delete(ruleId);
  }
}
