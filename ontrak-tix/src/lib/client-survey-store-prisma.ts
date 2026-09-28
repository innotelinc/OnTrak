/**
 * Prisma adapter for client-level surveys (M4).
 *
 * The period is held as two dates at midnight UTC and read back as `YYYY-MM-DD`,
 * for the same reason a work day is: a survey that asked about "August" and
 * answered about "July" because a server sits in another timezone would be worse
 * than no survey.
 */

import type { ClientSurveyRecord } from "./client-survey-rules";
import type { ClientSurveyStore } from "./client-survey-service";
import { fromWorkDate, toWorkDate } from "./time-store-prisma";
import type { CsatScore } from "./csat-rules";

export interface ClientSurveyRow {
  id: string;
  tenantId: string;
  clientId: string;
  token: string;
  periodStart: Date;
  periodEnd: Date;
  requestedBy: string;
  requestedAt: Date;
  score: number | null;
  comment: string | null;
  respondedAt: Date | null;
}

export interface ClientSurveyPrismaClient {
  clientSurvey: {
    findMany(args: unknown): Promise<ClientSurveyRow[]>;
    findFirst(args: unknown): Promise<ClientSurveyRow | null>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toClientSurveyRecord(row: ClientSurveyRow): ClientSurveyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    token: row.token,
    periodStart: toWorkDate(row.periodStart),
    periodEnd: toWorkDate(row.periodEnd),
    requestedBy: row.requestedBy,
    requestedAt: toIso(row.requestedAt),
    // Narrowed on the way out like every other adapter result: a hand-edited
    // score of 9 must not become a rating the report believes.
    score: row.score === null || row.score < 1 || row.score > 5 ? null : (row.score as CsatScore),
    comment: row.comment,
    respondedAt: row.respondedAt === null ? null : toIso(row.respondedAt),
  };
}

export class PrismaClientSurveyStore implements ClientSurveyStore {
  constructor(private readonly db: ClientSurveyPrismaClient) {}

  async list(tenantId: string, clientId?: string): Promise<ClientSurveyRecord[]> {
    const rows = await this.db.clientSurvey.findMany({
      where: clientId === undefined ? { tenantId } : { tenantId, clientId },
      orderBy: { requestedAt: "desc" },
    });
    return rows.map(toClientSurveyRecord);
  }

  async findByToken(token: string): Promise<ClientSurveyRecord | null> {
    const row = await this.db.clientSurvey.findFirst({ where: { token } });
    return row ? toClientSurveyRecord(row) : null;
  }

  async findForPeriod(
    tenantId: string,
    clientId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ClientSurveyRecord | null> {
    const row = await this.db.clientSurvey.findFirst({
      where: { tenantId, clientId, periodStart: fromWorkDate(periodStart), periodEnd: fromWorkDate(periodEnd) },
    });
    return row ? toClientSurveyRecord(row) : null;
  }

  async insert(record: ClientSurveyRecord): Promise<void> {
    await this.db.clientSurvey.create({ data: surveyData(record) });
  }

  async update(record: ClientSurveyRecord): Promise<void> {
    await this.db.clientSurvey.update({ where: { id: record.id }, data: surveyData(record) });
  }
}

function surveyData(record: ClientSurveyRecord): Record<string, unknown> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    clientId: record.clientId,
    token: record.token,
    periodStart: fromWorkDate(record.periodStart),
    periodEnd: fromWorkDate(record.periodEnd),
    requestedBy: record.requestedBy,
    requestedAt: new Date(record.requestedAt),
    score: record.score,
    comment: record.comment,
    respondedAt: record.respondedAt === null ? null : new Date(record.respondedAt),
  };
}
