import os from "node:os";
import { modelTaskKind } from "./auto-mode.mjs";

const imagePath = /\.(png|jpe?g|webp)$/i;
const TASK_MODES = ["auto", "general", "coding", "vision"];

export function classifyTask({
  text = "",
  mode = "auto",
  attachments = [],
  history = [],
  effectiveMode,
} = {}) {
  if (!TASK_MODES.includes(mode)) throw new Error("Invalid task mode");
  if (attachments.some((p) => imagePath.test(p)) || mode === "vision")
    return "vision";
  if (mode !== "auto") return mode;
  return modelTaskKind({
    effectiveMode: effectiveMode || "auto",
    text,
    attachments,
    history,
  });
}

function reasonCode({ locked, kind, gaming, fallback, remote }) {
  if (locked) return "manual_lock";
  if (gaming) return "gaming_fallback";
  if (fallback) return "fallback_after_failure";
  if (kind === "vision") return "vision_required";
  if (kind === "coding") return "coding_capable";
  if (remote) return "remote_selected";
  return "local_fast";
}

function scoreModel(entry, { kind, gaming, remoteBudget, preferLocal }) {
  let score = 0;
  const caps = entry.capabilities || [];
  if (kind === "vision") score += caps.includes("vision") ? 50 : -100;
  if (kind === "coding") score += caps.includes("tools") ? 30 : 0;
  if (kind === "coding") score += caps.includes("coding") ? 20 : 5;
  if (caps.includes("reasoning") && /reason|complex|architect/i.test(kind))
    score += 10;
  if (entry.local) score += preferLocal || gaming ? 40 : 15;
  else {
    score += gaming ? -80 : 10;
    if (remoteBudget === "off") score -= 100;
    if (remoteBudget === "conservative") score -= 5;
    if (remoteBudget === "performance") score += 15;
  }
  if (entry.speedTier === "fast") score += gaming ? 20 : 5;
  if (entry.costTier === "free" || entry.costTier === "local") score += 5;
  return score;
}

/**
 * Smart model selection using ProviderRegistry when available.
 * Backward compatible with ollama-only callers.
 */
export async function routeModel({
  ollama,
  registry,
  settings,
  signal,
  memoryBytes = os.totalmem(),
  requestedModel = "auto",
  gaming = false,
  effectiveMode,
  preferences = {},
  previousFailures = [],
  ...task
}) {
  signal?.throwIfAborted();
  const kind = classifyTask({ ...task, effectiveMode });
  const remoteAi = preferences.remoteAi || "allowed";
  const remoteBudget = preferences.remoteBudget || "conservative";
  const preferLocal = remoteAi === "never" || gaming || remoteBudget === "off";

  if (registry) {
    await registry.refresh?.(signal);
    const models = registry.listModels({
      localOnly: preferLocal,
      remoteAllowed: remoteAi !== "never" && !gaming,
    });
    const normalize = (name) =>
      name && (name.includes(":") ? name : name + ":latest");
    const locked =
      requestedModel &&
      requestedModel !== "auto" &&
      models.some(
        (m) =>
          m.id === requestedModel ||
          m.effectiveModel === requestedModel ||
          normalize(m.id) === normalize(requestedModel),
      );

    let candidates = models.filter((m) => {
      if (previousFailures.includes(m.id) || previousFailures.includes(m.effectiveModel))
        return false;
      const caps = m.capabilities || [];
      if (kind === "vision" && !caps.includes("vision") && !locked) return false;
      if (kind === "coding" && !caps.includes("tools") && !m.local && !locked)
        return false;
      if (preferLocal && !m.local) return false;
      return true;
    });

    if (locked) {
      candidates = models.filter(
        (m) =>
          m.id === requestedModel ||
          m.effectiveModel === requestedModel ||
          normalize(m.id) === normalize(requestedModel),
      );
    } else {
      candidates = [...candidates].sort(
        (a, b) =>
          scoreModel(b, { kind, gaming, remoteBudget, preferLocal }) -
          scoreModel(a, { kind, gaming, remoteBudget, preferLocal }),
      );
    }

    // Prefer settings.model / codingModel / visionModel as soft hints for local.
    const preferredName =
      kind === "vision"
        ? settings.visionModel
        : kind === "coding"
          ? settings.codingModel || settings.model
          : settings.model;
    if (!locked && preferredName) {
      const preferred = candidates.find(
        (m) =>
          m.id === preferredName || normalize(m.id) === normalize(preferredName),
      );
      if (preferred) {
        candidates = [
          preferred,
          ...candidates.filter((m) => m !== preferred),
        ];
      }
    }

    for (const entry of candidates) {
      signal?.throwIfAborted();
      const provider = registry.getProvider(entry.provider);
      let capabilities = entry.capabilities || [];
      let context = 8192;
      if (entry.provider === "ollama" && ollama?.inspect) {
        try {
          const info = await ollama.inspect(entry.id, signal);
          capabilities = info.capabilities ?? capabilities;
          const supportedContext = Object.entries(info.model_info ?? {})
            .filter(([key]) => key.endsWith(".context_length"))
            .map(([, value]) => Number(value))
            .filter((n) => n > 0);
          context = Math.min(
            kind === "coding" && memoryBytes >= 24 * 1024 ** 3 ? 16384 : 8192,
            ...(supportedContext.length ? supportedContext : []),
          );
          if (kind === "vision" && !capabilities.includes("vision") && !locked)
            continue;
          if (kind === "coding" && !capabilities.includes("tools") && !locked)
            continue;
        } catch {
          continue;
        }
      }
      const fallback =
        Boolean(previousFailures.length) ||
        (preferredName &&
          normalize(entry.id) !== normalize(preferredName) &&
          !locked);
      const remote = !entry.local;
      return {
        kind,
        model: entry.id,
        requestedModel: requestedModel || "auto",
        effectiveModel: entry.id,
        provider: entry.provider,
        capabilities,
        fallback,
        reasonCode: reasonCode({ locked, kind, gaming, fallback, remote }),
        reason: locked
          ? "Manual model lock"
          : gaming
            ? "Gaming Mode prefers a light local model"
            : kind === "vision"
              ? "Vision-capable model"
              : kind === "coding"
                ? "Coding-capable model"
                : remote
                  ? "Configured remote model"
                  : "Auto local model selection",
        profile: {
          think:
            kind === "coding" && capabilities.includes("thinking")
              ? /^gpt-oss/i.test(entry.id)
                ? "medium"
                : true
              : false,
          context: entry.contextLength
            ? Math.min(entry.contextLength, context)
            : context,
          predict: kind === "coding" ? 4096 : 3072,
        },
        needsRemoteApproval: remote && remoteAi === "ask",
        fallbackModels: candidates
          .filter((m) => m.id !== entry.id)
          .slice(0, 3)
          .map((m) => m.id),
      };
    }
    throw new Error(
      kind === "vision"
        ? "No installed local vision model is available. Configure a vision-capable model before sending images."
        : "No compatible model is available for this request.",
    );
  }

  // Legacy ollama-only path (tests without registry).
  return routeModelLegacy({
    ollama,
    settings,
    signal,
    memoryBytes,
    requestedModel,
    gaming,
    effectiveMode,
    kind,
    ...task,
  });
}

async function routeModelLegacy({
  ollama,
  settings,
  signal,
  memoryBytes,
  requestedModel,
  gaming,
  kind,
}) {
  signal?.throwIfAborted();
  const installed = (await ollama.models(signal)).filter(
    (m) => !m.remote_host && !/(?:^|[-:])cloud(?:$|:)/i.test(m.name),
  );
  const normalize = (name) =>
    name && (name.includes(":") ? name : name + ":latest");
  const locked =
    requestedModel &&
    requestedModel !== "auto" &&
    installed.some((m) => normalize(m.name) === normalize(requestedModel));
  const preferred = locked
    ? requestedModel
    : kind === "vision"
      ? settings.visionModel
      : kind === "coding"
        ? settings.codingModel || settings.model
        : settings.model;
  const candidates = [
    ...new Set(
      [preferred, settings.model, ...installed.map((m) => m.name)].filter(
        Boolean,
      ),
    ),
  ];
  for (const candidate of candidates) {
    const entry = installed.find(
      (m) => normalize(m.name) === normalize(candidate),
    );
    if (!entry) continue;
    signal?.throwIfAborted();
    const info = await ollama.inspect(entry.name, signal);
    const capabilities = info.capabilities ?? [];
    if (kind === "vision" && !capabilities.includes("vision")) continue;
    if (kind === "coding" && !capabilities.includes("tools") && !locked)
      continue;
    void gaming;
    const supportedContext = Object.entries(info.model_info ?? {})
      .filter(([key]) => key.endsWith(".context_length"))
      .map(([, value]) => Number(value))
      .filter((n) => n > 0);
    const context = Math.min(
      kind === "coding" && memoryBytes >= 24 * 1024 ** 3 ? 16384 : 8192,
      ...(supportedContext.length ? supportedContext : []),
    );
    return {
      kind,
      model: entry.name,
      requestedModel: requestedModel || "auto",
      effectiveModel: entry.name,
      provider: "ollama",
      capabilities,
      fallback:
        normalize(entry.name) !== normalize(preferred || settings.model),
      reasonCode: reasonCode({
        locked,
        kind,
        gaming,
        fallback:
          normalize(entry.name) !== normalize(preferred || settings.model),
      }),
      reason: locked
        ? "Manual model lock"
        : kind === "vision"
          ? "Verified image-capable local model"
          : kind === "coding"
            ? "Coding workflow with local tools"
            : requestedModel === "auto"
              ? "Auto model selection"
              : "General conversation",
      profile: {
        think:
          kind === "coding" && capabilities.includes("thinking")
            ? /^gpt-oss/i.test(entry.name)
              ? "medium"
              : true
            : false,
        context,
        predict: kind === "coding" ? 4096 : 3072,
      },
    };
  }
  throw new Error(
    kind === "vision"
      ? "No installed local vision model is available. Configure a vision-capable model before sending images."
      : "No compatible local model is installed. Check the model settings and Ollama.",
  );
}
