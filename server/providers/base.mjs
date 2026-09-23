export const MODEL_CAPABILITIES = Object.freeze({
  tools: "tools",
  vision: "vision",
  reasoning: "reasoning",
});

export function capabilityFlags(capabilities = []) {
  const values = new Set(capabilities);
  return {
    tools: values.has(MODEL_CAPABILITIES.tools),
    vision: values.has(MODEL_CAPABILITIES.vision),
    reasoning:
      values.has(MODEL_CAPABILITIES.reasoning) || values.has("thinking"),
  };
}

export function normalizeModelRef(providerId, modelId) {
  if (typeof providerId !== "string" || !providerId.trim())
    throw new TypeError("providerId is required");
  if (typeof modelId !== "string" || !modelId.trim())
    throw new TypeError("modelId is required");
  const normalizedProvider = providerId.trim();
  return normalizedProvider === "ollama"
    ? modelId.trim()
    : `${normalizedProvider}:${modelId.trim()}`;
}

/*
Provider adapter interface:
  listModels(signal)
    -> [{ id, name, capabilities[], contextLength?, local, costTier,
          speedTier, privacyClass }]
  health(signal) -> { available, latencyMs?, error? }
  chat({ model, messages, tools, profile, signal, onToken })
    -> same shape as Ollama.chat
  supportsTools(modelMeta)
  supportsVision(modelMeta)
  supportsReasoning(modelMeta)

Providers may additionally expose unload(signal), prepare(model, signal), and
inspect(model, signal) when their backend supports those operations.
*/
