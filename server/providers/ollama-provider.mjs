import { capabilityFlags } from "./base.mjs";

function isCloudModel(model) {
  return (
    model?.name?.endsWith(":cloud") ||
    model?.model?.endsWith(":cloud") ||
    Boolean(model?.remote_host || model?.remote_model)
  );
}

function contextLength(info) {
  const entries = Object.entries(info?.model_info ?? {});
  const found = entries.find(([key, value]) => {
    return key.endsWith(".context_length") && Number.isFinite(value);
  });
  return found?.[1];
}

export function createOllamaProvider(ollamaInstance) {
  if (!ollamaInstance) throw new TypeError("ollamaInstance is required");
  const inspectCache = new Map();

  const provider = {
    id: "ollama",
    name: "Ollama",
    type: "local",
    privacyClass: "local",
    enabled: true,

    async listModels(signal) {
      const models = await ollamaInstance.models(signal);
      return models
        .filter((model) => !isCloudModel(model))
        .map((model) => {
          const id = model.name ?? model.model;
          const inspected = inspectCache.get(id);
          const capabilities =
            inspected?.capabilities ?? model.capabilities ?? [];
          return {
            id,
            name: id,
            capabilities,
            ...(contextLength(inspected)
              ? { contextLength: contextLength(inspected) }
              : {}),
            local: true,
            costTier: "free",
            speedTier: "hardware-dependent",
            privacyClass: "local",
          };
        });
    },

    async health(signal) {
      const started = performance.now();
      try {
        await ollamaInstance.models(signal);
        return {
          available: true,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          available: false,
          latencyMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async inspect(model, signal) {
      if (!inspectCache.has(model))
        inspectCache.set(model, await ollamaInstance.inspect(model, signal));
      return inspectCache.get(model);
    },

    chat(options) {
      return ollamaInstance.chat(options);
    },

    unload(signal) {
      return ollamaInstance.unload(signal);
    },

    prepare(model, signal) {
      return ollamaInstance.prepare(model, signal);
    },

    supportsTools(modelMeta) {
      return capabilityFlags(modelMeta?.capabilities).tools;
    },
    supportsVision(modelMeta) {
      return capabilityFlags(modelMeta?.capabilities).vision;
    },
    supportsReasoning(modelMeta) {
      return capabilityFlags(modelMeta?.capabilities).reasoning;
    },
  };

  return provider;
}
