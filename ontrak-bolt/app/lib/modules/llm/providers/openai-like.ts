import type { LanguageModel } from 'ai';
import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { logger } from '~/utils/logger';

interface OpenAIModelsResponse {
  data: Array<{ id: string }>;
}

/**
 * One entry of `OPENAI_LIKE_API_MODELS`.
 *
 * The format is upstream's — `path/to/model:limit;path/to/model:limit` — and is
 * kept so an existing `.env` from anywhere else still parses. `limit` is optional
 * and defaults to 8000, which is upstream's default too.
 */
export interface CuratedModel {
  name: string;
  maxTokenAllowed: number;
}

/** Parse `OPENAI_LIKE_API_MODELS` into the models it names, in the order given. */
export function parseCuratedModels(raw: string | undefined): CuratedModel[] {
  if (!raw) {
    return [];
  }

  const models: CuratedModel[] = [];

  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    // `lastIndexOf`, not `split`, because a gateway id may itself contain a colon
    // (`vendor:tag`) and only a trailing numeric field is a limit.
    const separator = trimmed.lastIndexOf(':');
    const tail = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    const hasLimit = separator !== -1 && /^\d+$/.test(tail);
    const name = (hasLimit ? trimmed.slice(0, separator) : trimmed).trim();

    if (!name) {
      continue;
    }

    models.push({ name, maxTokenAllowed: hasLimit ? parseInt(tail, 10) : 8000 });
  }

  return models;
}

/**
 * Narrow a discovered catalogue to the curated list.
 *
 * The gateway answers `/models` with its whole catalogue — 1,245 ids on this
 * estate's OmniRoute, which is not a picker, it is a directory. Setting
 * `OPENAI_LIKE_API_MODELS` says *these are the models this deployment offers*: the
 * discovered entry is kept where there is one, because its label comes from the
 * gateway rather than from this app's guess, and a curated id the catalogue does not
 * list is still offered with its declared limit — asking for a model explicitly must
 * not fail because discovery lagged.
 *
 * The context length is the larger of the two, and that is not a preference so much
 * as a correction: `getDynamicModels` lists every id from `/models` with 8,000 tokens,
 * because an OpenAI-style catalogue carries no context length at all — so the 8,000
 * is this provider's placeholder, not the gateway's answer. Preferring it over a
 * declared `id:200000` would cap the deployment at 8,000 tokens on exactly the models
 * the operator took the trouble to describe, and the first turn would be refused with
 * "Requested tokens (8192) exceed model's context window (8000)". A catalogue that
 * does report a larger window still wins, which is the case this rule was written for.
 */
export function curateModels(discovered: ModelInfo[], curated: CuratedModel[], provider: string): ModelInfo[] {
  if (curated.length === 0) {
    return discovered;
  }

  const byName = new Map(discovered.map((model) => [model.name, model]));

  return curated.map((entry) => {
    const found = byName.get(entry.name);

    return {
      name: entry.name,
      label: found?.label ?? entry.name,
      provider,
      maxTokenAllowed: Math.max(found?.maxTokenAllowed ?? 0, entry.maxTokenAllowed),
    };
  });
}

export default class OpenAILikeProvider extends BaseProvider {
  name = 'OpenAILike';
  getApiKeyLink = undefined;

  config = {
    baseUrlKey: 'OPENAI_LIKE_API_BASE_URL',
    apiTokenKey: 'OPENAI_LIKE_API_KEY',
    modelsKey: 'OPENAI_LIKE_API_MODELS',
  };

  staticModels: ModelInfo[] = [];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'OPENAI_LIKE_API_BASE_URL',
      defaultApiTokenKey: 'OPENAI_LIKE_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      return [];
    }

    // The deployment's own list, if it has one. Same precedence as the base URL and
    // the key: worker bindings, then this browser's provider settings, then the
    // process environment — which is where a container deployment's settings arrive
    // (`scripts/render-worker-vars.mjs` publishes them through wrangler's `vars`).
    const curated = parseCuratedModels(
      serverEnv['OPENAI_LIKE_API_MODELS'] ||
        settings?.OPENAI_LIKE_API_MODELS ||
        process.env['OPENAI_LIKE_API_MODELS'] ||
        undefined,
    );

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const res = (await response.json()) as OpenAIModelsResponse;

      const discovered: ModelInfo[] = res.data.map((model) => ({
        name: model.id,
        label: model.id,
        provider: this.name,
        maxTokenAllowed: 8000,
      }));

      return curateModels(discovered, curated, this.name);
    } catch (error) {
      logger.info(`${this.name}: Could not fetch /models endpoint, checking fallback env`, error);

      /* A gateway that is unreachable still has a known list: the curated one. */
      if (curated.length > 0) {
        logger.info(`${this.name}: Using OPENAI_LIKE_API_MODELS fallback`);

        return curateModels([], curated, this.name);
      }

      return [];
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModel {
    const { model, serverEnv, apiKeys, providerSettings } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'OPENAI_LIKE_API_BASE_URL',
      defaultApiTokenKey: 'OPENAI_LIKE_API_KEY',
    });

    if (!baseUrl || !apiKey) {
      throw new Error(`Missing configuration for ${this.name} provider`);
    }

    return getOpenAILikeModel(baseUrl, apiKey, model);
  }
}
