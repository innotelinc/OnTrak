/**
 * Knowledge service (M5): the articles a desk keeps, and who may write them.
 *
 * `knowledge-rules.ts` owns the decisions — validation, what a tag is, and how a
 * query is matched — and this file stores the result and records it. Two choices:
 *
 *  - **Authoring is `ticket:update`**, the same bar the canned responses carry.
 *    A public article is customer-visible content, like a canned reply, so the
 *    people who write the desk's words are the people who may publish them.
 *  - **Every write is audited, and publishing is its own event.** A visibility
 *    flip from private to public is the moment something became readable by a
 *    customer, so it is recorded as `knowledge.publish` rather than buried in an
 *    ordinary edit — the question "who made this public?" deserves its own line.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  articleHazards,
  suggestArticles,
  validateArticle,
  type ArticleSuggestion,
  type ArticleVisibility,
  type KnowledgeArticle,
} from "./knowledge-rules";
import type { ServiceResult } from "./ticket-service";

export interface KnowledgeStore {
  listArticles(tenantId: string): Promise<KnowledgeArticle[]>;
  findArticle(tenantId: string, articleId: string): Promise<KnowledgeArticle | null>;
  findArticleByTitle(tenantId: string, title: string): Promise<KnowledgeArticle | null>;
  insertArticle(record: KnowledgeArticle): Promise<void>;
  updateArticle(record: KnowledgeArticle): Promise<void>;
  removeArticle(tenantId: string, articleId: string): Promise<void>;
}

export interface KnowledgeIds {
  id(): string;
  now(): string;
}

export function systemKnowledgeIds(): KnowledgeIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** What a console needs to render one article: the record, plus what to warn about. */
export interface ArticleOverview {
  article: KnowledgeArticle;
  hazards: string[];
}

export interface ArticleInput {
  title?: string;
  body?: string;
  visibility?: string;
  tags?: readonly string[];
}

export class KnowledgeService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: KnowledgeIds = systemKnowledgeIds(),
  ) {}

  /* ------------------------------------------------------------- reading */

  /** Every article the tenant keeps, for the console. Most recently changed first. */
  async list(actor: Actor): Promise<ServiceResult<ArticleOverview[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the knowledge base." };
    }
    const articles = await this.store.listArticles(actor.tenantId);
    return {
      ok: true,
      value: [...articles]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
        .map((article) => ({ article, hazards: articleHazards(article) })),
    };
  }

  async find(tenantId: string, articleId: string): Promise<KnowledgeArticle | null> {
    return this.store.findArticle(tenantId, articleId);
  }

  /**
   * Suggestions for a requester: **public articles only**, and no account.
   *
   * The portal is the one surface a stranger reaches, so the private/public
   * check is the rules function's, not this method's — there is one place that
   * decides what a requester may see.
   */
  async suggestPublic(tenantId: string, query: string): Promise<ArticleSuggestion[]> {
    const articles = await this.store.listArticles(tenantId);
    return suggestArticles(articles, query, { includePrivate: false });
  }

  /** Suggestions for staff, who may also be shown an article that is not public. */
  async suggestForStaff(actor: Actor, query: string): Promise<ServiceResult<ArticleSuggestion[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the knowledge base." };
    }
    const articles = await this.store.listArticles(actor.tenantId);
    return { ok: true, value: suggestArticles(articles, query, { includePrivate: true }) };
  }

  /* ------------------------------------------------------------- writing */

  async create(actor: Actor, input: ArticleInput): Promise<ServiceResult<KnowledgeArticle>> {
    const denied = this.requireAuthor(actor);
    if (denied) return denied;

    const issues = validateArticle(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const title = input.title!.trim();
    if (await this.store.findArticleByTitle(actor.tenantId, title)) {
      return { ok: false, error: `An article called “${title}” already exists.` };
    }

    const now = this.ids.now();
    const record: KnowledgeArticle = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      title,
      body: input.body!.trim(),
      visibility: input.visibility as ArticleVisibility,
      tags: normalizeTags(input.tags),
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insertArticle(record);
    await this.append(actor, record.visibility === "PUBLIC" ? "knowledge.publish" : "knowledge.create", record.id, {
      title: record.title,
      visibility: record.visibility,
      tags: record.tags,
    });
    return { ok: true, value: record };
  }

  async update(actor: Actor, articleId: string, input: ArticleInput): Promise<ServiceResult<KnowledgeArticle>> {
    const denied = this.requireAuthor(actor);
    if (denied) return denied;

    const article = await this.store.findArticle(actor.tenantId, articleId);
    if (!article) return { ok: false, error: "That article does not exist." };

    const merged: ArticleInput = {
      title: input.title ?? article.title,
      body: input.body ?? article.body,
      visibility: input.visibility ?? article.visibility,
      tags: input.tags ?? article.tags,
    };

    const issues = validateArticle(merged);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const title = merged.title!.trim();
    const clash = await this.store.findArticleByTitle(actor.tenantId, title);
    if (clash && clash.id !== article.id) {
      return { ok: false, error: `An article called “${title}” already exists.` };
    }

    const next: KnowledgeArticle = {
      ...article,
      title,
      body: merged.body!.trim(),
      visibility: merged.visibility as ArticleVisibility,
      tags: normalizeTags(merged.tags),
      updatedAt: this.ids.now(),
    };

    await this.store.updateArticle(next);
    // A private article becoming public is a different event from an edit: it is
    // the moment a customer could read it.
    const action =
      article.visibility !== "PUBLIC" && next.visibility === "PUBLIC"
        ? "knowledge.publish"
        : article.visibility === "PUBLIC" && next.visibility !== "PUBLIC"
          ? "knowledge.unpublish"
          : "knowledge.update";
    await this.append(actor, action, article.id, {
      title: next.title,
      visibility: next.visibility,
      tags: next.tags,
    });
    return { ok: true, value: next };
  }

  async remove(actor: Actor, articleId: string): Promise<ServiceResult<{ id: string }>> {
    const denied = this.requireAuthor(actor);
    if (denied) return denied;

    const article = await this.store.findArticle(actor.tenantId, articleId);
    if (!article) return { ok: false, error: "That article does not exist." };

    await this.store.removeArticle(actor.tenantId, article.id);
    // Kept on the chain after the row is gone, so "what did it say when it was
    // shown to that customer?" still has an answer.
    await this.append(actor, "knowledge.remove", article.id, {
      title: article.title,
      visibility: article.visibility,
      tags: article.tags,
    });
    return { ok: true, value: { id: article.id } };
  }

  /* ------------------------------------------------------------- internals */

  private requireAuthor(actor: Actor): ServiceResult<never> | null {
    if (!hasPermission(actor.role, "ticket:update")) return { ok: false, error: "You do not manage the knowledge base." };
    return null;
  }

  private async append(actor: Actor, action: string, articleId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "KnowledgeArticle",
      targetId: articleId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** Trim, de-duplicate case-insensitively and drop blanks. */
function normalizeTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const tag of tags ?? []) {
    const trimmed = tag.trim().replace(/\s+/g, " ");
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    clean.push(trimmed);
  }
  return clean;
}

/** An in-memory store, used by tests and local development. */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly articles = new Map<string, KnowledgeArticle>();

  async listArticles(tenantId: string): Promise<KnowledgeArticle[]> {
    return [...this.articles.values()]
      .filter((article) => article.tenantId === tenantId)
      .map((article) => structuredClone(article));
  }

  async findArticle(tenantId: string, articleId: string): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(articleId);
    return article && article.tenantId === tenantId ? structuredClone(article) : null;
  }

  /** Case-insensitive, because two articles differing only in case are one article. */
  async findArticleByTitle(tenantId: string, title: string): Promise<KnowledgeArticle | null> {
    const wanted = title.trim().toLowerCase();
    const article = [...this.articles.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.title.trim().toLowerCase() === wanted,
    );
    return article ? structuredClone(article) : null;
  }

  async insertArticle(record: KnowledgeArticle): Promise<void> {
    this.articles.set(record.id, structuredClone(record));
  }

  async updateArticle(record: KnowledgeArticle): Promise<void> {
    this.articles.set(record.id, structuredClone(record));
  }

  async removeArticle(tenantId: string, articleId: string): Promise<void> {
    const article = this.articles.get(articleId);
    if (article && article.tenantId === tenantId) this.articles.delete(articleId);
  }
}
