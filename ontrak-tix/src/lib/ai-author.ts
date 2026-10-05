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
 * The call itself now lives in `ai-gateway.ts`, shared with the M7 assist, so there
 * is exactly one place in the product that speaks to a model — and one place to
 * change if the shape ever does.
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
import { callChat, type GatewayConfig } from "./ai-gateway";

/**
 * The author's settings.
 *
 * The shape lives in `ai-gateway.ts` — one place knows the knobs — and this name is
 * kept so the author's own callers do not have to move when a second AI feature
 * starts reading the same configuration.
 */
export type AuthorConfig = GatewayConfig;

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
  const answer = await callChat({ config, system, user, fetchImpl: deps.fetchImpl });
  if (!answer.ok) return { ...template, note: answer.reason };

  const parsed = parseAuthorResponse(answer.content);
  if (!parsed.ok) return { ...template, note: `the model's answer was unusable: ${parsed.reason}` };

  // The caller's visibility wins over whatever the model put in the JSON: the
  // model has no idea whether this desk publishes to customers, and the desk
  // does. A model that answers PUBLIC is not granted one.
  return {
    source: "model",
    article: { ...parsed.value.article, visibility: deps.visibility ?? "PRIVATE" },
    scenario: parsed.value.scenario,
  };
}
