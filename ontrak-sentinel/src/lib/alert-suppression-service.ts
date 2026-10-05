import { randomUUID } from "node:crypto";

import type { AuditSink } from "./audit-chain";
import type { ServiceResult } from "./identity-service";
import {
  activeSuppressions,
  matchSuppression,
  normalizeMatcher,
  suppressionIssue,
  type SuppressionCandidate,
  type SuppressionDraft,
  type SuppressionMatch,
  type SuppressionRule,
} from "./alert-suppression-rules";

/**
 * The mute, as a record with a life (S4): an operator creates a bounded window, the detector
 * consults it, and it is removed or simply expires.
 *
 * The rules module answers *what does this matcher cover, and is it in force* (`alert-suppression-
 * rules.ts`). This module is the part that stores it and answers the pipeline's question, and
 * two decisions are what make a mute something an incident review can live with:
 *
 *   * **A mute is audited like anything else.** Creating and removing one lands on the
 *     organization's evidence chain, because "we silenced that rule last Tuesday" is exactly
 *     the fact a review is trying to reconstruct — and a silence nobody can find is worse than
 *     the noise it removed.
 *   * **A suppressed detection is recorded, not forgotten.** The pipeline does not consult a
 *     boolean; it asks which rule caught it and why (`suppressionFor`), so the chain can say
 *     what was muted and by which window. An absence would be indistinguishable from a rule
 *     that stopped firing.
 *
 * What this module is **not**: the pipeline. It does not raise or drop anything; the detection
 * service asks it a question and records the answer.
 */

/* -------------------------------------------------------------------------- */
/*  The port                                                                  */
/* -------------------------------------------------------------------------- */

export interface SuppressionStore {
  saveRule(rule: SuppressionRule): Promise<void>;
  listRules(organizationId: string): Promise<SuppressionRule[]>;
  findRule(organizationId: string, ruleId: string): Promise<SuppressionRule | null>;
  removeRule(organizationId: string, ruleId: string): Promise<void>;
}

export interface SuppressionIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemSuppressionIds(): SuppressionIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class SuppressionService {
  constructor(
    private readonly store: SuppressionStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: SuppressionIds = systemSuppressionIds(),
  ) {}

  list(organizationId: string): Promise<SuppressionRule[]> {
    return this.store.listRules(organizationId);
  }

  /**
   * Create a mute.
   *
   * Refused rather than repaired when the draft is unusable: a matcher with no dimension, a
   * window that never ends and a window longer than a week are the three ways a mute becomes a
   * permanent, invisible detection gap, and each is answered with the sentence saying so.
   */
  async add(
    organizationId: string,
    draft: SuppressionDraft,
    by: { identityId: string; label: string },
  ): Promise<ServiceResult<SuppressionRule>> {
    const issue = suppressionIssue(draft);
    if (issue) return { ok: false, error: issue };

    const at = this.ids.now();
    const rule: SuppressionRule = {
      id: this.ids.id(),
      organizationId,
      name: draft.name.trim(),
      matcher: normalizeMatcher(draft.matcher),
      startsAt: new Date(Date.parse(draft.startsAt)).toISOString(),
      endsAt: new Date(Date.parse(draft.endsAt)).toISOString(),
      createdById: by.identityId,
      createdByLabel: by.label,
      createdAt: at,
    };
    await this.store.saveRule(rule);
    await this.append({
      id: this.ids.id(),
      at,
      actor: by.identityId,
      action: "guard.suppression.created",
      targetType: "Suppression",
      targetId: rule.id,
      detail: {
        organizationId,
        name: rule.name,
        matcher: rule.matcher,
        startsAt: rule.startsAt,
        endsAt: rule.endsAt,
      },
    });
    return { ok: true, value: rule };
  }

  /**
   * Remove a mute.
   *
   * Not just "set it to end now": the row is removed so the list an operator reads is the
   * windows that are actually in force, and the chain keeps the fact that it existed. Removing
   * a mute that is already gone is refused by name rather than silently succeeding, because a
   * second removal usually means somebody is looking at a stale page.
   */
  async remove(
    organizationId: string,
    ruleId: string,
    by: { identityId: string; label: string },
  ): Promise<ServiceResult<{ name: string }>> {
    const found = await this.store.findRule(organizationId, ruleId);
    if (!found) return { ok: false, error: "No such mute." };

    const at = this.ids.now();
    await this.store.removeRule(organizationId, ruleId);
    await this.append({
      id: this.ids.id(),
      at,
      actor: by.identityId,
      action: "guard.suppression.removed",
      targetType: "Suppression",
      targetId: ruleId,
      detail: { organizationId, name: found.name, endsAt: found.endsAt },
    });
    return { ok: true, value: { name: found.name } };
  }

  /* ------------------------------------------------------------- the query */

  /**
   * The rules in force right now, for the detection pipeline.
   *
   * This is the method that makes the service the pipeline's `SuppressionSource`: the detection
   * service calls it once per batch and asks `suppressionFor` about each draft, so a feed read
   * is not repeated per observation.
   */
  async activeSuppressions(organizationId: string, at: number): Promise<readonly SuppressionRule[]> {
    const rules = await this.store.listRules(organizationId);
    return activeSuppressions(rules, new Date(at).toISOString());
  }

  /**
   * Which active rule mutes this candidate, or `null`.
   *
   * Reads the rules fresh rather than taking an already-filtered list, because this is the
   * entry point a caller that has one draft uses, and the two entry points must not disagree
   * about what is in force.
   */
  async suppressionFor(
    organizationId: string,
    candidate: SuppressionCandidate,
    at: number,
  ): Promise<SuppressionMatch | null> {
    const rules = await this.activeSuppressions(organizationId, at);
    return matchSuppression(candidate, rules, new Date(at).toISOString());
  }

  private async append(input: Parameters<AuditSink["append"]>[0]): Promise<void> {
    if (!this.audit) return;
    await this.audit.append(input);
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and the memory-mode server              */
/* -------------------------------------------------------------------------- */

export class MemorySuppressionStore implements SuppressionStore {
  private readonly rules = new Map<string, SuppressionRule>();

  async saveRule(rule: SuppressionRule): Promise<void> {
    this.rules.set(`${rule.organizationId}:${rule.id}`, { ...rule, matcher: { ...rule.matcher } });
  }

  async listRules(organizationId: string): Promise<SuppressionRule[]> {
    return [...this.rules.values()]
      .filter((rule) => rule.organizationId === organizationId)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((rule) => ({ ...rule, matcher: { ...rule.matcher } }));
  }

  async findRule(organizationId: string, ruleId: string): Promise<SuppressionRule | null> {
    const found = this.rules.get(`${organizationId}:${ruleId}`);
    return found ? { ...found, matcher: { ...found.matcher } } : null;
  }

  async removeRule(organizationId: string, ruleId: string): Promise<void> {
    this.rules.delete(`${organizationId}:${ruleId}`);
  }
}
