/**
 * Macro service (M5): the shortcuts a desk keeps, and who may change them.
 *
 * The split matches the rules engine: `macro-rules.ts` decides everything (what
 * a macro may be, what it would do, what is worth warning about) and this file
 * only stores the result and records it.
 *
 * Two decisions are worth stating out loud:
 *
 *  - **A macro is configuration, not data.** Running one is an agent's ordinary
 *    work and needs `ticket:update`; *writing* one changes what every agent can
 *    do at a click, so it needs `rule:manage`, the same permission a rule does.
 *    The two are the same power pointed at one ticket instead of at all of them.
 *  - **Names are unique case-insensitively**, the same rule rules and SLA
 *    policies follow. Two macros called "Escalate to L2" are a support ticket of
 *    their own: an agent cannot tell from the picker which one they are running.
 *
 * Every write is audited with the macro's whole body, so "who made one click
 * reassign this to the network team?" has an answer on the chain.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import { macroHazards, validateMacro, type MacroRecord } from "./macro-rules";
import type { RuleAction } from "./rule-rules";
import type { ServiceResult } from "./ticket-service";

export interface MacroStore {
  listMacros(tenantId: string): Promise<MacroRecord[]>;
  findMacro(tenantId: string, macroId: string): Promise<MacroRecord | null>;
  findMacroByName(tenantId: string, name: string): Promise<MacroRecord | null>;
  insertMacro(record: MacroRecord): Promise<void>;
  updateMacro(record: MacroRecord): Promise<void>;
  removeMacro(tenantId: string, macroId: string): Promise<void>;
}

export interface MacroIds {
  id(): string;
  now(): string;
}

export function systemMacroIds(): MacroIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What a console needs to render one macro: the record, plus what to warn about. */
export interface MacroOverview {
  macro: MacroRecord;
  hazards: string[];
}

export interface MacroInput {
  name?: string;
  description?: string;
  actions?: readonly RuleAction[];
}

export class MacroService {
  constructor(
    private readonly store: MacroStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: MacroIds = systemMacroIds(),
  ) {}

  /* ------------------------------------------------------------- reading */

  /** Every macro the tenant keeps, name-ordered — the order the picker shows. */
  async list(actor: Actor): Promise<ServiceResult<MacroOverview[]>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's macros." };
    }
    const macros = await this.store.listMacros(actor.tenantId);
    return {
      ok: true,
      value: [...macros]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((macro) => ({ macro, hazards: macroHazards(macro) })),
    };
  }

  /**
   * One macro, by id, with no actor.
   *
   * This is what the intake path resolves a chosen macro through: the agent has
   * already been checked against the ticket, and the macro is named by id, so
   * there is no second access question to answer here.
   */
  async find(tenantId: string, macroId: string): Promise<MacroRecord | null> {
    return this.store.findMacro(tenantId, macroId);
  }

  /* ------------------------------------------------------------- writing */

  async create(actor: Actor, input: MacroInput): Promise<ServiceResult<MacroRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const issues = validateMacro(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name!.trim();
    if (await this.store.findMacroByName(actor.tenantId, name)) {
      return { ok: false, error: `A macro called “${name}” already exists.` };
    }

    const now = this.ids.now();
    const record: MacroRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      name,
      description: input.description?.trim() ?? "",
      actions: input.actions ?? [],
      enabled: true,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insertMacro(record);
    await this.append(actor, "macro.create", record.id, {
      name: record.name,
      description: record.description,
      actions: record.actions,
    });
    return { ok: true, value: record };
  }

  async update(actor: Actor, macroId: string, input: MacroInput): Promise<ServiceResult<MacroRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const macro = await this.store.findMacro(actor.tenantId, macroId);
    if (!macro) return { ok: false, error: "That macro does not exist." };

    const merged: MacroInput = {
      name: input.name ?? macro.name,
      description: input.description ?? macro.description,
      actions: input.actions ?? macro.actions,
    };

    const issues = validateMacro(merged);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = merged.name!.trim();
    const clash = await this.store.findMacroByName(actor.tenantId, name);
    if (clash && clash.id !== macro.id) {
      return { ok: false, error: `A macro called “${name}” already exists.` };
    }

    const next: MacroRecord = {
      ...macro,
      name,
      description: merged.description?.trim() ?? "",
      actions: merged.actions ?? [],
      updatedAt: this.ids.now(),
    };

    await this.store.updateMacro(next);
    await this.append(actor, "macro.update", macro.id, {
      name: next.name,
      description: next.description,
      // The whole body, because the question the chain has to answer is what the
      // macro did *after* the change, not which field moved.
      actions: next.actions,
    });
    return { ok: true, value: next };
  }

  /** Switch a macro on or off. A switch-off retires it without losing its history. */
  async setEnabled(actor: Actor, macroId: string, enabled: boolean): Promise<ServiceResult<MacroRecord>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const macro = await this.store.findMacro(actor.tenantId, macroId);
    if (!macro) return { ok: false, error: "That macro does not exist." };

    const next: MacroRecord = { ...macro, enabled, updatedAt: this.ids.now() };
    await this.store.updateMacro(next);
    await this.append(actor, enabled ? "macro.enable" : "macro.disable", macro.id, { name: macro.name });
    return { ok: true, value: next };
  }

  async remove(actor: Actor, macroId: string): Promise<ServiceResult<{ id: string }>> {
    const denied = this.requireManage(actor);
    if (denied) return denied;

    const macro = await this.store.findMacro(actor.tenantId, macroId);
    if (!macro) return { ok: false, error: "That macro does not exist." };

    await this.store.removeMacro(actor.tenantId, macro.id);
    // Kept on the chain after the row is gone: "this macro used to exist, and
    // this is what one click did" is exactly the question an audit asks later.
    await this.append(actor, "macro.delete", macro.id, {
      name: macro.name,
      description: macro.description,
      actions: macro.actions,
    });
    return { ok: true, value: { id: macro.id } };
  }

  /* ------------------------------------------------------------- internals */

  private requireManage(actor: Actor): ServiceResult<never> | null {
    if (!actorHasPermission(actor, "rule:manage")) return { ok: false, error: "You do not manage the desk's macros." };
    return null;
  }

  private async append(actor: Actor, action: string, macroId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "Macro",
      targetId: macroId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** An in-memory store, used by tests and local development. */
export class MemoryMacroStore implements MacroStore {
  private readonly macros = new Map<string, MacroRecord>();

  async listMacros(tenantId: string): Promise<MacroRecord[]> {
    return [...this.macros.values()].filter((macro) => macro.tenantId === tenantId).map((macro) => structuredClone(macro));
  }

  async findMacro(tenantId: string, macroId: string): Promise<MacroRecord | null> {
    const macro = this.macros.get(macroId);
    return macro && macro.tenantId === tenantId ? structuredClone(macro) : null;
  }

  /** Case-insensitive, because two macros differing only in case are one macro. */
  async findMacroByName(tenantId: string, name: string): Promise<MacroRecord | null> {
    const wanted = name.trim().toLowerCase();
    const macro = [...this.macros.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.name.trim().toLowerCase() === wanted,
    );
    return macro ? structuredClone(macro) : null;
  }

  async insertMacro(record: MacroRecord): Promise<void> {
    this.macros.set(record.id, structuredClone(record));
  }

  async updateMacro(record: MacroRecord): Promise<void> {
    this.macros.set(record.id, structuredClone(record));
  }

  async removeMacro(tenantId: string, macroId: string): Promise<void> {
    const macro = this.macros.get(macroId);
    if (macro && macro.tenantId === tenantId) this.macros.delete(macroId);
  }
}
