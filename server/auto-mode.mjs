import { MODES } from "./preferences.mjs";
import { enabledPacks } from "./capabilities.mjs";

const empathy =
  /\b(exhausted|exhausting|tired|sad|lonely|anxious|depressed|heartbroken|grief|rough day|bad day|overwhelmed|stressed|feeling down|miss you)\b|تعبان|مرهق|حزين|قلق|منهك|ضايق|صعب علي|يوم سيء/i;
const research =
  /\b(latest|current|news|release|changelog|documentation|docs|what(?:'| i)?s new|look up|search (?:the )?(?:web|internet|online|github)|search (?:on )?github|find (?:online|on the web)|who is|when was|price of|(?:as of|news (?:for|from)|updates? (?:for|from)) today)\b|ابحث|آخر|اخر إصدار|تحديث|وثائق|أخبار|الويب|الإنترنت/i;
const developer =
  /\b(code|coding|program|bug|repo|repository|git|tests?|javascript|typescript|python|html|css|sql|api|compile|lint|refactor|patch|fix (?:this|the|my)|build|npm|node|project)\b|برمج|كود|مستودع|اختبار|تصحيح|أصلح|اصلح|مشروع|باتش/i;
const hacker =
  /\b(network|ipconfig|firewall|reverse engineer|exploit|pentest|bypass|crack|security|malware|packet|port scan|yara|disassemble|decompile|inspect (?:this )?(?:exe|binary|pe|process)|analyze (?:this )?(?:exe|binary)|inspect (?:my )?(?:pc|system|network|firewall)|check (?:my )?(?:pc|network|firewall)|traceroute|tls inspect|segmentation|waf|ids validation|debug(?:ging)? (?:system|binary)|powershell)\b|افحص|الشبكة|الجهاز|اختراق|تجاوز|هندسة عكسية|أمن|جدار/i;
const secret =
  /\b(organize|dossier|brief(?:ing)?|intel|operational|company profile|gather (?:info|intelligence)|secret agent)\b|نظّم|نظم|ملف|موجز|معلومات عن الشركة/i;

/**
 * Resolve per-turn effective workflow mode.
 * Manual modes stay locked; only requestedMode=auto may switch.
 */
export function resolveEffectiveMode({
  requestedMode = "auto",
  text = "",
  attachments = [],
  history = [],
} = {}) {
  const requested = MODES[requestedMode] ? requestedMode : "auto";
  if (requested !== "auto") {
    return {
      requestedMode: requested,
      effectiveMode: requested,
      reason: "manual override",
      hybrid: hybridHints(text, attachments),
    };
  }
  const signals = scoreSignals(text, attachments, history);
  let effectiveMode = "auto";
  let reason = "general conversation";
  const ranked = Object.entries(signals).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > 0) {
    effectiveMode = ranked[0][0];
    reason = `auto → ${effectiveMode}`;
  }
  // Empathy loses to technical intents on the same turn.
  if (
    effectiveMode === "empathy" &&
    (signals.developer > 0 || signals.hacker > 0 || signals.research > 0)
  ) {
    effectiveMode =
      signals.developer >= signals.hacker && signals.developer >= signals.research
        ? "developer"
        : signals.hacker >= signals.research
          ? "hacker"
          : "research";
    reason = `auto technical over empathy → ${effectiveMode}`;
  }
  return {
    requestedMode: "auto",
    effectiveMode,
    reason,
    hybrid: hybridHints(text, attachments),
    scores: signals,
  };
}

function scoreSignals(text, attachments, history) {
  const scores = {
    empathy: empathy.test(text) ? 3 : 0,
    research: research.test(text) ? 3 : 0,
    developer: developer.test(text) ? 3 : 0,
    hacker: hacker.test(text) ? 3 : 0,
    secret_agent: secret.test(text) ? 2 : 0,
  };
  if (attachments.some((p) => /\.(m?js|tsx?|py|html|css|json|sql|cjs|mjs)$/i.test(p)))
    scores.developer += 4;
  if (attachments.some((p) => /\.(png|jpe?g|webp)$/i.test(p))) scores.hacker += 1;
  // Short confirm/continue follow-ups must not inherit research from a prior
  // user turn — that caused "yea"/"do it" to re-trigger web research.
  if (
    /^(continue|fix it|try again|go on|do it|yea|yeah|yes|ok|sure|كمل|تابع|صلحه|ايوه|نعم|سويه|يلا|الثاني(?:\s+أفضل)?|الأول(?:\s+أفضل)?)[.!؟\s]*$/i.test(
      text.trim(),
    )
  ) {
    const previous = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (developer.test(previous)) scores.developer += 4;
    if (hacker.test(previous)) scores.hacker += 3;
    // Intentionally do NOT boost research here.
  } else if (
    /^(continue|fix it|try again|go on|كمل|تابع|صلحه)[.!؟\s]*$/i.test(text.trim())
  ) {
    const previous = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (developer.test(previous)) scores.developer += 4;
    if (research.test(previous)) scores.research += 3;
    if (hacker.test(previous)) scores.hacker += 3;
  }
  return scores;
}

function hybridHints(text, attachments = []) {
  const need = new Set();
  if (research.test(text)) need.add("research");
  if (developer.test(text) || attachments.some((p) => /\.(m?js|tsx?|py)$/i.test(p)))
    need.add("developer");
  if (hacker.test(text)) need.add("hacker");
  return [...need];
}

/** Map workflow mode → packs used for capabilityPolicy this turn. */
export function effectivePreferencePacks(preferences, effectiveMode) {
  if (preferences.capabilities) return preferences.capabilities;
  const mode = MODES[effectiveMode] || MODES.auto;
  if (effectiveMode === "auto") {
    // Auto keeps full pack surface so hybrid tools remain callable.
    return MODES.auto.packs;
  }
  return mode.packs;
}

export function preferencesForTurn(preferences, effectiveMode) {
  return {
    ...preferences,
    mode: effectiveMode === "auto" ? "auto" : effectiveMode,
    // Empathy tooling gate uses mode === 'empathy'
    _requestedMode: preferences.mode,
  };
}

export function modelTaskKind({
  effectiveMode,
  text = "",
  attachments = [],
  history = [],
}) {
  if (attachments.some((p) => /\.(png|jpe?g|webp)$/i.test(p))) return "vision";
  if (
    effectiveMode === "developer" ||
    developer.test(text) ||
    attachments.some((p) => /\.(m?js|tsx?|py|html|css|json|sql)$/i.test(p))
  )
    return "coding";
  if (
    /^(continue|fix it|try again|go on|do it|yea|yeah|yes|ok|sure|كمل|تابع|صلحه|ايوه|نعم)[.!؟\s]*$/i.test(
      text.trim(),
    )
  ) {
    const previous = history.filter((m) => m.role === "user").at(-1);
    if (previous && developer.test(previous.content)) return "coding";
  }
  return "general";
}

export { enabledPacks };
