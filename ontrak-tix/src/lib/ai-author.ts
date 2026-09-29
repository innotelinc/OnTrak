/**
 * The author: who writes the draft.
 *
 * ONE INTERFACE, ANY MODEL, AND A GUARANTEED ANSWER.
 *
 * The model call is the generic OpenAI *chat-completions* shape, configured by
 * environment. That is deliberately the least exotic thing available: it works
 * unchanged against OpenAI, Azure OpenAI, OpenRouter, Groq, a vLLM box, an Ollama
 * daemon, LiteLLM, or the organization's own gateway — which is what a self-hosted
 * Network actually runs, and it is the difference between "we chose a vendor" and
 * "we can change our mind". Nothing in this file imports a vendor SDK, and nothing
 * else in the product knows a model exists.
 *
 * When no key is set — which is most deployments, and every air-gapped one — the
 * deterministic author writes the draft instead. When a key *is* set and the call
 * fails, times out, or answers with something that is not the JSON it was asked
 * for, the same thing happens, and the reason travels with the draft so nobody has
 * to guess why an article reads like a template.
 *
 * It never throws. A resolution is a fact about the desk's day; a writer that can
 * fail a resolution is a writer that will.
 */

import {
  buildAuthorPrompt,
  deterministicOutcome,
  parseAuthorResponse,
  type ArticleVisibility,
  type OutcomeDraft,
  type OutcomeTranscript,
} from "./outcome-rules";

export interface AuthorConfig {
  /** `<base>/chat/completions` is called; the trailing slash is not needed. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** How long to wait before falling back to the template. */
  timeoutMs: number;
  /** Set to `0` to force the deterministic author even when a key is present. */
  enabled: boolean;
}

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read the author's settings.
 *
 * `ONTRAK_AI_API_KEY` is the only thing that has to be set; the base URL and model
 * have defaults that work, and `ONTRAK_AI_ENABLED=0` turns the model off without
 * removing the key — which is what a deployment wants while it is deciding whether
 * the drafts are good enough.
 */
export function authorConfig(env: Record<string, string | undefined> = process.env): AuthorConfig {
  const apiKey = (env.ONTRAK_AI_API_KEY ?? "").trim();
  return {
    baseUrl: (env.ONTRAK_AI_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey,
    model: (env.ONTRAK_AI_MODEL ?? DEFAULT_MODEL).trim(),
    timeoutMs: Number(env.ONTRAK_AI_TIMEOUT_MS ?? "") > 0 ? Number(env.ONTRAK_AI_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    enabled: apiKey.length > 0 && (env.ONTRAK_AI_ENABLED ?? "1") !== "0",
  };
}

export interface AuthorDeps {
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  config?: AuthorConfig;
  /** The visibility the caller wants the article to carry. */
  visibility?: ArticleVisibility;
}

/**
 * Write the draft for one resolved ticket.
 *
 * The returned `source` says which author answered, and `note` carries the reason
 * when a configured model could not. Both are surfaced to the desk rather than
 * logged: an article that reads like the transcript is fine, and an article that
 * reads like the transcript *because the gateway is down* is something an operator
 * needs to see.
 */
export async function authorOutcome(ticket: OutcomeTranscript, deps: AuthorDeps = {}): Promise<OutcomeDraft> {
  const config = deps.config ?? authorConfig();
  const template = deterministicOutcome(ticket, deps.visibility ?? "PRIVATE");

  if (!config.enabled) {
    return { ...template, note: config.apiKey ? "the model is switched off (ONTRAK_AI_ENABLED=0)" : undefined };
  }

  const { system, user } = buildAuthorPrompt(ticket);
  const call = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await call(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        // Low but not zero: a writer that never varies produces the same flat
        // sentence for every ticket in the queue.
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ...template, note: `the model answered ${response.status}` };
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { ...template, note: "the model's answer had no content" };
    }

    const parsed = parseAuthorResponse(content);
    if (!parsed.ok) return { ...template, note: `the model's answer was unusable: ${parsed.reason}` };

    // The caller's visibility wins over whatever the model put in the JSON: the
    // model has no idea whether this desk publishes to customers, and the desk
    // does. A model that answers PUBLIC is not granted one.
    return {
      source: "model",
      article: { ...parsed.value.article, visibility: deps.visibility ?? "PRIVATE" },
      scenario: parsed.value.scenario,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? `the model did not answer within ${config.timeoutMs}ms`
      : `the model could not be reached (${error instanceof Error ? error.message : String(error)})`;
    return { ...template, note: reason };
  } finally {
    clearTimeout(timer);
  }
}
