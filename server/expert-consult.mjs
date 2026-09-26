import { sanitizeForRemote } from "./privacy.mjs";

const DEFAULT_GOOGLE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-flash-latest",
];
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const MAX_FIELD_CHARS = 6000;

const EXPLICIT_EXPERT_REQUEST =
  /\b(?:consult|ask)\s+(?:(?:an?|the)\s+)?expert\b|\bsecond\s+opinion\b|(?:استشر|استشير|شاور)\s+(?:خبير|مستشار)/iu;

export function isExplicitExpertConsultRequest(text = "") {
  return EXPLICIT_EXPERT_REQUEST.test(String(text || ""));
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function safeField(value) {
  return sanitizeForRemote(String(value || ""), {
    maxChars: MAX_FIELD_CHARS,
  });
}

function providerEnabled(registry, providerId) {
  const provider = registry?.getProvider?.(providerId);
  return Boolean(provider && provider.enabled !== false);
}

function providerModels(registry, providerId) {
  return (registry?.listModels?.() || []).filter(
    (entry) => entry.provider === providerId,
  );
}

function preferredModel(registry, providerId, explicitModel = "") {
  const models = providerModels(registry, providerId);
  if (!models.length) return null;
  if (explicitModel) {
    return models.find((entry) => entry.id === explicitModel) || null;
  }
  const preferred =
    providerId === "google" ? DEFAULT_GOOGLE_MODELS[0] : DEFAULT_GROQ_MODEL;
  if (providerId === "groq") {
    return (
      models.find((entry) => entry.id === preferred) ||
      models.find((entry) => /qwen\/qwen3\.8-27b/i.test(entry.id)) ||
      models.find((entry) => /openai\/gpt-oss-20b/i.test(entry.id)) ||
      null
    );
  }
  return models.find((entry) => entry.id === preferred) || null;
}

function candidateProviders(registry) {
  const requested = env("COFFEEJACK_EXPERT_PROVIDER").toLowerCase();
  const explicitModel = env("COFFEEJACK_EXPERT_MODEL");
  const order =
    requested && requested !== "auto" ? [requested] : ["google", "groq"];
  const out = [];
  for (const providerId of order) {
    if (!["google", "groq"].includes(providerId)) continue;
    if (!providerEnabled(registry, providerId)) continue;
    if (providerId === "google" && !explicitModel) {
      const models = providerModels(registry, providerId);
      for (const modelId of DEFAULT_GOOGLE_MODELS) {
        const model = models.find((entry) => entry.id === modelId);
        if (model) out.push({ providerId, modelId: model.id });
      }
      continue;
    }
    const model = preferredModel(registry, providerId, explicitModel);
    if (!model) continue;
    out.push({ providerId, modelId: model.id });
  }
  return out;
}

export function expertStatus(registry) {
  const candidates = candidateProviders(registry);
  return {
    configured: candidates.length > 0,
    candidates,
    policy: "free-advisor-only",
  };
}
export async function consultExpert({
  registry,
  task = "",
  context = "",
  attempts = "",
  question = "",
  signal,
} = {}) {
  if (!registry) throw new Error("Expert consultation registry is unavailable");
  await registry.refresh?.(signal);
  const candidates = candidateProviders(registry);
  if (!candidates.length) {
    throw new Error(
      "No free expert provider is configured. Add GEMINI_API_KEY or GROQ_API_KEY locally, then restart CoffeeJack.",
    );
  }

  const safeTask = safeField(task);
  const safeContext = safeField(context);
  const safeAttempts = safeField(attempts);
  const safeQuestion = safeField(question);
  const redacted =
    safeTask.redacted +
    safeContext.redacted +
    safeAttempts.redacted +
    safeQuestion.redacted;

  const messages = [
    {
      role: "system",
      content:
        "You are a second-opinion technical advisor to CoffeeJack, Abdulrahman's local execution agent. " +
        "CoffeeJack alone can use tools and control the PC. You cannot. Give a concise, practical next action, " +
        "identify likely root causes, and state uncertainty. Never claim that you executed or verified anything.",
    },
    {
      role: "user",
      content: [
        "Goal:\n" + safeTask.text,
        safeContext.text ? "Context:\n" + safeContext.text : "",
        safeAttempts.text
          ? "What Jack already tried:\n" + safeAttempts.text
          : "",
        safeQuestion.text ? "Question:\n" + safeQuestion.text : "",
        "Return the best next action for Jack. Do not request credentials or secrets.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const failures = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted?.();
    try {
      const result = await registry.chat({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        messages,
        tools: [],
        profile: { think: false, predict: 1400, temperature: 0.2 },
        signal,
      });
      const advice = String(result?.content || "").trim();
      if (!advice) throw new Error("Expert returned an empty response");
      return {
        advice,
        provider: candidate.providerId,
        model: candidate.modelId,
        remote: true,
        redacted,
        sanitized: true,
      };
    } catch (error) {
      failures.push(
        candidate.providerId +
          "/" +
          candidate.modelId +
          ": " +
          String(error?.message || error).slice(0, 240),
      );
    }
  }

  throw new Error(
    "Free expert consultation failed: " + failures.join(" | "),
  );
}
