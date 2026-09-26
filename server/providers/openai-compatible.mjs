import { capabilityFlags } from "./base.mjs";

const OPENAI_MODELS = [
  model("gpt-4o-mini", ["tools", "vision"], 128000, "low", "fast"),
  model("gpt-4o", ["tools", "vision"], 128000, "high", "balanced"),
];
const ANTHROPIC_MODELS = [
  model(
    "claude-sonnet-4-5",
    ["tools", "vision", "reasoning"],
    200000,
    "high",
    "balanced",
  ),
];
const GOOGLE_MODELS = [
  model(
    "gemini-3.8-flash",
    ["tools", "vision", "reasoning"],
    1048576,
    "free",
    "fast",
  ),
];

function model(id, capabilities, contextLength, costTier, speedTier) {
  return {
    id,
    name: id,
    capabilities,
    contextLength,
    local: false,
    costTier,
    speedTier,
    privacyClass: "remote",
  };
}

function trimBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function configuredKey(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

function safeError(error, keys = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of keys) {
    if (key) message = message.replaceAll(key, "[redacted]");
  }
  return message.slice(0, 500);
}

async function responseJson(response, keys) {
  if (!response.ok) {
    const detail = safeError(await response.text(), keys);
    throw new Error(`Provider request failed (${response.status}): ${detail}`);
  }
  return response.json();
}

function supportMethods(provider) {
  provider.supportsTools = (meta) => capabilityFlags(meta?.capabilities).tools;
  provider.supportsVision = (meta) =>
    capabilityFlags(meta?.capabilities).vision;
  provider.supportsReasoning = (meta) =>
    capabilityFlags(meta?.capabilities).reasoning;
  return provider;
}

export function createOpenAICompatibleProvider({
  id,
  name,
  envKey,
  baseUrlEnv,
  defaultBaseUrl,
}) {
  if (!id || !name || !envKey || !defaultBaseUrl)
    throw new TypeError("id, name, envKey and defaultBaseUrl are required");

  const getKey = () => configuredKey(envKey);
  const getBaseUrl = () =>
    trimBaseUrl((baseUrlEnv && process.env[baseUrlEnv]) || defaultBaseUrl);

  return supportMethods({
    id,
    name,
    type: "remote",
    privacyClass: "remote",
    get enabled() {
      return Boolean(getKey());
    },

    async listModels(signal) {
      const key = getKey();
      if (!key) return [];
      if (id === "openai") return OPENAI_MODELS.map((entry) => ({ ...entry }));
      try {
        const response = await fetch(`${getBaseUrl()}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: signal ?? AbortSignal.timeout(10000),
        });
        const payload = await responseJson(response, [key]);
        return (payload.data ?? []).map((entry) =>
          model(entry.id, [], undefined, "unknown", "unknown"),
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(safeError(error, [key]));
      }
    },

    async health(signal) {
      const key = getKey();
      if (!key) return { available: false, error: "API key is not configured" };
      const started = performance.now();
      try {
        const response = await fetch(`${getBaseUrl()}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: signal ?? AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {
          available: true,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          available: false,
          latencyMs: Math.round(performance.now() - started),
          error: safeError(error, [key]),
        };
      }
    },

    async chat({ model: modelId, messages, profile = {}, signal, onToken }) {
      const key = getKey();
      if (!key) throw new Error(`${name} API key is not configured`);
      const timed = signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : signal
        : AbortSignal.timeout(45000);
      try {
        const response = await fetch(`${getBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            stream: false,
            ...(profile.temperature != null
              ? { temperature: profile.temperature }
              : {}),
          }),
          signal: timed,
        });
        const payload = await responseJson(response, [key]);
        const content = payload.choices?.[0]?.message?.content ?? "";
        onToken?.(content);
        return {
          role: "assistant",
          content,
          tokens: payload.usage?.completion_tokens ?? 0,
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(safeError(error, [key]));
      }
    },
  });
}

export function createAnthropicProvider() {
  const getKey = () => configuredKey("ANTHROPIC_API_KEY");
  const baseUrl = () =>
    trimBaseUrl(
      process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
    );

  return supportMethods({
    id: "anthropic",
    name: "Anthropic",
    type: "remote",
    privacyClass: "remote",
    get enabled() {
      return Boolean(getKey());
    },
    async listModels() {
      return getKey() ? ANTHROPIC_MODELS.map((entry) => ({ ...entry })) : [];
    },
    async health(signal) {
      return remoteHealth(
        `${baseUrl()}/models`,
        {
          "x-api-key": getKey(),
          "anthropic-version": "2023-06-01",
        },
        getKey(),
        signal,
      );
    },
    async chat({ model: modelId, messages, profile = {}, signal, onToken }) {
      const key = getKey();
      if (!key) throw new Error("Anthropic API key is not configured");
      const system = messages
        .filter((entry) => entry.role === "system")
        .map((entry) => entry.content)
        .join("\n");
      const conversational = messages.filter(
        (entry) => entry.role !== "system",
      );
      const timed = signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : signal
        : AbortSignal.timeout(45000);
      try {
        const response = await fetch(`${baseUrl()}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            messages: conversational,
            max_tokens: profile.predict ?? 3072,
            ...(system ? { system } : {}),
          }),
          signal: timed,
        });
        const payload = await responseJson(response, [key]);
        const content = (payload.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        onToken?.(content);
        return {
          role: "assistant",
          content,
          tokens: payload.usage?.output_tokens ?? 0,
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(safeError(error, [key]));
      }
    },
  });
}

export function createGoogleProvider() {
  const getKey = () => configuredKey("GOOGLE_API_KEY", "GEMINI_API_KEY");
  const baseUrl = () =>
    trimBaseUrl(
      process.env.GOOGLE_AI_BASE_URL ||
        "https://generativelanguage.googleapis.com/v1beta",
    );

  return supportMethods({
    id: "google",
    name: "Google Gemini",
    type: "remote",
    privacyClass: "remote",
    get enabled() {
      return Boolean(getKey());
    },
    async listModels() {
      return getKey() ? GOOGLE_MODELS.map((entry) => ({ ...entry })) : [];
    },
    async health(signal) {
      return remoteHealth(
        `${baseUrl()}/models`,
        {
          "x-goog-api-key": getKey(),
        },
        getKey(),
        signal,
      );
    },
    async chat({ model: modelId, messages, signal, onToken }) {
      const key = getKey();
      if (!key) throw new Error("Google API key is not configured");
      const systemText = messages
        .filter((entry) => entry.role === "system")
        .map((entry) => entry.content)
        .join("\n");
      const contents = messages
        .filter((entry) => entry.role !== "system")
        .map((entry) => ({
          role: entry.role === "assistant" ? "model" : "user",
          parts: [{ text: String(entry.content ?? "") }],
        }));
      const timed = signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : signal
        : AbortSignal.timeout(45000);
      try {
        const response = await fetch(
          `${baseUrl()}/models/${encodeURIComponent(modelId)}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents,
              ...(systemText
                ? { systemInstruction: { parts: [{ text: systemText }] } }
                : {}),
            }),
            signal: timed,
          },
        );
        const payload = await responseJson(response, [key]);
        const content = (payload.candidates?.[0]?.content?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("");
        onToken?.(content);
        return {
          role: "assistant",
          content,
          tokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(safeError(error, [key]));
      }
    },
  });
}

async function remoteHealth(url, headers, key, signal) {
  if (!key) return { available: false, error: "API key is not configured" };
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: signal ?? AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      available: true,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      available: false,
      latencyMs: Math.round(performance.now() - started),
      error: safeError(error, [key]),
    };
  }
}
