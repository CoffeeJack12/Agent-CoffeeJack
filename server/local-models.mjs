/**
 * Local Ollama model catalog and hardware-aware defaults.
 * CoffeeJack stays Ollama-only for inference; remote API keys are never required.
 *
 * Performance bias on 12GB VRAM: prefer qwen3:8b for everyday chat;
 * escalate to qwen3:14b only for coding / hard reasoning / prior 8b failure.
 */

/** Fast/default Auto picks (smallest practical first). */
export const FAST_MODEL_CANDIDATES = ["qwen3:8b", "qwen3:14b"];

/** Strong picks for coding / hard analysis (largest practical first, 30b excluded on 12GB). */
export const STRONG_MODEL_CANDIDATES = ["qwen3:14b", "qwen3:8b"];

/** @deprecated Prefer FAST_MODEL_CANDIDATES; kept for callers that still import this name. */
export const GENERAL_MODEL_CANDIDATES = FAST_MODEL_CANDIDATES;

/** Hard-reasoning preference: strong local chat model before optional deepseek. */
export const REASONING_MODEL_CANDIDATES = [
  "qwen3:14b",
  "deepseek-r1:14b",
  "deepseek-r1:8b",
  "qwen3:8b",
  "deepseek-r1:32b",
  "qwen3:30b",
];

export const FALLBACK_MODEL_CANDIDATES = ["qwen3:8b", "qwen3:14b"];

const HARD_REASONING =
  /\b(race condition|deadlock|complex (?:algorithm|architecture|design)|architect(?:ure)? (?:problem|decision)|deep(?:er)? reason(?:ing)?|step[- ]by[- ]step (?:proof|derivation)|prove that|np[- ]hard|formal verification|multi[- ]step (?:debug|reason|plan|analysis)|difficult (?:debug|math|logic|proof|analysis)|long[- ]form|solve this (?:hard|difficult)|inspect .+ (?:and|to) find why)\b|تفكير عميق|معمارية معقدة|سباق بيانات|إثبات|خوارزمية معقدة|تحليل معقد/i;

const EXPLICIT_DEEP =
  /\b(?:use |with )?(?:deepseek|deep reason(?:ing)?|think hard|hard reasoning|reason carefully)\b|فكّر بعمق|تفكير عميق|ديпсиك/i;

const DEVELOPER =
  /\b(code|coding|program|bug|debug|debugging|repo|repository|git|tests?|javascript|typescript|python|html|css|sql|api|compile|lint|refactor|patch|fix (?:this|the|my)|build|npm|node|project|stack ?trace|exception|typescript error)\b|برمج|كود|مستودع|اختبار|تصحيح|أصلح|اصلح|مشروع|باتش|ديبغ/i;

const FOLLOW_UP =
  /^(continue|fix it|try again|go on|do it|yea|yeah|yes|ok|sure|كمل|تابع|صلحه|ايوه|نعم)[.!؟\s]*$/i;

function normalize(name) {
  if (!name) return "";
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * Deterministic task class for Auto model routing (separate from workflow MODE).
 * @returns {'general'|'coding'|'vision'|'hard_reasoning'}
 */
export function classifyLocalTask({
  text = "",
  mode = "auto",
  attachments = [],
  history = [],
  effectiveMode,
  previousFailures = [],
} = {}) {
  const imagePath = /\.(png|jpe?g|webp)$/i;
  if (attachments.some((p) => imagePath.test(p)) || mode === "vision")
    return "vision";
  if (mode === "coding") return "coding";
  if (mode === "general") {
    if (EXPLICIT_DEEP.test(text) || HARD_REASONING.test(text))
      return "hard_reasoning";
    return "general";
  }
  const trimmed = String(text || "").trim();
  if (EXPLICIT_DEEP.test(trimmed) || HARD_REASONING.test(trimmed))
    return "hard_reasoning";
  if (
    previousFailures.length >= 1 &&
    trimmed.length > 40 &&
    /\b(bug|error|fail|crash|debug|algorithm|architecture|race|deadlock)\b/i.test(
      trimmed,
    )
  )
    return "hard_reasoning";

  // After a failed 8b attempt this turn, escalate classification for retries.
  if (
    previousFailures.some((f) => /qwen3:8b/i.test(String(f))) &&
    trimmed.length > 24
  )
    return "hard_reasoning";

  if (
    effectiveMode === "developer" ||
    DEVELOPER.test(trimmed) ||
    attachments.some((p) =>
      /\.(m?js|tsx?|py|html|css|json|sql|cjs|mjs)$/i.test(p),
    )
  )
    return "coding";

  if (FOLLOW_UP.test(trimmed)) {
    const previous =
      history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (HARD_REASONING.test(previous) || EXPLICIT_DEEP.test(previous))
      return "hard_reasoning";
    if (DEVELOPER.test(previous)) return "coding";
  }
  return "general";
}

export function pickInstalled(candidates, installedNames = []) {
  const byNorm = new Map(
    installedNames.map((name) => [normalize(name), name]),
  );
  for (const candidate of candidates) {
    const hit = byNorm.get(normalize(candidate));
    if (hit) return hit;
  }
  for (const candidate of candidates) {
    const base = candidate.split(":")[0].toLowerCase();
    const tag = (candidate.split(":")[1] || "").toLowerCase();
    const hit = installedNames.find((name) => {
      const [nBase, nTag = "latest"] = name.toLowerCase().split(":");
      return nBase === base && (!tag || nTag === tag || nTag.startsWith(tag));
    });
    if (hit) return hit;
  }
  return undefined;
}

export function resolveLocalModelPlan(installedNames = []) {
  const fast =
    pickInstalled(FAST_MODEL_CANDIDATES, installedNames) ||
    pickInstalled(FALLBACK_MODEL_CANDIDATES, installedNames) ||
    installedNames[0];
  const strong =
    pickInstalled(STRONG_MODEL_CANDIDATES, installedNames) || fast;
  const reasoning =
    pickInstalled(REASONING_MODEL_CANDIDATES, installedNames) || strong;
  const fallback =
    pickInstalled(FALLBACK_MODEL_CANDIDATES, installedNames) || fast;
  return {
    provider: "ollama",
    /** Everyday / casual Auto target (prefer 8b). */
    fast,
    /** Coding / analysis Auto target (prefer 14b). */
    strong,
    /** Alias: everyday chat uses fast. */
    general: fast,
    reasoning,
    fallback,
    installed: [...installedNames],
  };
}

/**
 * Pick concrete model for a local task kind.
 * Escalates to strong if the fast model already failed this turn.
 */
export function modelForLocalTask(kind, plan, { previousFailures = [], preferStrong = false } = {}) {
  if (!plan?.general && !plan?.fast) return undefined;
  const fastFailed = previousFailures.some((f) =>
    /qwen3:8b/i.test(String(f)),
  );
  if (kind === "hard_reasoning")
    return plan.reasoning || plan.strong || plan.general;
  if (kind === "coding" || fastFailed || preferStrong)
    return plan.strong || plan.reasoning || plan.general;
  return plan.fast || plan.general;
}

/** Keep-alive tuned for 12GB VRAM: warm the fast model longer. */
export function keepAliveForModel(modelId, kind = "general", { sticky = false } = {}) {
  const id = String(modelId || "");
  if (sticky && /qwen3:14b/i.test(id)) return "10m";
  if (/deepseek|r1/i.test(id)) return "1m";
  if (/qwen3:14b|qwen3:30b/i.test(id) || kind === "coding" || kind === "hard_reasoning")
    return "5m";
  return "10m";
}

/** Practical context sizes for RTX 4070 Ti 12GB — avoid huge windows. */
export function contextForKind(kind, memoryBytes = 0) {
  if (kind === "coding" || kind === "hard_reasoning") {
    // Cap at 8192 even with plenty of system RAM — VRAM is the bottleneck.
    return memoryBytes >= 24 * 1024 ** 3 ? 8192 : 6144;
  }
  return 4096;
}

export function assessLocalModelHardware({
  vramMiB = 0,
  ramBytes = 0,
  freeDiskBytes = 0,
} = {}) {
  const ramGiB = ramBytes / 1024 ** 3;
  const freeDiskGiB = freeDiskBytes / 1024 ** 3;
  const can30b = vramMiB >= 20000 && ramGiB >= 48 && freeDiskGiB >= 25;
  const can32b = vramMiB >= 20000 && ramGiB >= 48 && freeDiskGiB >= 25;
  const can14b = vramMiB >= 8000 && ramGiB >= 16 && freeDiskGiB >= 12;
  return {
    can30b,
    can32b,
    can14b,
    recommendedGeneral: "qwen3:8b",
    recommendedStrong: can14b ? "qwen3:14b" : "qwen3:8b",
    recommendedReasoning: can14b ? "qwen3:14b" : "qwen3:8b",
    notes: can30b
      ? []
      : [
          "Prefer qwen3:8b for chat speed and qwen3:14b for coding on ~12GB VRAM; avoid loading both at once.",
        ],
  };
}

export { HARD_REASONING, EXPLICIT_DEEP };
