"use server";

/**
 * Knowledge console actions (M5): the app-facing entry points for `/knowledge`.
 *
 * Like every other console, these only marshal form data and translate a
 * `ServiceResult` into a redirect; the permission (`ticket:update`), the
 * validation and the audit event belong to `KnowledgeService`.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { knowledgeServicesFor } from "../../lib/db";
import { parseTags } from "../../lib/knowledge-rules";

const HOME = "/knowledge";

function fail(message: string): never {
  redirect(`${HOME}?error=${encodeURIComponent(message)}`);
}

function done(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?flash=${encodeURIComponent(message)}`);
}

/** Write an article from the console form. A hidden `articleId` means edit. */
export async function saveArticleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const articleId = String(formData.get("articleId") ?? "").trim();
  const input = {
    title: String(formData.get("title") ?? ""),
    body: String(formData.get("body") ?? ""),
    visibility: String(formData.get("visibility") ?? ""),
    tags: parseTags(String(formData.get("tags") ?? "")),
  };

  const result = articleId
    ? await knowledgeServicesFor().update(actor, articleId, input)
    : await knowledgeServicesFor().create(actor, input);

  if (!result.ok) fail(result.error);
  done(`Article “${result.value.title}” saved`);
}

/**
 * Flip an article between public and staff-only.
 *
 * This is the one edit that changes who can read it, so it gets its own control
 * rather than hiding inside the edit form; the service records a publish or an
 * unpublish rather than an ordinary update.
 */
export async function setArticleVisibilityAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const articleId = String(formData.get("articleId") ?? "");
  const visibility = String(formData.get("visibility") ?? "");
  if (!articleId) fail("Choose an article first.");

  const result = await knowledgeServicesFor().update(actor, articleId, { visibility });
  if (!result.ok) fail(result.error);
  done(`${visibility === "PUBLIC" ? "Published" : "Made staff-only"}: ${result.value.title}`);
}

/** Remove an article. What it said stays on the audit chain. */
export async function removeArticleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const articleId = String(formData.get("articleId") ?? "");
  if (!articleId) fail("Choose an article first.");

  const result = await knowledgeServicesFor().remove(actor, articleId);
  if (!result.ok) fail(result.error);
  done("Article removed");
}
