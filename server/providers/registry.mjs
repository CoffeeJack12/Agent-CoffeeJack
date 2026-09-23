import { normalizeModelRef } from "./base.mjs";
import { createOllamaProvider } from "./ollama-provider.mjs";
import {
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAICompatibleProvider,
} from "./openai-compatible.mjs";

export class ProviderRegistry {
  constructor({ ollama, providers = [] } = {}) {
    this.providers = new Map();
    this.statuses = new Map();
    this.models = new Map();
    if (ollama) this.register(createOllamaProvider(ollama));
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider?.id || typeof provider.listModels !== "function")
      throw new TypeError("Provider must have an id and listModels()");
    if (this.providers.has(provider.id))
      throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    this.statuses.set(provider.id, {
      available: provider.enabled !== false,
      successes: 0,
      failures: 0,
    });
    this.models.set(provider.id, []);
    return provider;
  }

  async refresh(signal) {
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        signal?.throwIfAborted();
        const previous = this.statuses.get(provider.id);
        let health;
        try {
          health =
            typeof provider.health === "function"
              ? await provider.health(signal)
              : { available: provider.enabled !== false };
        } catch (error) {
          signal?.throwIfAborted();
          health = {
            available: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        let models = [];
        try {
          models = await provider.listModels(signal);
        } catch (error) {
          signal?.throwIfAborted();
          health = {
            ...health,
            available: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        this.models.set(
          provider.id,
          models.map((entry) => ({
            ...entry,
            provider: provider.id,
            effectiveModel: normalizeModelRef(provider.id, entry.id),
          })),
        );
        this.statuses.set(provider.id, {
          available: Boolean(health.available),
          ...(health.latencyMs != null ? { latencyMs: health.latencyMs } : {}),
          ...(health.error ? { error: health.error } : {}),
          refreshedAt: new Date().toISOString(),
          successes: previous?.successes ?? 0,
          failures: previous?.failures ?? 0,
        });
      }),
    );
    return {
      providers: this.listProviders(),
      models: this.listModels(),
    };
  }

  listProviders() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      privacyClass: provider.privacyClass,
      enabled: provider.enabled !== false,
      modelCount: this.models.get(provider.id)?.length ?? 0,
      ...this.statuses.get(provider.id),
    }));
  }

  listModels({ localOnly = false, remoteAllowed = true } = {}) {
    return [...this.models.values()].flat().filter((entry) => {
      if (localOnly) return entry.local;
      if (!remoteAllowed) return entry.local;
      return true;
    });
  }

  getProvider(id) {
    return this.providers.get(id);
  }

  getModel(providerId, modelId) {
    return this.models.get(providerId)?.find((entry) => entry.id === modelId);
  }

  resolveModel(ref) {
    if (typeof ref !== "string" || !ref) return undefined;
    const exact = this.listModels().find(
      (entry) => entry.effectiveModel === ref,
    );
    if (exact) return exact;

    const separator = ref.indexOf(":");
    if (separator > 0) {
      const providerId = ref.slice(0, separator);
      if (providerId !== "ollama" && this.providers.has(providerId))
        return this.getModel(providerId, ref.slice(separator + 1));
    }
    return this.getModel("ollama", ref);
  }

  recordSuccess(providerId) {
    const status = this.#status(providerId);
    status.successes += 1;
    status.lastSuccessAt = new Date().toISOString();
    status.available = true;
  }

  recordFailure(providerId, error) {
    const status = this.#status(providerId);
    status.failures += 1;
    status.lastFailureAt = new Date().toISOString();
    if (error)
      status.error = error instanceof Error ? error.message : String(error);
  }

  #status(providerId) {
    const status = this.statuses.get(providerId);
    if (!status) throw new Error(`Unknown provider: ${providerId}`);
    return status;
  }
}

export function createDefaultRegistry(ollama) {
  const registry = new ProviderRegistry({ ollama });
  registry.register(
    createOpenAICompatibleProvider({
      id: "openai",
      name: "OpenAI",
      envKey: "OPENAI_API_KEY",
      baseUrlEnv: "OPENAI_BASE_URL",
      defaultBaseUrl: "https://api.openai.com/v1",
    }),
  );
  registry.register(createAnthropicProvider());
  registry.register(createGoogleProvider());

  if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY) {
    registry.register(
      createOpenAICompatibleProvider({
        id: "openai-compatible",
        name: "OpenAI-compatible",
        envKey: "OPENAI_COMPAT_API_KEY",
        baseUrlEnv: "OPENAI_COMPAT_BASE_URL",
        defaultBaseUrl: process.env.OPENAI_COMPAT_BASE_URL,
      }),
    );
  }
  return registry;
}
