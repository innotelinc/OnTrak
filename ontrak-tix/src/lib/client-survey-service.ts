/**
 * Client survey service (M4): asking a client's own people how the desk did, and
 * recording the answer.
 *
 * The public half is the point. `open` and `submit` take no actor — the token is
 * the credential — because the person who signs the invoice should not need a
 * portal account to say whether they are happy, and because a survey behind a
 * sign-in is answered by whoever happens to have one. That makes the token two
 * things at once: an unguessable link, and the audit trail's explanation of who
 * could have answered.
 *
 * Everything a survey touches is recorded twice over: the row (so the console can
 * show what was asked and what came back) and the chain (`client.survey.request`,
 * `client.survey.respond`), so "when did we last ask them, and what did they say"
 * is a question with an answer.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import type { ClientService } from "./client-service";
import { canSeeClient } from "./client-rules";
import {
  CLIENT_SURVEY_TTL_DAYS,
  clientSurveyStatus,
  validateCsatResponse,
  validateSurveyPeriod,
  type ClientSurveyRecord,
} from "./client-survey-rules";
import type { CsatScore } from "./csat-rules";
import type { ServiceResult } from "./ticket-service";

export interface ClientSurveyStore {
  list(tenantId: string, clientId?: string): Promise<ClientSurveyRecord[]>;
  findByToken(token: string): Promise<ClientSurveyRecord | null>;
  findForPeriod(tenantId: string, clientId: string, periodStart: string, periodEnd: string): Promise<ClientSurveyRecord | null>;
  insert(record: ClientSurveyRecord): Promise<void>;
  update(record: ClientSurveyRecord): Promise<void>;
}

export interface ClientSurveyIds {
  id(): string;
  token(): string;
  now(): string;
}

export function systemClientSurveyIds(): ClientSurveyIds {
  return {
    id: () => randomUUID(),
    token: () => randomUUID().replace(/-/g, ""),
    now: () => new Date().toISOString(),
  };
}

export class ClientSurveyService {
  constructor(
    private readonly store: ClientSurveyStore,
    private readonly clients: ClientService,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ClientSurveyIds = systemClientSurveyIds(),
  ) {}

  /**
   * Ask a client for a rating, once per period. Asking again for a period that
   * has already been asked returns the existing link rather than a second one —
   * a client answering twice would make the average meaningless.
   */
  async request(
    actor: Actor,
    clientId: string,
    input: { periodStart: string; periodEnd: string },
  ): Promise<ServiceResult<ClientSurveyRecord>> {
    if (!actorHasPermission(actor, "client:manage")) {
      return { ok: false, error: "You do not manage clients." };
    }
    // The id comes from a form, and a form is a suggestion: the client has to be
    // one of this desk's, in the actor's scope, or the survey would be a live
    // public link to nothing.
    const known = await this.clients.list(actor);
    if (!known.ok) return known;
    if (!known.value.some((entry) => entry.client.id === clientId)) {
      return { ok: false, error: "Client not found." };
    }

    const issues = validateSurveyPeriod(input, this.ids.now().slice(0, 10));
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const existing = await this.store.findForPeriod(actor.tenantId, clientId, input.periodStart, input.periodEnd);
    if (existing) return { ok: true, value: existing };

    const record: ClientSurveyRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId,
      token: this.ids.token(),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      requestedBy: actor.id,
      requestedAt: this.ids.now(),
      score: null,
      comment: null,
      respondedAt: null,
    };

    await this.store.insert(record);
    await this.append(actor.tenantId, "client.survey.request", record, actor.id, {
      requestedBy: actor.id,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
    });
    return { ok: true, value: record };
  }

  /** The surveys asked of one client, newest first. */
  async list(actor: Actor, clientId: string): Promise<ServiceResult<ClientSurveyRecord[]>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's surveys." };
    }
    if (!(await this.clients.canSee(actor, clientId))) {
      return { ok: false, error: "That client is not in your scope." };
    }
    const records = await this.store.list(actor.tenantId, clientId);
    return { ok: true, value: records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) };
  }

  /** Every survey the actor may see, for the per-client report. */
  async all(actor: Actor): Promise<ServiceResult<ClientSurveyRecord[]>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the desk's surveys." };
    }
    const scope = await this.clients.scope(actor);
    const records = await this.store.list(actor.tenantId);
    return { ok: true, value: records.filter((record) => canSeeClient(scope, record.clientId)) };
  }

  /**
   * Read a survey by its token. No actor: the token is the credential, and this
   * is the call the public page makes for somebody who has never signed in.
   */
  async open(token: string): Promise<ClientSurveyRecord | null> {
    if (!token) return null;
    return this.store.findByToken(token);
  }

  /** Whether a link can still be answered, so a page can say why it cannot. */
  status(record: ClientSurveyRecord): ReturnType<typeof clientSurveyStatus> {
    return clientSurveyStatus(record, this.ids.now());
  }

  /**
   * Record an answer from the link. One answer per survey: a link that could be
   * answered twice would let one person move the average.
   */
  async submit(token: string, score: unknown, comment?: string): Promise<ServiceResult<ClientSurveyRecord>> {
    const survey = await this.store.findByToken(token);
    if (!survey) return { ok: false, error: "That survey link is not valid." };

    const status = clientSurveyStatus(survey, this.ids.now(), CLIENT_SURVEY_TTL_DAYS);
    if (status === "answered") return { ok: false, error: "This survey has already been answered. Thank you." };
    if (status === "expired") return { ok: false, error: "This survey link has expired." };

    const issues = validateCsatResponse(score, comment);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const answered: ClientSurveyRecord = {
      ...survey,
      score: score as CsatScore,
      comment: comment && comment.trim() ? comment.trim() : null,
      respondedAt: this.ids.now(),
    };
    await this.store.update(answered);
    await this.append(survey.tenantId, "client.survey.respond", answered, "client:survey", {
      score: answered.score,
      periodStart: answered.periodStart,
      periodEnd: answered.periodEnd,
      hasComment: answered.comment !== null,
    });
    return { ok: true, value: answered };
  }

  /* ------------------------------------------------------------- internals */

  private async append(
    tenantId: string,
    action: string,
    record: ClientSurveyRecord,
    actorId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId,
      at: this.ids.now(),
      actor: actorId,
      action,
      targetType: "client-survey",
      targetId: record.id,
      detail: { clientId: record.clientId, ...detail },
    };
    await this.audit.append(event);
  }
}

/** An in-memory store, used by tests and local development. */
export class MemoryClientSurveyStore implements ClientSurveyStore {
  private readonly surveys = new Map<string, ClientSurveyRecord>();

  async list(tenantId: string, clientId?: string): Promise<ClientSurveyRecord[]> {
    return [...this.surveys.values()]
      .filter((record) => record.tenantId === tenantId && (clientId === undefined || record.clientId === clientId))
      .map((record) => structuredClone(record));
  }

  async findByToken(token: string): Promise<ClientSurveyRecord | null> {
    const found = [...this.surveys.values()].find((record) => record.token === token);
    return found ? structuredClone(found) : null;
  }

  async findForPeriod(
    tenantId: string,
    clientId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ClientSurveyRecord | null> {
    const found = [...this.surveys.values()].find(
      (record) =>
        record.tenantId === tenantId &&
        record.clientId === clientId &&
        record.periodStart === periodStart &&
        record.periodEnd === periodEnd,
    );
    return found ? structuredClone(found) : null;
  }

  async insert(record: ClientSurveyRecord): Promise<void> {
    this.surveys.set(record.id, structuredClone(record));
  }

  async update(record: ClientSurveyRecord): Promise<void> {
    this.surveys.set(record.id, structuredClone(record));
  }
}
