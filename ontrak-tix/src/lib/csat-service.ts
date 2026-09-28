/**
 * CSAT service (M1): requesting and recording satisfaction surveys.
 *
 * Two layers, as elsewhere: pure `plan*` decisions (who may ask, when a survey
 * may be answered) and a thin service that persists them through a store port.
 * The app implements the port against Prisma; tests use the in-memory store.
 */

import { randomUUID } from "node:crypto";

import { canReadTicket, type Actor } from "./access-rules";
import {
  csatStatus,
  shouldRequestSurvey,
  summariseCsat,
  validateCsatResponse,
  type CsatScore,
  type CsatStatus,
  type CsatSummary,
  type CsatSurvey,
} from "./csat-rules";
import type { TicketRecord } from "./ticket-service";

export interface SatisfactionRecord {
  id: string;
  tenantId: string;
  ticketId: string;
  token: string;
  score: CsatScore | null;
  comment: string | null;
  requestedAt: string;
  respondedAt: string | null;
}

export type CsatResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Injected so plans are deterministic under test. */
export interface CsatIds {
  id(): string;
  token(): string;
  now(): string;
}

export function systemCsatIds(): CsatIds {
  return { id: () => randomUUID(), token: () => randomUUID().replace(/-/g, ""), now: () => new Date().toISOString() };
}

/** The minimum a ticket must expose for a CSAT decision. */
export type CsatTicket = Pick<TicketRecord, "id" | "tenantId" | "status" | "resolvedAt" | "requesterId"> & {
  assigneeId?: string | null;
};

/**
 * Decide whether to create a survey for a ticket. Pure: no clock, no id, no
 * store — the caller supplies "has one been asked already?".
 */
export function planSurveyRequest(
  actor: Actor,
  ticket: CsatTicket,
  existing: SatisfactionRecord | null,
  ids: CsatIds,
): CsatResult<{ record: SatisfactionRecord; created: boolean }> {
  if (!canReadTicket(actor, ticket)) return { ok: false, error: "You do not have access to this ticket." };
  if (existing) return { ok: true, value: { record: existing, created: false } };
  if (!shouldRequestSurvey({ status: ticket.status, resolvedAt: ticket.resolvedAt }, false)) {
    return { ok: false, error: "A survey is only offered once a ticket is resolved." };
  }

  return {
    ok: true,
    value: {
      created: true,
      record: {
        id: ids.id(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        token: ids.token(),
        score: null,
        comment: null,
        requestedAt: ids.now(),
        respondedAt: null,
      },
    },
  };
}

/** Decide whether a survey can still be answered. Pure. */
export function planSurveyResponse(
  survey: SatisfactionRecord,
  score: unknown,
  comment: string | undefined,
  now: string,
): CsatResult<{ record: SatisfactionRecord }> {
  const status = csatStatus(toSurvey(survey), now);
  if (status === "answered") return { ok: false, error: "This survey has already been answered. Thank you." };
  if (status === "expired") return { ok: false, error: "This survey has expired." };

  const issues = validateCsatResponse(score, comment);
  if (issues.length > 0) return { ok: false, error: issues[0].message };

  return {
    ok: true,
    value: {
      record: {
        ...survey,
        score: score as CsatScore,
        comment: comment && comment.trim() ? comment.trim() : null,
        respondedAt: now,
      },
    },
  };
}

function toSurvey(record: SatisfactionRecord): CsatSurvey {
  return {
    token: record.token,
    requestedAt: record.requestedAt,
    respondedAt: record.respondedAt,
    score: record.score,
    comment: record.comment,
  };
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

export interface CsatStore {
  findByTicket(tenantId: string, ticketId: string): Promise<SatisfactionRecord | null>;
  findByToken(token: string): Promise<SatisfactionRecord | null>;
  listByTenant(tenantId: string): Promise<SatisfactionRecord[]>;
  insert(record: SatisfactionRecord): Promise<void>;
  update(record: SatisfactionRecord): Promise<void>;
}

export class CsatService {
  constructor(
    private readonly store: CsatStore,
    private readonly ids: CsatIds = systemCsatIds(),
  ) {}

  /** Fetch the survey for a ticket, if the caller may read the ticket. */
  async surveyFor(actor: Actor, ticket: CsatTicket): Promise<SatisfactionRecord | null> {
    if (!canReadTicket(actor, ticket)) return null;
    return this.store.findByTicket(ticket.tenantId, ticket.id);
  }

  /**
   * Idempotently request a survey for a resolved ticket. Calling it twice
   * returns the same survey rather than creating a second link.
   */
  async requestSurvey(actor: Actor, ticket: CsatTicket): Promise<CsatResult<SatisfactionRecord>> {
    const existing = await this.store.findByTicket(ticket.tenantId, ticket.id);
    const plan = planSurveyRequest(actor, ticket, existing, this.ids);
    if (!plan.ok) return plan;
    if (plan.value.created) await this.store.insert(plan.value.record);
    return { ok: true, value: plan.value.record };
  }

  /** Answer a survey by its token. The token is the only credential needed. */
  async submit(token: string, score: unknown, comment?: string): Promise<CsatResult<SatisfactionRecord>> {
    const survey = await this.store.findByToken(token);
    if (!survey) return { ok: false, error: "That survey link is not valid." };

    const plan = planSurveyResponse(survey, score, comment, this.ids.now());
    if (!plan.ok) return plan;
    await this.store.update(plan.value.record);
    return { ok: true, value: plan.value.record };
  }

  /** A tenant-wide satisfaction roll-up for reporting. */
  async summary(tenantId: string): Promise<CsatSummary> {
    const surveys = await this.store.listByTenant(tenantId);
    return summariseCsat(
      surveys.map(toSurvey),
      surveys.length,
    );
  }

  /**
   * Every survey in the tenant, for a report that needs to split them per
   * client rather than roll them up. Read-only: the caller decides what to show,
   * exactly as the single-ticket read does.
   */
  async list(tenantId: string): Promise<SatisfactionRecord[]> {
    return this.store.listByTenant(tenantId);
  }
}

/** The status of a survey link, for a page that is deciding what to render. */
export function surveyStatus(survey: SatisfactionRecord, now: string): CsatStatus {
  return csatStatus(toSurvey(survey), now);
}

/** An in-memory store, used by tests and local development. */
export class MemoryCsatStore implements CsatStore {
  private readonly byId = new Map<string, SatisfactionRecord>();

  async findByTicket(tenantId: string, ticketId: string): Promise<SatisfactionRecord | null> {
    for (const record of this.byId.values()) {
      if (record.tenantId === tenantId && record.ticketId === ticketId) return structuredClone(record);
    }
    return null;
  }

  async findByToken(token: string): Promise<SatisfactionRecord | null> {
    for (const record of this.byId.values()) {
      if (record.token === token) return structuredClone(record);
    }
    return null;
  }

  async listByTenant(tenantId: string): Promise<SatisfactionRecord[]> {
    return [...this.byId.values()].filter((record) => record.tenantId === tenantId).map((record) => structuredClone(record));
  }

  async insert(record: SatisfactionRecord): Promise<void> {
    this.byId.set(record.id, structuredClone(record));
  }

  async update(record: SatisfactionRecord): Promise<void> {
    this.byId.set(record.id, structuredClone(record));
  }
}
