import { BaseProvider } from './base-provider';
import { setEnv } from './env';
import * as providers from './registry';
import type { ModelInfo, ProviderInfo } from './types';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LLMManager');

/*
 * Providers exposed to the app. Every other provider in ./registry stays
 * unregistered, so its models never reach the model picker.
 */
const ENABLED_PROVIDERS = new Set([
  'OpenRouter',
  'Anthropic',
  'OpenAI',
  'Google',
  'Groq',
  'HuggingFace',
  'Cohere',
  'Mistral',
  'Perplexity',
  'Deepseek',
  'xAI',
  'Together',
  'Fireworks',
  'Cerebras',
  'AmazonBedrock',
  'Github',
  'Moonshot',
  'Hyperbolic',
  'Z.ai',
  'Ollama',
  'LMStudio',
  'OpenAILike',
]);

export class LLMManager {
  private static _instance: LLMManager;
  private _providers: Map<string, BaseProvider> = new Map();
  private _modelList: ModelInfo[] = [];
  private _env: Record<string, string> = {};

  private constructor(_env: Record<string, string>) {
    this._registerProvidersFromDirectory();
    this._env = _env;
    setEnv(_env);
  }

  static getInstance(env: Record<string, string> = {}): LLMManager {
    if (!LLMManager._instance) {
      LLMManager._instance = new LLMManager(env);
    } else if (Object.keys(env).length > 0) {
      // Update env on subsequent calls so Cloudflare Workers get fresh bindings
      LLMManager._instance._env = env;
      setEnv(env);
    }

    return LLMManager._instance;
  }
  get env() {
    return this._env;
  }

  private async _registerProvidersFromDirectory() {
    try {
      /*
       * Dynamically import all files from the providers directory
       * const providerModules = import.meta.glob('./providers/*.ts', { eager: true });
       */

      // Look for exported classes that extend BaseProvider
      for (const exportedItem of Object.values(providers)) {
        if (typeof exportedItem === 'function' && exportedItem.prototype instanceof BaseProvider) {
          const provider = new exportedItem();

          if (!ENABLED_PROVIDERS.has(provider.name)) {
            continue;
          }

          try {
            this.registerProvider(provider);
          } catch (error: any) {
            logger.warn('Failed To Register Provider: ', provider.name, 'error:', error.message);
          }
        }
      }
    } catch (error) {
      logger.error('Error registering providers:', error);
    }
  }

  registerProvider(provider: BaseProvider) {
    if (this._providers.has(provider.name)) {
      logger.warn(`Provider ${provider.name} is already registered. Skipping.`);
      return;
    }

    logger.info('Registering Provider: ', provider.name);
    this._providers.set(provider.name, provider);
    this._modelList = [...this._modelList, ...provider.staticModels];
  }

  getProvider(name: string): BaseProvider | undefined {
    return this._providers.get(name);
  }

  getAllProviders(): BaseProvider[] {
    return Array.from(this._providers.values());
  }

  getModelList(): ModelInfo[] {
    return this._modelList;
  }

  async updateModelList(options: {
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    serverEnv?: Record<string, string>;
    enabledProviderNames?: string[];
  }): Promise<ModelInfo[]> {
    const { apiKeys, providerSettings, serverEnv, enabledProviderNames } = options;

    let enabledProviders = Array.from(this._providers.values()).map((p) => p.name);

    if (enabledProviderNames) {
      enabledProviders = enabledProviders.filter((name) => enabledProviderNames.includes(name));
    }

    if (!enabledProviderNames && providerSettings && Object.keys(providerSettings).length > 0) {
      enabledProviders = enabledProviders.filter((name) => providerSettings[name]?.enabled);
    }

    // Get dynamic models from all providers that support them
    const dynamicModels = await Promise.all(
      Array.from(this._providers.values())
        .filter((provider) => enabledProviders.includes(provider.name))
        .filter(
          (provider): provider is BaseProvider & Required<Pick<ProviderInfo, 'getDynamicModels'>> =>
            !!provider.getDynamicModels,
        )
        .map(async (provider) => {
          const cachedModels = provider.getModelsFromCache(options);

          if (cachedModels) {
            return cachedModels;
          }

          const dynamicModels = await provider
            .getDynamicModels(apiKeys, providerSettings?.[provider.name], serverEnv)
            .then((models) => {
              logger.info(`Caching ${models.length} dynamic models for ${provider.name}`);
              provider.storeDynamicModels(options, models);

              return models;
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);

              if (message.toLowerCase().includes('missing api key')) {
                logger.debug(`Dynamic models skipped for ${provider.name}: ${message}`);
              } else {
                logger.error(`Error getting dynamic models ${provider.name} :`, err);
              }

              return [];
            });

          return dynamicModels;
        }),
    );

    const staticModels = Array.from(this._providers.values())
      .filter((provider) => enabledProviders.includes(provider.name))
      .flatMap((provider) => provider.staticModels || []);

    const dynamicModelsFlat = dynamicModels.flat();
    const dynamicModelKeys = dynamicModelsFlat.map((d) => `${d.name}-${d.provider}`);
    const filteredStaticModels = staticModels.filter((m) => !dynamicModelKeys.includes(`${m.name}-${m.provider}`));

    // Combine static and dynamic models
    const modelList = [...dynamicModelsFlat, ...filteredStaticModels];
    modelList.sort((a, b) => a.name.localeCompare(b.name));
    this._modelList = modelList;

    return modelList;
  }
  getStaticModelList() {
    return [...this._providers.values()].flatMap((p) => p.staticModels || []);
  }
  async getModelListFromProvider(
    providerArg: BaseProvider,
    options: {
      apiKeys?: Record<string, string>;
      providerSettings?: Record<string, IProviderSetting>;
      serverEnv?: Record<string, string>;
    },
  ): Promise<ModelInfo[]> {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    const staticModels = provider.staticModels || [];

    if (!provider.getDynamicModels) {
      return staticModels;
    }

    const { apiKeys, providerSettings, serverEnv } = options;

    const cachedModels = provider.getModelsFromCache({
      apiKeys,
      providerSettings,
      serverEnv,
    });

    if (cachedModels) {
      logger.info(`Found ${cachedModels.length} cached models for ${provider.name}`);

      const cachedModelNames = new Set(cachedModels.map((model) => model.name));

      return [...cachedModels, ...staticModels.filter((model) => !cachedModelNames.has(model.name))];
    }

    logger.info(`Getting dynamic models for ${provider.name}`);

    const dynamicModels = await provider
      .getDynamicModels?.(apiKeys, providerSettings?.[provider.name], serverEnv)
      .then((models) => {
        logger.info(`Got ${models.length} dynamic models for ${provider.name}`);
        provider.storeDynamicModels(options, models);

        return models;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);

        if (message.toLowerCase().includes('missing api key')) {
          logger.debug(`Dynamic models skipped for ${provider.name}: ${message}`);
        } else {
          logger.error(`Error getting dynamic models ${provider.name} :`, err);
        }

        return [];
      });

    const dynamicModelsName = dynamicModels.map((d) => d.name);
    const filteredStaticList = staticModels.filter((m) => !dynamicModelsName.includes(m.name));
    const modelList = [...dynamicModels, ...filteredStaticList];
    modelList.sort((a, b) => a.name.localeCompare(b.name));

    return modelList;
  }
  getStaticModelListFromProvider(providerArg: BaseProvider) {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    return [...(provider.staticModels || [])];
  }

  getDefaultProvider(): BaseProvider {
    /*
     * Prefer OpenRouter explicitly. Registration order follows the export
     * order of ./registry, which would otherwise make the default depend on
     * which provider happens to be listed first.
     *
     * With one exception, and it is this deployment's whole configuration: a
     * build whose models come from a gateway (`OPENAI_LIKE_API_BASE_URL`) and
     * which has no OpenRouter key. OpenRouter is upstream's default because
     * upstream expects you to paste a key into it; here there is nothing to
     * paste, so the console opened on a provider that could only answer with
     * "Invalid or missing API key" while the five models this deployment does
     * serve sat one dropdown away. The key is checked as well as the base URL,
     * so a deployment that has both still starts where upstream starts.
     */
    const openRouter = this._providers.get('OpenRouter');
    const gateway = this._providers.get('OpenAILike');
    // Read from both, because the two sides of this app are configured differently:
    // the browser has `import.meta.env` and the worker in `vite preview` has the vars
    // `scripts/render-worker-vars.mjs` wrote into `wrangler.jsonc` on `process.env`.
    // A check that only read one of them answered "OpenRouter" everywhere, which is
    // how the console came to open on a provider with no key.
    const has = (key: string) => Boolean(this._env[key] || (typeof process !== 'undefined' && process.env?.[key]));

    if (openRouter && (has('OPENROUTER_API_KEY') || !has('OPENAI_LIKE_API_BASE_URL') || !gateway)) {
      return openRouter;
    }

    if (gateway) {
      return gateway;
    }

    const firstProvider = this._providers.values().next().value;

    if (!firstProvider) {
      throw new Error('No providers registered');
    }

    return firstProvider;
  }
}
