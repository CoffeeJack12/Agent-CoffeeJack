/**
 * Per-conversation language / dialect / tone presentation state.
 * Chat-scoped only — not long-term memory unless memory policy says so.
 */

import {
  formatJeddawiStylePackPrompt,
  isVerbatimStyleExample,
} from "./styles/jeddawi.mjs";
import { looksLikeButterCalque } from "./jeddawi-semantics.mjs";
import { normalizeSpeakerPersona } from "./speaker-persona.mjs";
import { isMasterAccount, isQueenAccount } from "./account-personas.mjs";

export const DEFAULT_CONVERSATION_STYLE = Object.freeze({
  language: "auto", // auto | en | ar
  arabic_style: "default", // default | msa | jeddawi
  tone: "normal", // normal | casual | concise
  verbosity: "normal", // normal | concise
});

const EGYPTIAN_RE =
  /مفيش|عايز|عاوز|(?:^|[^\u0600-\u06ff])مش(?:[^\u0600-\u06ff]|$)|إزاي|ازاي|يا\s*باشا|تمام أوي|كده أوي/u;
const LEVANTINE_RE =
  /(?:^|[^\u0600-\u06ff])شو(?:[^\u0600-\u06ff]|$)|هيك|(?:^|[^\u0600-\u06ff])بدي(?:[^\u0600-\u06ff]|$)|شو\s*فيك/u;
const LATIN_TRANSLIT_RE =
  /\b(?:Duhin|Duheen|Asr|Isha|Maghrib|Fajr|Yalla(?!\s*[A-Za-z])|Abgha)\b/i;
const ARABIC_SCRIPT_RE = /[\u0600-\u06ff]/;
const STIFF_MSA_RE =
  /السياق السابق محفوظ|أحتاج التفصيل الناقص|حتى أتابع|بناءً على ما سبق|يمكنني مساعدتك/u;
const META_DIALECT_RE =
  /راح أكون معك|أنا حاسس أني|بطريقة طبيعية زي واحد من جدة|بحب التواص|خليني أكلمك جداوي|راح أكلمك جداوي/u;
/** Tokens models tend to stuff when over-instructed — detection only, not required vocab. */
const DIALECT_STUFF_TOKENS = [
  "دحين",
  "خلّك",
  "خلك",
  "يلا",
  "دوبك",
  "ما زبط",
  "مازبط",
  "سويه",
  "سوّيه",
];
const NONSENSE_JEDDAWI_RE =
  /مالك\s*تعب|تعبّ?د\s*ليش|جدة\s*نايم|خلّ?ك\s*جدة/u;

/**
 * Jeddawi session (sticky) — remains true during a temporary English switch.
 */
export function isJeddawiSession(style = {}) {
  return normalizeConversationStyle(style).arabic_style === "jeddawi";
}

/**
 * Prefer qwen3:14b for Auto when this conversation is a Jeddawi session,
 * including a temporary "English now". New English-only chats stay on 8b.
 */
export function shouldPreferJeddawiQuality(
  style = {},
  { intent = null, priorityLane = null } = {},
) {
  if (!isJeddawiSession(style)) return false;
  if (priorityLane === "self_repair") return false;
  if (intent === "greeting") return false;
  return true;
}

/**
 * Direct Jeddawi generation instructions for the main model (primary path).
 */
export function formatDirectJeddawiPrompt(style = {}) {
  const s = normalizeConversationStyle(style);
  if (!isJeddawiActive(s)) return "";
  return [
    "ARABIC STYLE = JEDDAWI — write the FINAL user-visible answer directly.",
    "Natural contemporary Jeddah/Hijazi Saudi Arabic.",
    "Answer THIS turn using CANONICAL TOPIC + this-turn semantic intent (not dialect keywords alone).",
    "Preserve the canonical topic across language/style switches. Never calque slang (الزبدة ≠ butter).",
    "Naturalness > slang. Do NOT keyword-stuff (دحين/يلا/خلّك/دوبك/ما زبط are optional, not required).",
    "Do not invent fake dialect. Do not overuse Master. No emojis by default.",
    "FORBIDDEN Egyptian/Levantine: مفيش، ما فيش، عايز، مش، إزاي، شو، بدي، هيك.",
    "Do not transliterate Arabic into Latin (no Duhin/Asr — use دحين/العصر).",
    "Preserve file paths, URLs, commands, code, numbers, and names exactly — copy them unchanged from the user message when present.",
    "Do not paste style-pack example sentences.",
    s.verbosity === "concise" || s.tone === "concise"
      ? "Keep the reply short — gist only. Do not mention butter/food."
      : s.tone === "casual"
        ? "Tone: casual, natural — not stiff."
        : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeConversationStyle(raw = {}) {
  const base = { ...DEFAULT_CONVERSATION_STYLE, ...(raw || {}) };
  if (!["auto", "en", "ar"].includes(base.language)) base.language = "auto";
  if (!["default", "msa", "jeddawi"].includes(base.arabic_style))
    base.arabic_style = "default";
  if (!["normal", "casual", "concise"].includes(base.tone))
    base.tone = "normal";
  if (!["normal", "concise"].includes(base.verbosity))
    base.verbosity = "normal";
  // Jeddawi/MSA imply Arabic presentation unless English was explicitly chosen this patch.
  if (
    (base.arabic_style === "jeddawi" || base.arabic_style === "msa") &&
    base.language === "auto"
  ) {
    base.language = "ar";
  }
  return base;
}

export function isArabicPresentation(style = {}) {
  const s = normalizeConversationStyle(style);
  return (
    s.language === "ar" ||
    (s.language !== "en" &&
      (s.arabic_style === "jeddawi" || s.arabic_style === "msa"))
  );
}

export function isJeddawiActive(style = {}) {
  const s = normalizeConversationStyle(style);
  return s.arabic_style === "jeddawi" && s.language !== "en";
}

/**
 * Classify language/dialect/tone directives (presentation only — keep topic).
 * @returns {{ patch: object, kind: string, continueTopic: boolean } | null}
 */
export function classifyStyleCommand(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length > 240) return null;

  // --- Dialect / language switches (match phrases inside longer turns) ---
  if (
    /^(?:جداوي)[.!؟\s]*$/iu.test(t) ||
    /ارجع\s*(?:لي\s*)?جداوي/i.test(t) ||
    /(?:كلمني|تكلم|احكي|رد|كمل).{0,40}جداوي/i.test(t) ||
    /من\s*دحين\s*كلمني\s*جداوي/i.test(t) ||
    /جداوي\s*طبيعي/i.test(t) ||
    /مو\s*فصحى.{0,40}جداوي|جداوي.{0,40}مو\s*فصحى/i.test(t) ||
    /لهجة\s*(?:جدة|جداوية|حجازية)/i.test(t) ||
    /زي\s*واحد\s*من\s*جدة/i.test(t) ||
    /لا\s*فصحى\s*ولا\s*مصري/i.test(t) ||
    /^(?:jeddawi|hijazi(?:\s+jeddah)?)[.!?\s]*$/i.test(t)
  ) {
    return {
      kind: "jeddawi",
      continueTopic: /كمل|نفس\s*الموضوع|continue|topic/i.test(t),
      patch: {
        language: "ar",
        arabic_style: "jeddawi",
        tone: "casual",
      },
    };
  }

  if (
    /^(?:فصحى|فصيح|بالفصحى)[.!؟\s]*$/iu.test(t) ||
    /^(?:msa|formal\s+arabic)[.!?\s]*$/i.test(t) ||
    /(?:كلمني|تكلم|احكي).{0,20}(?:فصحى|فصيح)/i.test(t)
  ) {
    return {
      kind: "msa",
      continueTopic: true,
      patch: { language: "ar", arabic_style: "msa", tone: "normal" },
    };
  }

  if (
    /^(?:english(?:\s+now)?|speak\s+english|switch\s+to\s+english)[.!?\s]*$/i.test(
      t,
    ) ||
    /^(?:بالانجليزي|انجليزي)[.!؟\s]*$/iu.test(t) ||
    /(?:تكلم|احكي|رد|كمل).{0,20}(?:انجليزي|بالانجليزي|الإنجليزية)/i.test(t) ||
    /(?:speak|talk|reply|answer|continue).{0,30}\benglish\b/i.test(t)
  ) {
    return {
      kind: "english",
      continueTopic: true,
      patch: { language: "en" },
    };
  }

  if (
    /^(?:تكلم\s*عربي|بالعربي|عربي)[.!؟\s]*$/iu.test(t) ||
    /(?:تكلم|احكي|رد).{0,16}(?:عربي|بالعربي|العربية)/i.test(t) ||
    /(?:speak|talk|reply).{0,30}\barabic\b/i.test(t)
  ) {
    return {
      kind: "arabic",
      continueTopic: true,
      patch: { language: "ar" },
    };
  }

  if (
    /لا\s*تصير\s*رسمي|مو\s*رسمي|خلّ?ك\s*عفوي|كلمني\s*عادي|كلمني\s*بطبيعتك|زي\s*واحد\s*من\s*جدة/i.test(
      t,
    ) ||
    /لا\s*كذا\s*ناشف|ناشف\s*مرة/i.test(t) ||
    /\b(?:don't be formal|be casual|talk normally)\b/i.test(t)
  ) {
    return {
      kind: "tone_casual",
      continueTopic: true,
      patch: {
        tone: "casual",
        language: /جدة|جداوي|عربي|دحين|إيش|ايش|بطبيعتك/.test(t)
          ? "ar"
          : undefined,
        arabic_style: /جدة|جداوي/.test(t) ? "jeddawi" : undefined,
      },
    };
  }

  if (
    /اديني\s*الزبدة|الزبدة|لا\s*تفلسفها|بلا\s*فلسفة|concise|get to the point|bottom line/i.test(
      t,
    ) &&
    !/^(?:طيب\s*)?اختصرها?[.!؟\s]*$/iu.test(t)
  ) {
    return {
      kind: "tone_concise",
      continueTopic: true,
      patch: { tone: "concise", verbosity: "concise" },
    };
  }

  return null;
}

export function applyStylePatch(current, patch = {}) {
  const next = normalizeConversationStyle(current);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null) continue;
    if (key in next) next[key] = value;
  }
  // Dialect switches always force Arabic script for the next replies.
  if (patch?.arabic_style === "jeddawi" || patch?.arabic_style === "msa") {
    next.language = "ar";
  }
  return normalizeConversationStyle(next);
}

/** Short Arabic follow-ups that must bind to active topic (Jeddawi-friendly). */
export function classifyArabicFollowUp(text = "") {
  const t = String(text || "").trim();
  if (!t || t.length > 80) return null;

  if (
    /^(?:دحين\s*ايش\s*اسوي|دحين\s*إيش\s*أسوي|ايش\s*اسوي\s*دحين|إيش\s*أسوي)[.?؟\s]*$/iu.test(
      t,
    ) ||
    /^(?:what (?:should|do) i do(?: now)?|what now)[.?!\s]*$/i.test(t)
  ) {
    return { intent: "continue", hint: "what_now" };
  }

  if (
    /^(?:طيب\s*لو\s*ما\s*زبط|لو\s*ما\s*زبط|إذا\s*ما\s*زبط|لو\s*فشل)[.?؟\s]*$/iu.test(
      t,
    ) ||
    /^(?:what if (?:it )?(?:doesn't|does not) work|and if that fails)[.?!\s]*$/i.test(
      t,
    )
  ) {
    return { intent: "clarify", hint: "fallback_if_fails" };
  }

  if (/^(?:خلصني\s*بالله|خلّ?صني|سويه|سوّيه|يلا\s*سويه)[.!؟\s]*$/iu.test(t)) {
    return { intent: "confirm", hint: "do_it" };
  }

  if (
    /^(?:طيب\s*اختصرها|اختصرها|اختصر)[.!؟\s]*$/iu.test(t) ||
    /^(?:make it shorter|shorter)[.!?\s]*$/i.test(t)
  ) {
    return { intent: "rewrite", hint: "shorter" };
  }

  if (/^(?:لا\s*كذا\s*ناشف|ناشف)[.!؟\s]*$/iu.test(t)) {
    return { intent: "style_tone", hint: "less_dry" };
  }

  return null;
}

/**
 * Authoritative style instructions injected into fast + full agent prompts.
 * Jeddawi: direct final dialect answer (renderer is fallback-only).
 */
export function formatConversationStylePrompt(style = {}) {
  const s = normalizeConversationStyle(style);
  const lines = [
    "CONVERSATION STYLE STATE (presentation only — do not change topic because of this):",
    `language=${s.language}; arabic_style=${s.arabic_style}; tone=${s.tone}; verbosity=${s.verbosity}`,
    "No emojis by default. No canned help-desk Arabic. Do not call the user Master every turn.",
  ];

  if (s.language === "en") {
    lines.push(
      "Reply in natural English this turn. Preserve the CANONICAL TOPIC.",
      "Do not translate Jeddawi idioms literally. الزبدة = bottom line, never butter.",
      "Do not use romanized Arabic slang.",
    );
  } else if (isJeddawiActive(s)) {
    lines.push(formatDirectJeddawiPrompt(s));
  } else if (isArabicPresentation(s)) {
    lines.push(
      "Reply in Arabic script this turn. Preserve the active topic. Do not answer in English.",
    );
  }

  if (s.arabic_style === "msa" && s.language !== "en" && !isJeddawiActive(s)) {
    lines.push(
      "ARABIC STYLE = MSA (فصحى): clear Modern Standard Arabic. Not Jeddawi slang, not Egyptian. Arabic script only.",
    );
  }

  if (s.tone === "casual" && !isJeddawiActive(s)) {
    lines.push("Tone: casual/low formality. Not stiff, not dry-formal.");
  } else if (s.tone === "concise" && !isJeddawiActive(s)) {
    lines.push("Tone: direct. Give the bottom line. Do not over-explain.");
  }

  if (s.verbosity === "concise" && !isJeddawiActive(s)) {
    lines.push("Keep the reply short.");
  }

  return lines.join("\n");
}

/**
 * Strong final-answer contract — must be placed at the END of the system prompt.
 * For Jeddawi, append the style pack last so it survives prompt composition.
 */
export function formatFinalOutputContract(style = {}) {
  const s = normalizeConversationStyle(style);
  const lines = ["FINAL OUTPUT CONTRACT (overrides examples above):"];
  if (s.language === "en") {
    lines.push(
      "FINAL OUTPUT LANGUAGE: English.",
      "Do not switch to Arabic unless quoting the user.",
      "Do not invent romanized Jeddawi.",
    );
  } else if (isJeddawiActive(s)) {
    lines.push(
      "FINAL OUTPUT LANGUAGE: Arabic script only.",
      "DIALECT: Natural Jeddah/Hijazi — answer the question coherently.",
      "Use canonical topic + semantic intent. Do not paste style demonstrations.",
      "Naturalness > slang. Do not keyword-stuff dialect words.",
      "Do not use Egyptian, Levantine, or broken fake Hijazi.",
      "Do not transliterate Arabic into Latin letters.",
      "Preserve paths, URLs, commands, code, numbers, and names exactly.",
      "No emojis. No canned help-desk lines. Do not overuse Master.",
      formatJeddawiStylePackPrompt(),
    );
  } else if (s.arabic_style === "msa" && s.language !== "en") {
    lines.push(
      "FINAL OUTPUT LANGUAGE: Arabic script (فصحى).",
      "Do not use Egyptian/Levantine. Do not answer in English.",
      "Preserve the active topic.",
    );
  } else if (s.language === "ar") {
    lines.push(
      "FINAL OUTPUT LANGUAGE: Arabic script.",
      "Do not answer in English. Preserve the active topic.",
    );
  }
  lines.push(
    "Tool results are Jack's observations, never user-authored data.",
    'Never say "the data you provided", "the output you gave me", or "your network data" about tool output.',
    'Say "I observed...", "The inspection returned...", or "The tool reported...".',
  );
  return lines.join("\n");
}

const USER_PROVIDED_TOOL_SPEECH = [
  [/the data you(?:'ve| have)? provided/gi, "The inspection returned"],
  [/the output you(?:'ve| have)? (?:gave me|provided|sent)/gi, "The tool reported"],
  [/the (?:network |process |tool )?data you (?:gave|sent|shared)/gi, "The inspection returned"],
  [/your network data/gi, "the observed network snapshot"],
  [/your process data/gi, "the observed process snapshot"],
];

export function rewriteUserProvidedToolSpeech(text = "") {
  let next = String(text || "");
  for (const [pattern, replacement] of USER_PROVIDED_TOOL_SPEECH) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

function countDialectStuffTokens(body) {
  const lower = String(body || "");
  let hits = 0;
  for (const tok of DIALECT_STUFF_TOKENS) {
    if (lower.includes(tok)) hits += 1;
  }
  return hits;
}

function hasRepeatedClause(body) {
  const parts = String(body || "")
    .split(/[،.؟!\n]+/u)
    .map((p) => p.trim())
    .filter((p) => p.length >= 6);
  if (parts.length < 2) return false;
  const seen = new Set();
  for (const p of parts) {
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return false;
}

/**
 * Detect style / naturalness violations for one-shot revision.
 * @param {string} text
 * @param {object} style
 * @param {{ userText?: string }} [opts]
 * @returns {{ code: string, detail: string } | null}
 */
export function detectStyleViolation(text = "", style = {}, opts = {}) {
  const s = normalizeConversationStyle(style);
  const body = String(text || "").trim();
  if (!body) return null;
  void opts.userText;

  if (isJeddawiActive(s) || (s.language === "ar" && s.arabic_style !== "default")) {
    if (EGYPTIAN_RE.test(body)) {
      return {
        code: "egyptian",
        detail: "Egyptian dialect tokens detected (e.g. مفيش/عايز/مش/إزاي).",
      };
    }
    if (LEVANTINE_RE.test(body)) {
      return {
        code: "levantine",
        detail: "Levantine dialect tokens detected.",
      };
    }
    if (LATIN_TRANSLIT_RE.test(body)) {
      return {
        code: "transliteration",
        detail: "Arabic concepts transliterated into Latin (e.g. Duhin/Asr).",
      };
    }
    if (NONSENSE_JEDDAWI_RE.test(body) || /روح\s*واجبه/u.test(body)) {
      return {
        code: "malformed",
        detail: "Broken/fake Hijazi phrasing detected.",
      };
    }
    if (isVerbatimStyleExample(body)) {
      return {
        code: "example_copy",
        detail: "Reply copied a style demonstration verbatim.",
      };
    }
    if (isJeddawiActive(s) && STIFF_MSA_RE.test(body)) {
      return {
        code: "stiff_msa",
        detail: "Stiff MSA / canned assistant phrasing while Jeddawi is active.",
      };
    }
    if (isJeddawiActive(s) && META_DIALECT_RE.test(body)) {
      const user = String(opts.userText || "");
      const styleOnlyRequest =
        /جداوي|فصحى|بطبيعتك|كلمني|English|انجليزي/i.test(user) &&
        !/كمل|نفس\s*الموضوع|continue|topic/i.test(user);
      if (!styleOnlyRequest) {
        return {
          code: "meta_style",
          detail: "Meta dialect narration instead of answering the active topic.",
        };
      }
    }
    if (hasRepeatedClause(body)) {
      return {
        code: "repetitive",
        detail: "Reply repeats the same clause.",
      };
    }
    const stuffHits = countDialectStuffTokens(body);
    if (
      (stuffHits >= 3 && body.length < 90) ||
      (stuffHits >= 4 && body.length < 160)
    ) {
      return {
        code: "keyword_stuffed",
        detail: "Dialect keyword stuffing instead of a natural answer.",
      };
    }
    const arabicChars = (body.match(/[\u0600-\u06ff]/g) || []).length;
    const latinLetters = (body.match(/[A-Za-z]/g) || []).length;
    if (latinLetters > 12 && arabicChars < latinLetters * 0.35) {
      return {
        code: "english_while_arabic",
        detail: "Answer is primarily English while Arabic/Jeddawi style is active.",
      };
    }
  }

  if (s.language === "en" && looksLikeButterCalque(body)) {
    return {
      code: "idiom_calque",
      detail: "Literal butter/dairy translation of الزبدة.",
    };
  }

  if (s.language === "en" && ARABIC_SCRIPT_RE.test(body)) {
    const arabicChars = (body.match(/[\u0600-\u06ff]/g) || []).length;
    const latinLetters = (body.match(/[A-Za-z]/g) || []).length;
    if (arabicChars > 20 && arabicChars > latinLetters) {
      return {
        code: "arabic_while_english",
        detail: "Answer is primarily Arabic while English style is active.",
      };
    }
  }

  return null;
}

export function buildStyleRevisionPrompt(style = {}, violation = null, userText = "") {
  const s = normalizeConversationStyle(style);
  return [
    "STYLE REVISION (one attempt only): previous draft failed naturalness/style checks.",
    violation ? `Violation: ${violation.code} — ${violation.detail}` : "",
    userText ? `User question to answer: ${String(userText).slice(0, 400)}` : "",
    formatFinalOutputContract(s),
    isJeddawiActive(s)
      ? [
          "Rewrite as ONE natural Jeddawi Arabic answer that actually answers the user.",
          "Clear grammar. No keyword stuffing. No Egyptian. No English. No Latin transliteration.",
          "Do not paste slang lists. Do not repeat clauses. Do not overuse Master.",
        ].join(" ")
      : s.language === "en"
        ? "Rewrite the SAME meaning in clear English. Keep the topic."
        : "Rewrite to obey FINAL OUTPUT CONTRACT. Keep the topic.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Persona answer hints that respect active Arabic style. */
export function personaStyleHint(style = {}, { name = "Abdulrahman", isOwner = true } = {}) {
  const s = normalizeConversationStyle(style);
  // Prefer dialect presentation over English defaults.
  if (isJeddawiActive(s)) {
    return isOwner
      ? `REQUIRED ANSWER in Jeddawi Arabic script ONLY (no Egyptian): "إنت يا ${name === "Abdulrahman" ? "عبدالرحمن" : name}، Master." One short loyal line. No tools. No emoji.`
      : `REQUIRED ANSWER in Jeddawi Arabic: الـ Owner عبدالرحمن. أنت ${name} مو Owner. سطر قصير.`;
  }
  if (s.arabic_style === "msa" && s.language !== "en") {
    return isOwner
      ? `REQUIRED ANSWER in MSA Arabic: "${name === "Abdulrahman" ? "عبدالرحمن" : name} هو سيدي." سطر قصير. بدون إنجليزي كامل.`
      : `REQUIRED ANSWER بالعربية: السيدي هو عبدالرحمن. أنت ${name} ولست Owner.`;
  }
  if (s.language === "ar") {
    return isOwner
      ? `REQUIRED ANSWER بالعربية: "${name === "Abdulrahman" ? "عبدالرحمن" : name} هو سيدي." سطر قصير.`
      : `REQUIRED ANSWER بالعربية: السيدي هو عبدالرحمن. أنت ${name} ولست Owner.`;
  }
  return isOwner
    ? `REQUIRED ANSWER: "${name} is my Owner and Master." One short loyal line.`
    : `REQUIRED ANSWER: My Owner/Master is the CoffeeJack Owner (Abdulrahman). You are ${name}, not Owner.`;
}

/**
 * Deterministic persona reply so identity never falls back to English templates
 * while Arabic/Jeddawi style is active.
 */
export function personaDeterministicReply(
  style = {},
  user = null,
  personaKind = "who_master",
  speakerPersona = null,
  userText = "",
  store = null,
) {
  const s = normalizeConversationStyle(style);
  const role = String(user?.role || "").toLowerCase();
  const name =
    String(
      user?.display_name || user?.displayName || user?.name || "Abdulrahman",
    ).trim() || "Abdulrahman";
  const isOwner = isMasterAccount(user);
  const queen = isQueenAccount(user, store);
  const arabicName = name === "Abdulrahman" || /abdulrahman/i.test(name)
    ? "عبدالرحمن"
    : name;
  const speaker = normalizeSpeakerPersona(speakerPersona, user, store);
  const arabicUi =
    isJeddawiActive(s) ||
    isArabicPresentation(s) ||
    /[\u0600-\u06ff]/.test(String(userText || ""));

  if (personaKind === "identify_lubna") {
    if (queen) return arabicUi ? "عرفتك يا Queen." : "Got it, Queen.";
    if (isOwner) return arabicUi ? "عرفتك يا Master." : "Got it, Master.";
    return arabicUi
      ? "ما أعطيك لقب من النص."
      : "That name doesn't change how I address you.";
  }
  if (personaKind === "identify_abdulrahman") {
    if (isOwner) return arabicUi ? "عرفتك يا Master." : "Got it, Master.";
    return arabicUi
      ? "ما أعطيك لقب من النص."
      : "That name doesn't change how I address you.";
  }
  if (personaKind === "who_am_i") {
    if (queen) {
      if (arabicUi) return "إنتِ لبنى، Queen.";
      return "You're Lubna, Queen.";
    }
    if (isOwner) {
      if (isJeddawiActive(s)) return `إنت يا ${arabicName}، Master.`;
      if (isArabicPresentation(s)) return `${arabicName}، Master.`;
      return `${name} — Master.`;
    }
    return arabicUi
      ? `أنت ${name}.`
      : `You're ${name}. Session role is ${role || "standard"}.`;
  }
  if (personaKind === "call_me") {
    if (queen) return "Queen.";
    if (isOwner) return "Master.";
    return speaker.speaker_name || name;
  }

  if (personaKind === "who_master") {
    if (isJeddawiActive(s)) {
      return isOwner
        ? `إنت يا ${arabicName}، Master.`
        : `سيدي الـ Owner عبدالرحمن. أنت ${name} مو Owner.`;
    }
    if (isArabicPresentation(s)) {
      return isOwner
        ? `${arabicName} هو سيدي.`
        : `سيدي هو عبدالرحمن. أنت ${name} ولست Owner.`;
    }
    return isOwner
      ? `${name} is my Owner and Master.`
      : `My Owner/Master is the CoffeeJack Owner (Abdulrahman). You are ${name}, not Owner.`;
  }

  if (personaKind === "claim_master") {
    if (isJeddawiActive(s)) {
      return isOwner
        ? `تحت أمرك يا ${arabicName}.`
        : `جلسة ${role} ما تخليك Owner.`;
    }
    if (isArabicPresentation(s)) {
      return isOwner ? `تحت أمرك.` : `صلاحياتك ${role} — لست Owner.`;
    }
    return isOwner
      ? `At your service, Master.`
      : `Session role is ${role} — that does not make you Owner/Master.`;
  }

  return null;
}

/** Locale-aware short system notes (cancel / incomplete). */
export function localizedSystemNote(style = {}, { ar, en, jeddawi }) {
  const s = normalizeConversationStyle(style);
  if (isJeddawiActive(s)) return jeddawi || ar || en;
  if (isArabicPresentation(s)) return ar || en;
  return en || ar;
}
