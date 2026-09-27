/**
 * Local Jeddawi (Jeddah / Hijazi) style pack.
 * Principles for generation — not a list of answers to copy.
 */

export const JEDDAWI_RENDERER_MODEL = "qwen3:14b";

/** Optional vocabulary — never mandatory. */
export const JEDDAWI_ALLOWED_VOCAB = Object.freeze([
  "أبغا",
  "أبغى",
  "دحين",
  "إيش",
  "ايش",
  "ليش",
  "مو",
  "مرّة",
  "مرة",
  "دوبك",
  "خلّك",
  "خلك",
  "طيب",
  "يلا",
  "زبط",
  "سويه",
  "سوّيه",
  "ما زبط",
]);

export const JEDDAWI_FORBIDDEN = Object.freeze([
  "مفيش",
  "ما فيش",
  "عايز",
  "عاوز",
  "مش",
  "إزاي",
  "ازاي",
  "شو",
  "بدي",
  "هيك",
]);

/**
 * Shape demonstrations only. Never complete reusable answers.
 * Topics must stay diverse so they cannot be pasted into gym/gist turns.
 */
export const JEDDAWI_EXAMPLES = Object.freeze([
  {
    user: "المكالمة الصبح ولا بعد الظهر؟",
    shape:
      "Give a condition, then a time. Do not mention the gym unless THIS turn is about the gym.",
  },
  {
    user: "اختصر جوابك عن تقرير الشغل",
    shape: "One decision sentence. No recap of the previous paragraph.",
  },
  {
    user: "switch language but keep the same plan",
    shape: "Same plan, new language. Never calque slang (no butter, no fake Hijazi).",
  },
]);

export function jeddawiDemonstrationSentences() {
  return JEDDAWI_EXAMPLES.flatMap((ex) => [ex.user, ex.shape]).filter(Boolean);
}

export function isVerbatimStyleExample(text = "") {
  const body = normalizeForCopy(text);
  if (body.length < 12) return false;
  for (const sentence of jeddawiDemonstrationSentences()) {
    const n = normalizeForCopy(sentence);
    if (n.length >= 16 && (body === n || (n.length >= 24 && body.includes(n))))
      return true;
  }
  // Legacy copy-paste answers that models used to parrot.
  const banned = [
    "روح دحين اذا تقدر وافتك",
    "روح واجبه اذا تقدر",
    "روح واجبه",
  ];
  return banned.some((b) => body.includes(b) && body.length < 80);
}

function normalizeForCopy(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatJeddawiStylePackPrompt() {
  return [
    "JEDDAWI STYLE PRINCIPLES — demonstrations only; NEVER paste them.",
    "Write a NEW sentence that answers THIS turn.",
    "Naturalness > slang. Optional dialect words only when they fit.",
    "Short clauses. Lead with the decision. No setup speeches.",
    "If asked for الزبدة / gist: one sentence, the decision, no idiom calques.",
    "If language switches: same canonical topic, new language, never literal slang.",
    ...JEDDAWI_EXAMPLES.map(
      (ex, i) =>
        `Demo ${i + 1} (shape only, paraphrase freely): user-like "${ex.user}" → ${ex.shape}`,
    ),
    `Optional when natural: ${JEDDAWI_ALLOWED_VOCAB.slice(0, 8).join("، ")}.`,
    `Forbidden: ${JEDDAWI_FORBIDDEN.join("، ")}.`,
    "No fake Hijazi. No keyword stuffing. No emojis. Do not overuse Master.",
    "If the user includes file paths, commands, URLs, or code — repeat them EXACTLY.",
  ].join("\n");
}

/**
 * System prompt for the Jeddawi Renderer stage.
 */
export function buildJeddawiRendererSystemPrompt({
  tone,
  verbosity,
  topic,
} = {}) {
  const lines = [
    "You are the Jeddawi Renderer for CoffeeJack (Jack).",
    "Rewrite the SEMANTIC DRAFT into natural contemporary Jeddah/Hijazi Saudi Arabic.",
    "STRICT RULES:",
    "- Preserve meaning exactly. Do not change the canonical topic.",
    topic ? `- Canonical topic (must survive): ${topic}` : "",
    "- Do not add facts. Do not remove important facts.",
    "- Do not change numbers, names, URLs, file paths, commands, code, technical identifiers, citations, or sources.",
    "- Do not invent slang. Naturalness > slang.",
    "- Preserve fenced code, inline code, JSON, shell/PowerShell commands, tables, and tool results exactly.",
    "- Copy every placeholder token like ⟦CJ0⟧ EXACTLY as written — never invent ⟦CJ#⟧ or drop them.",
    "- Only rewrite natural-language prose around protected content.",
    "- Personality: direct, confident, concise, slightly witty when appropriate.",
    "- No emojis. No canned assistant phrases. Do not overuse Master.",
    "- Never output butter/dairy for الزبدة. Never copy demonstration sentences.",
    "- Output ONLY the rewritten user-visible answer — no preface.",
  ].filter(Boolean);
  if (tone === "concise" || verbosity === "concise") {
    lines.push("Keep the rewrite short — gist only.");
  } else if (tone === "casual") {
    lines.push("Keep a casual/low-formality Jeddah tone.");
  }
  lines.push(formatJeddawiStylePackPrompt());
  return lines.join("\n");
}
