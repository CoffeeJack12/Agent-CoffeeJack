import { normalizeModelRef } from "./base.mjs";
import { createOllamaProvider } from "./ollama-provider.mjs";
import {
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAICompatibleProvider,
} from "./openai-compatible.mjs";

const COOLDOWN_MS = 60_000;
const FAILURE_COOLDOWN_THRESHOLD = 3;

export class ProviderRegistry {
  constructor({ ollama, providers = [] } = {}) {
    this.providers = new Map();
    this.statuses = new Map();
    this.models = new Map();
    /** @type {Map<string, object>} providerId:modelId → health */
    this.modelHealth = new Map();
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
      timeouts: 0,
      malformed: 0,
      fallbackCount: 0,
      rollingLatencyMs: null,
    });
    this.models.set(provider.id, []);
    return provider;
  }

  #modelKey(providerId, modelId) {
    return `${providerId}:${modelId}`;
  }

  getModelHealth(providerId, modelId) {
    const key = this.#modelKey(providerId, modelId);
    const health = this.modelHealth.get(key) || {
      successes: 0,
      failures: 0,
      timeouts: 0,
      qualityBoost: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    const inCooldown =
      Boolean(health.cooldownUntil) &&
      Date.parse(health.cooldownUntil) > Date.now();
    return { ...health, inCooldown };
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
            ...this.getModelHealth(provider.id, entry.id),
          })),
        );
        this.statuses.set(provider.id, {
          available: Boolean(health.available),
          ...(health.latencyMs != null ? { latencyMs: health.latencyMs } : {}),
          ...(health.error ? { error: health.error } : {}),
          refreshedAt: new Date().toISOString(),
          successes: previous?.successes ?? 0,
          failures: previous?.failures ?? 0,
          timeouts: previous?.timeouts ?? 0,
          malformed: previous?.malformed ?? 0,
          fallbackCount: previous?.fallbackCount ?? 0,
          rollingLatencyMs: previous?.rollingLatencyMs ?? null,
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          lastFailureAt: previous?.lastFailureAt ?? null,
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

  /**
   * Provider-native chat. Routes through the adapter; never invents providers.
   */
  async chat({
    providerId,
    modelId,
    messages,
    tools,
    profile,
    signal,
    onToken,
  }) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (typeof provider.chat !== "function")
      throw new Error(`Provider ${providerId} does not support chat`);
    const started = performance.now();
    try {
      const result = await provider.chat({
        model: modelId,
        messages,
        tools,
        profile,
        signal,
        onToken,
      });
      if (result == null || typeof result.content !== "string") {
        this.recordFailure(providerId, new Error("malformed response"), modelId, {
          malformed: true,
        });
        throw new Error(`Malformed response from ${providerId}`);
      }
      const latencyMs = Math.round(performance.now() - started);
      this.recordSuccess(providerId, modelId, { latencyMs });
      return { ...result, latencyMs, providerId, modelId };
    } catch (error) {
      this.recordFailure(providerId, error, modelId);
      throw error;
    }
  }

  recordSuccess(providerId, modelId, { latencyMs } = {}) {
    const status = this.#status(providerId);
    status.successes += 1;
    status.lastSuccessAt = new Date().toISOString();
    status.available = true;
    if (latencyMs != null) {
      status.rollingLatencyMs =
        status.rollingLatencyMs == null
          ? latencyMs
          : Math.round(status.rollingLatencyMs * 0.7 + latencyMs * 0.3);
    }
    if (modelId) {
      const health = this.#modelHealthMut(providerId, modelId);
      health.successes += 1;
      health.lastSuccessAt = status.lastSuccessAt;
      health.cooldownUntil = null;
      if (latencyMs != null) health.lastLatencyMs = latencyMs;
    }
  }

  recordFailure(providerId, error, modelId, { malformed = false } = {}) {
    const status = this.#status(providerId);
    status.failures += 1;
    status.lastFailureAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    if (error) status.error = message.slice(0, 500);
    if (/abort|timeout/i.test(message)) status.timeouts += 1;
    if (malformed) status.malformed += 1;
    if (modelId) {
      const health = this.#modelHealthMut(providerId, modelId);
      health.failures += 1;
      health.lastFailureAt = status.lastFailureAt;
      if (/abort|timeout/i.test(message)) health.timeouts += 1;
      if (health.failures >= FAILURE_COOLDOWN_THRESHOLD) {
        health.cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString();
      }
    }
  }

  recordFallback(providerId) {
    const status = this.#status(providerId);
    status.fallbackCount += 1;
  }

  /** Bounded quality boost after verified outcomes (tests/sources). */
  recordQuality(providerId, modelId, amount = 1) {
    if (!modelId) return;
    const health = this.#modelHealthMut(providerId, modelId);
    health.qualityBoost = Math.min(15, (health.qualityBoost || 0) + amount);
  }

  #status(providerId) {
    const status = this.statuses.get(providerId);
    if (!status) throw new Error(`Unknown provider: ${providerId}`);
    return status;
  }

  #modelHealthMut(providerId, modelId) {
    const key = this.#modelKey(providerId, modelId);
    if (!this.modelHealth.has(key)) {
      this.modelHealth.set(key, {
        successes: 0,
        failures: 0,
        timeouts: 0,
        qualityBoost: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        cooldownUntil: null,
      });
    }
    return this.modelHealth.get(key);
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
  registry.register(
    createOpenAICompatibleProvider({
      id: "groq",
      name: "Groq",
      envKey: "GROQ_API_KEY",
      baseUrlEnv: "GROQ_BASE_URL",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
    }),
  );

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
