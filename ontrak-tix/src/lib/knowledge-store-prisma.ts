/**
 * Prisma adapter for the knowledge base (M5).
 *
 * Same split as the other adapters: the port speaks domain records with ISO
 * strings and `PUBLIC`/`PRIVATE`, this file owns the row, the `Date`
 * conversions and the enum spelling, and nothing here decides anything.
 */

import type { ArticleVisibility, KnowledgeArticle } from "./knowledge-rules";
import type { KnowledgeStore } from "./knowledge-service";

export interface KnowledgeArticleRow {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  visibility: string;
  tags: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgePrismaClient {
  knowledgeArticle: {
    findFirst(args: unknown): Promise<KnowledgeArticleRow | null>;
    findMany(args: unknown): Promise<KnowledgeArticleRow[]>;
    create(args: { data: unknown }): Promise<unknown>;
    update(args: { where: unknown; data: unknown }): Promise<unknown>;
    deleteMany(args: { where: unknown }): Promise<unknown>;
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** An unknown visibility is treated as private, because private is the safe side. */
function asVisibility(value: unknown): ArticleVisibility {
  return value === "PUBLIC" ? "PUBLIC" : "PRIVATE";
}

export function toArticleRecord(row: KnowledgeArticleRow): KnowledgeArticle {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    body: row.body,
    visibility: asVisibility(row.visibility),
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PrismaKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: KnowledgePrismaClient) {}

  async listArticles(tenantId: string): Promise<KnowledgeArticle[]> {
    const rows = await this.db.knowledgeArticle.findMany({ where: { tenantId }, orderBy: { updatedAt: "desc" } });
    return rows.map(toArticleRecord);
  }

  async findArticle(tenantId: string, articleId: string): Promise<KnowledgeArticle | null> {
    const row = await this.db.knowledgeArticle.findFirst({ where: { tenantId, id: articleId } });
    return row ? toArticleRecord(row) : null;
  }

  /** Case-insensitive, matching the service's uniqueness rule. */
  async findArticleByTitle(tenantId: string, title: string): Promise<KnowledgeArticle | null> {
    const row = await this.db.knowledgeArticle.findFirst({
      where: { tenantId, title: { equals: title.trim(), mode: "insensitive" } },
    });
    return row ? toArticleRecord(row) : null;
  }

  async insertArticle(record: KnowledgeArticle): Promise<void> {
    await this.db.knowledgeArticle.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        title: record.title,
        body: record.body,
        visibility: record.visibility,
        tags: [...record.tags],
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async updateArticle(record: KnowledgeArticle): Promise<void> {
    await this.db.knowledgeArticle.update({
      where: { id: record.id },
      data: {
        title: record.title,
        body: record.body,
        visibility: record.visibility,
        tags: [...record.tags],
        updatedAt: new Date(record.updatedAt),
      },
    });
  }

  async removeArticle(tenantId: string, articleId: string): Promise<void> {
    // A tenant-scoped delete, so a cross-tenant id deletes nothing rather than
    // relying on the caller having checked first.
    await this.db.knowledgeArticle.deleteMany({ where: { tenantId, id: articleId } });
  }
}
