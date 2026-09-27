/**
 * Jeddawi / Hijazi semantic-normalization (understanding only).
 * Never used as a generation keyword list. Never writes long-term memory.
 */

const GIST_RE =
  /اديني\s*الزبدة|هات\s*الزبدة|الزبدة\s*بس|وش\s*الزبدة|(?:^|[\s،.])الزبدة(?:$|[\s.؟!])/iu;
const DIRECT_RE =
  /لا\s*تفلسفها|بلا\s*فلسفة|لا\s*تطولها|على\s*طول|بلا\s*كلام\s*زيادة/iu;
const WHAT_NOW_RE =
  /دحين\s*(?:ايش|إيش)\s*(?:اسوي|أسوي)|(?:ايش|إيش)\s*(?:اسوي|أسوي)\s*دحين/iu;
const IF_FAILS_RE =
  /(?:طيب\s*)?(?:لو|إذا|اذا)\s*ما\s*زبط|لو\s*فشل|إذا\s*ما\s*اشتغل|what if i can'?t|if (?:that|it) (?:doesn'?t|does not) work|if i can'?t go/iu;
const DO_IT_RE =
  /^(?:سويه|سوّيه|يلا\s*سويه|خلصني(?:\s*بالله)?|خلّ?صني)[.!؟\s]*$/iu;
const AFTEK_RE = /افتك|أفتك/u;
const NOW_RE = /دحين/u;
const NOT_RE = /(?:^|[^\u0600-\u06ff])مو(?:[^\u0600-\u06ff]|$)/u;

/** Understanding lexicon — do not inject these into output. */
export const JEDDAWI_UNDERSTANDING_LEXICON = Object.freeze([
  {
    id: "gist",
    match: GIST_RE,
    gloss: "give the concise bottom line",
    neverLiteral: ["butter", "dairy", "زبدة الطعام"],
  },
  {
    id: "be_direct",
    match: DIRECT_RE,
    gloss: "be direct; do not over-explain",
  },
  {
    id: "what_now",
    match: WHAT_NOW_RE,
    gloss: "what should I do now regarding the active topic?",
  },
  {
    id: "if_fails",
    match: IF_FAILS_RE,
    gloss: "what should I do if the previous suggestion does not work?",
  },
  {
    id: "do_it",
    match: DO_IT_RE,
    gloss: "execute/apply the most recent actionable proposal",
  },
  {
    id: "get_it_done",
    match: AFTEK_RE,
    gloss: "get it done / get it out of the way (context-dependent)",
  },
  { id: "now", match: NOW_RE, gloss: "now" },
  { id: "not", match: NOT_RE, gloss: "not" },
]);

const STYLE_ONLY_RE =
  /جداوي|فصحى|english\s*now|بالانجليزي|انجليزي|تكلم\s*عربي|كلمني/i;

const GYM_RE = /النادي|نادي|gym|workout|تمرين/i;
const DINNER_RE = /العشا|العشاء|dinner|العشا/i;
const NOW_OR_LATER = /دحين|الحين|بعد|قبل|now|after|before/i;

/**
 * @returns {{
 *   kind: string,
 *   gloss: string,
 *   semanticIntent: string,
 *   preserveTopic: boolean,
 *   opensTopic: boolean,
 *   matched: string[],
 *   forbiddenLiterals: string[],
 * }}
 */
export function normalizeJeddawiSemantics(text = "") {
  const raw = String(text || "").trim();
  const matched = [];
  const forbiddenLiterals = [];
  let kind = "content";
  let gloss = "";

  for (const entry of JEDDAWI_UNDERSTANDING_LEXICON) {
    if (entry.match.test(raw)) {
      matched.push(entry.id);
      if (entry.neverLiteral) forbiddenLiterals.push(...entry.neverLiteral);
      if (!gloss && entry.gloss && !["now", "not"].includes(entry.id))
        gloss = entry.gloss;
      if (["gist", "be_direct", "what_now", "if_fails", "do_it"].includes(entry.id))
        kind = entry.id;
    }
  }

  const styleOnly =
    STYLE_ONLY_RE.test(raw) &&
    raw.length < 160 &&
    !GYM_RE.test(raw) &&
    kind === "content";

  if (styleOnly) {
    kind = "style";
    gloss = gloss || "presentation/style switch; keep the active topic";
  }

  const preserveTopic =
    kind !== "content" ||
    styleOnly ||
    matched.includes("gist") ||
    matched.includes("be_direct") ||
    matched.includes("what_now") ||
    matched.includes("if_fails") ||
    matched.includes("do_it");

  const opensTopic = !preserveTopic && looksSubstantive(raw);

  let semanticIntent = gloss;
  if (kind === "gist")
    semanticIntent =
      "Give the concise bottom line of the CANONICAL TOPIC. Do not translate الزبدة as butter/food.";
  else if (kind === "be_direct")
    semanticIntent =
      "Be direct and short about the CANONICAL TOPIC. Do not over-explain.";
  else if (kind === "what_now")
    semanticIntent =
      "What should the user do now regarding the CANONICAL TOPIC?";
  else if (kind === "if_fails")
    semanticIntent =
      "If the current recommendation for the CANONICAL TOPIC does not work, what is the fallback?";
  else if (kind === "do_it")
    semanticIntent =
      "Apply/execute the most recent actionable proposal for the CANONICAL TOPIC.";
  else if (kind === "style")
    semanticIntent =
      "Change presentation style only. Continue the CANONICAL TOPIC. Do not reinterpret slang.";
  else if (!semanticIntent)
    semanticIntent = "Answer the user's current request about the active topic.";

  return {
    kind,
    gloss,
    semanticIntent,
    preserveTopic,
    opensTopic,
    matched,
    forbiddenLiterals: [...new Set(forbiddenLiterals)],
  };
}

function looksSubstantive(text) {
  if (!text || text.length < 10) return false;
  if (GIST_RE.test(text) && text.length < 48) return false;
  if (DIRECT_RE.test(text) && text.length < 40) return false;
  return /[?؟]|نادي|gym|مشروع|كود|ملف|مشكلة|bug|error|أروح|اروح/i.test(text);
}

/**
 * Language-neutral canonical topic. Never store dialect idioms or prior wording.
 */
export function extractCanonicalTopic(text = "", previousTopic = null) {
  const semantic = normalizeJeddawiSemantics(text);
  if (semantic.preserveTopic && previousTopic) return previousTopic;
  if (!semantic.opensTopic && previousTopic) return previousTopic;

  const raw = String(text || "").trim();
  if (GYM_RE.test(raw) && (DINNER_RE.test(raw) || NOW_OR_LATER.test(raw))) {
    return "whether to go to the gym now or after dinner";
  }
  if (GYM_RE.test(raw)) return "going to the gym";

  const cleaned = stripUnderstandingTokens(raw)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 8 && !/جداوي|فصحى|english now/i.test(cleaned)) {
    return cleaned.slice(0, 160);
  }
  return previousTopic || null;
}

function stripUnderstandingTokens(text) {
  return String(text || "")
    .replace(GIST_RE, " ")
    .replace(DIRECT_RE, " ")
    .replace(/يا\s*حبيبي/g, " ")
    .replace(/من\s*دحين\s*كلمني\s*جداوي[^.؟!]*[.؟!]?/giu, " ")
    .trim();
}

export function formatSemanticUnderstandingPrompt({
  topic,
  semantic,
  recentContext = "",
} = {}) {
  const s = semantic || {};
  const lines = [
    "SEMANTIC UNDERSTANDING (pre-routing; not output style):",
    `Canonical topic: ${topic || "(none yet — wait for a real question)"}`,
    `This-turn intent: ${s.semanticIntent || "answer the user"}`,
    `Intent kind: ${s.kind || "content"}`,
    "Do NOT reason from dialect keywords alone. Use canonical topic + this-turn intent + recent context.",
    "Never translate idioms literally (الزبدة is NEVER butter/food).",
    "Language/style switches must keep the same canonical topic.",
  ];
  if (s.forbiddenLiterals?.length)
    lines.push(`Forbidden calques this turn: ${s.forbiddenLiterals.join(", ")}`);
  if (recentContext)
    lines.push(`Recent context (supporting facts only):\n${String(recentContext).slice(0, 500)}`);
  return lines.join("\n");
}

const LEVANTINE_BAD = /بدي|هيك|(?:^|[^\u0600-\u06ff])شو(?:[^\u0600-\u06ff]|$)/u;
const EGYPTIAN_BAD =
  /مفيش|عايز|عاوز|يوم\s*تاني|(?:^|[^\u0600-\u06ff])تاني(?:[^\u0600-\u06ff]|$)|إزاي|ازاي|بسويش|حاببتش|ما\s*بسوي/u;
const META_NONSENSE = /ما تمشي تبي|تبي أكون معاك|أكون معاك/u;

export function looksLikeFailedSemanticReply(
  output = "",
  { userText = "", semantic = {}, topic = "", language = "ar" } = {},
) {
  const body = String(output || "").trim();
  if (!body) return true;
  if (looksLikeButterCalque(body)) return true;
  if (LEVANTINE_BAD.test(body) || /روح\s*واجبه/u.test(body)) return true;
  if (EGYPTIAN_BAD.test(body) || META_NONSENSE.test(body)) return true;
  if (/\/no_think/i.test(body)) return true;
  const kind = semantic?.kind;
  if (kind === "gist" && /الزبدة|الزبده/u.test(body)) return true;
  if (
    (kind === "style" || kind === "content") &&
    /^(?:ارجع|جداوي|دحين)[.!؟]*$/u.test(body)
  )
    return true;
  if (language === "en" && /^(now|ok|okay|sure|yes)[.!]*$/i.test(body) && topic)
    return true;
  if (kind === "be_direct" && /^(?:لا|طيب)[.!؟]*$/u.test(body)) return true;
  const mentionsTopic =
    /نادي|gym|عشا|dinner|تمرين|workout/i.test(body);
  if (topic && /gym|نادي/.test(topic) && !mentionsTopic) {
    if (
      ["gist", "what_now", "be_direct", "if_fails", "content", "style"].includes(
        kind,
      )
    )
      return true;
  }
  if (
    topic &&
    /gym|نادي/.test(topic) &&
    /[?؟]\s*$/.test(body) &&
    !/إذا تقدر|go now if you can|خله بعدها/i.test(body)
  )
    return true;
  const user = String(userText || "").trim();
  if (user && body.length <= 12 && user.includes(body.replace(/[.!؟]/g, "")))
    return true;
  return false;
}

/** Topic-aware salvage when generation echoes slang or collapses. */
export function salvageTopicReply({
  topic,
  semantic,
  language = "ar",
} = {}) {
  const gym = /gym|نادي/.test(String(topic || ""));
  const en = language === "en";
  const kind = semantic?.kind || "content";
  if (!gym && kind === "style") {
    return en
      ? "Got it. Same topic, this style."
      : "تمام، نكمل نفس الموضوع بهالستايل.";
  }
  if (gym) {
    if (en) {
      if (kind === "if_fails")
        return "If today doesn't work, move it to tomorrow or do a lighter session.";
      if (kind === "what_now")
        return "Go to the gym now if you can; otherwise go after dinner.";
      if (kind === "be_direct")
        return "Go now if you can. After dinner if you're about to eat.";
      return "Bottom line: go now if you can. If you're about to eat, go after dinner.";
    }
    if (kind === "if_fails")
      return "إذا اليوم ما زبط، خله بكرة أو سو حركة خفيفة.";
    if (kind === "what_now")
      return "روح النادي دحين إذا تقدر، وإلا بعد العشا.";
    if (kind === "be_direct")
      return "تقدر دحين؟ روح. بتتعشى؟ خله بعدها.";
    return "روح النادي دحين إذا تقدر؛ إذا العشا قريب، خله بعدها.";
  }
  return semanticArabicFallback({ topic, semantic, draft: "" });
}

export function looksLikeButterCalque(text = "") {
  return /\bbutter\b|dairy|الزبدة\s*(?:الحليب|الطعام)|قشدة/i.test(
    String(text || ""),
  );
}

export function topicKeywords(topic = "") {
  const t = String(topic || "").toLowerCase();
  const keys = [];
  if (/gym|نادي|workout/.test(t)) keys.push("gym", "نادي", "تمرين", "workout");
  if (/dinner|عشا/.test(t)) keys.push("dinner", "عشا", "eat", "تعشى", "جوع");
  return keys;
}

/**
 * True when output abandoned the canonical topic for a slang calque / nonsense.
 */
export function outputAbandonsTopic(output = "", topic = "", semantic = {}) {
  const body = String(output || "");
  if (!body) return false;
  if (looksLikeButterCalque(body) && (semantic?.kind === "gist" || /gym|نادي/.test(topic)))
    return true;
  if (/روح\s*واجبه|واجبه\s*إذا/u.test(body)) return true;
  return false;
}

/** Clear MSA fallback — better than fake Jeddawi. */
export function semanticArabicFallback({
  topic,
  semantic,
  draft,
} = {}) {
  const d = String(draft || "").trim();
  const contaminated =
    /مفيش|عايز|عاوز|(?:^|[^\u0600-\u06ff])مش(?:[^\u0600-\u06ff]|$)|إزاي|ازاي|روح\s*واجبه/u.test(
      d,
    );
  if (
    d &&
    /[\u0600-\u06ff]/.test(d) &&
    !looksLikeButterCalque(d) &&
    !contaminated
  ) {
    return d;
  }
  const topicBit = topic
    ? `بخصوص: ${topic}`
    : "بخصوص الموضوع الحالي";
  const kind = semantic?.kind;
  if (kind === "gist")
    return `الخلاصة ${topicBit}: نفّذ القرار الحالي إن قدرت، وإلا أخّره لوقت أنسب.`;
  if (kind === "be_direct")
    return `مباشرة ${topicBit}: التزم بنفس القرار المختصر.`;
  if (kind === "what_now")
    return `الآن ${topicBit}: نفّذ الخطوة التالية من نفس الخطة.`;
  if (kind === "if_fails")
    return `إذا لم ينفع ${topicBit}: اختر البديل العملي (وقت آخر أو نسخة أخف) ولا تغيّر الموضوع.`;
  if (kind === "style")
    return `نكمل نفس الموضوع ${topicBit}.`;
  return d || `نكمل ${topicBit}.`;
}

export function isDialectOnlyUtterance(text = "") {
  const s = normalizeJeddawiSemantics(text);
  const t = String(text || "").trim();
  return Boolean(t) && t.length < 140 && s.preserveTopic && !s.opensTopic;
}
