/**
 * Casual emotional turns (Arabic): frustration with Jack, being lost after an
 * explanation, low mood, venting. Replies are short, human, dialect-aware and
 * use the authenticated account's grammatical gender — never chat claims.
 * Jack acknowledges feelings; it never claims to have them.
 */

import { accountBoundSpeaker } from "./account-personas.mjs";
import { normalizeConversationStyle } from "./conversation-style.mjs";

const ARABIC_RE = /[\u0600-\u06ff]/u;
/** Arabic letters only — ، ؛ ؟ must count as boundaries. */
const AR = "\\u0621-\\u064a\\u0671-\\u06d3";
const NEG = "(?:مو|مب|ما|مش|ماني|مانيب|لست)";

function normalizeForMatch(text = "") {
  return String(text || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ة/gu, "ه")
    .replace(/ى/gu, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keeps ى so Hijazi تبغى (m) and تبغي (f) stay distinct. */
function normalizeForGender(text = "") {
  return String(text || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/gu, "")
    .replace(/[أإآ]/gu, "ا")
    .replace(/ة/gu, "ه");
}

function word(alternatives, { negatable = false } = {}) {
  const neg = negatable ? `(?<!${NEG}\\s+)` : "";
  return new RegExp(
    `(?<![${AR}])${neg}(?:${alternatives})(?![${AR}])`,
    "u",
  );
}

const TECH_RAW_RE = /https?:|www\.|[\\/`{}<>=|]|[A-Za-z]{3,}|\d{3,}/;
const TECH_NOUN_RE = new RegExp(
  `(?<![${AR}])(?:[وبفل])?(?:ال)?(?:كود|برنامج|سيرفر|جهاز|جهازي|لابتوب|كمبيوتر|بي\\s*سي|نت|انترنت|شبكه|موديل|لعبه|ملف|خطا|ايرور|ستيم|جوال|جوالي|تطبيق|موقع|مشروع)(?![${AR}])`,
  "u",
);
const TASK_VERB_RE = word(
  "ابحث|دور|افتح|شغل|ثبت|حمل|نزل|افحص|صلح|عدل|اكتب|ترجم|لخص|احذف|اشرح|وضح|فسر|سوي|سويه|نفذ|نفذه|اريد|ابغي|ابغا|ابي|ابيك|ابغاك|ممكن",
);
const ABOUT_JACK_FEELINGS_RE = new RegExp(
  `(?<![${AR}])(?:انت|انتا)\\s*(?:كمان\\s*)?(?:تعبان|حزين|زعلان|ضايق|متضايق|مقهور|تحس|تشعر|عندك\\s*(?:مشاعر|احساس))|عندك\\s*مشاعر|(?:تحس|تشعر)\\s*(?:بشي|بمشاعر|زينا|مثلنا)`,
  "u",
);

const MISUNDERSTOOD_RE = new RegExp(
  `(?:^|[\\s،,])${NEG}\\s*(?:فهمت|فاهم|فاهمه|فهمتك)(?:\\s*(?:منك|عليك|كلامك|شرحك|قصدك))?(?:\\s*(?:ولا|اي)\\s*(?:شي|شيء|حرف|كلمه|حاجه))?\\s*(?:[،,.!؟?…]|$)`,
  "u",
);
const CONFUSED_RE =
  /لخبطتني|خربطتني|ضيعتني|دوختني|عقدتها|(?:كلامك|شرحك)\s*(?:مو\s*واضح|ملخبط|مخربط|معقد|مو\s*مفهوم|غير\s*مفهوم|زفت)/u;

const UPSET_VERBS =
  "قهرتني|نرفزتني|عصبتني|فقعتني|طفشتني|زهقتني|جننتني|ضايقتني|خنقتني|فشلتني|نكدت\\s*علي|فقعت\\s*مرارتي";
const UPSET_RE = word(UPSET_VERBS);
const LEADING_UPSET_RE = new RegExp(
  `^(?:(?:ياخي|يا\\s*اخي|والله|يا\\s*شيخ|يا\\s*رجال|يا\\s*جاك|جاك)[\\s،,]*)*(?:${UPSET_VERBS})`,
  "u",
);
const SECOND_PERSON_RE = word("انت|انتا|منك|جاك");
const UPSET_FROM_YOU_RE =
  /(?:زعلان|زعلانه|مقهور|مقهوره|متضايق|متضايقه|معصب|معصبه)\s*(?:منك|عليك)/u;
const FRUSTRATION_MARKER_RE = word("ياخي|يا\\s*اخي");

const VENTING_RE = word(
  "مقهور|مقهوره|معصب|معصبه|متنرفز|متنرفزه|زهقان|زهقانه|طفشان|طفشانه|زهقت|طفشت|انقهرت|تنرفزت|قهرني|قهرتني|فقعني|نرفزني|مضغوط|مضغوطه|ضغطني",
  { negatable: true },
);
const LOW_MOOD_RE =
  /نفسيتي[\s\S]{0,20}?(?:تعبان|زفت|خايس|مو\s*زين|مو\s*تمام|مو\s*ولا\s*بد|داون|تحت|سيئ|مضروب|خربان|زباله|مقفل|مسدود)|مالي\s*خلق|ما\s*لي\s*خلق|صدري\s*ضايق|خاطري\s*مكسور|يومي\s*(?:زفت|سيئ|خايس|تعبان|ثقيل)|فيني\s*ضيقه|حاس(?:ه)?\s*بضيقه|مو\s*مرتاح/u;
const LOW_MOOD_ADJ_RE = word(
  "تعبان|تعبانه|حزين|حزينه|زعلان|زعلانه|ضايق|ضايقه|متضايق|متضايقه|مهموم|مهمومه|مدبرس|مدبرسه|مخنوق|مخنوقه|مرهق|مرهقه|محبط|محبطه|مكسور|مكسوره",
  { negatable: true },
);
const QUESTION_WORD_RE = word("ليش|ليه|لماذا|كيف|وش|ايش|متى|هل|كم|وين|مين");

/**
 * @returns {{ kind: 'misunderstood'|'upset_with_jack'|'low_mood'|'venting', frustrated: boolean } | null}
 */
export function classifyEmotionalTurn(text = "") {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 140 || !ARABIC_RE.test(raw)) return null;
  if (TECH_RAW_RE.test(raw)) return null;
  const t = normalizeForMatch(raw);
  if (TECH_NOUN_RE.test(t) || TASK_VERB_RE.test(t)) return null;
  if (ABOUT_JACK_FEELINGS_RE.test(t)) return null;

  const upset =
    (UPSET_RE.test(t) &&
      (SECOND_PERSON_RE.test(t) || LEADING_UPSET_RE.test(t))) ||
    UPSET_FROM_YOU_RE.test(t);
  const venting = VENTING_RE.test(t);
  const frustrated = upset || venting || FRUSTRATION_MARKER_RE.test(t);

  if (MISUNDERSTOOD_RE.test(t) || CONFUSED_RE.test(t))
    return { kind: "misunderstood", frustrated };
  if (upset) return { kind: "upset_with_jack", frustrated: true };
  if (/[؟?]/.test(raw) || QUESTION_WORD_RE.test(t)) return null;
  if (LOW_MOOD_RE.test(t) || LOW_MOOD_ADJ_RE.test(t))
    return { kind: "low_mood", frustrated: false };
  if (venting) return { kind: "venting", frustrated: true };
  return null;
}

const CANNED_OPENERS_RE =
  /^(?:حقك علي|معك حق|معليش، شكلي|سلامتك|سلامة قلبك|الله يعين|والله إنها تقهر|أعانك الله)/u;

export function isEmotionalCannedReply(text = "") {
  const body = String(text || "").trim();
  return body.length < 160 && CANNED_OPENERS_RE.test(body);
}

function lastSubstantiveAnswer(snapshot = null) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const candidates = messages.length
    ? messages.filter((m) => m.role === "assistant").map((m) => m.content)
    : [snapshot?.lastAssistant];
  for (const content of candidates.reverse()) {
    const body = String(content || "").trim();
    if (!body || isEmotionalCannedReply(body)) continue;
    return body.length >= 40 ? body : "";
  }
  return "";
}

/**
 * Plan for this turn, or null when it is not a casual emotional turn.
 * deterministic=false only when the user is lost after a real answer — the
 * model must re-explain that answer, under the emotional directive + guard.
 */
export function emotionalTurnPlan(text = "", { snapshot = null, style = null } = {}) {
  const s = normalizeConversationStyle(style);
  if (s.language === "en") return null;
  const classified = classifyEmotionalTurn(text);
  if (!classified) return null;
  const priorAnswer =
    classified.kind === "misunderstood" ? lastSubstantiveAnswer(snapshot) : "";
  return {
    ...classified,
    register: s.arabic_style === "msa" ? "msa" : "jeddawi",
    deterministic: !priorAnswer,
    ...(priorAnswer ? { priorAnswer: priorAnswer.slice(0, 2000) } : {}),
  };
}

function speakerGender(user, store) {
  const gender = accountBoundSpeaker(user, store).gender;
  return gender === "m" || gender === "f" ? gender : null;
}

function arabicAddressName(user, store) {
  const speaker = accountBoundSpeaker(user, store);
  if (speaker.honorific === "Queen") return "لبنى";
  if (speaker.honorific !== "Master") return "";
  const name = String(speaker.speaker_name || "").trim();
  if (/abdul\s*rahman/i.test(name)) return "عبدالرحمن";
  return ARABIC_RE.test(name) ? name : "";
}

const JEDDAWI_REPLIES = {
  misunderstood: [
    {
      frustratedOnly: true,
      m: "معك حق تنقهر، شرحي كان ملخبط. قول لي وين ضعت وأعيدها لك بكلام أبسط.",
      f: "معك حق تنقهري، شرحي كان ملخبط. قولي لي وين ضعتي وأعيدها لك بكلام أبسط.",
      n: "حقك علي، شرحي كان ملخبط. إيش الجزء اللي ما وضح؟ أعيده لك بكلام أبسط.",
    },
    {
      m: "حقك علي، الغلط من شرحي مو منك. قول لي إيش اللي ما وضح وأختصره لك.",
      f: "حقك علي، الغلط من شرحي مو منك. قولي لي إيش اللي ما وضح وأختصره لك.",
      n: "حقك علي، الغلط من شرحي. إيش اللي ما وضح؟ أختصره لك.",
    },
  ],
  upset_with_jack: [
    {
      m: "حقك علي. إيش اللي ضايقك في ردي؟ أعدّله على طول.",
      f: "حقك علي. إيش اللي ضايقك في ردي؟ أعدّله على طول.",
      n: "حقك علي. إيش اللي ضايقك في ردي؟ أعدّله على طول.",
    },
    {
      m: "معليش، شكلي زودتها. قول لي وين وأعدّلها.",
      f: "معليش، شكلي زودتها. قولي لي وين وأعدّلها.",
      n: "معليش، شكلي زودتها. إيش اللي ضايقك؟ أعدّله.",
    },
  ],
  low_mood: [
    {
      m: "سلامتك{name}. إذا حاب تفضفض أنا معك، وإذا تبغى نغيّر جو برضو ماشي.",
      f: "سلامتك{name}. إذا حابة تفضفضي أنا معك، وإذا تبغي نغيّر جو برضو ماشي.",
      n: "سلامتك. الفضفضة هنا مفتوحة، ولو ودّك نغيّر جو برضو ماشي.",
    },
    {
      m: "سلامة قلبك. خذ راحتك، وإذا فيه شي مضايقك نتكلم فيه.",
      f: "سلامة قلبك. خذي راحتك، وإذا فيه شي مضايقك نتكلم فيه.",
      n: "سلامة قلبك. إذا فيه شي مضايقك، نتكلم فيه على راحتك.",
    },
  ],
  venting: [
    {
      m: "الله يعينك، باين إن الموضوع قاهرك. فضفض إذا حاب، أو قول لي إيش صار ونشوف له حل.",
      f: "الله يعينك، باين إن الموضوع قاهرك. فضفضي إذا حابة، أو قولي لي إيش صار ونشوف له حل.",
      n: "الله يعين، باين إن الموضوع قاهرك. إيش صار؟ نشوف له حل أو بس نسولف، اللي يريحك.",
    },
    {
      m: "والله إنها تقهر. خذ نفس، وإذا تبغى نحلها سوا قول لي إيش اللي صار.",
      f: "والله إنها تقهر. خذي نفس، وإذا تبغي نحلها سوا قولي لي إيش اللي صار.",
      n: "والله إنها تقهر. إيش اللي صار؟ نشوفها سوا.",
    },
  ],
};

const MSA_REPLIES = {
  misunderstood: [
    {
      m: "معك حق، شرحي لم يكن واضحًا. أخبرني أي جزء لم يتضح وسأعيده بصورة أبسط.",
      f: "معك حق، شرحي لم يكن واضحًا. أخبريني أي جزء لم يتضح وسأعيده بصورة أبسط.",
      n: "معك حق، شرحي لم يكن واضحًا. أي جزء لم يتضح؟ سأعيده بصورة أبسط.",
    },
  ],
  upset_with_jack: [
    {
      m: "معك حق. ما الذي أزعجك في ردي؟ سأعدّله فورًا.",
      f: "معك حق. ما الذي أزعجك في ردي؟ سأعدّله فورًا.",
      n: "معك حق. ما الذي أزعجك في ردي؟ سأعدّله فورًا.",
    },
  ],
  low_mood: [
    {
      m: "سلامتك{name}. إن أردت الحديث عمّا يضايقك فأنا معك، وإن أردت تغيير الجو فلا بأس.",
      f: "سلامتك{name}. إن أردت الحديث عمّا يضايقك فأنا معك، وإن أردت تغيير الجو فلا بأس.",
      n: "سلامتك. إن أردت الحديث عمّا يضايقك فأنا معك، وإن أردت تغيير الجو فلا بأس.",
    },
  ],
  venting: [
    {
      m: "أعانك الله، يبدو أن الأمر أثقل عليك. أخبرني بما حدث ونبحث له عن حل.",
      f: "أعانك الله، يبدو أن الأمر أثقل عليكِ. أخبريني بما حدث ونبحث له عن حل.",
      n: "أعانك الله، يبدو أن الأمر ثقيل. ما الذي حدث؟ لنبحث له عن حل.",
    },
  ],
};

/**
 * Short, gender-correct reply. Avoids repeating the previous assistant line.
 */
export function emotionalDeterministicReply({
  plan,
  user = null,
  store = null,
  lastAssistant = "",
} = {}) {
  if (!plan?.kind) return "";
  const table = plan.register === "msa" ? MSA_REPLIES : JEDDAWI_REPLIES;
  const gender = speakerGender(user, store) || "n";
  const name = arabicAddressName(user, store);
  const variants = (table[plan.kind] || []).filter(
    (v) => !v.frustratedOnly || plan.frustrated,
  );
  const rendered = variants.map((v) =>
    v[gender].replace("{name}", name ? ` يا ${name}` : ""),
  );
  const previous = String(lastAssistant || "").trim();
  return rendered.find((r) => r !== previous) || rendered[0] || "";
}

/** Model-path instructions (used when Jack must re-explain a prior answer). */
export function emotionalDirective(plan, { user = null, store = null } = {}) {
  if (!plan?.kind) return "";
  const gender = speakerGender(user, store);
  const opening = {
    misunderstood:
      "The user is frustrated because your previous answer was unclear. Open with ONE short human acknowledgement (e.g. حقك علي / معك حق), then re-explain the core of your previous answer in 1–3 plain sentences. No lists, no headings.",
    upset_with_jack:
      "The user is upset with your previous reply. One short acknowledgement (e.g. حقك علي), then fix or ask exactly what bothered them in one line.",
    low_mood:
      "The user is feeling low. One or two warm, short lines (e.g. سلامتك). Leave room to talk without pushing a question.",
    venting:
      "The user is venting. Acknowledge it plainly in one or two short lines (e.g. الله يعينك) and leave room to talk or solve it.",
  }[plan.kind];
  return [
    "CASUAL EMOTIONAL TURN — reply like a sharp, loyal friend, not a help desk.",
    opening,
    plan.register === "msa"
      ? "Reply in clear, warm Modern Standard Arabic (the user chose فصحى)."
      : "Reply in natural Saudi/Jeddah Arabic.",
    "Forbidden: AI/model disclaimers, talk about having or lacking feelings, therapy-speak (أتفهم شعورك، يؤسفني سماع ذلك), referrals to specialists, apology theater, offers of help, canned questions (هل تريد التحدث عن ذلك؟).",
    "Do not claim to feel emotions yourself.",
    gender === "m"
      ? "Address the user with MASCULINE Arabic grammar (إنت، تبغى، حاب، قول لي). Never feminine forms."
      : gender === "f"
        ? "Address the user with FEMININE Arabic grammar (إنتي، تبغي، حابة، قولي لي). Never masculine forms."
        : "The user's gender is unknown: prefer gender-neutral phrasing and avoid gendered second-person verb forms.",
  ].join("\n");
}

const AI_BOILERPLATE_RE =
  /كذكاء\s*اصطناعي|كنموذج|نموذج\s*(?:لغوي|ذكاء|لغه)|ذكاء\s*اصطناعي|مساعد\s*(?:ذكي|افتراضي|رقمي)|(?:لا\s*املك|ليس\s*لدي|ما\s*عندي)\s*(?:مشاعر|احاسيس)|لا\s*استطيع\s*(?:الشعور|ان\s*اشعر)|انا\s*هنا\s*(?:لمساعدتك|للمساعده|لخدمتك)|كيف\s*(?:يمكنني|اقدر|استطيع)\s*(?:ان\s*)?(?:اساعدك|مساعدتك|اخدمك)|يسعدني\s*(?:مساعدتك|ان\s*اساعدك)|لا\s*تتردد|(?:اتفهم|افهم)\s*(?:شعورك|مشاعرك|تماما)|من\s*الطبيعي\s*ان\s*تشعر|اسف\s*لسماع|يؤسفني|هل\s*(?:هناك|يوجد)\s*(?:شيء|اي\s*شيء)|هل\s*(?:تريد|تريدين|تود|تودين|ترغب|ترغبين)\s*(?:في\s*)?(?:التحدث|الحديث|ان\s*تتحدث|مشاركه)|(?<![\u0621-\u064a])(?:ال)?(?:مختص|اخصائي)(?:ين)?(?![\u0621-\u064a])|معالج\s*نفسي|\bas an ai\b|language model|i don'?t have feelings|i'?m here to help|how can i (?:help|assist)/iu;
const SENTIENCE_RE =
  /(?:^|[\s،,.])(?:انا|وانا)\s*(?:كمان\s*|بعد\s*|برضو\s*)?(?:حزين|زعلان|مقهور|متضايق|متاثر|تعبان)|اشعر\s*(?:بالحزن|بالالم|بمشاعر|مثلك)|قلبي\s*(?:معك|يوجعني|انكسر)|\bi feel (?:sad|hurt|your pain)\b|\bi'?m (?:sad|hurt) too\b/iu;
const FEMININE_ADDRESS_RE = new RegExp(
  `(?<![${AR}])(?:انتي|تبغين|تبغي|تبين|تبيني|تريدين|تودين|تحتاجين|تشعرين|تحسين|تحسي|تقدرين|تقدري|تستطيعين|تفضفضين|تفضفضي|تكونين|تحبين|تنقهرين|تنقهري|حابه|عزيزتي|حبيبتي|فضفضي|خذي|قولي\\s*لي|ضعتي|كنتي|اردتي|اخبريني|ارتاحي)(?![${AR}])`,
  "u",
);
const MASCULINE_ADDRESS_RE = new RegExp(
  `(?<![${AR}])(?:حاب|تبغى|تنقهر|فضفض|خذ\\s*راحتك|خذ\\s*نفس|قول\\s*لي|اخبرني|ارتاح)(?![${AR}])`,
  "u",
);

/**
 * @returns {{ code: string, detail: string } | null}
 */
export function detectEmotionalReplyViolation(
  text = "",
  { user = null, store = null } = {},
) {
  const body = String(text || "").trim();
  if (!body) return { code: "empty", detail: "Empty reply." };
  const g = normalizeForGender(body);
  if (AI_BOILERPLATE_RE.test(g))
    return {
      code: "boilerplate",
      detail: "AI-helper / therapy boilerplate in a casual emotional turn.",
    };
  if (SENTIENCE_RE.test(g))
    return { code: "sentience", detail: "Reply claims Jack feels emotions." };
  const gender = speakerGender(user, store);
  if (
    gender === "m" &&
    (new RegExp(`(?:كِ|نتِ)(?![${AR}])`, "u").test(body) ||
      FEMININE_ADDRESS_RE.test(g))
  )
    return {
      code: "wrong_gender",
      detail: "Feminine grammar used for a male account.",
    };
  if (gender === "f" && MASCULINE_ADDRESS_RE.test(g))
    return {
      code: "wrong_gender",
      detail: "Masculine grammar used for a female account.",
    };
  const arabicChars = (body.match(/[\u0600-\u06ff]/g) || []).length;
  const latinLetters = (body.match(/[A-Za-z]/g) || []).length;
  if (latinLetters > arabicChars)
    return { code: "wrong_language", detail: "Non-Arabic reply to Arabic." };
  const sentences = body.split(/[.!؟?]+/u).filter((s) => s.trim()).length;
  if (
    body.length > 320 ||
    sentences > 4 ||
    /\n\s*(?:[-*•]|\d+[.)])\s/u.test(body)
  )
    return { code: "too_long", detail: "Not brief/conversational." };
  return null;
}

/**
 * Instant emotional reply — no model, tools, research, or memory writes.
 */
export function emitEmotionalReply({
  store,
  chatId,
  user,
  text,
  plan,
  emit,
  timing = null,
}) {
  const speakerPersona = accountBoundSpeaker(user, store);
  const lastAssistant =
    [...store.messages(chatId)].reverse().find((m) => m.role === "assistant")
      ?.content || "";
  const reply = emotionalDeterministicReply({ plan, user, store, lastAssistant });
  const previousState = store.taskState(chatId) || {};
  store.saveTaskState(chatId, { ...previousState, speakerPersona });
  store.message(chatId, "user", text);
  store.message(chatId, "assistant", reply);
  emit({
    type: "priority",
    lane: "normal",
    intent: "emotional",
    personaKind: null,
    fastPath: true,
  });
  emit({
    type: "turn_context",
    intent: "emotional",
    taskHint: "emotional_support",
    emotionalKind: plan.kind,
    fastPath: true,
    effectiveIntent: String(text || "").slice(0, 400),
    speakerPersona,
    allowResearch: false,
    allowVerification: false,
    allowMemoryWrite: false,
    allowWebSearch: false,
    allowMemoryRecall: false,
  });
  emit({ type: "token", text: reply });
  emit({ type: "done", tokens: 0 });
  if (timing?.snapshot) {
    emit({
      type: "timing",
      ...timing.snapshot({ model: null, kind: "emotional", fastPath: true }),
    });
  }
  return reply;
}
