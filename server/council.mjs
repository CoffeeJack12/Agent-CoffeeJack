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
  const evidenceMode = Boolean(evidence) || safeRound > 1;
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
    const system = evidenceMode
      ? member.role === "critic" || member.role === "specialist" || member.role === "judge"
        ? "You review ONLY against the verified evidence pack. Ask: Does evidence support the proposed fix? Any regression visible from tests/diff? Is another check necessary? For research: flag unsupported conclusions and source conflicts. Do not invent tool results. Do not claim success if tests failed. Be concise."
        : "You are reviewing verified tool evidence. Confirm what the evidence supports and what remains unproven. Do not invent tool results. Do not override failing tests. Be concise."
      : roleSystem(member.role);
    let messages = [
      { role: "system", content: system },
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
          evidenceMode
            ? "This is an evidence critique round. Focus only on remaining issues given the verified evidence. Tool evidence wins over model opinions."
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
  const isReview = result.round > 1 || result.evidenceRound;
  return {
    title: isReview ? "Council Review" : "AI Council",
    status: "done",
    detail: isReview
      ? `Evidence round: ${result.round || 2} · Participants: ${result.succeeded || 0}/${result.requested || 0}${
          result.testsVerified != null
            ? ` · Tests verified: ${result.testsVerified ? "yes" : "no"}`
            : ""
        }`
      : `${result.modelsConsulted || result.succeeded || 0} models consulted${
          providers.size ? `, ${providers.size} providers` : ""
        }${result.rejected ? `, ${result.rejected} failed` : ""}${
          result.round > 1 ? ` · round ${result.round}` : ""
        }`,
    triggerReason: plan?.triggerReason,
    providers: providers.size,
    modelsConsulted: result.modelsConsulted || result.succeeded || 0,
    succeeded: result.succeeded,
    requested: result.requested,
    evidenceRound: Boolean(isReview),
    evidenceTypes: result.evidenceTypes || [],
    testsVerified: result.testsVerified,
    verification: result.verification || null,
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

const SECRET =
  /\b(?:sk-[a-zA-Z0-9]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|password\s*[:=]\s*\S+|Bearer\s+\S+)/gi;

function parseDetail(row) {
  if (row.detail && typeof row.detail === "object") return row.detail;
  const raw = typeof row.detail === "string" ? row.detail : "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Truncated event JSON — recover research source URLs when present.
    const recovered = { result: { sources: [], searchResults: [] } };
    const urlRe =
      /"url"\s*:\s*"(https:\\\/\\\/[^"\\]+|https:\/\/[^"]+)"/g;
    const titleRe = /"title"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    const urls = [...raw.matchAll(urlRe)].map((m) =>
      m[1].replace(/\\\//g, "/"),
    );
    const titles = [...raw.matchAll(titleRe)].map((m) =>
      m[1].replace(/\\"/g, '"').slice(0, 120),
    );
    for (let i = 0; i < Math.min(urls.length, 8); i++)
      recovered.result.sources.push({
        title: titles[i] || urls[i],
        url: urls[i],
      });
    return recovered;
  }
}

function normalizeEvidenceSources(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && (s.url || s.href))
    .slice(0, 8)
    .map((s) => {
      const url = String(s.url || s.href).slice(0, 300);
      let domain = String(s.domain || "");
      if (!domain) {
        try {
          domain = new URL(url).hostname;
        } catch {
          domain = "";
        }
      }
      return {
        title: clip(s.title || domain || url, 80),
        url,
        domain,
      };
    });
}

function clip(text, n = 400) {
  const s = String(text ?? "")
    .replace(SECRET, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * Build a bounded evidence pack from tool events for this chat turn.
 */
export function buildEvidencePack(events = [], { taskType = "general", chatId } = {}) {
  const rows = (events || []).filter(
    (e) => !chatId || e.chat_id === chatId || e.chatId === chatId,
  );
  const pack = {
    taskType,
    changedFiles: [],
    tests: null,
    research: null,
    inspection: null,
    checks: null,
    failures: [],
    warnings: [],
  };

  for (const row of rows) {
    const tool = row.tool || row.name;
    const status = row.status;
    const detail = parseDetail(row);
    const result = detail?.result ?? detail;
    const args = detail?.args ?? {};

    if (tool === "apply_patch" && status === "done") {
      const file = args.path || args.file || result?.path;
      if (file && !pack.changedFiles.includes(file))
        pack.changedFiles.push(String(file).slice(0, 200));
    }
    if (tool === "write_file" && status === "done") {
      const file = args.path || result?.path;
      if (file && !pack.changedFiles.includes(file))
        pack.changedFiles.push(String(file).slice(0, 200));
    }
    if (tool === "run_tests") {
      const code =
        typeof result?.code === "number"
          ? result.code
          : status === "done"
            ? 0
            : status === "error"
              ? 1
              : null;
      const passed = status === "done" && code === 0;
      pack.tests = {
        command: clip(args.command || args.script || "run_tests", 120),
        exitCode: code,
        passed,
        summary: clip(
          result?.output || detail?.error || (passed ? "tests passed" : "tests failed"),
          500,
        ),
      };
      if (!passed)
        pack.failures.push({
          type: "tests",
          summary: pack.tests.summary,
        });
    }
    if (tool === "run_check") {
      const code = typeof result?.code === "number" ? result.code : status === "done" ? 0 : 1;
      pack.checks = {
        command: clip(args.script || "run_check", 120),
        exitCode: code,
        passed: status === "done" && code === 0,
        summary: clip(result?.output || detail?.error || "", 400),
      };
      if (!pack.checks.passed)
        pack.failures.push({ type: "check", summary: pack.checks.summary });
    }
    if (tool === "research" && status === "done") {
      // Structured tool payload is source of truth — never invent from chat text.
      const payload =
        result?.result && typeof result.result === "object"
          ? result.result
          : result;
      const seen = new Set();
      const sources = [];
      for (const list of [
        payload?.sources,
        payload?.searchResults,
        result?.sources,
        result?.searchResults,
        result?.results,
        detail?.result?.sources,
        detail?.result?.searchResults,
      ]) {
        for (const item of normalizeEvidenceSources(list)) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          sources.push(item);
          if (sources.length >= 8) break;
        }
        if (sources.length >= 8) break;
      }
      const keyFacts = clip(
        payload?.summary ||
          payload?.answer ||
          payload?.instructions ||
          result?.summary ||
          result?.answer ||
          "",
        600,
      );
      pack.research = { sources, keyFacts };
      if (!sources.length) pack.warnings.push("research_no_sources");
    }
    if (tool === "inspect_pc" && status === "done") {
      pack.inspection = {
        relevantFindings: clip(
          JSON.stringify(result?.summary || result || {}).slice(0, 800),
          600,
        ),
      };
    }
    if ((tool === "git_diff" || tool === "git_status") && status === "done") {
      const text = clip(result?.output || result?.status || JSON.stringify(result), 400);
      if (text && !pack.changedFiles.includes(text.slice(0, 80)))
        pack.warnings.push(`git:${text.slice(0, 120)}`);
    }
    if (status === "error" && tool) {
      pack.failures.push({
        type: tool,
        summary: clip(detail?.error || result?.error || "tool error", 200),
      });
    }
  }

  pack.changedFiles = pack.changedFiles.slice(0, 12);
  pack.failures = pack.failures.slice(0, 8);
  pack.warnings = pack.warnings.slice(0, 8);
  pack.meaningful = Boolean(
    pack.tests ||
      pack.research?.sources?.length ||
      pack.inspection ||
      pack.checks ||
      pack.changedFiles.length,
  );
  // Failed tests are decisive ground truth — no debate needed.
  pack.decisiveFailure = Boolean(pack.tests && pack.tests.passed === false);
  // Decisive success only when trivial (no coding/research review needed).
  pack.decisiveSuccess = Boolean(
    pack.meaningful &&
      !pack.failures.length &&
      !pack.tests &&
      !pack.research &&
      pack.changedFiles.length === 0 &&
      pack.inspection,
  );
  return pack;
}

export function formatEvidencePack(pack) {
  if (!pack) return "";
  const lines = [`Evidence pack (verified tools only; taskType=${pack.taskType}):`];
  if (pack.changedFiles?.length)
    lines.push(`Changed files: ${pack.changedFiles.join(", ")}`);
  if (pack.tests) {
    lines.push(
      `Tests: exit=${pack.tests.exitCode} passed=${pack.tests.passed} cmd=${pack.tests.command}`,
    );
    lines.push(`Test summary: ${pack.tests.summary}`);
  }
  if (pack.checks) {
    lines.push(
      `Check: exit=${pack.checks.exitCode} passed=${pack.checks.passed} ${pack.checks.summary}`,
    );
  }
  if (pack.research?.sources?.length) {
    lines.push("Research sources:");
    for (const s of pack.research.sources)
      lines.push(`- ${s.title}: ${s.url}`);
    if (pack.research.keyFacts) lines.push(`Key facts: ${pack.research.keyFacts}`);
  }
  if (pack.inspection?.relevantFindings)
    lines.push(`Inspection: ${pack.inspection.relevantFindings}`);
  if (pack.failures?.length)
    lines.push(
      `Failures: ${pack.failures.map((f) => `${f.type}:${f.summary}`).join(" | ")}`,
    );
  if (pack.warnings?.length) lines.push(`Warnings: ${pack.warnings.join(" | ")}`);
  return lines.join("\n").slice(0, 6000);
}

/**
 * Decide whether to run automatic Council evidence Round 2.
 */
export function shouldRunEvidenceRound({
  pack,
  gaming = false,
  round1Result = null,
  participants = [],
  preferences = {},
} = {}) {
  if (gaming) return { run: false, reason: "gaming" };
  if (preferences.councilMode === "off")
    return { run: false, reason: "council_off" };
  if (!round1Result || round1Result.skipped)
    return { run: false, reason: "no_prior_council" };
  if ((participants?.length || 0) < 2)
    return { run: false, reason: "one_model_available" };
  if ((round1Result.succeeded || 0) < 1)
    return { run: false, reason: "round1_empty" };
  if (!pack?.meaningful) return { run: false, reason: "no_meaningful_evidence" };
  if (pack.decisiveFailure)
    return { run: false, reason: "failed_tests_decisive" };
  if (pack.decisiveSuccess)
    return { run: false, reason: "evidence_decisive" };
  return { run: true, reason: "review_evidence" };
}

/**
 * Ground final synthesis in tool evidence. Council critique cannot override facts.
 */
export function synthesizeFromEvidence({
  pack,
  round2Result = null,
  taskText = "",
} = {}) {
  const lines = [];
  if (pack?.tests) {
    if (pack.tests.passed) {
      lines.push("Verified: tests passed.");
      lines.push(`Test evidence: ${pack.tests.summary}`);
    } else {
      lines.push("Verified: tests did not pass. Success is not claimed.");
      lines.push(`Test evidence: ${pack.tests.summary}`);
    }
  }
  if (pack?.research?.sources?.length) {
    lines.push("Sources (authoritative over model opinions):");
    for (const s of pack.research.sources.slice(0, 5))
      lines.push(`- ${s.title}: ${s.url}`);
  }
  if (pack?.changedFiles?.length)
    lines.push(`Changed files: ${pack.changedFiles.join(", ")}`);
  if (pack?.failures?.length && !pack?.tests) {
    lines.push(
      `Tool failures: ${pack.failures.map((f) => f.summary).join("; ")}`,
    );
  }

  const critiques = (round2Result?.proposals || [])
    .filter((p) => p.status === "ok" && p.summary)
    .map((p) => `- ${p.role}: ${p.summary}`);
  if (critiques.length && pack?.tests?.passed !== false) {
    lines.push("Council review (advisory; cannot override tool evidence):");
    lines.push(...critiques.slice(0, 4));
  } else if (critiques.length && pack?.tests?.passed === false) {
    lines.push("Council opinions disregarded where they conflict with failing tests.");
  }

  if (!lines.length) {
    return clip(taskText ? `No decisive verification evidence for: ${taskText.slice(0, 80)}` : "No verification evidence.", 400);
  }
  return lines.join("\n").slice(0, 2500);
}

export function evidenceTypesFromPack(pack) {
  const types = [];
  if (pack?.tests) types.push("tests");
  if (pack?.research?.sources?.length) types.push("research");
  if (pack?.inspection) types.push("inspection");
  if (pack?.checks) types.push("checks");
  if (pack?.changedFiles?.length) types.push("diff");
  return types;
}

export { MAX_ROUNDS, ROLES, uniqueModels };
