/**
 * The author: who writes the draft.
 *
 * ONE INTERFACE, ANY MODEL, AND A GUARANTEED ANSWER.
 *
 * The default target is **OmniRoute** — the self-hosted, MIT-licensed gateway that
 * pools however many providers (including free ones) an operator has connected, and
 * answers on one OpenAI-compatible endpoint at `127.0.0.1:20128/v1`. It is the right
 * default for this Network because it is software the operator runs rather than an
 * account somebody has to keep paying for, and because pooling free tiers is exactly
 * the kind of cost control the whole theme of this deployment is about.
 *
 * The call itself is the generic OpenAI *chat-completions* shape, so nothing here is
 * OmniRoute-specific: the same code works unchanged against OpenAI, Azure OpenAI, a
 * vLLM box, an Ollama daemon, LiteLLM, or the organization's own gateway — which is
 * the difference between "we chose a vendor" and "we can change our mind". Nothing
 * in this file imports a vendor SDK, and nothing else in the product knows a model
 * exists.
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
  /**
   * Whether the deployment *asked* for a model and was refused.
   *
   * The distinction that decides whether a fallback is worth mentioning: a desk that
   * configured a gateway and silently got the template needs to hear about it, while
   * one that never configured anything is working exactly as intended.
   */
  switchedOff: boolean;
}

/**
 * OmniRoute's default endpoint, and its `auto` combo.
 *
 * `auto` is the gateway's own router — it picks a connected provider per request and
 * falls back when one runs out of quota — so naming a model here would be choosing a
 * provider, which is the one thing this file exists not to do. A deployment that wants
 * a specific model sets `ONTRAK_AI_MODEL`.
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
export const DEFAULT_MODEL = "auto";
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read the author's settings.
 *
 * **When the zero-config gateway runs, no key is needed** — OmniRoute answers on
 * `auto` with nothing configured, so a deployment that has it on localhost sets
 * `ONTRAK_AI_ENABLED=1` and nothing else.
 *
 * **When it does not, nothing is needed either**, and that is the more important
 * half: with no key and no explicit switch the author stays *off* and the
 * deterministic writer answers. The alternative — trying the default base URL on
 * every sweep — would add a connection-refused timeout to each resolution on every
 * air-gapped deployment and every developer's laptop, which is a real cost paid for
 * a feature nobody asked for. `ONTRAK_AI_ENABLED=0` is the hard off, and wins over
 * everything, which is what a deployment wants while it is deciding whether the
 * drafts are good enough.
 */
export function authorConfig(env: Record<string, string | undefined> = process.env): AuthorConfig {
  const apiKey = (env.ONTRAK_AI_API_KEY ?? "").trim();
  const explicit = (env.ONTRAK_AI_ENABLED ?? "").trim();
  return {
    baseUrl: (env.ONTRAK_AI_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey,
    model: (env.ONTRAK_AI_MODEL ?? DEFAULT_MODEL).trim(),
    timeoutMs: Number(env.ONTRAK_AI_TIMEOUT_MS ?? "") > 0 ? Number(env.ONTRAK_AI_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    enabled: explicit === "0" ? false : apiKey.length > 0 || explicit === "1",
    switchedOff: explicit === "0",
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
    return {
      ...template,
      // No note for the common case: a deployment that never configured a model is not
      // a deployment with something wrong, and a "no model is configured" banner on
      // every private draft would train people to ignore the note that matters.
      note: config.switchedOff ? "the model is switched off (ONTRAK_AI_ENABLED=0)" : undefined,
    };
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
        // Omitted rather than sent empty: a keyless local gateway rejects
        // `Authorization: Bearer ` on some builds, and an empty credential is not a
        // credential worth sending.
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
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
