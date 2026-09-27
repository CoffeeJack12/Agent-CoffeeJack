import os from "node:os";
import { modelTaskKind } from "./auto-mode.mjs";
import {
  classifyLocalTask,
  contextForKind,
  keepAliveForModel,
  modelForLocalTask,
  resolveLocalModelPlan,
} from "./local-models.mjs";
import { shouldPreferJeddawiQuality } from "./conversation-style.mjs";

const imagePath = /\.(png|jpe?g|webp)$/i;
const TASK_MODES = ["auto", "general", "coding", "vision"];

export function classifyTask({
  text = "",
  mode = "auto",
  attachments = [],
  history = [],
  effectiveMode,
  previousFailures = [],
} = {}) {
  if (!TASK_MODES.includes(mode)) throw new Error("Invalid task mode");
  const localKind = classifyLocalTask({
    text,
    mode,
    attachments,
    history,
    effectiveMode,
    previousFailures,
  });
  if (localKind === "hard_reasoning") return "hard_reasoning";
  if (attachments.some((p) => imagePath.test(p)) || mode === "vision")
    return "vision";
  if (mode !== "auto") return mode;
  if (localKind === "coding" || localKind === "general") return localKind;
  return modelTaskKind({
    effectiveMode: effectiveMode || "auto",
    text,
    attachments,
    history,
  });
}

function reasonCode({ locked, kind, gaming, fallback, remote, jeddawiQuality }) {
  if (locked) return "manual_lock";
  if (gaming) return "gaming_fallback";
  if (fallback) return "fallback_after_failure";
  if (kind === "vision") return "vision_required";
  if (kind === "hard_reasoning") return "hard_reasoning";
  if (kind === "coding") return "coding_capable";
  if (jeddawiQuality) return "jeddawi_quality";
  if (remote) return "remote_selected";
  return "local_fast";
}

function scoreModel(entry, { kind, gaming, remoteBudget, preferLocal, health }) {
  let score = 0;
  const caps = entry.capabilities || [];
  if (kind === "vision") score += caps.includes("vision") ? 50 : -100;
  if (kind === "coding") score += caps.includes("tools") ? 30 : 0;
  if (kind === "coding") score += caps.includes("coding") ? 20 : 5;
  if (kind === "hard_reasoning") {
    score += caps.includes("reasoning") || caps.includes("thinking") ? 40 : 0;
    if (/deepseek|r1/i.test(entry.id)) score += 35;
    if (/qwen3:8b/i.test(entry.id)) score -= 5;
  }
  if (caps.includes("reasoning") && /reason|complex|architect/i.test(kind))
    score += 10;
  // Zero-API-cost bias: always prefer local Ollama over remote APIs.
  if (entry.local) score += preferLocal || gaming ? 40 : 25;
  else {
    score += gaming ? -80 : -40;
    if (remoteBudget === "off") score -= 100;
    if (remoteBudget === "conservative") score -= 25;
    if (remoteBudget === "performance") score += 5;
  }
  if (entry.speedTier === "fast") score += gaming ? 20 : 5;
  if (entry.costTier === "free" || entry.costTier === "local") score += 5;
  const h = health || {};
  if (h.inCooldown) score -= 70;
  if ((h.failures || 0) >= 3) score -= 35;
  else if ((h.failures || 0) >= 1) score -= 8;
  if ((h.timeouts || 0) >= 2) score -= 20;
  if (h.qualityBoost) score += Math.min(15, h.qualityBoost);
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
  fastPath = false,
  conversationStyle = null,
  turnIntent = null,
  priorityLane = null,
  ...task
}) {
  signal?.throwIfAborted();
  const kind = classifyTask({
    ...task,
    effectiveMode,
    previousFailures,
  });
  const jeddawiQuality = shouldPreferJeddawiQuality(conversationStyle, {
    intent: turnIntent,
    priorityLane,
  });
  // Local-only by default for zero API cost; explicit prefs can re-enable remotes.
  const remoteAi = preferences.remoteAi || "never";
  const remoteBudget =
    preferences.remoteBudget ||
    (remoteAi === "never" ? "off" : "conservative");
  const preferLocal = remoteAi === "never" || gaming || remoteBudget === "off";

  const installedNames = registry
    ? (registry.listModels({ localOnly: true }) || []).map((m) => m.id)
    : ((await ollama?.models?.(signal)) || [])
        .filter((m) => !m.remote_host)
        .map((m) => m.name);
  const localPlan = resolveLocalModelPlan(installedNames);
  const autoPick = modelForLocalTask(kind, localPlan, {
    previousFailures,
    preferStrong: jeddawiQuality,
  });

  if (registry) {
    // Fast path: never hit /api/show or remote health probes before the first token.
    if (!fastPath) await registry.refresh?.(signal);
    else if (!(registry.listModels({ localOnly: true }) || []).length)
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
      if (
        previousFailures.includes(m.id) ||
        previousFailures.includes(m.effectiveModel)
      )
        return false;
      const health = registry.getModelHealth?.(m.provider, m.id);
      if (health?.inCooldown && !locked) return false;
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
      candidates = [...candidates].sort((a, b) => {
        const ha = registry.getModelHealth?.(a.provider, a.id);
        const hb = registry.getModelHealth?.(b.provider, b.id);
        return (
          scoreModel(b, {
            kind,
            gaming,
            remoteBudget,
            preferLocal,
            health: hb,
          }) -
          scoreModel(a, {
            kind,
            gaming,
            remoteBudget,
            preferLocal,
            health: ha,
          })
        );
      });
    }

    const preferredName = locked
      ? requestedModel
      : kind === "vision"
        ? settings.visionModel || autoPick
        : kind === "hard_reasoning"
          ? autoPick || settings.model
          : kind === "coding"
            ? settings.codingModel || autoPick || settings.model
            : autoPick || settings.model;
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
      let capabilities = entry.capabilities || [];
      const profileKind =
        jeddawiQuality && kind === "general"
          ? "coding"
          : fastPath && !jeddawiQuality
            ? "general"
            : kind;
      let context = contextForKind(profileKind, memoryBytes);
      if (!fastPath && entry.provider === "ollama" && ollama?.inspect) {
        try {
          const info = await ollama.inspect(entry.id, signal);
          capabilities = info.capabilities ?? capabilities;
          const supportedContext = Object.entries(info.model_info ?? {})
            .filter(([key]) => key.endsWith(".context_length"))
            .map(([, value]) => Number(value))
            .filter((n) => n > 0);
          const wantCtx = contextForKind(profileKind, memoryBytes);
          context = Math.min(
            wantCtx,
            ...(supportedContext.length ? supportedContext : [wantCtx]),
          );
          if (kind === "vision" && !capabilities.includes("vision") && !locked)
            continue;
          if (kind === "coding" && !capabilities.includes("tools") && !locked)
            continue;
        } catch {
          continue;
        }
      } else if (fastPath) {
        // Assume local chat models can answer without a tools capability probe.
        capabilities = capabilities.length ? capabilities : ["tools"];
        context = contextForKind(profileKind, memoryBytes);
      }
      const fallback =
        Boolean(previousFailures.length) ||
        (preferredName &&
          normalize(entry.id) !== normalize(preferredName) &&
          !locked);
      const remote = !entry.local;
      return {
        kind: fastPath && !jeddawiQuality ? "general" : kind,
        model: entry.id,
        requestedModel: requestedModel || "auto",
        effectiveModel: entry.id,
        provider: entry.provider,
        capabilities,
        fallback,
        localPlan,
        jeddawiQuality: Boolean(jeddawiQuality),
        reasonCode: reasonCode({
          locked,
          kind: fastPath && !jeddawiQuality ? "general" : kind,
          gaming,
          fallback,
          remote,
          jeddawiQuality,
        }),
        reason: locked
          ? "Manual model lock"
          : gaming
            ? "Gaming Mode prefers a light local model"
            : jeddawiQuality
              ? "Jeddawi quality prefers qwen3:14b"
              : fastPath
                ? "Fast-path local chat model"
                : kind === "vision"
                  ? "Vision-capable model"
                  : kind === "hard_reasoning"
                    ? "Hard-reasoning local model"
                    : kind === "coding"
                      ? "Coding-capable model"
                      : remote
                        ? "Configured remote model"
                        : "Auto fast local model (8b unless complexity needs 14b)",
        profile: {
          think: false,
          keepAlive: keepAliveForModel(entry.id, profileKind, {
            sticky: Boolean(jeddawiQuality),
          }),
          context: entry.contextLength
            ? Math.min(entry.contextLength, context)
            : context,
          predict:
            fastPath && !jeddawiQuality
              ? 512
              : kind === "hard_reasoning" ||
                  kind === "coding" ||
                  jeddawiQuality
                ? 3072
                : 1536,
        },
        needsRemoteApproval: remote && remoteAi === "ask",
        fallbackModels: candidates
          .filter((m) => m.id !== entry.id)
          .slice(0, 3)
          .map((m) => m.id),
        fastPath: Boolean(fastPath),
      };
    }
    throw new Error(
      kind === "vision"
        ? "No installed local vision model is available. Configure a vision-capable model before sending images."
        : "No compatible model is available for this request.",
    );
  }

  return routeModelLegacy({
    ollama,
    settings,
    signal,
    memoryBytes,
    requestedModel,
    gaming,
    kind,
    autoPick,
    localPlan,
    fastPath,
    jeddawiQuality,
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
  autoPick,
  localPlan,
  fastPath = false,
  jeddawiQuality = false,
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
      ? (installed.some(
          (m) => normalize(m.name) === normalize(settings.visionModel || ""),
        )
          ? settings.visionModel
          : undefined) ||
        autoPick ||
        settings.model
      : kind === "hard_reasoning"
        ? autoPick || settings.model
        : kind === "coding"
          ? (installed.some(
              (m) =>
                normalize(m.name) === normalize(settings.codingModel || ""),
            )
              ? settings.codingModel
              : undefined) ||
            autoPick ||
            settings.model
          : jeddawiQuality
            ? autoPick || settings.model
            : (installed.some(
                (m) => normalize(m.name) === normalize(settings.model || ""),
              )
                ? settings.model
                : undefined) ||
              autoPick ||
              settings.model;
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
    let capabilities = ["tools"];
    const profileKind =
      jeddawiQuality && kind === "general"
        ? "coding"
        : fastPath && !jeddawiQuality
          ? "general"
          : kind;
    let context = contextForKind(profileKind, memoryBytes);
    if (!fastPath) {
      const info = await ollama.inspect(entry.name, signal);
      capabilities = info.capabilities ?? [];
      if (kind === "vision" && !capabilities.includes("vision")) continue;
      if (kind === "coding" && !capabilities.includes("tools") && !locked)
        continue;
      const supportedContext = Object.entries(info.model_info ?? {})
        .filter(([key]) => key.endsWith(".context_length"))
        .map(([, value]) => Number(value))
        .filter((n) => n > 0);
      const wantCtx = contextForKind(profileKind, memoryBytes);
      context = Math.min(
        wantCtx,
        ...(supportedContext.length ? supportedContext : [wantCtx]),
      );
    }
    void gaming;
    const configuredPreferred = locked
      ? requestedModel
      : kind === "vision"
        ? settings.visionModel || settings.model
        : kind === "coding"
          ? settings.codingModel || settings.model
          : settings.model;
    const configuredInstalled = installed.some(
      (m) => normalize(m.name) === normalize(configuredPreferred || ""),
    );
    return {
      kind: fastPath && !jeddawiQuality ? "general" : kind,
      model: entry.name,
      requestedModel: requestedModel || "auto",
      effectiveModel: entry.name,
      provider: "ollama",
      capabilities,
      fallback:
        !locked &&
        (!configuredInstalled ||
          normalize(entry.name) !== normalize(configuredPreferred || "")),
      localPlan,
      jeddawiQuality: Boolean(jeddawiQuality),
      reasonCode: reasonCode({
        locked,
        kind: fastPath && !jeddawiQuality ? "general" : kind,
        gaming,
        fallback:
          normalize(entry.name) !== normalize(preferred || settings.model),
        jeddawiQuality,
      }),
      reason: locked
        ? "Manual model lock"
        : jeddawiQuality
          ? "Jeddawi quality prefers qwen3:14b"
          : fastPath
            ? "Fast-path local chat model"
            : kind === "vision"
              ? "Verified image-capable local model"
              : kind === "hard_reasoning"
                ? "Hard-reasoning local model"
                : kind === "coding"
                  ? "Coding workflow with local tools"
                  : requestedModel === "auto"
                    ? "Auto fast local model"
                    : "General conversation",
      profile: {
        think: false,
        keepAlive: keepAliveForModel(entry.name, profileKind, {
          sticky: Boolean(jeddawiQuality),
        }),
        context,
        predict:
          fastPath && !jeddawiQuality
            ? 512
            : kind === "coding" || kind === "hard_reasoning" || jeddawiQuality
              ? 3072
              : 1536,
      },
      fastPath: Boolean(fastPath),
    };
  }
  throw new Error(
    kind === "vision"
      ? "No installed local vision model is available. Configure a vision-capable model before sending images."
      : "No compatible local model is installed. Check the model settings and Ollama.",
  );
}
