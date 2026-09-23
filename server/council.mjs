/**
 * Provider-native AI Council — multi-provider consultation.
 * Models propose text only; Jack remains the sole tool executor.
 * Never invents providers/models that are not configured and available.
 */

import { messagesForRemote, sanitizeForRemote } from "./privacy.mjs";

const EXPLICIT =
  /\b(?:consult (?:other )?models?|ask the council|second opinion|ai council|council of models|get (?:a )?second opinion)\b|استشر|مجلس الذكاء/i;
const COMPLEX =
  /\b(?:architect(?:ure)?|refactor (?:the )?(?:entire |whole )?|difficult bug|root cause|compare approaches|trade-?offs?|deep research|carefully reason|security (?:review|analysis)|ambiguous|multiple (?:valid )?designs?)\b|إعادة هيكلة|سبب جذري|عمارة|مقارنة/i;
const SIMPLE =
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|yo|مرحبا|هلا|شكرا)[.!؟\s]*$/i;
const SIMPLE_TASK =
  /\b(?:translate|read (?:this |the )?file|what time|weather|rename|list files?)\b|^what is \d|^who are you\b/i;

const MAX_PROMPT = 8000;
const MAX_OUTPUT = 2500;
const MAX_ROUNDS = 2;
const DEFAULT_TIMEOUT_MS = {
  local: 90000,
  remote: 45000,
};

const ROLES = ["primary", "critic", "specialist", "judge"];

export function shouldConsultCouncil({
  text = "",
  preferences = {},
  gaming = false,
  effectiveMode = "auto",
  availableModels = [],
  failedAttempts = 0,
  taskKind = "general",
} = {}) {
  const mode = preferences.councilMode || "auto";
  if (gaming || mode === "off")
    return { consult: false, reason: gaming ? "gaming" : "council_off" };

  const distinct = uniqueModels(availableModels);
  if (distinct.length < 2)
    return {
      consult: false,
      reason: "one_model_available",
      available: distinct.length,
    };

  if (EXPLICIT.test(text))
    return { consult: true, reason: "explicit_request" };
  if (
    SIMPLE.test(text.trim()) ||
    SIMPLE_TASK.test(text.trim()) ||
    effectiveMode === "empathy"
  )
    return { consult: false, reason: "simple_or_empathy" };

  const complex =
    COMPLEX.test(text) ||
    taskKind === "coding" ||
    effectiveMode === "developer" ||
    effectiveMode === "hacker" ||
    effectiveMode === "research" ||
    failedAttempts >= 1;

  if (mode === "on" && complex)
    return { consult: true, reason: "council_on_complex" };
  if (mode === "auto" && (COMPLEX.test(text) || failedAttempts >= 2))
    return { consult: true, reason: "auto_complex" };
  if (mode === "auto" && complex && distinct.length >= 3)
    return { consult: true, reason: "auto_multi_model" };
  return { consult: false, reason: "not_warranted" };
}

function modelKey(m) {
  return `${m.provider || m.providerId || "ollama"}:${m.id || m.modelId || m.name || m.model}`;
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    if (!m) continue;
    const key = modelKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function caps(m) {
  return m.capabilities || [];
}

function scoreForRole(entry, role, taskKind, { remoteBudget, preferLocal }) {
  let score = 0;
  const c = caps(entry);
  if (role === "primary") {
    if (taskKind === "coding") {
      score += c.includes("tools") ? 30 : 0;
      score += c.includes("coding") ? 20 : 5;
    }
    if (taskKind === "vision") score += c.includes("vision") ? 40 : -50;
    score += c.includes("reasoning") ? 10 : 0;
  }
  if (role === "critic") {
    score += c.includes("reasoning") ? 25 : 10;
    score += entry.local ? 5 : 8;
  }
  if (role === "specialist") {
    score += c.includes("reasoning") ? 15 : 5;
    if (taskKind === "coding") score += c.includes("tools") ? 10 : 0;
  }
  if (role === "judge") score += c.includes("reasoning") ? 20 : 8;

  if (entry.local) score += preferLocal ? 25 : 8;
  else {
    if (preferLocal || remoteBudget === "off") score -= 100;
    else if (remoteBudget === "conservative") score -= 5;
    else if (remoteBudget === "performance") score += 20;
    else score += 8;
  }
  // Health penalties (bounded)
  const failures = entry.recentFailures || entry.failures || 0;
  if (failures >= 3) score -= 40;
  else if (failures >= 1) score -= 10;
  if (entry.inCooldown) score -= 60;
  if (entry.qualityBoost) score += Math.min(15, entry.qualityBoost);
  return score;
}

/**
 * Prefer distinct providers, then distinct models. Never duplicate the same model
 * as independent "AIs".
 */
export function selectCouncilParticipants(
  models,
  {
    max = 2,
    gaming = false,
    taskKind = "general",
    preferences = {},
    lockedModel = null,
    effectiveModel = null,
    healthLookup = () => ({}),
  } = {},
) {
  if (gaming) return [];
  const remoteAi = preferences.remoteAi || "allowed";
  const remoteBudget = preferences.remoteBudget || "conservative";
  const preferLocal =
    remoteAi === "never" || remoteBudget === "off";
  const otherModels = preferences.councilOtherModels !== "off";
  const limit = Math.max(2, Math.min(4, Number(max) || 2));

  let pool = uniqueModels(models).filter((m) => m && (m.id || m.name || m.model));
  if (preferLocal) pool = pool.filter((m) => m.local !== false);
  if (remoteAi === "never") pool = pool.filter((m) => m.local !== false);

  // Manual lock: if councilOtherModels off, only the locked/effective model → skip.
  if (!otherModels && (lockedModel || effectiveModel)) {
    const lock = lockedModel || effectiveModel;
    pool = pool.filter(
      (m) =>
        m.id === lock ||
        m.effectiveModel === lock ||
        m.name === lock,
    );
  }

  pool = pool.map((m) => {
    const health = healthLookup(m.provider || m.providerId, m.id) || {};
    return {
      ...m,
      provider: m.provider || m.providerId || "ollama",
      id: m.id || m.modelId || m.name || m.model,
      recentFailures: health.failures || 0,
      inCooldown: Boolean(health.inCooldown),
      qualityBoost: health.qualityBoost || 0,
    };
  });

  if (pool.length < 2) return [];

  // Diversity-first greedy selection.
  const selected = [];
  const usedProviders = new Set();
  const usedKeys = new Set();
  const roleOrder =
    limit >= 4
      ? ["primary", "critic", "specialist", "judge"]
      : limit === 3
        ? ["primary", "critic", "specialist"]
        : ["primary", "critic"];

  // Conservative remote budget: at most one remote participant.
  let remoteCount = 0;
  const maxRemote =
    remoteBudget === "off" || preferLocal
      ? 0
      : remoteBudget === "conservative"
        ? 1
        : remoteBudget === "balanced"
          ? 2
          : limit;

  for (const role of roleOrder) {
    if (selected.length >= limit) break;
    const ranked = [...pool]
      .filter((m) => !usedKeys.has(modelKey(m)))
      .filter((m) => {
        if (m.local === false && remoteCount >= maxRemote) return false;
        return true;
      })
      .sort((a, b) => {
        const diversify = (x) =>
          (usedProviders.has(x.provider) ? -25 : 40) +
          scoreForRole(x, role, taskKind, { remoteBudget, preferLocal });
        return diversify(b) - diversify(a);
      });

    // Prefer different provider when possible.
    let pick =
      ranked.find((m) => !usedProviders.has(m.provider)) || ranked[0];
    if (!pick) break;

    // Primary prefers effective/locked model when allowed in pool.
    if (role === "primary" && effectiveModel) {
      const preferred = ranked.find(
        (m) =>
          m.id === effectiveModel ||
          m.effectiveModel === effectiveModel,
      );
      if (preferred) pick = preferred;
    }

    usedKeys.add(modelKey(pick));
    usedProviders.add(pick.provider);
    if (pick.local === false) remoteCount += 1;
    selected.push({
      modelId: pick.id,
      providerId: pick.provider,
      role,
      reasonCode: usedProviders.size > 1 && selected.length
        ? "provider_diversity"
        : pick.local === false
          ? "remote_capable"
          : taskKind === "coding"
            ? "coding_capable"
            : "local_available",
      local: pick.local !== false,
      capabilities: caps(pick),
    });
  }

  return selected.length >= 2 ? selected : [];
}

/**
 * Structured council plan (internal). Concise metadata only for UI.
 */
export function buildCouncilPlan({
  text,
  preferences = {},
  gaming = false,
  effectiveMode = "auto",
  taskKind = "general",
  availableModels = [],
  failedAttempts = 0,
  lockedModel = null,
  effectiveModel = null,
  healthLookup,
} = {}) {
  const decision = shouldConsultCouncil({
    text,
    preferences,
    gaming,
    effectiveMode,
    availableModels,
    failedAttempts,
    taskKind,
  });
  if (!decision.consult) {
    return {
      enabled: false,
      triggerReason: decision.reason,
      participants: [],
      maxParticipants: Number(preferences.councilMaxModels || 2),
      remotePolicy: preferences.remoteAi || "allowed",
      budgetClass: preferences.remoteBudget || "conservative",
    };
  }
  const participants = selectCouncilParticipants(availableModels, {
    max: Number(preferences.councilMaxModels || 2),
    gaming,
    taskKind,
    preferences,
    lockedModel,
    effectiveModel,
    healthLookup,
  });
  if (participants.length < 2) {
    return {
      enabled: false,
      triggerReason: "insufficient_distinct_models",
      participants: [],
      maxParticipants: Number(preferences.councilMaxModels || 2),
      remotePolicy: preferences.remoteAi || "allowed",
      budgetClass: preferences.remoteBudget || "conservative",
    };
  }
  return {
    enabled: true,
    triggerReason: decision.reason,
    participants,
    maxParticipants: Number(preferences.councilMaxModels || 2),
    remotePolicy: preferences.remoteAi || "allowed",
    budgetClass: preferences.remoteBudget || "conservative",
  };
}

function roleSystem(role) {
  if (role === "critic")
    return "You are a critic. List flaws, risks and missing checks. Be concise. Do not claim to run tools. Do not invent tool results.";
  if (role === "specialist")
    return "You are a specialist. Give a focused alternative approach. Be concise. Do not claim to run tools.";
  if (role === "judge")
    return "You are a judge. Compare proposals briefly and recommend one plan. Do not claim to run tools.";
  return "You are the primary analyst. Propose a clear plan. Be concise. Do not claim to run tools. Do not invent tool results.";
}

function mergeAbort(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([signal, timeout]);
  return timeout;
}

/**
 * Run council via ProviderRegistry adapters (text-only).
 * chatViaRegistry({ providerId, modelId, messages, signal }) → { content }
 * Or pass registry + optional chatFn override for tests.
 */
export async function runCouncil({
  participants,
  prompt,
  context = "",
  evidence = "",
  round = 1,
  registry,
  chatFn,
  signal,
  preferences = {},
  timeouts = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!participants?.length)
    return {
      skipped: true,
      reason: "no_participants",
      proposals: [],
      round,
    };
  if (participants.length < 2)
    return {
      skipped: true,
      reason: "one_model_available",
      proposals: [],
      available: participants.length,
      round,
    };

  const safeRound = Math.min(MAX_ROUNDS, Math.max(1, Number(round) || 1));
  const proposals = [];
  const callChat =
    chatFn ||
    (async ({ providerId, modelId, messages, signal: sig }) => {
      if (!registry) throw new Error("registry required");
      return registry.chat({
        providerId,
        modelId,
        messages,
        signal: sig,
        profile: { think: false, predict: 1024 },
      });
    });

  for (const member of participants) {
    signal?.throwIfAborted();
    const providerId = member.providerId || member.provider || "ollama";
    const modelId = member.modelId || member.id || member.model;
    const local = member.local !== false && providerId === "ollama";
    const timeoutMs = local
      ? timeouts.local || DEFAULT_TIMEOUT_MS.local
      : timeouts.remote || DEFAULT_TIMEOUT_MS.remote;
    const started = performance.now();
    let messages = [
      { role: "system", content: roleSystem(member.role) },
      {
        role: "user",
        content: [
          context
            ? `Context:\n${sanitizeForRemote(context, { maxChars: 4000 }).text}`
            : "",
          evidence
            ? `Verified evidence (from Jack tools only):\n${sanitizeForRemote(evidence, { maxChars: 4000 }).text}`
            : "",
          `Task:\n${sanitizeForRemote(prompt, { maxChars: MAX_PROMPT }).text}`,
          safeRound > 1
            ? "This is an evidence critique round. Focus on remaining issues given the verified evidence."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
    if (!local) messages = messagesForRemote(messages, { maxChars: MAX_PROMPT });

    try {
      const result = await callChat({
        providerId,
        modelId,
        model: modelId,
        provider: providerId,
        messages,
        signal: mergeAbort(signal, timeoutMs),
      });
      const content = String(result?.content || "").slice(0, MAX_OUTPUT);
      const summary = content.slice(0, 400).replace(/\s+/g, " ").trim();
      proposals.push({
        providerId,
        modelId,
        role: member.role,
        status: "ok",
        summary,
        proposal: content,
        confidenceHint: null,
        latencyMs: Math.round(performance.now() - started),
        errorCode: null,
      });
      registry?.recordSuccess?.(providerId, modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /abort|timeout/i.test(message);
      proposals.push({
        providerId,
        modelId,
        role: member.role,
        status: timedOut ? "timeout" : "error",
        summary: "",
        proposal: "",
        confidenceHint: null,
        latencyMs: Math.round(performance.now() - started),
        errorCode: timedOut ? "timeout" : "provider_error",
        error: message.slice(0, 300),
      });
      registry?.recordFailure?.(providerId, error, modelId);
    }
  }

  const ok = proposals.filter((p) => p.status === "ok");
  const rejected = proposals.length - ok.length;
  const providers = new Set(ok.map((p) => p.providerId));
  const synthesis =
    ok.length === 0
      ? ""
      : [
          "Council synthesis (proposals only; Jack executes tools):",
          ...ok.map(
            (p) =>
              `- ${p.role} (${p.providerId}/${p.modelId}): ${p.summary}`,
          ),
        ].join("\n");

  return {
    skipped: false,
    round: safeRound,
    proposals,
    rejected,
    synthesis,
    modelsConsulted: ok.length,
    providersConsulted: providers.size,
    succeeded: ok.length,
    requested: proposals.length,
  };
}

/**
 * Optional second evidence round (bounded).
 * Pass priorRound (completed rounds so far). Skips if already at MAX_ROUNDS.
 */
export async function runCouncilEvidenceRound(options = {}) {
  const prior = Number(options.priorRound ?? options.round ?? 1) || 1;
  if (prior >= MAX_ROUNDS && !options.force)
    return { skipped: true, reason: "max_rounds", proposals: [], round: prior };
  return runCouncil({
    ...options,
    round: Math.min(MAX_ROUNDS, prior + 1),
    evidence: options.evidence || "",
  });
}

export function councilUiSummary(result, plan = null) {
  if (!result || result.skipped) {
    const reason = result?.reason || plan?.triggerReason || "skipped";
    return {
      title: "AI Council",
      status: "skipped",
      detail:
        reason === "one_model_available" ||
        reason === "insufficient_distinct_models"
          ? "1 model available — consultation skipped"
          : reason,
      triggerReason: reason,
      providers: 0,
      modelsConsulted: 0,
    };
  }
  const providers = new Set(
    (result.proposals || [])
      .filter((p) => p.status === "ok")
      .map((p) => p.providerId || p.provider),
  );
  return {
    title: "AI Council",
    status: "done",
    detail: `${result.modelsConsulted || result.succeeded || 0} models consulted${
      providers.size ? `, ${providers.size} providers` : ""
    }${result.rejected ? `, ${result.rejected} failed` : ""}${
      result.round > 1 ? ` · round ${result.round}` : ""
    }`,
    triggerReason: plan?.triggerReason,
    providers: providers.size,
    modelsConsulted: result.modelsConsulted || result.succeeded || 0,
    succeeded: result.succeeded,
    requested: result.requested,
    proposals: (result.proposals || []).map((p) => ({
      model: p.modelId || p.model,
      provider: p.providerId || p.provider,
      role: p.role,
      status: p.status,
      latencyMs: p.latencyMs,
      summary: p.summary || "",
    })),
  };
}

export { MAX_ROUNDS, ROLES, uniqueModels };
